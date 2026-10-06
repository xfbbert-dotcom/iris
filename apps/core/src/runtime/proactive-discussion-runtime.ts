import { randomUUID } from "node:crypto";
import { readProactiveDiscussionConfig } from "../config/runtime-config.js";
import { readEmbeddingProviderConfig, readProactiveDiscussionModelProviderConfig, readOptionalFeishuBotOpenId, readOptionalFeishuOpenApiConfig, type EnvLike } from "../config/env.js";
import { readDatabaseConfig } from "../database/database-config.js";
import { createPostgresPool } from "../database/postgres.js";
import type { RuntimeController } from "../admin/runtime-controller.js";
import { createPostgresProactiveDiscussionRepository } from "../proactive-discussion/postgres-repository.js";
import type { PdRepository } from "../proactive-discussion/repository.js";
import { PD_PILOT_CHAT, type PdDelivery, type PdStatus } from "../proactive-discussion/contracts.js";
import { createPdRegistrar, type PdRegistrar } from "../proactive-discussion/registrar.js";
import { createPdEvaluationWorker } from "../proactive-discussion/evaluation-worker.js";
import { createPdDeliveryWorker } from "../proactive-discussion/delivery-worker.js";
import { createPdModel, type PdModel } from "../proactive-discussion/model.js";
import { pdOpinionModeOptions } from "../proactive-discussion/opinion-mode.js";
import { createPdContextBuilder, type PdContextBuilder } from "../proactive-discussion/context-builder.js";
import { createPdSourceVerifier, type PdSourceVerifier } from "../proactive-discussion/source-verifier.js";
import { createOpenAICompatibleChatCompletionsClient } from "../model/openai-compatible-chat-completions-client.js";
import { createOpenAICompatibleEmbeddingProvider } from "../model/openai-compatible-embedding-provider.js";
import { createFeishuTenantAccessTokenProvider } from "../feishu/feishu-tenant-access-token-provider.js";
import { createFeishuChatHistoryReader, type FeishuChatHistoryReader } from "../feishu/feishu-chat-history-reader.js";
import { createFeishuMessageReplier, type FeishuMessageReplier } from "../feishu/feishu-message-replier.js";
import { createFeishuGroupMembershipChecker, type FeishuGroupMembershipChecker } from "../feishu/feishu-group-membership-checker.js";
import { createFeishuDocumentPermissionChecker } from "../permissions/feishu-document-permission-checker.js";
import { createAnswerSourcePermissionVerifier, type AnswerSourcePermissionVerifier } from "../answer-replies/answer-source-permission-verifier.js";
import { createDocumentRetrievalContextBuilder } from "../memory/document-retrieval-context.js";
import { createEmbeddingProfileRepository } from "../documents/embedding-profile-repository.js";
import { createDocumentFragmentRepository } from "../documents/document-fragment-repository.js";
import { createPostgresDocumentSourceRegistry } from "../documents/postgres-document-source-registry.js";
import type { DocumentSource } from "../documents/document-source-registry.js";
import { createDocumentSnapshotRepository } from "../documents/document-snapshot-repository.js";
import { createPostgresDocumentSourceGroupGrantRepository } from "../documents/postgres-document-source-group-grant-repository.js";
import { resolveRuntimeEmbedding } from "./answer-draft-runtime.js";
import { observeStartupPromise } from "./startup-promise.js";

export type PdControl = {
  repository: Pick<PdRepository, "setPolicy" | "readState" | "readDelivery" | "resumeByOperator" | "reconcile">;
  verifySentReceipt(delivery: PdDelivery, replyMessageId: string): Promise<boolean>;
};
export type ProactiveDiscussionRuntime = {
  start(): Promise<void>;
  close(): Promise<void>;
  getStatus(): Promise<PdStatus & { enabled: boolean; running: boolean; ok: boolean; drainPending?: boolean }>;
  registrar: ReturnType<typeof createPdRegistrar>;
  readonly control?: PdControl;
};
export type PdRuntimeResources = {
  repository: PdRepository; botOpenId: string; contextBuilder: PdContextBuilder; model: PdModel;
  membership: Pick<FeishuGroupMembershipChecker, "isCurrentMember">; reader: FeishuChatHistoryReader;
  replier: FeishuMessageReplier; sourceVerifier: PdSourceVerifier; close(): Promise<void>;
};
type ResourceInput = { env: EnvLike; runtimeController?: RuntimeController; isStopping(): boolean;
  dependencies?: { createPostgresPool?: typeof createPostgresPool; fetch?: typeof fetch } };
