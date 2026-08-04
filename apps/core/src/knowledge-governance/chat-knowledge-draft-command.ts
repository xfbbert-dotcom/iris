import { createHash } from "node:crypto";

import type {
  ActionProposalRepository,
  PublicationTargetPolicy,
} from "../action-approvals/action-proposal-repository.js";
import {
  presentKnowledgeDraft as defaultPresentKnowledgeDraft,
  type KnowledgeDraftPresentationRuntime,
} from "../knowledge-cards/knowledge-draft-presentation-service.js";
import type { ActionApprovalRuntime } from "../runtime/action-approval-runtime.js";
import type { KnowledgeDraftRuntime } from "../runtime/knowledge-draft-runtime.js";

import type { ChatKnowledgeDraftGenerator } from "./chat-knowledge-draft-generator.js";

const POLICY_LIMIT = 100;

export type ChatKnowledgeDraftCommandResult =
  | { status: "created"; draftId: string; presentationId: string }
  | { status: "already_created"; draftId: string; presentationId?: string }
  | { status: "runtime_disabled" | "no_context" | "target_unavailable" };

export type ChatKnowledgeDraftCommand = {
  execute(input: {
    messageId: string;
    chatId: string;
    requesterOpenId: string;
    requestText: string;
    observedAt: Date;
  }): Promise<ChatKnowledgeDraftCommandResult>;
};

type PublicationPolicyRuntime = {
  repository: Pick<ActionProposalRepository, "listTargetPolicies">;
  canUseActionApprovalsForSourceGroup(groupId?: string): boolean;
};

export type ChatKnowledgeDraftCommandDependencies = {
  generator: ChatKnowledgeDraftGenerator;
  canReadGroupContext(groupId: string): boolean;
  draftRuntime: Pick<KnowledgeDraftRuntime, "repository" | "canCreateDraft">;
  cardRuntime: KnowledgeDraftPresentationRuntime;
  actionApprovalRuntime: Pick<
    ActionApprovalRuntime,
    "repository" | "canUseActionApprovalsForSourceGroup"
  > & PublicationPolicyRuntime;
  presentKnowledgeDraft?: typeof defaultPresentKnowledgeDraft;
};

export class ChatKnowledgeDraftCommandConflictError extends Error {
  constructor() {
    super("chat knowledge draft command identity conflict");
    this.name = "ChatKnowledgeDraftCommandConflictError";
  }
}

export function createChatKnowledgeDraftCommand(
  dependencies: ChatKnowledgeDraftCommandDependencies,
): ChatKnowledgeDraftCommand {
  const presentKnowledgeDraft = dependencies.presentKnowledgeDraft ?? defaultPresentKnowledgeDraft;
  const inFlight = new Map<string, Promise<ChatKnowledgeDraftCommandResult>>();

  return {
    execute(rawInput) {
      const input = normalizeInput(rawInput);
      const identity = commandIdentity(input.messageId);
      const existing = inFlight.get(identity.digest);
      if (existing !== undefined) return existing;

      const execution = executeOnce({
        dependencies,
        presentKnowledgeDraft,
        input,
        identity,
      }).finally(() => {
        if (inFlight.get(identity.digest) === execution) inFlight.delete(identity.digest);
      });
      inFlight.set(identity.digest, execution);
      return execution;
    },
  };
}

