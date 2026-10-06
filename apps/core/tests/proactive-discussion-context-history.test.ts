import { expect, test, vi } from "vitest";
import { createPdContextBuilder } from "../src/proactive-discussion/context-builder.js";
import { createPdModel } from "../src/proactive-discussion/model.js";
import { createPdSourceRef, type PdIssue, type PdJob, type PdSource } from "../src/proactive-discussion/contracts.js";
import type { DocumentSnapshot } from "../src/documents/document-snapshot-repository.js";
import type { FeishuChatHistoryMessage } from "../src/feishu/feishu-chat-history-reader.js";
import { hashLocalMessageText } from "../src/memory/local-message-source.js";
import { pdAssessment, pdContextWithIssue, pdReviewFieldChecks, PILOT_CHAT } from "./fixtures/proactive-discussion.js";

const at = new Date("2026-09-14T00:00:00Z");
const trigger: FeishuChatHistoryMessage = { messageId: "new", chatId: PILOT_CHAT, senderId: "human", text: "新报价每人9万", sentAt: at };
function messageSource(message: FeishuChatHistoryMessage): PdSource {
  const binding = { chatId: message.chatId, messageId: message.messageId, contentHash: hashLocalMessageText(message.text) };
  return { kind: "message", binding, ref: createPdSourceRef({ kind: "message", binding }) };
}
const old: FeishuChatHistoryMessage = { ...trigger, messageId: "old", text: "预算只有10万元" };
const oldSource = messageSource(old);
const docBinding = { documentSourceId: "doc", documentSnapshotId: "snapshot" };
const docSource: PdSource = { kind: "document", binding: docBinding, ref: createPdSourceRef({ kind: "document", binding: docBinding }) };
const snapshot: DocumentSnapshot = { id: "snapshot", documentSourceId: "doc", sourceUri: "https://synthetic.invalid/doc", fetchStatus: "succeeded", bodyText: "历史预算文件", fetchedAt: at, createdAt: at };
function issue(basis: PdSource[], prose = basis): PdIssue {
  return { ...pdContextWithIssue().issues[0]!, basisSources: basis, proseSources: prose };
}
function harness(issues: PdIssue[] = [issue([oldSource])]) {
  let readable = true, permitted = true;
  const readMessagesByIds = vi.fn(async (_input: { chatId: string; messageIds: string[]; sender?: "user" | "assistant" }): Promise<FeishuChatHistoryMessage[]> => [old]);
  const findSnapshotById = vi.fn(async (_id: string): Promise<DocumentSnapshot | undefined> => snapshot);
  const verify = vi.fn(async (_input: { chatId: string; sources: readonly PdSource[] }) => permitted);
  const state = { policy: { chatId: PILOT_CHAT, version: 1, enabled: true, operatorId: "test" }, contextVersion: 1, catalogVersion: 1, issues };
  const builder = createPdContextBuilder({ repository: { readState: async () => state },
    reader: { listRecentMessages: async () => [trigger], readMessagesByIds },
    documents: () => ({ buildContext: async () => ({ promptContext: "", allowedFragments: [], deniedDocumentIds: [], retrievedFragmentCount: 0, usedGroupMemories: [] }) }),
    sourceVerifier: { verify }, canReadGroup: () => readable,
    historicalSnapshots: { findSnapshotById },
  });
  const job: PdJob = { id: "job", chatId: PILOT_CHAT, messageId: trigger.messageId, contentHash: hashLocalMessageText(trigger.text), policyVersion: 1, leaseToken: "lease", attempt: 1, purpose: "assessment" };
  return { load: () => builder.load(job), readMessagesByIds, findSnapshotById, verify,
    revoke: () => { permitted = false; }, stopReading: () => { readable = false; } };
}

