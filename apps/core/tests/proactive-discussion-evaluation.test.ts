import { expect, test, vi } from "vitest";
import { createPdEvaluationWorker } from "../src/proactive-discussion/evaluation-worker.js";
import { pdAssessment, pdContext, pdContextWithIssue, pdSkipAssessment } from "./fixtures/proactive-discussion.js";
import type { PdRepository } from "../src/proactive-discussion/repository.js";
import type { PdJob } from "../src/proactive-discussion/contracts.js";
import type { FeishuChatHistoryMessage } from "../src/feishu/feishu-chat-history-reader.js";
import { hashLocalMessageText } from "../src/memory/local-message-source.js";

test.each(["accepted", "rejected"] as const)("%s joint review commits the final pair or only the blocked candidate audit", async outcome => {
  const context = pdContext();
  const at = new Date("2026-09-14T00:00:00Z");
  const job: PdJob = { id: "job", chatId: context.chatId, messageId: "m2", contentHash: "a".repeat(64),
    policyVersion: 1, leaseToken: "lease", attempt: 1, purpose: "assessment" };
  const candidate = { ...pdAssessment(), reasoning: "预算缺口会导致项目失败。" };
  const reviewed = { assessment: { ...candidate,
    observation: "两人各 8 万共 16 万，当前预算 10 万。", reasoning: "预算相差 6 万，可能影响招聘计划。",
    suggestion: "建议先确认能否追加 6 万预算。", uncertainty: "qualified_inference" as const },
  draft: { text: "两人共 16 万，比预算多 6 万，可能影响招聘计划，建议先确认能否追加预算。", evidenceRefs: candidate.evidenceRefs } };
  const committed: Parameters<PdRepository["commitEvaluation"]>[0][] = [];
  const failures: Parameters<PdRepository["failEvaluation"]>[0][] = [];
  const repository = { claimEvaluation: async () => job,
    commitEvaluation: async (input: Parameters<PdRepository["commitEvaluation"]>[0]) => {
      committed.push(input); return outcome === "accepted" ? "prepared" : "blocked";
    },
    failEvaluation: async (input: Parameters<PdRepository["failEvaluation"]>[0]) => { failures.push(input); },
  } as unknown as PdRepository;
  const render = vi.fn(async () => outcome === "accepted" ? reviewed : null);
  const worker = createPdEvaluationWorker({ repository, contextBuilder: { load: async () => context },
    model: { assess: async () => candidate, render },
    membership: { isCurrentMember: async () => false }, reader: { listRecentMessages: async () => [] },
    now: () => at, workerId: "joint-review" });

  expect(await worker.runOnce()).toBe("processed");
  expect(render).toHaveBeenCalledOnce();
  expect(render).toHaveBeenCalledWith({ context, assessment: candidate }, expect.any(Function));
  expect(committed).toEqual([{ job, context, at,
    assessment: outcome === "accepted" ? reviewed.assessment : candidate,
    draft: outcome === "accepted" ? reviewed.draft : null }]);
  expect(failures).toEqual([]);
});

test("skip assessment completes its job without calling prose rendering", async () => {
  const context = pdContext();
  const job = { id: "job", chatId: context.chatId, messageId: "m2", contentHash: "a".repeat(64),
    policyVersion: 1, leaseToken: "lease", attempt: 1, purpose: "assessment" as const };
  const committed: unknown[] = [];
  const repository = { claimEvaluation: async () => job,
    commitEvaluation: async (input: unknown) => { committed.push(input); return "skipped"; },
    failEvaluation: async () => { throw new Error("unexpected failure"); },
  } as unknown as PdRepository;
  const render = vi.fn(async () => { throw new Error("skip must never render"); });
  const worker = createPdEvaluationWorker({ repository, contextBuilder: { load: async () => context },
    model: { assess: async () => pdSkipAssessment(), render },
    membership: { isCurrentMember: async () => false }, reader: { listRecentMessages: async () => [] },
    now: () => new Date("2026-09-14T00:00:00Z"), workerId: "evaluation" });
  expect(await worker.runOnce()).toBe("processed");
  expect(render).toHaveBeenCalledTimes(0);
  expect(committed).toHaveLength(1);
  expect(committed[0]).toMatchObject({ job, context, assessment: { decision: "skip" }, draft: null });
});