async function executeOnce(input: {
  dependencies: ChatKnowledgeDraftCommandDependencies;
  presentKnowledgeDraft: typeof defaultPresentKnowledgeDraft;
  input: NormalizedCommandInput;
  identity: CommandIdentity;
}): Promise<ChatKnowledgeDraftCommandResult> {
  const { dependencies, identity } = input;
  const { chatId, requesterOpenId, requestText, observedAt } = input.input;
  const existingDraft = await dependencies.draftRuntime.repository.getDraft(identity.draftId);
  if (existingDraft !== undefined) {
    if (
      existingDraft.sourceGroupId !== chatId ||
      existingDraft.originKind !== "user_requested"
    ) throw new ChatKnowledgeDraftCommandConflictError();
    if (existingDraft.status !== "pending_confirmation") {
      return { status: "already_created", draftId: existingDraft.id };
    }
    if (!readGate(() => dependencies.cardRuntime.canUseKnowledgeCards(chatId))) {
      return { status: "runtime_disabled" };
    }
    const result = await input.presentKnowledgeDraft({
      runtime: dependencies.cardRuntime,
      draftId: existingDraft.id,
      expectedVersion: existingDraft.version,
      operationKey: identity.presentationOperationKey,
      at: observedAt,
    });
    return {
      status: "already_created",
      draftId: existingDraft.id,
      presentationId: result.presentation.id,
    };
  }

  const initialTarget = await readCreationTarget(dependencies, chatId);
  if (initialTarget.status !== "available") return { status: initialTarget.status };

  const generated = await dependencies.generator.generate({
    chatId,
    requesterOpenId,
    requestText,
    observedAt,
  });
  if (generated.status === "no_context") return { status: "no_context" };

  const confirmedTarget = await readCreationTarget(dependencies, chatId);
  if (confirmedTarget.status !== "available") return { status: confirmedTarget.status };
  if (!sameTargetPolicy(initialTarget.policy, confirmedTarget.policy)) {
    return { status: "target_unavailable" };
  }
  const targetPolicy = confirmedTarget.policy;

  const creation = await dependencies.draftRuntime.repository.createDraft({
    id: identity.draftId,
    operationKey: identity.creationOperationKey,
    originKind: "user_requested",
    createdBy: "iris",
    revision: {
      sourceGroupId: chatId,
      title: generated.title,
      content: generated.content,
      riskLevel: "medium",
      reviewer: { type: "feishu_user", ref: requesterOpenId },
      suggestedPublication: {
        spaceId: targetPolicy.spaceId,
        ...(targetPolicy.parentNodeToken === undefined
          ? {}
          : { parentNodeToken: targetPolicy.parentNodeToken }),
      },
      evidence: generated.evidence,
    },
    at: observedAt,
  });
  if (
    creation.draft.id !== identity.draftId ||
    creation.draft.sourceGroupId !== chatId
  ) throw new ChatKnowledgeDraftCommandConflictError();

  const presentation = await input.presentKnowledgeDraft({
    runtime: dependencies.cardRuntime,
    draftId: creation.draft.id,
    expectedVersion: creation.draft.version,
    operationKey: identity.presentationOperationKey,
    at: observedAt,
  });
  return {
    status: creation.outcome === "applied" ? "created" : "already_created",
    draftId: creation.draft.id,
    presentationId: presentation.presentation.id,
  };
}

type CreationTargetResult =
  | { status: "runtime_disabled" | "target_unavailable" }
  | { status: "available"; policy: PublicationTargetPolicy };

async function readCreationTarget(
  dependencies: ChatKnowledgeDraftCommandDependencies,
  chatId: string,
): Promise<CreationTargetResult> {
  if (
    !readGate(() => dependencies.canReadGroupContext(chatId)) ||
    !readGate(() => dependencies.draftRuntime.canCreateDraft({ sourceGroupId: chatId })) ||
    !readGate(() => dependencies.cardRuntime.canUseKnowledgeCards(chatId)) ||
    !readGate(() => (
      dependencies.actionApprovalRuntime.canUseActionApprovalsForSourceGroup(chatId)
    ))
  ) return { status: "runtime_disabled" };

  const policies = await dependencies.actionApprovalRuntime.repository.listTargetPolicies({
    enabled: true,
    limit: POLICY_LIMIT,
  });
  const matchingPolicies = policies.filter((policy) => (
    policy.enabled &&
    policy.allowedGroupIds.includes(chatId) &&
    policy.allowedRiskLevels.includes("medium")
  ));
  return matchingPolicies.length === 1
    ? { status: "available", policy: matchingPolicies[0]! }
    : { status: "target_unavailable" };
}

function sameTargetPolicy(
  first: PublicationTargetPolicy,
  second: PublicationTargetPolicy,
): boolean {
  return first.id === second.id &&
    first.version === second.version &&
    first.spaceId === second.spaceId &&
    first.parentNodeToken === second.parentNodeToken;
}

type NormalizedCommandInput = {
  messageId: string;
  chatId: string;
  requesterOpenId: string;
  requestText: string;
  observedAt: Date;
};

type CommandIdentity = {
  digest: string;
  draftId: string;
  creationOperationKey: string;
  presentationOperationKey: string;
};

function normalizeInput(input: NormalizedCommandInput): NormalizedCommandInput {
  return {
    messageId: requireNonBlank(input.messageId, "messageId"),
    chatId: requireNonBlank(input.chatId, "chatId"),
    requesterOpenId: requireNonBlank(input.requesterOpenId, "requesterOpenId"),
    requestText: requireNonBlank(input.requestText, "requestText"),
    observedAt: requireDate(input.observedAt),
  };
}

function commandIdentity(messageId: string): CommandIdentity {
  const digest = createHash("sha256")
    .update(JSON.stringify({ provider: "feishu", messageId }))
    .digest("hex");
  return {
    digest,
    draftId: `chat-knowledge-draft-${digest.slice(0, 40)}`,
    creationOperationKey: `chat-knowledge-draft-create-${digest}`,
    presentationOperationKey: `chat-knowledge-draft-present-${digest}`,
  };
}

function readGate(read: () => boolean): boolean {
  try {
    return read();
  } catch {
    return false;
  }
}

function requireNonBlank(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must not be blank`);
  }
  return value.trim();
}

function requireDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("observedAt must be a valid date");
  }
  return new Date(value);
}
