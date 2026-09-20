import {
  createPdSourceRef,
  type PdAssessment,
  type PdContext,
  type PdIssue,
} from "../../src/proactive-discussion/contracts.js";
import { hashLocalMessageText } from "../../src/memory/local-message-source.js";

export const PILOT_CHAT = "oc_637a9aca45f01943477f4e17f1fc5b9a";
export function pdReviewFieldChecks() {
  return {
    issueRef: { supported: true, reason: "问题描述仍指向材料中的预算与招聘计划。" },
    observation: { supported: true, reason: "观察保留材料事实及原有数值口径。" },
    reasoning: { supported: true, reason: "理由区分直接算术与有条件的影响判断。" },
    suggestion: { supported: true, reason: "建议是核实或调整，没有声称已经执行。" },
    uncertainty: { supported: true, reason: "判断类别与事实或限定推断一致。" },
    materialChange: { supported: true, reason: "变化说明仍在解释当前同一问题的依据。" },
  };
}

export function pdContext(): PdContext {
  const messages = [{ messageId: "m1", text: "预算只有 10 万" }, { messageId: "m2", text: "按每人 8 万招两人，预算够" }];
  const sources = messages.map(({ messageId, text }) => {
    const binding = { chatId: PILOT_CHAT, messageId, contentHash: hashLocalMessageText(text) };
    return { kind: "message" as const, ref: createPdSourceRef({ kind: "message", binding }), binding };
  });
  return { chatId: PILOT_CHAT, triggerMessageId: "m2", policy: {
    chatId: PILOT_CHAT, version: 1, enabled: true, operatorId: "test-operator",
  }, contextVersion: 1, catalogVersion: 1, sources,
  items: messages.map((message, index) => ({ ref: sources[index]!.ref, text: message.text })), issues: [] };
}
export function pdAssessment(): PdAssessment {
  const refs = pdContext().sources.map(source => source.ref);
  return { decision: "intervene", reason: "material_issue", issueRef: { kind: "new", description: "招聘预算不足" },
    evidenceRefs: refs, observation: "预算为 10 万，两人各 8 万合计 16 万。", reasoning: "总费用超过预算 6 万。",
    suggestion: "建议先确认是否有追加预算，再确定招聘人数。", uncertainty: "fact",
    materialChange: { kind: "new_issue", explanation: "发现预算与招聘成本矛盾。", evidenceRefs: refs } };
}

export function pdSkipAssessment(
  reason: Exclude<PdAssessment["reason"], "material_issue"> = "no_work_value",
): PdAssessment {
  return {
    decision: "skip",
    reason,
    issueRef: null,
    evidenceRefs: [],
    observation: "",
    reasoning: "",
    suggestion: "",
    uncertainty: "fact",
    materialChange: { kind: "none", explanation: "", evidenceRefs: [] },
  };
}

export function pdContextWithIssue(
  issueOverrides: Partial<PdIssue> = {},
): PdContext {
  const context = pdContext();
  const issue: PdIssue = {
    id: "issue-1",
    chatId: context.chatId,
    description: "招聘预算不足",
    state: "surfaced",
    version: 1,
    basisVersion: 1,
    lastObservation: "预算和招聘计划可能不匹配。",
    lastReasoning: "现有计划可能超过预算。",
    lastSuggestion: "核对招聘总成本。",
    basisSources: [context.sources[0]!],
    proseSources: [context.sources[0]!],
    canReassessUnattempted: false,
    hasUnknownDelivery: false,
    ...issueOverrides,
  };
  return { ...context, issues: [issue] };
}
