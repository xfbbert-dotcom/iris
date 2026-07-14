import { describe, expect, it } from "vitest";

import type { ProposedMemoryCandidate } from "../src/memory-extraction/ai-worker-memory-extraction-client.js";
import type { ClaimedMemoryExtractionRun } from "../src/memory-extraction/memory-extraction-repository.js";
import { validateCandidates } from "../src/memory-extraction/memory-candidate-validator.js";

describe("validateCandidates", () => {
  it("accepts a grounded new candidate at the approved confidence threshold", () => {
    expect(
      validateCandidates({
        run: runFixture(),
        candidates: [candidateFixture({ confidence: 0.85 })],
      }),
    ).toEqual({
      accepted: [
        {
          category: "decision",
          content: "Launch is Thursday.",
          importance: 4,
          confidence: 0.85,
          evidenceMessageIds: ["message-1"],
        },
      ],
      proposedCount: 1,
      acceptedCount: 1,
      rejectedCount: 0,
      duplicateCount: 0,
      conflictCount: 0,
      rejectionCodes: [],
    });
  });

  it("rejects confidence below 0.85 regardless of the model relation", () => {
    const result = validateCandidates({
      run: runFixture(),
      candidates: [candidateFixture({ confidence: 0.8499999999999999, relation: "new" })],
    });

    expect(result).toMatchObject({ accepted: [], rejectedCount: 1 });
    expect(result.rejectionCodes).toEqual(["low_confidence"]);
  });

  it("rejects context-only evidence even when the context object claims eligibility", () => {
    const run = runFixture();
    run.contextMessages[0]!.evidenceEligible = true;

    const result = validateCandidates({
      run,
      candidates: [candidateFixture({ evidenceMessageIds: ["context-1"] })],
    });

    expect(result).toMatchObject({ accepted: [], rejectedCount: 1 });
    expect(result.rejectionCodes).toEqual(["invalid_evidence"]);
  });

  it.each([
    ["missing", "missing-message"],
    ["cross-group", "other-group-message"],
  ])("rejects %s evidence", (_name, evidenceId) => {
    const run = runFixture();
    run.evidenceMessages.push({
      ...run.evidenceMessages[0]!,
      id: "other-group-message",
      groupId: "group-2",
    });

    const result = validateCandidates({
      run,
      candidates: [candidateFixture({ evidenceMessageIds: [evidenceId] })],
    });

    expect(result).toMatchObject({ accepted: [], rejectedCount: 1 });
    expect(result.rejectionCodes).toEqual(["invalid_evidence"]);
  });

  it("requires evidence and deduplicates exact valid ids", () => {
    const run = runFixture();
    run.evidenceMessages.push({
      ...run.evidenceMessages[0]!,
      id: "message-2",
      text: "The owner is Mei.",
    });

    expect(
      validateCandidates({
        run,
        candidates: [
          candidateFixture({
            evidenceMessageIds: ["message-2", "message-1", "message-2"],
          }),
        ],
      }).accepted[0]?.evidenceMessageIds,
    ).toEqual(["message-1", "message-2"]);

    const empty = validateCandidates({
      run,
      candidates: [candidateFixture({ evidenceMessageIds: [] })],
    });
    expect(empty.rejectionCodes).toEqual(["invalid_evidence"]);
  });

  it("rejects the whole candidate when any evidence id is invalid", () => {
    const result = validateCandidates({
      run: runFixture(),
      candidates: [candidateFixture({ evidenceMessageIds: ["message-1", "missing"] })],
    });

    expect(result).toMatchObject({ accepted: [], acceptedCount: 0, rejectedCount: 1 });
    expect(result.rejectionCodes).toEqual(["invalid_evidence"]);
  });

  it("records a valid duplicate relation as bounded diagnostics", () => {
    const result = validateCandidates({
      run: runFixture(),
      candidates: [
        candidateFixture({ relation: "duplicate", existingMemoryId: "memory-1" }),
      ],
    });

    expect(result).toMatchObject({
      accepted: [],
      rejectedCount: 1,
      duplicateCount: 1,
      conflictCount: 0,
      rejectionCodes: ["duplicate_relation"],
    });
  });

  it("records a valid conflict relation without automatically correcting memory", () => {
    const result = validateCandidates({
      run: runFixture(),
      candidates: [
        candidateFixture({ relation: "conflict", existingMemoryId: "memory-1" }),
      ],
    });

    expect(result).toMatchObject({
      accepted: [],
      rejectedCount: 1,
      duplicateCount: 0,
      conflictCount: 1,
      rejectionCodes: ["conflict_relation"],
    });
  });

  it.each([
    candidateFixture({ relation: "duplicate", existingMemoryId: "other-memory" }),
    candidateFixture({ relation: "duplicate", existingMemoryId: undefined }),
    candidateFixture({ relation: "conflict", existingMemoryId: undefined }),
    candidateFixture({ relation: "new", existingMemoryId: "memory-1" }),
  ])("rejects an invalid relation reference without trusting its diagnostics", (candidate) => {
    const result = validateCandidates({ run: runFixture(), candidates: [candidate] });

    expect(result).toMatchObject({
      accepted: [],
      rejectedCount: 1,
      duplicateCount: 0,
      conflictCount: 0,
      rejectionCodes: ["invalid_relation_reference"],
    });
  });

  it("rejects exact safely-normalized duplicates presented as new", () => {
    const run = runFixture();
    run.existingMemories[0]!.content = "Launch IS Thursday.";

    const result = validateCandidates({
      run,
      candidates: [candidateFixture({ content: "  launch is Thursday.  " })],
    });

    expect(result).toMatchObject({
      accepted: [],
      rejectedCount: 1,
      duplicateCount: 1,
      rejectionCodes: ["exact_duplicate"],
    });
  });

  it.each([
    ["NBSP persistence trimming", "Launch Plan", "\u00a0launch plan\u00a0"],
    ["canonical accents", "Caf\u00e9", "Cafe\u0301"],
    ["non-ASCII case", "\u00c5NGSTR\u00d6M", "\u00e5ngstr\u00f6m"],
  ])("rejects Unicode-equivalent active-memory duplicates: %s", (_name, existing, proposed) => {
    const run = runFixture();
    run.existingMemories[0]!.content = existing;

    const result = validateCandidates({
      run,
      candidates: [candidateFixture({ content: proposed })],
    });

    expect(result).toMatchObject({
      accepted: [],
      rejectedCount: 1,
      duplicateCount: 1,
      rejectionCodes: ["exact_duplicate"],
    });
  });

  it("does not conflate Unicode compatibility characters during duplicate checks", () => {
    const run = runFixture();
    run.existingMemories[0]!.content = "Project IV ships Thursday.";

    const result = validateCandidates({
      run,
      candidates: [candidateFixture({ content: "Project \u2163 ships Thursday." })],
    });

    expect(result.accepted).toHaveLength(1);
  });

  it.each(["", "   \t\r\n", "\u200b", "\u2066\u2069", "\ud800"])(
    "rejects empty or unsafe invisible content without normalization hiding it: %j",
    (content) => {
      const result = validateCandidates({
        run: runFixture(),
        candidates: [candidateFixture({ content })],
      });

      expect(result).toMatchObject({ accepted: [], rejectedCount: 1 });
      expect(result.rejectionCodes).toEqual(["invalid_content"]);
    },
  );

  it.each([
    ["4000 ASCII code units", "x".repeat(4000), true],
    ["4001 ASCII code units", "x".repeat(4001), false],
    ["2000 surrogate pairs", "\ud83d\ude00".repeat(2000), true],
    ["2001 surrogate pairs", "\ud83d\ude00".repeat(2001), false],
    ["trim before measuring", `  ${"x".repeat(4000)}  `, true],
    ["lone high surrogate", String.fromCharCode(0xd800), false],
    ["lone low surrogate", String.fromCharCode(0xdc00), false],
  ])("uses Group Memory UTF-16 content admission: %s", (_name, content, valid) => {
    const result = validateCandidates({
      run: runFixture(),
      candidates: [candidateFixture({ content })],
    });

    if (valid) {
      expect(result.accepted).toHaveLength(1);
      expect(result.accepted[0]!.content).toBe(content.trim());
    } else {
      expect(result).toMatchObject({ accepted: [], rejectedCount: 1 });
      expect(result.rejectionCodes).toEqual(["invalid_content"]);
    }
  });

  it("preserves trimmed decomposed content instead of persisting the NFC comparison key", () => {
    const content = "  Re\u0301sume\u0301 policy  ";

    const result = validateCandidates({
      run: runFixture(),
      candidates: [candidateFixture({ content })],
    });

    expect(result.accepted[0]!.content).toBe("Re\u0301sume\u0301 policy");
    expect(result.accepted[0]!.content).not.toBe(content.trim().normalize("NFC"));
  });

  it("rejects unknown fields and invalid finite numeric or enum values", () => {
    const invalidCandidates = [
      { ...candidateFixture(), unknown: true },
      { ...candidateFixture(), category: "action" },
      { ...candidateFixture(), importance: 4.5 },
      { ...candidateFixture(), confidence: Number.POSITIVE_INFINITY },
      { ...candidateFixture(), relation: "similar" },
    ] as unknown as ProposedMemoryCandidate[];

    const result = validateCandidates({
      run: runFixture(),
      candidates: invalidCandidates,
    });

    expect(result).toMatchObject({ accepted: [], proposedCount: 5, rejectedCount: 5 });
    expect(result.rejectionCodes).toEqual([
      "invalid_shape",
      "invalid_category",
      "invalid_importance",
      "invalid_confidence",
      "invalid_relation",
    ]);
  });

  it("omits relation metadata, canonicalizes candidates, and does not mutate inputs", () => {
    const run = runFixture();
    run.evidenceMessages.push({
      ...run.evidenceMessages[0]!,
      id: "message-2",
      text: "Ada owns the launch.",
    });
    const candidates = [
      candidateFixture({
        category: "project",
        content: "  Zebra   launch  ",
        evidenceMessageIds: ["message-2", "message-1"],
      }),
      candidateFixture({ category: "decision", content: "Alpha launch" }),
    ];
    const beforeRun = structuredClone(run);
    const beforeCandidates = structuredClone(candidates);

    const result = validateCandidates({ run, candidates });

    expect(result.accepted).toEqual([
      {
        category: "decision",
        content: "Alpha launch",
        importance: 4,
        confidence: 0.95,
        evidenceMessageIds: ["message-1"],
      },
      {
        category: "project",
        content: "Zebra   launch",
        importance: 4,
        confidence: 0.95,
        evidenceMessageIds: ["message-1", "message-2"],
      },
    ]);
    expect(result.accepted.every((item) => !("relation" in item))).toBe(true);
    expect(result.accepted.every((item) => !("existingMemoryId" in item))).toBe(true);
    expect(run).toEqual(beforeRun);
    expect(candidates).toEqual(beforeCandidates);
  });

  it("fails closed with bounded deterministic diagnostics for more than eight candidates", () => {
    const result = validateCandidates({
      run: runFixture(),
      candidates: Array.from({ length: 100 }, (_, index) =>
        candidateFixture({ content: `Candidate ${index}` }),
      ),
    });

    expect(result).toEqual({
      accepted: [],
      proposedCount: 8,
      acceptedCount: 0,
      rejectedCount: 8,
      duplicateCount: 0,
      conflictCount: 0,
      rejectionCodes: ["candidate_count"],
    });
  });

  it("fails closed before scanning a grossly oversized claimed run", () => {
    const run = runFixture();
    run.evidenceMessages = Array.from({ length: 41 }, (_, index) => ({
      ...run.evidenceMessages[0]!,
      id: `message-${index}`,
    }));

    expect(validateCandidates({ run, candidates: [candidateFixture()] })).toEqual({
      accepted: [],
      proposedCount: 1,
      acceptedCount: 0,
      rejectedCount: 1,
      duplicateCount: 0,
      conflictCount: 0,
      rejectionCodes: ["invalid_run"],
    });
  });
});