const emptyStatus: PdStatus = { pending: 0, failed: 0, deadLetter: 0, unknown: 0, lastSuccessAt: null };
// Technical shutdown bound, unrelated to participation policy or speech frequency.
const DRAIN_TIMEOUT_MS = 5000;

export function createProactiveDiscussionRuntime({ env = process.env, runtimeController,
  createResources = createDefaultResources, now = () => new Date(), dependencies,
}: { env?: EnvLike; runtimeController?: RuntimeController;
  createResources?: (input: ResourceInput) => Promise<PdRuntimeResources>; now?: () => Date;
  dependencies?: ResourceInput["dependencies"];
} = {}): ProactiveDiscussionRuntime {
  // Invalid scope is a configuration error and must escape operational containment.
  const config = readProactiveDiscussionConfig(env);
  let resources: PdRuntimeResources | undefined;
  let control: PdControl | undefined;
  let delegate: PdRegistrar | undefined;
  let running = false, stopping = false, failed = false, drainPending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let startup: Promise<void> | undefined, inFlight: Promise<void> | undefined, cleanup: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let latest: PdStatus = { ...emptyStatus };
  function cleanupOnce() {
    return cleanup ??= Promise.resolve().then(async () => {
      await resources?.close();
    }).catch(() => { failed = true; }).finally(() => { drainPending = false; });
  }
  const runtime: ProactiveDiscussionRuntime = {
    registrar: { async registerMessage(input) {
      if (!config.enabled) return;
      const knownBot = resources?.botOpenId ?? readOptionalFeishuBotOpenId(env);
      if (input.conversationMessage.chatId !== PD_PILOT_CHAT || input.senderType !== "user"
        || (knownBot !== undefined && input.conversationMessage.senderOpenId === knownBot)) return;
      // The raw-event processor finishes ordinary work before propagating this
      // retryable failure. Enabled startup must never acknowledge lost PD work.
      if (stopping || !running || !delegate) throw new Error("proactive discussion registration unavailable");
      await delegate.registerMessage(input);
    } },
    get control() { return stopping ? undefined : control; },
    start() {
      return startup ??= observeStartupPromise((async () => {
        if (!config.enabled || stopping) return;
        try {
          resources = await createResources({ env, dependencies, ...(runtimeController ? { runtimeController } : {}), isStopping: () => stopping });
          if (stopping) return;
          latest = await resources.repository.getStatus();
          if (stopping) return;
          delegate = createPdRegistrar({ repository: resources.repository, botOpenId: resources.botOpenId, now });
          control = { repository: resources.repository,
            verifySentReceipt: async (delivery, replyMessageId) => {
              if (stopping || delivery.chatId !== PD_PILOT_CHAT || !resources?.reader.readMessagesByIds) return false;
              try {
                const rows = await resources.reader.readMessagesByIds({ chatId: delivery.chatId, messageIds: [replyMessageId], sender: "assistant" });
                const message = rows.length === 1 ? rows[0] : undefined;
                return !stopping && message?.messageId === replyMessageId && message.chatId === delivery.chatId
                  && message.role === "assistant" && message.text === delivery.text
                  && (message.parentMessageId ?? message.rootMessageId) === delivery.triggerMessageId;
              } catch { return false; }
            } };
          const shared = { ...resources, now, workerId: `pd-${randomUUID()}`, isStopping: () => stopping };
          const evaluation = createPdEvaluationWorker(shared);
          const delivery = createPdDeliveryWorker({ ...shared, replier: { replyText(input) {
            if (stopping) return Promise.reject(new Error("proactive runtime stopping"));
            return resources!.replier.replyText(input);
          } } });
          running = true;
          const poll = () => {
            if (stopping || !running) return;
            inFlight = (async () => {
              let currentFailure = false;
              for (let count = 0; count < config.batchLimit && !stopping; count++) {
                const assessed = await evaluation.runOnce();
                currentFailure ||= assessed === "failed";
                if (stopping) break;
                const sent = await delivery.runOnce();
                currentFailure ||= sent === "failed";
                if (assessed === "idle" && sent === "idle") break;
              }
              failed = currentFailure;
            })().catch(() => { failed = true; }).finally(() => {
              inFlight = undefined;
              if (!stopping) timer = setTimeout(poll, config.pollIntervalMs);
            });
          };
          timer = setTimeout(poll, config.pollIntervalMs);
        } catch { failed = true; running = false; await cleanupOnce(); }
      })());
    },
    async getStatus() {
      if (resources && !stopping) {
        // A failed read must not be disguised as successful zero counters.
        latest = await resources.repository.getStatus();
      }
      return { ...latest, enabled: config.enabled, running,
        ok: !config.enabled || (running && !failed && !drainPending && latest.failed === 0 && latest.deadLetter === 0 && latest.unknown === 0),
        ...(drainPending ? { drainPending } : {}) };
    },
    close() {
      if (!config.enabled) { stopping = true; return Promise.resolve(); }
      return closing ??= (async () => {
      stopping = true; running = false;
      if (timer) clearTimeout(timer);
      drainPending = true;
      const drain = Promise.allSettled([startup, inFlight]).then(() => cleanupOnce());
      let bound: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([drain, new Promise<void>(resolve => { bound = setTimeout(resolve, DRAIN_TIMEOUT_MS); })]);
      if (bound) clearTimeout(bound);
      })();
    },
  };
  return runtime;
}

