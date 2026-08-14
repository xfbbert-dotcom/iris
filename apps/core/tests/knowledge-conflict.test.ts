import { describe, expect, expectTypeOf, it } from "vitest";

import {
  KnowledgeConflictValidationError,
  parseKnowledgeConflictPlan,
  type KnowledgeConflictEvidenceReference,
} from "../src/knowledge-conflicts/knowledge-conflict.js";

const fullyReferencedConflict = {
  outcome: "conflict",
  subject: "Expense approval threshold",
  knowledgeBaseStatement: "Director approval starts at CNY 5,000.",
  knowledgeBaseCitationRefs: ["D1"],
  groupConclusionStatement: "Director approval now starts at CNY 10,000.",
  groupCitationRefs: ["M1", "C1"],
  difference: "The approval threshold differs.",
  suggestedUpdate: "Replace CNY 5,000 with CNY 10,000.",
  targetDocumentRef: "D1",
  missingEvidence: [],
  confidence: "high",
} as const;

describe("parseKnowledgeConflictPlan", () => {
  it("assigns C refs only to messages, M1 only to memory, and D refs only to documents", () => {
    type MessageEvidence = Extract<
      KnowledgeConflictEvidenceReference,
      { type: "conversation_message" }
    >;
    type MemoryEvidence = Extract<KnowledgeConflictEvidenceReference, { type: "group_memory" }>;
    type DocumentEvidence = Extract<
      KnowledgeConflictEvidenceReference,
      { type: "document_source" | "document_snapshot" | "document_fragment" }
    >;

    expectTypeOf<MessageEvidence["referenceId"]>()
      .toEqualTypeOf<`C${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10}`>();
    expectTypeOf<MemoryEvidence["referenceId"]>().toEqualTypeOf<"M1">();
    expectTypeOf<DocumentEvidence["referenceId"]>()
      .toEqualTypeOf<`D${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12}`>();

    expect(() => parseKnowledgeConflictPlan(
      conflictJson({ groupCitationRefs: ["M1", "D1"] }),
      new Set(["M1", "D1"]),
    )).toThrow(KnowledgeConflictValidationError);
    expect(() => parseKnowledgeConflictPlan(
      conflictJson({ groupCitationRefs: ["M2", "C1"] }),
      new Set(["M2", "C1", "D1"]),
    )).toThrow(KnowledgeConflictValidationError);
  });

  it("accepts a fully referenced conflict plan", () => {
    expect(parseKnowledgeConflictPlan(
      JSON.stringify(fullyReferencedConflict),
      new Set(["M1", "C1", "D1"]),
    )).toMatchObject({ outcome: "conflict" });
  });

  it("rejects conflict without a source-message reference", () => {
    expect(() => parseKnowledgeConflictPlan(
      conflictJson({ groupCitationRefs: ["M1"] }),
      new Set(["M1", "D1"]),
    )).toThrow("source-message");
  });

  it("rejects conflict without the exact group-memory reference", () => {
    expect(() => parseKnowledgeConflictPlan(
      conflictJson({ groupCitationRefs: ["C1"] }),
      new Set(["C1", "D1"]),
    )).toThrow("group-memory");
  });

  it("normalizes bounded strings and returns unique sorted references", () => {
    const parsed = parseKnowledgeConflictPlan(conflictJson({
      subject: "  Cafe\u0301 policy  ",
      knowledgeBaseCitationRefs: ["D2", "D1"],
      groupCitationRefs: ["M1", "C2", "C1"],
      targetDocumentRef: "D1",
    }), new Set(["M1", "C1", "C2", "D1", "D2"]));

    expect(parsed.subject).toBe("Caf\u00e9 policy");
    expect(parsed.knowledgeBaseCitationRefs).toEqual(["D1", "D2"]);
    expect(parsed.groupCitationRefs).toEqual(["C1", "C2", "M1"]);
  });

  it.each([
    ["duplicate references", { knowledgeBaseCitationRefs: ["D1", "D1"] }],
    ["unknown references", { knowledgeBaseCitationRefs: ["D2"] }],
    ["invalid reference kinds", { knowledgeBaseCitationRefs: ["C1"] }],
    ["unreferenced target", { targetDocumentRef: "D2" }],
    ["low confidence", { confidence: "low" }],
  ])("rejects conflict with %s", (_label, override) => {
    expect(() => parseKnowledgeConflictPlan(
      conflictJson(override),
      new Set(["M1", "C1", "D1"]),
    )).toThrow(KnowledgeConflictValidationError);
  });

  it("rejects extra fields instead of silently accepting contract drift", () => {
    expect(() => parseKnowledgeConflictPlan(
      conflictJson({ explanation: "raw model prose" }),
      new Set(["M1", "C1", "D1"]),
    )).toThrow("exact fields");
  });

  it.each(["no_conflict", "insufficient_evidence"] as const)(
    "rejects %s plans that contain an update proposal",
    (outcome) => {
      expect(() => parseKnowledgeConflictPlan(JSON.stringify({
        ...fullyReferencedConflict,
        outcome,
      }), new Set(["M1", "C1", "D1"]))).toThrow("must not contain");
    },
  );

  it("accepts an insufficient-evidence plan with content-free missing evidence codes", () => {
    expect(parseKnowledgeConflictPlan(JSON.stringify({
      outcome: "insufficient_evidence",
      subject: "Expense approval threshold",
      knowledgeBaseStatement: null,
      knowledgeBaseCitationRefs: [],
      groupConclusionStatement: "Director approval now starts at CNY 10,000.",
      groupCitationRefs: ["M1", "C1"],
      difference: null,
      suggestedUpdate: null,
      targetDocumentRef: null,
      missingEvidence: ["knowledge_base_statement"],
      confidence: "low",
    }), new Set(["M1", "C1"]))).toMatchObject({
      outcome: "insufficient_evidence",
      missingEvidence: ["knowledge_base_statement"],
    });
  });
});

function conflictJson(overrides: Record<string, unknown>): string {
  return JSON.stringify({ ...fullyReferencedConflict, ...overrides });
}
