import { describe, expect, it } from "vitest";

import {
  EvidencePlanValidationError,
  citedRefsForEvidencePlan,
  createConflictEvidencePlan,
  parseEvidencePlanContent,
} from "../src/agent/evidence-plan.js";

describe("createConflictEvidencePlan", () => {
  it("creates conflict only through an exact candidate-bound deterministic wrapper", () => {
    expect(createConflictEvidencePlan({
      candidateId: "candidate-1",
      knowledgePremise: {
        citationRef: "D1",
        statement: "Current KB threshold is 5,000.",
      },
      groupPremise: {
        citationRef: "M1",
        statement: "New group threshold is 10,000.",
      },
      proposedAnswer:
        "Possible conflict: the KB says 5,000; the newer group conclusion says 10,000.",
      confidence: "high",
    })).toEqual({
      candidateId: "candidate-1",
      plan: {
        taskMode: "company_fact",
        evidenceState: "conflict",
        premises: [
          { citationRef: "M1", statement: "New group threshold is 10,000." },
          { citationRef: "D1", statement: "Current KB threshold is 5,000." },
        ],
        proposedAnswer:
          "Possible conflict: the KB says 5,000; the newer group conclusion says 10,000.",
        missingInformation: [],
        confidence: "high",
      },
    });
  });

  it.each([
    ["blank candidate", { candidateId: " " }],
    ["non-document premise", { knowledgePremise: { citationRef: "M2", statement: "KB" } }],
    ["non-group premise", { groupPremise: { citationRef: "D2", statement: "Group" } }],
    ["low confidence", { confidence: "low" }],
    ["blank explanation", { proposedAnswer: " " }],
  ])("rejects %s", (_label, override) => {
    expect(() => createConflictEvidencePlan({
      candidateId: "candidate-1",
      knowledgePremise: { citationRef: "D1", statement: "KB" },
      groupPremise: { citationRef: "M1", statement: "Group" },
      proposedAnswer: "Possible conflict.",
      confidence: "medium",
      ...override,
    } as Parameters<typeof createConflictEvidencePlan>[0])).toThrow(EvidencePlanValidationError);
  });
});

