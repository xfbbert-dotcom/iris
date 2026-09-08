import { describe, expect, it } from "vitest";
import { createAnswerDraftOrchestrator } from "../src/agent/answer-draft-orchestrator.js";
import { assemblePromptContext } from "../src/memory/context-assembly.js";
import { createOpenAICompatibleEvidencePlanner, type EvidencePlanningInput } from "../src/model/openai-compatible-evidence-planner.js";
import { createOpenAICompatibleGroundedAnswerRenderer, type GroundedAnswerRenderInput } from "../src/model/openai-compatible-grounded-answer-renderer.js";
import type { OpenAICompatibleChatMessage } from "../src/model/openai-compatible-chat-completions-client.js";

const directPlan = { taskMode: "direct_task", evidenceState: null, premises: [], proposedAnswer: null, missingInformation: [], confidence: null };
const groundedPlan = { taskMode: "company_fact", evidenceState: "complete_inference", premises: [{ citationRef: "C1", statement: "原文末节要求记录回访意愿。" }], proposedAnswer: "新增回访意愿有助于后续访谈。", missingInformation: [], confidence: "medium" };

function fixture(input: { direct?: boolean; onPlanner?: (payload: EvidencePlanningInput) => void; onRenderer?: (payload: GroundedAnswerRenderInput) => void; denied?: boolean; citedSourceRefs?: string[] } = {}) {
  return createAnswerDraftOrchestrator({
    contextBuilder: { async buildContext(request) {
      return {
        promptContext: assemblePromptContext({ backgroundDocuments: [], liveChatMessages: request.liveChatMessages }),
        liveChatMessages: request.liveChatMessages,
        allowedFragments: [], deniedDocumentIds: input.denied ? ["revoked-original"] : [], retrievedFragmentCount: 0, usedGroupMemories: [],
      };
    } },
    planner: createOpenAICompatibleEvidencePlanner({ client: { async complete(messages) {
      input.onPlanner?.(JSON.parse(messages[1]!.content));
      return JSON.stringify(input.direct ? directPlan : groundedPlan);
    } } }),
    renderer: createOpenAICompatibleGroundedAnswerRenderer({ client: { async complete(messages) {
      input.onRenderer?.(JSON.parse(messages[1]!.content));
      return JSON.stringify({ answerText: "根据原文推断，新增回访意愿有助于后续访谈。", evidenceState: "complete_inference", confidence: "medium" });
    } } }),
    model: { async generateAnswerDraft(request) {
      return { answerText: request.question.includes("改短") ? request.promptContext : "开放式问题允许自由回答，封闭式问题提供固定选项。", citedSourceRefs: input.citedSourceRefs };
    } },
  });
}

describe("continuous dialogue through the real planner and orchestrator", () => {
  it("executes the semantic direct_task union for ordinary knowledge", async () => {
    const result = await fixture({ direct: true }).generateDraft({ question: "开放式问题和封闭式问题有什么区别？", liveChatMessages: [] });
    expect(result.answerText).toBe("开放式问题允许自由回答，封闭式问题提供固定选项。");
  });

  it("retains authorized assistant text for a contextual rewrite without making it Cn evidence", async () => {
    let payload!: EvidencePlanningInput;
    const result = await fixture({ direct: true, onPlanner: (value) => { payload = value; } }).generateDraft({
      question: "把上一条改短一点", liveChatMessages: [{ speaker: "Iris", role: "assistant", text: "先问使用场景，再问满意度，最后问改进建议。" }],
    });
    expect(payload.evidence).toEqual([]);
    expect(payload.liveChatMessages[0]!.role).toBe("assistant");
    expect(result.answerText).toContain('role="assistant"');
    expect(result.answerText).toContain("先问使用场景");
  });

  it("passes the later section of a 4600-character original through context, planner and renderer", async () => {
    const witness = "末节见证：记录回访意愿";
    const text = "问卷原文" + "内".repeat(4600 - 4 - witness.length) + witness;
    let planning!: EvidencePlanningInput;
    let rendering!: GroundedAnswerRenderInput;
    const result = await fixture({ onPlanner: (value) => { planning = value; }, onRenderer: (value) => { rendering = value; } }).generateDraft({
      question: "分析这份问卷的访谈价值", liveChatMessages: [{ speaker: "Alice", text }],
    });
    expect(result.promptContext).toContain(witness);
    expect(planning.evidence[0]!.text).toContain(witness);
    expect(rendering.evidence[0]!.text).toContain(witness);
    expect(result.answerText).toContain("回访意愿");
  });

  it("bounds all planner live bodies together to 24000 characters and marks clipping", async () => {
    let payload!: EvidencePlanningInput;
    await fixture({ onPlanner: (value) => { payload = value; } }).generateDraft({
      question: "分析问卷的访谈价值",
      liveChatMessages: Array.from({ length: 10 }, (_, index) => ({ speaker: "Alice", text: `问卷${index}：${"内容".repeat(5000)}` })),
    });
    const texts = [...payload.evidence.filter((item) => /^C\d+$/u.test(item.citationRef)).map((item) => item.text), ...payload.liveChatMessages.map((item) => item.text)];
    expect(texts.reduce((sum, text) => sum + text.length, 0)).toBeLessThanOrEqual(24000);
    expect(texts.every((text) => text.length <= 8000)).toBe(true);
    expect(texts.join("")).toContain("[truncated]");
  });

  it("keeps a denied original blocked before semantic direct execution", async () => {
    const result = await fixture({ direct: true, denied: true }).generateDraft({ question: "把上一条改短一点", liveChatMessages: [] });
    expect(result.answerText).toBe("Answer withheld by the live permission guard.");
  });

  it("rejects a semantic direct answer citation outside its authorized prompt", async () => {
    await expect(fixture({ direct: true, citedSourceRefs: ["D1"] }).generateDraft({ question: "开放式问题和封闭式问题有什么区别？", liveChatMessages: [] })).rejects.toThrow("outside the allowed prompt window");
  });

  it("keeps background document item text at 1200 characters", async () => {
    const planner = createOpenAICompatibleEvidencePlanner({ client: { async complete(_messages: readonly OpenAICompatibleChatMessage[]) { return JSON.stringify(directPlan); } } });
    await expect(planner.plan({ question: "解释", evidence: [{ citationRef: "D1", source: "doc", text: "文".repeat(1201) }], liveChatMessages: [] })).rejects.toThrow("at most 1200");
  });
});