async function createDefaultResources({ env, runtimeController, isStopping, dependencies = {} }: ResourceInput): Promise<PdRuntimeResources> {
  const feishu = readOptionalFeishuOpenApiConfig(env), modelConfig = readProactiveDiscussionModelProviderConfig(env);
  const botOpenId = readOptionalFeishuBotOpenId(env);
  if (!feishu || !modelConfig || !botOpenId || !runtimeController) throw new Error("proactive dependencies unavailable");
  const fetch: typeof globalThis.fetch = (...args) => {
    if (isStopping()) return Promise.reject(new Error("proactive runtime stopping"));
    return (dependencies.fetch ?? globalThis.fetch)(...args);
  };
  const pool = (dependencies.createPostgresPool ?? createPostgresPool)({ ...readDatabaseConfig(env),
    connectionTimeoutMillis: 5000, queryTimeoutMillis: 10000, statementTimeoutMillis: 10000, lockTimeoutMillis: 5000 });
  try {
    const tokenProvider = createFeishuTenantAccessTokenProvider({ baseUrl: feishu.baseUrl, appId: feishu.appId,
      appSecret: feishu.appSecret, timeoutMs: feishu.documentFetchTimeoutMs, fetch });
    const transport = { baseUrl: feishu.baseUrl, tokenProvider, timeoutMs: feishu.documentFetchTimeoutMs, fetch };
    const reader = createFeishuChatHistoryReader({ ...transport, assistantAppId: feishu.appId });
    const replier = createFeishuMessageReplier(transport);
    const membership = createFeishuGroupMembershipChecker(transport);
    const permissionChecker = createFeishuDocumentPermissionChecker(transport);
    const registry = createPostgresDocumentSourceRegistry(pool);
    const grants = createPostgresDocumentSourceGroupGrantRepository({ dataSource: pool });
    const canReadGroup = (chatId: string) => !isStopping() && chatId === PD_PILOT_CHAT && runtimeController.canReadGroupContext(chatId);
    const sourceAllowed = (source: DocumentSource | undefined, chatId: string,
      access?: { hasCrossGroupGrantBinding: boolean; crossGroupGrantValidated: boolean }) => {
      if (!canReadGroup(chatId) || !runtimeController.canReadDocuments()) return false;
      if (!source || !source.canUseForAnswering || source.permissionState !== "readable" || source.syncState !== "synced") return false;
      if (source.sourceType === "authorized_wiki_document" && !runtimeController.canRetrieveKnowledgeBase()) return false;
      const local = source.originGroupId === chatId || source.evidence.some(item => item.groupId === chatId);
      return local ? access?.hasCrossGroupGrantBinding !== true : !!(access?.hasCrossGroupGrantBinding && access.crossGroupGrantValidated);
    };
    const canReadDocument = async (id: string, chatId: string, access?: { hasCrossGroupGrantBinding: boolean; crossGroupGrantValidated: boolean }) => {
      const source = await registry.findSourceById(id);
      if (!sourceAllowed(source, chatId, access) || !source || !await permissionChecker.canReadSource(source)) return false;
      const current = await registry.findSourceById(id);
      return current?.sourceUri === source.sourceUri && sourceAllowed(current, chatId, access);
    };
    const permissionVerifier = createAnswerSourcePermissionVerifier({ canReadDocument, managedSourceQueryable: pool });
    const snapshots = createDocumentSnapshotRepository({ queryable: pool });
    // The ordinary verifier checks permission/managed pages, but exact grant and
    // ordinary snapshot freshness are independent proof obligations before PD
    // consumes either retrieved text or persisted issue premises.
    const currentBindings = async (input: Parameters<AnswerSourcePermissionVerifier["verify"]>[0]) => {
      if (!canReadGroup(input.chatId)) return false;
      const ids = [...new Set(input.documentSourceIds)];
      if (ids.length === 0) return true;
      const bindings = input.sourceSnapshotBindings ?? [];
      if (bindings.length !== ids.length) return false;
      const latest = await snapshots.findLatestSnapshotMetadataForSources(ids);
      if (ids.some(id => {
        const bound = bindings.filter(binding => binding.documentSourceId === id);
        const actual = latest.filter(snapshot => snapshot.documentSourceId === id);
        return bound.length !== 1 || actual.length !== 1 || actual[0]!.fetchStatus !== "succeeded"
          || actual[0]!.id !== bound[0]!.documentSnapshotId;
      })) return false;
      for (const binding of input.crossGroupGrantBindings ?? []) {
        if (!await grants.validateExact(binding)) return false;
      }
      for (const id of ids) {
        const grantBound = input.crossGroupGrantBindings?.some(binding => binding.documentSourceId === id) === true;
        if (!sourceAllowed(await registry.findSourceById(id), input.chatId,
          grantBound ? { hasCrossGroupGrantBinding: true, crossGroupGrantValidated: true } : undefined)) return false;
      }
      return canReadGroup(input.chatId);
    };
    const documentVerifier: AnswerSourcePermissionVerifier = { async verify(input) {
      const denied = () => input.documentSourceIds.map(documentSourceId => ({ documentSourceId, outcome: "denied" as const }));
      if (!await currentBindings(input)) return denied();
      const decisions = await permissionVerifier.verify(input);
      return await currentBindings(input) ? decisions : denied();
    } };
    const repository = createPostgresProactiveDiscussionRepository({ dataSource: pool });
    const sourceVerifier = createPdSourceVerifier({ reader, documents: documentVerifier, canReadGroup,
      canProactivelySpeak: chatId => !isStopping() && chatId === PD_PILOT_CHAT && runtimeController.canProactivelySpeak(chatId) });
    const profiles = createEmbeddingProfileRepository({ queryable: pool });
    const fragments = createDocumentFragmentRepository({ queryable: pool, embeddingProfiles: profiles });
    const embedding = await resolveRuntimeEmbedding({ embeddingConfig: readEmbeddingProviderConfig(env), profiles,
      createEmbeddingProvider: config => createOpenAICompatibleEmbeddingProvider({ config, fetch }) });
    const contextBuilder = createPdContextBuilder({ repository, reader, sourceVerifier, canReadGroup, historicalSnapshots: snapshots,
      documents: chatId => createDocumentRetrievalContextBuilder({ embeddingProfileId: embedding.profile.id,
        embedder: embedding.embedder, fragments, groupId: chatId,
        sourceTypes: ["group_visible_document", "authorized_wiki_document", "user_submitted_document"],
        crossGroupGrantValidator: grants, canReadDocument: (id, access) => canReadDocument(id, chatId, access) }) });
    const client = createOpenAICompatibleChatCompletionsClient({ config: modelConfig, fetch });
    const model = createPdModel({ ...pdOpinionModeOptions(readProactiveDiscussionConfig(env).opinionMode), client: { complete(...args) {
      if (isStopping()) return Promise.reject(new Error("proactive runtime stopping"));
      return client.complete(...args);
    } } });
    return { repository, botOpenId, contextBuilder, model, membership, reader, replier, sourceVerifier, close: () => pool.end() };
  } catch (error) { await pool.end(); throw error; }
}