function candidateFixture(
  overrides: Partial<ProposedMemoryCandidate> = {},
): ProposedMemoryCandidate {
  return {
    category: "decision",
    content: "Launch is Thursday.",
    importance: 4,
    confidence: 0.95,
    evidenceMessageIds: ["message-1"],
    relation: "new",
    ...overrides,
  };
}

function runFixture(): ClaimedMemoryExtractionRun {
  return {
    id: "run-1",
    groupId: "group-1",
    inputFingerprint: "a".repeat(64),
    requestIds: ["request-1"],
    evidenceMessages: [
      {
        id: "message-1",
        groupId: "group-1",
        senderId: "sender-1",
        text: "Launch is Thursday.",
        sentAt: new Date("2026-07-14T00:01:00.000Z"),
        createdAt: new Date("2026-07-14T00:01:01.000Z"),
        evidenceEligible: true,
      },
    ],
    contextMessages: [
      {
        id: "context-1",
        groupId: "group-1",
        senderId: "sender-0",
        text: "Earlier context.",
        sentAt: new Date("2026-07-14T00:00:00.000Z"),
        createdAt: new Date("2026-07-14T00:00:01.000Z"),
        evidenceEligible: false,
      },
    ],
    existingMemories: [
      {
        id: "memory-1",
        category: "project",
        content: "Launch planning is active.",
        updatedAt: new Date("2026-07-13T00:00:00.000Z"),
      },
    ],
  };
}