function feedbackHarness(messageOverrides: Partial<FeishuChatHistoryMessage> = {}) {
  const context = pdContextWithIssue();
  const now = new Date("2026-09-14T00:00:00Z");
  const job: PdJob = { id: "job", chatId: context.chatId, messageId: "feedback", contentHash: hashLocalMessageText("不再跟进这件事"),
    policyVersion: 1, leaseToken: "lease", attempt: 1, purpose: "feedback",
    feedback: { action: "pause", replyMessageId: "sent-reply", actorOpenId: "human" } };
  const events: string[] = [];
  const applied: unknown[] = [];
  const failures: unknown[] = [];
  const repository = { claimEvaluation: async () => job,
    findIssueByReply: async () => { events.push("receipt"); return context.issues[0]!; },
    applyFeedback: async (input: unknown) => { applied.push(input); events.push("apply"); return "applied"; },
    failEvaluation: async (input: unknown) => { failures.push(input); },
  } as unknown as PdRepository;
  const reader = { listRecentMessages: async () => [], readMessagesByIds: async () => {
    events.push("fresh");
    return [{ messageId: "feedback", chatId: context.chatId, senderId: "human", text: "不再跟进这件事",
      sentAt: now, parentMessageId: "sent-reply", rootMessageId: "older-thread", ...messageOverrides }];
  } };
  const membership = { isCurrentMember: async () => { events.push("member"); return true; } };
  const worker = () => createPdEvaluationWorker({ repository, reader, membership,
    contextBuilder: { load: async () => { throw new Error("feedback must not load assessment"); } },
    model: { assess: async () => { throw new Error("feedback must not assess"); }, render: async () => { throw new Error("feedback must not render"); } },
    now: () => now, workerId: "feedback" });
  return { context, job, events, applied, failures, repository, membership, reader, worker };
}

test("feedback fresh source then sent receipt then current member bind one issue version", async () => {
  const h = feedbackHarness();
  expect(await h.worker().runOnce()).toBe("processed");
  expect(h.events).toEqual(["fresh", "receipt", "member", "apply"]);
  expect(h.applied).toHaveLength(1);
  expect(h.applied[0]).toMatchObject({ action: "pause", issueId: "issue-1", expectedIssueVersion: 1,
    verifiedReplyMessageId: "sent-reply", actorOpenId: "human",
    verifiedMessage: { chatId: h.job.chatId, messageId: "feedback", contentHash: hashLocalMessageText("不再跟进这件事") } });
});

test("verified ingress Iris mention proof survives exact fresh body validation", async () => {
  const h = feedbackHarness({ text: "@_user_1 不再跟进这件事" });
  h.job.contentHash = hashLocalMessageText("@_user_1 不再跟进这件事");
  h.job.feedback = { ...h.job.feedback!, irisMentionKey: "@_user_1" };
  expect(await h.worker().runOnce()).toBe("processed");
  expect(h.applied).toHaveLength(1);
  expect(h.applied[0]).toMatchObject({ verifiedMessage: { contentHash: h.job.contentHash } });
});

test.each(["@Iris 不再跟进这件事", "@_user_10 不再跟进这件事", "他说 @_user_1 不再跟进这件事"])("unproved mention or quote cannot turn into feedback: %s", async text => {
  const h = feedbackHarness({ text });
  h.job.contentHash = hashLocalMessageText(text);
  h.job.feedback = { ...h.job.feedback!, irisMentionKey: "@_user_1" };
  await h.worker().runOnce();
  expect(h.applied).toEqual([]);
  expect(h.failures).toEqual([expect.objectContaining({ reason: "feedback_blocked", retryable: false })]);
});

test("membership transport failure retains technical retry rather than rejecting the user's stop", async () => {
  const h = feedbackHarness();
  h.membership.isCurrentMember = async () => { throw new Error("private upstream secret"); };
  expect(await h.worker().runOnce()).toBe("failed");
  expect(h.applied).toEqual([]);
  expect(h.failures).toEqual([expect.objectContaining({ reason: "evaluation_failed", retryable: true })]);
});

test.each([
  { chatId: "other" }, { senderId: "forger" }, { messageId: "other" }, { text: "他说：不再跟进这件事" },
  { parentMessageId: "unrelated", rootMessageId: "sent-reply" }, { role: "assistant" as const },
  { parentMessageId: undefined, rootMessageId: undefined },
])("forged or indirect feedback is blocked: %j", async overrides => {
  const h = feedbackHarness(overrides);
  await h.worker().runOnce();
  expect(h.applied).toEqual([]);
  expect(h.failures).toEqual([expect.objectContaining({ reason: "feedback_blocked", retryable: false })]);
  expect(h.events).toEqual(["fresh"]);
});

test("feedback rejects lost membership and missing real receipt", async () => {
  const h = feedbackHarness();
  h.membership.isCurrentMember = async () => false;
  await h.worker().runOnce();
  expect(h.applied).toEqual([]);
  expect(h.failures).toHaveLength(1);
  h.repository.findIssueByReply = async () => null;
  await h.worker().runOnce();
  expect(h.applied).toEqual([]);
  expect(h.failures).toHaveLength(2);
});