test("restores a verified issue baseline through actual assessment, generation and review without substituting old AI prose", async () => {
  const h = harness([{ ...issue([oldSource]), lastObservation: "OLD_AI_OBSERVATION", lastReasoning: "OLD_AI_REASONING", lastSuggestion: "OLD_AI_SUGGESTION" }]);
  const context = (await h.load())!;
  expect(context.items).toEqual([{ ref: messageSource(trigger).ref, text: trigger.text }, { ref: oldSource.ref, text: old.text }]);
  const selected = { ...pdAssessment(), issueRef: { kind: "existing" as const, id: context.issues[0]!.id }, evidenceRefs: [messageSource(trigger).ref],
    materialChange: { kind: "new_evidence" as const, explanation: "报价变化", evidenceRefs: [messageSource(trigger).ref] } };
  const evidenceInputs: { ref: string; text: string }[][] = [];
  const model = createPdModel({ client: { complete: async (messages, options) => {
    const stage = options?.responseFormat?.json_schema.name;
    if (stage === "iris_proactive_discussion_assessment") return JSON.stringify(selected);
    evidenceInputs.push(JSON.parse(messages[1]!.content).evidence);
    return JSON.stringify(stage === "iris_proactive_discussion_generated_pair"
      ? { prose: { issueDescription: null, observation: "预算10万元，新报价每人9万。", reasoning: "需要核对新总成本。", suggestion: "建议核对预算。",
        uncertainty: "fact", changeExplanation: "报价变化", draftText: "建议核对预算。" } }
      : { fieldChecks: pdReviewFieldChecks(), supported: true, reason: "合成审核", requiredNumbers: [], adviceQuote: "建议核对预算。" });
  } } });
  const assessed = await model.assess(context);
  expect(assessed.evidenceRefs).toEqual([messageSource(trigger).ref, oldSource.ref]);
  expect(assessed.materialChange.evidenceRefs).toEqual([messageSource(trigger).ref]);
  expect((await model.render({ context, assessment: assessed }))?.draft.evidenceRefs).toEqual(assessed.evidenceRefs);
  expect(evidenceInputs).toHaveLength(2);
  for (const evidence of evidenceInputs) {
    expect(evidence.map(({ ref, text }) => ({ ref, text }))).toEqual([
      { ref: messageSource(trigger).ref, text: trigger.text }, { ref: oldSource.ref, text: old.text },
    ]);
    expect(JSON.stringify(evidence)).not.toContain("OLD_AI_");
  }
});

test("restores only missing basis once across issues, in batches of eight, without expanding prose history", async () => {
  const messages = Array.from({ length: 9 }, (_, index) => ({ ...old, messageId: `old-${index}`, text: `预算${index}` }));
  const sources = messages.map(messageSource);
  const unseen = messageSource({ ...old, messageId: "prose-only", text: "历史其他上下文" });
  const basis = [messageSource(trigger), ...sources];
  const h = harness([issue(basis, [...basis, unseen]), { ...issue(basis), id: "second" }]);
  h.readMessagesByIds.mockImplementation(async ({ messageIds }) => messages.filter(message => messageIds.includes(message.messageId)));
  const context = (await h.load())!;
  expect(context.items).toHaveLength(10);
  expect(context.items.map(item => item.ref)).not.toContain(unseen.ref);
  expect(h.readMessagesByIds.mock.calls.map(([input]) => input.messageIds)).toEqual([messages.slice(0, 8).map(message => message.messageId), ["old-8"]]);
  expect(h.readMessagesByIds.mock.calls.every(([input]) => input.chatId === PILOT_CHAT && input.sender === "user")).toBe(true);
});