describe("parseEvidencePlanContent", () => {
  it.each([
    ["explicit", "high", []],
    ["complete_inference", "medium", []],
    ["partial", "low", ["Missing mechanism detail"]],
  ] as const)("accepts a valid %s company-fact plan", (
    evidenceState,
    confidence,
    missingInformation,
  ) => {
    const plan = parseEvidencePlanContent(JSON.stringify({
      taskMode: "company_fact",
      evidenceState,
      premises: [{ citationRef: "D1", statement: "Supported premise" }],
      proposedAnswer: "Bounded answer",
      missingInformation,
      confidence,
    }), ["D1"]);

    expect(plan).toEqual({
      taskMode: "company_fact",
      evidenceState,
      premises: [{ citationRef: "D1", statement: "Supported premise" }],
      proposedAnswer: "Bounded answer",
      missingInformation: [...missingInformation],
      confidence,
    });
  });

  it("accepts direct tasks without evidence classification", () => {
    expect(parseEvidencePlanContent(JSON.stringify({
      taskMode: "direct_task",
      evidenceState: null,
      premises: [],
      proposedAnswer: null,
      missingInformation: [],
      confidence: null,
    }), [])).toEqual({
      taskMode: "direct_task",
      evidenceState: null,
      premises: [],
      proposedAnswer: null,
      missingInformation: [],
      confidence: null,
    });
  });

  it("accepts no-evidence plans only without a company-factual answer", () => {
    expect(parseEvidencePlanContent(JSON.stringify({
      taskMode: "company_fact",
      evidenceState: "none",
      premises: [],
      proposedAnswer: null,
      missingInformation: ["Relevant product documentation"],
      confidence: "low",
    }), [])).toEqual(expect.objectContaining({
      evidenceState: "none",
      proposedAnswer: null,
    }));
  });

  it("rejects model-originated conflict state", () => {
    expect(() => parseEvidencePlanContent(JSON.stringify({
      taskMode: "company_fact",
      evidenceState: "conflict",
      premises: [
        { citationRef: "M1", statement: "New group conclusion" },
        { citationRef: "D1", statement: "Current KB statement" },
      ],
      proposedAnswer: "Possible conflict.",
      missingInformation: [],
      confidence: "high",
    }), ["M1", "D1"])).toThrow("evidence plan state is invalid");
  });

  it("rejects partial conjecture without a real allowed premise", () => {
    expect(() => parseEvidencePlanContent(JSON.stringify({
      taskMode: "company_fact",
      evidenceState: "partial",
      premises: [{ citationRef: "D9", statement: "Invented" }],
      proposedAnswer: "Guess",
      missingInformation: ["Evidence"],
      confidence: "low",
    }), ["D1"])).toThrow("evidence plan citation reference is not allowed");
  });

  it("rejects partial evidence marked as high confidence", () => {
    expect(() => parseEvidencePlanContent(validPlan({
      evidenceState: "partial",
      missingInformation: ["Exact algorithm"],
      confidence: "high",
    }), ["D1"])).toThrow("partial evidence confidence is invalid");
  });

  it("rejects no-evidence plans that still propose a company fact", () => {
    expect(() => parseEvidencePlanContent(validPlan({
      evidenceState: "none",
      premises: [],
      proposedAnswer: "Invented answer",
      missingInformation: ["All evidence"],
      confidence: "low",
    }), ["D1"])).toThrow("no-evidence plan cannot contain a factual answer");
  });

  it("rejects malformed JSON, unknown fields, duplicate refs, blanks, and oversized text", () => {
    expect(() => parseEvidencePlanContent("{", ["D1"]))
      .toThrow(EvidencePlanValidationError);
    expect(() => parseEvidencePlanContent(validPlan({ extra: true }), ["D1"]))
      .toThrow("evidence plan includes unknown fields");
    expect(() => parseEvidencePlanContent(validPlan({
      premises: [
        { citationRef: "D1", statement: "One" },
        { citationRef: "D1", statement: "Two" },
      ],
    }), ["D1"]))
      .toThrow("evidence plan citation references must be unique");
    expect(() => parseEvidencePlanContent(validPlan({ proposedAnswer: "  " }), ["D1"]))
      .toThrow("evidence plan proposed answer must not be blank");
    expect(() => parseEvidencePlanContent(validPlan({
      premises: [{ citationRef: "D1", statement: "x".repeat(1201) }],
    }), ["D1"]))
      .toThrow("evidence plan premise statement is too long");
  });

  it("returns cited refs once in prompt order", () => {
    const plan = parseEvidencePlanContent(JSON.stringify({
      taskMode: "company_fact",
      evidenceState: "complete_inference",
      premises: [
        { citationRef: "D3", statement: "Third" },
        { citationRef: "D1", statement: "First" },
      ],
      proposedAnswer: "Inference",
      missingInformation: [],
      confidence: "medium",
    }), ["D1", "D2", "D3"]);

    expect(citedRefsForEvidencePlan(plan)).toEqual(["D1", "D3"]);
  });

  it("accepts group-local evidence references and returns them in retrieval order", () => {
    const allowedRefs = ["C1", "M1", "T1", "D1", "A1"];
    const plan = parseEvidencePlanContent(JSON.stringify({
      taskMode: "company_fact",
      evidenceState: "complete_inference",
      premises: [
        { citationRef: "A1", statement: "Action premise" },
        { citationRef: "D1", statement: "Document premise" },
        { citationRef: "T1", statement: "Thread premise" },
        { citationRef: "M1", statement: "Memory premise" },
        { citationRef: "C1", statement: "Chat premise" },
      ],
      proposedAnswer: "Bounded synthesis",
      missingInformation: [],
      confidence: "medium",
    }), allowedRefs);

    expect(citedRefsForEvidencePlan(plan)).toEqual(allowedRefs);
  });
});

function validPlan(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    taskMode: "company_fact",
    evidenceState: "explicit",
    premises: [{ citationRef: "D1", statement: "Supported premise" }],
    proposedAnswer: "Bounded answer",
    missingInformation: [],
    confidence: "high",
    ...overrides,
  });
}