test("null context releases the same job and a model failure does not stop subsequent work", async () => {
  const context = pdContext();
  const jobs = [1, 2, 3].map(index => ({ id: `job-${index}`, chatId: context.chatId, messageId: "m2", contentHash: "a".repeat(64),
    policyVersion: 1, leaseToken: `lease-${index}`, attempt: 1, purpose: "assessment" as const }));
  const requeued: string[] = [], failed: string[] = [], completed: string[] = [];
  const repository = { claimEvaluation: async () => jobs.shift() ?? null,
    requeueEvaluation: async ({ job }: { job: PdJob }) => { requeued.push(job.id); },
    failEvaluation: async ({ job }: { job: PdJob }) => { failed.push(job.id); },
    commitEvaluation: async ({ job }: { job: PdJob }) => { completed.push(job.id); return "prepared"; },
  } as unknown as PdRepository;
  let attempts = 0;
  const worker = createPdEvaluationWorker({ repository,
    contextBuilder: { load: async job => job.id === "job-1" ? null : context },
    model: { assess: async () => { if (++attempts === 1) throw new Error("model offline"); return pdAssessment(); },
      render: async ({ assessment }) => ({ assessment, draft: { text: "先核对预算。", evidenceRefs: assessment.evidenceRefs } }) },
    membership: { isCurrentMember: async () => false }, reader: { listRecentMessages: async () => [] },
    now: () => new Date("2026-09-14T00:00:00Z"), workerId: "isolated" });
  expect(await worker.runOnce()).toBe("processed");
  expect(await worker.runOnce()).toBe("failed");
  expect(await worker.runOnce()).toBe("processed");
  expect(await worker.runOnce()).toBe("idle");
  expect(requeued).toEqual(["job-1"]);
  expect(failed).toEqual(["job-2"]);
  expect(completed).toEqual(["job-3"]);
});

test("a failed claim or failed failure-record write returns failed and leaves durable lease recovery possible", async () => {
  const context = pdContext();
  let unavailable = true;
  const repository = { claimEvaluation: async () => {
    if (unavailable) throw new Error("database temporarily unavailable");
    return { id: "job", chatId: context.chatId, messageId: "m2", contentHash: "a".repeat(64),
      policyVersion: 1, leaseToken: "lease", attempt: 1, purpose: "assessment" as const };
  }, failEvaluation: async () => { throw new Error("cannot write retry state"); } } as unknown as PdRepository;
  const worker = createPdEvaluationWorker({ repository, contextBuilder: { load: async () => context },
    model: { assess: async () => { throw new Error("model failed"); }, render: async () => null },
    membership: { isCurrentMember: async () => false }, reader: { listRecentMessages: async () => [] },
    now: () => new Date("2026-09-14T00:00:00Z"), workerId: "worker" });
  expect(await worker.runOnce()).toBe("failed");
  unavailable = false;
  expect(await worker.runOnce()).toBe("failed");
});

test("default heartbeat renews slow in-flight model work and releases its timer after commit", async () => {
  vi.useFakeTimers();
  try {
    const context = pdContext();
    let until = 0, committed = false;
    const job: PdJob = { id: "slow", chatId: context.chatId, messageId: "m2", contentHash: "a".repeat(64),
      policyVersion: 1, leaseToken: "owner", attempt: 1, purpose: "assessment" };
    const repository = { claimEvaluation: async (input: { leaseUntil: Date }) => { until = input.leaseUntil.getTime(); return job; },
      renewEvaluation: async (input: { at: Date; leaseUntil: Date }) => { if (input.at.getTime() >= until) return false; until = input.leaseUntil.getTime(); return true; },
      commitEvaluation: async () => { if (Date.now() >= until) return "lease_lost"; committed = true; return "prepared"; },
      failEvaluation: async () => undefined,
    } as unknown as PdRepository;
    const delay = () => new Promise<void>(resolve => setTimeout(resolve, 25_000));
    const worker = createPdEvaluationWorker({ repository, contextBuilder: { load: async () => context },
      model: { assess: async () => { await delay(); return pdAssessment(); }, render: async ({ assessment }, active) => {
        await delay(); await active?.(); await delay(); return { assessment, draft: { text: "核对预算", evidenceRefs: assessment.evidenceRefs } }; } },
      membership: { isCurrentMember: async () => false }, reader: { listRecentMessages: async () => [] }, now: () => new Date(), workerId: "slow" });
    const result = worker.runOnce();
    await vi.advanceTimersByTimeAsync(75_000);
    expect(await result).toBe("processed"); expect(committed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

test.each(["lease_lost", "stale"])("commit %s is reported distinctly from an owned context requeue", async result => {
  const context = pdContext();
  const repository = { claimEvaluation: async () => ({ id: "job", chatId: context.chatId, messageId: "m2", contentHash: "a".repeat(64),
    policyVersion: 1, leaseToken: "lease", attempt: 1, purpose: "assessment" }), commitEvaluation: async () => result } as unknown as PdRepository;
  const worker = createPdEvaluationWorker({ repository, contextBuilder: { load: async () => context },
    model: { assess: async () => pdSkipAssessment(), render: async () => null }, membership: { isCurrentMember: async () => false },
    reader: { listRecentMessages: async () => [] }, now: () => new Date(), workerId: "w" });
  expect(await worker.runOnce()).toBe(result === "lease_lost" ? "failed" : "processed");
});