test.each(["missing", "edited", "foreign", "assistant", "recap", "derived", "local-derived", "duplicate", "unexpected", "blank-sender", "read-error"])("fails closed on %s historical message bodies", async mode => {
  const h = harness();
  const changed = { ...old, ...(mode === "edited" ? { text: "改后的10万元" } : {}), ...(mode === "foreign" ? { chatId: "other" } : {}),
    ...(mode === "assistant" ? { role: "assistant" as const } : {}), ...(mode === "recap" ? { sharedChatRecap: true } : {}),
    ...(mode === "derived" ? { underlyingDocumentSources: [] } : {}), ...(mode === "local-derived" ? { underlyingLocalMessageSources: [] } : {}),
    ...(mode === "blank-sender" ? { senderId: " " } : {}) };
  h.readMessagesByIds.mockImplementation(async () => {
    if (mode === "read-error") throw new Error("unavailable");
    return mode === "missing" ? [] : mode === "duplicate" ? [old, old] : mode === "unexpected" ? [old, trigger] : [changed];
  });
  await expect(h.load()).resolves.toBeNull();
});

test("reads exact historical snapshots only after authorization, then rechecks before returning source text", async () => {
  const h = harness([issue([docSource])]);
  h.findSnapshotById.mockImplementation(async () => {
    expect(h.verify).toHaveBeenCalledWith({ chatId: PILOT_CHAT, sources: [docSource] });
    return snapshot;
  });
  const context = (await h.load())!;
  expect(context.items).toContainEqual({ ref: docSource.ref, text: snapshot.bodyText });
  expect(h.findSnapshotById).toHaveBeenCalledTimes(1);
  expect(h.findSnapshotById).toHaveBeenCalledWith("snapshot");
  expect(h.verify).toHaveBeenLastCalledWith({ chatId: PILOT_CHAT, sources: context.sources });
});

test.each(["missing", "wrong-id", "wrong-source", "failed", "blank", "read-error"])("fails closed on %s historical document snapshots", async mode => {
  const h = harness([issue([docSource])]);
  h.findSnapshotById.mockImplementation(async () => {
    if (mode === "read-error") throw new Error("unavailable");
    return mode === "missing" ? undefined : { ...snapshot, ...(mode === "wrong-id" ? { id: "other" } : {}),
      ...(mode === "wrong-source" ? { documentSourceId: "other" } : {}), ...(mode === "failed" ? { fetchStatus: "failed" as const } : {}),
      ...(mode === "blank" ? { bodyText: " " } : {}) };
  });
  await expect(h.load()).resolves.toBeNull();
});

test.each(["message-revoked", "document-revoked", "group-stopped"])("discards restored text when %s during the read", async mode => {
  const h = harness([issue([mode === "document-revoked" ? docSource : oldSource])]);
  h.readMessagesByIds.mockImplementation(async () => { mode === "group-stopped" ? h.stopReading() : h.revoke(); return [old]; });
  h.findSnapshotById.mockImplementation(async () => { h.revoke(); return snapshot; });
  await expect(h.load()).resolves.toBeNull();
});

test("does not read text from an issue denied before restoration", async () => {
  const h = harness([issue([docSource])]);
  h.verify.mockImplementation(async ({ sources }) => !sources.some(source => source.ref === docSource.ref));
  expect((await h.load())!.issues).toEqual([]);
  expect(h.findSnapshotById).not.toHaveBeenCalled();
});

test("keeps restored originals within the shared text budget and per-document cap", async () => {
  const messages = Array.from({ length: 9 }, (_, index) => ({ ...old, messageId: `long-${index}`, text: "原".repeat(8000) }));
  const h = harness([issue([...messages.map(messageSource), docSource])]);
  h.readMessagesByIds.mockImplementation(async ({ messageIds }) => messages.filter(message => messageIds.includes(message.messageId)));
  h.findSnapshotById.mockResolvedValue({ ...snapshot, bodyText: "文".repeat(9000) });
  const context = (await h.load())!;
  expect(context.items).toHaveLength(11);
  expect(context.items.reduce((total, item) => total + item.text.length, 0)).toBeLessThanOrEqual(24000);
  expect(context.items.find(item => item.ref === docSource.ref)!.text.length).toBeLessThanOrEqual(1200);
});
