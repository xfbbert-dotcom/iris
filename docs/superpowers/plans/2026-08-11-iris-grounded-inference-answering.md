# Iris Grounded-Inference Answering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Iris retrieve coherent same-source knowledge, classify evidence explicitly, and answer with either a supported conclusion or a clearly warned, knowledge-base-grounded conjecture.

**Architecture:** The current question becomes the primary retrieval query and bounded recent chat becomes a lower-weight supplemental query. The application deterministically selects only explicit payload transformations for the direct path. All other turns use a structured company-fact planner over bounded chat, memory, thread, document, and action evidence, followed by a separate grounded-answer renderer and the existing citation and permission delivery path.

**Tech Stack:** TypeScript, Node.js, Vitest 2, PostgreSQL/pgvector, the existing OpenAI-compatible chat-completions API, Docker Compose, and the Feishu pilot runtime.

## 2026-08-12 Review Amendments (Authoritative)

These amendments were added after independent pre-merge review. They supersede any older task
snippet below that conflicts with them:

- Route ownership belongs to the application. Safe literal transformations with a supplied
  delimiter payload, content operations that name an explicit literal object before the delimiter,
  or an explicit exact-output payload may skip planning. Bare requests such as `Please summarize:
  Iris current annual revenue` and `Please list: Iris Q2 customers` remain company-factual. The
  evidence planner schema accepts `company_fact` only, and any provider result containing
  `direct_task` fails closed.
- Planning evidence follows the whitepaper order and uses stable references for prior live chat
  (`C1`-`C10`), group memory (`M1`-`M8`), discussion threads (`T1`-`T6`), documents
  (`D1`-`D12`), and action records (`A1`-`A6`). A plan selects at most 12 premises.
- Prior live chat reaches the planner and renderer only through selected `C*` evidence. Their
  separate `liveChatMessages` inputs are empty, so raw or unselected messages cannot bypass the
  evidence plan.
- Direct tasks receive only the explicit literal task with empty document and live-chat context
  envelopes. A task that requires company context must use the company-fact route.
- Only `D*` references become document citations and enter send-time document permission
  revalidation. Other references remain bounded provenance and never create fake source links.
- Valid long Feishu source URIs are not answer failures. Model-visible source labels are
  deterministically truncated to 512 characters while the stable evidence reference retains
  identity.
- Source-aware selection reserves a bounded leading-source budget before diversity backfill, so
  one-fragment noise sources cannot evict all coherent follow-up fragments from a matched source.
  Immediate neighbors must share the seed fragment's source, snapshot, and embedding profile.
- The original task checklist remains useful implementation history; this amendment and the
  approved design are normative where details differ.

## Global Constraints

- Execute runtime changes in the existing isolated worktree `D:\work\AGE-org\.worktrees\iris-grounded-inference-answering` on branch `codex/iris-grounded-inference-answering`.
- Keep `master@4aaa38bed1bf98a1d4fce5decd025597012cea3f` as the ancestry baseline; the prompt-only commit `a6905bbe33d00bdf71ded76051e2d00fbfb457da` is diagnostic history, not an independently deployable release.
- The current production service stays on the approved rolled-back image until an exact reviewed candidate passes every live-pilot gate.
- Company-factual premises may come only from permission-allowed evidence supplied to the current turn.
- `partial` answers must first name the evidence gap, then visibly label the conjecture and its low or medium confidence.
- `partial` requires at least one cited premise; `none` must not invent a company fact.
- Permission-denied content never enters either model request and keeps the existing fail-closed behavior.
- The planner owns evidence state and premise references; the renderer cannot add references or upgrade state or confidence.
- The application owns direct-task classification; the planner cannot authorize a bypass.
- Keep the existing send-time permission revalidation, Feishu source footer, runtime gates, retry bounds, prompt-injection boundary, and direct-task behavior.
- Do not add a database migration, dependency, external provider, knowledge-base write path, or unbounded retry.
- Use existing ledger phases; distinguish `retrieval`, `evidence_planning`, and `answer_rendering` with content-free `metadata.stage` values.
- Implement each behavior test-first and commit only the files named by that task.

---

## File Structure

- `apps/core/src/agent/answer-draft-orchestrator.ts`: builds primary/supplemental queries and coordinates planner, renderer, citations, and observations.
- `apps/core/src/agent/evidence-plan.ts`: owns evidence-plan types, strict parsing, structural validation, and citation extraction.
- `apps/core/src/memory/document-retrieval-context.ts`: embeds both query channels, fuses candidates, applies permissions, and assembles the final evidence window.
- `apps/core/src/memory/retrieval-candidate-fusion.ts`: owns deterministic weighted reciprocal-rank fusion.
- `apps/core/src/memory/source-aware-fragment-selector.ts`: owns title-aware source grouping, per-source caps, and bounded same-snapshot neighbor completion.
- `apps/core/src/model/openai-compatible-chat-completions-client.ts`: owns shared bounded chat-completions transport, retry, timeout, and response extraction.
- `apps/core/src/model/openai-compatible-model-provider.ts`: keeps direct-task answer rendering and composes the shared client.
- `apps/core/src/model/openai-compatible-evidence-planner.ts`: owns the planner system contract and one invalid-output retry.
- `apps/core/src/model/openai-compatible-grounded-answer-renderer.ts`: owns grounded-answer rendering and echoed-state validation.
- `apps/core/src/runtime/answer-draft-runtime.ts`: creates and injects the three model roles from the existing model configuration.
- Matching `apps/core/tests/*.test.ts` files own focused regressions; `apps/core/tests/answer-reasoning-test-doubles.ts` centralizes typed default doubles.

### Task 1: Separate primary and supplemental retrieval queries

**Files:**
- Modify: `apps/core/src/agent/answer-draft-orchestrator.ts:28-160,360-420`
- Modify: `apps/core/src/memory/document-retrieval-context.ts:30-38`
- Test: `apps/core/tests/answer-draft-orchestrator.test.ts:202-317`

**Interfaces:**
- Consumes: `AnswerDraftInput.question` and the existing deduplicated `LiveChatMessage[]`.
- Produces: `DocumentRetrievalContextInput` with `queryText: string` and optional `supplementalQueryText?: string`.

- [ ] **Step 1: Replace the polluted-query regression with failing primary/supplemental assertions**

```ts
it("keeps the current question clean and sends recent chat as a supplemental query", async () => {
  const contextBuilder = { buildContext: vi.fn(async () => ({
    promptContext: "<background_documents></background_documents>",
    allowedFragments: [],
    deniedDocumentIds: [],
    retrievedFragmentCount: 0,
    usedGroupMemories: [],
    usedDiscussionThreads: [],
    usedActionItems: [],
  })) };
  const orchestrator = createAnswerDraftOrchestrator({
    contextBuilder,
    model: { generateAnswerDraft: vi.fn(async () => ({ answerText: "Answer" })) },
  });

  await orchestrator.generateDraft({
    question: "Quello 的电子宠物是如何自己产生目标的？",
    liveChatMessages: [
      { speaker: "Alice", text: "我希望它可以自己推理" },
      { speaker: "Alice", text: "Quello 的电子宠物是如何自己产生目标的？" },
    ],
  });

  expect(contextBuilder.buildContext).toHaveBeenCalledWith(expect.objectContaining({
    queryText: "Quello 的电子宠物是如何自己产生目标的？",
    supplementalQueryText: expect.stringContaining("我希望它可以自己推理"),
  }));
  const input = contextBuilder.buildContext.mock.calls[0]![0];
  const supplementalQueryText = String(input.supplementalQueryText);
  expect(supplementalQueryText.match(/Quello 的电子宠物是如何自己产生目标的？/gu))
    .toHaveLength(1);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm --workspace apps/core test -- answer-draft-orchestrator.test.ts -t "keeps the current question clean"
```

Expected: FAIL because `queryText` still contains `Recent live chat` and no supplemental field exists.

- [ ] **Step 3: Add the optional input and build a deduplicated supplemental query**

```ts
export type DocumentRetrievalContextInput = {
  queryText: string;
  supplementalQueryText?: string;
  liveChatMessages: LiveChatMessage[];
  fragmentLimit?: number;
  liveChatLimit?: number;
  askerId?: string;
};

function buildSupplementalRetrievalQueryText(
  question: string,
  liveChatMessages: LiveChatMessage[],
): string | undefined {
  const normalizedQuestion = question.trim();
  const priorMessages = liveChatMessages.filter(
    ({ text }) => text.trim() !== normalizedQuestion,
  );
  const liveChatText = buildLiveChatRetrievalText(
    priorMessages.slice(-MAX_RETRIEVAL_QUERY_LIVE_CHAT_MESSAGES),
    MAX_ANSWER_DRAFT_QUESTION_CHARS - normalizedQuestion.length - 2,
  );
  return liveChatText.length === 0
    ? undefined
    : `${normalizedQuestion}\n\n${liveChatText}`;
}
```

Pass `queryText: normalized.question` and conditionally spread `supplementalQueryText` in `buildContext`.

- [ ] **Step 4: Run orchestrator tests and verify GREEN**

```powershell
npm --workspace apps/core test -- answer-draft-orchestrator.test.ts
```

Expected: all orchestrator tests pass after updating old expectations to treat chat as supplemental rather than primary.

- [ ] **Step 5: Commit**

```powershell
git add apps/core/src/agent/answer-draft-orchestrator.ts apps/core/src/memory/document-retrieval-context.ts apps/core/tests/answer-draft-orchestrator.test.ts
git commit -m "fix: separate answer retrieval queries"
```

### Task 2: Fuse primary and contextual semantic candidates

**Files:**
- Create: `apps/core/src/memory/retrieval-candidate-fusion.ts`
- Create: `apps/core/tests/retrieval-candidate-fusion.test.ts`
- Modify: `apps/core/src/memory/document-retrieval-context.ts:75-145,247-270`
- Modify: `apps/core/tests/document-retrieval-context.test.ts`

**Interfaces:**
- Consumes: two ranked `RetrievedDocumentFragment[]` result sets.
- Produces: `fuseRetrievedDocumentFragments(input): RetrievedDocumentFragment[]`, unique by fragment/source and ordered by weighted reciprocal rank.

- [ ] **Step 1: Write failing fusion tests**

```ts
it("lets a strong primary result resist contextual noise", () => {
  expect(fuseRetrievedDocumentFragments({
    primary: [fragment("quello"), fragment("watch")],
    supplemental: [fragment("diary"), fragment("watch"), fragment("quello")],
  }).map(({ id }) => id)).toEqual(["quello", "watch", "diary"]);
});

it("deduplicates the same fragment across query channels", () => {
  const fused = fuseRetrievedDocumentFragments({
    primary: [fragment("shared")],
    supplemental: [fragment("shared")],
  });
  expect(fused).toHaveLength(1);
});

function fragment(id: string): RetrievedDocumentFragment {
  return {
    id,
    documentSourceId: `source-${id}`,
    documentSnapshotId: `snapshot-${id}`,
    sourceUri: `https://example.com/${id}`,
    chunkIndex: 0,
    text: id,
    contentHash: `hash-${id}`,
    embedding: [],
    embeddingProfileId: "static-dev-6d",
    createdAt: new Date("2026-08-11T00:00:00.000Z"),
    sourceType: "feishu_wiki",
  };
}
```

- [ ] **Step 2: Run the new suite and verify RED**

```powershell
npm --workspace apps/core test -- retrieval-candidate-fusion.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement deterministic 2:1 reciprocal-rank fusion**

```ts
const RRF_OFFSET = 60;
const PRIMARY_WEIGHT = 2;
const SUPPLEMENTAL_WEIGHT = 1;

export function fuseRetrievedDocumentFragments(input: {
  primary: readonly RetrievedDocumentFragment[];
  supplemental?: readonly RetrievedDocumentFragment[];
}): RetrievedDocumentFragment[] {
  const candidates = new Map<string, {
    fragment: RetrievedDocumentFragment;
    score: number;
    firstSeen: number;
  }>();
  let firstSeen = 0;
  addRanks(input.primary, PRIMARY_WEIGHT);
  addRanks(input.supplemental ?? [], SUPPLEMENTAL_WEIGHT);
  return [...candidates.values()]
    .sort((left, right) => right.score - left.score || left.firstSeen - right.firstSeen)
    .map(({ fragment }) => fragment);

  function addRanks(fragments: readonly RetrievedDocumentFragment[], weight: number): void {
    fragments.forEach((fragment, index) => {
      const key = `${fragment.documentSourceId}\u0000${fragment.id}`;
      const score = weight / (RRF_OFFSET + index + 1);
      const existing = candidates.get(key);
      if (existing === undefined) {
        candidates.set(key, { fragment, score, firstSeen: firstSeen++ });
      } else {
        existing.score += score;
      }
    });
  }
}
```

- [ ] **Step 4: Make context retrieval embed and search both queries**

```ts
const queryTexts = input.supplementalQueryText === undefined
  ? [queryText]
  : [queryText, sanitizeQueryText(input.supplementalQueryText)];
const queryEmbeddings = await embedQueries(queryTexts, embedder);
const resultSets = await Promise.all(queryEmbeddings.map((embedding) =>
  fragments.searchSimilarFragments({
    embeddingProfileId,
    embedding,
    limit: candidateFragmentLimit,
    ...(sourceTypes === undefined ? {} : { sourceTypes }),
    ...(groupId === undefined ? {} : { groupId }),
  })));
const retrievedFragments = fuseRetrievedDocumentFragments({
  primary: resultSets[0] ?? [],
  supplemental: resultSets[1],
});
```

Replace `embedQuery` with `embedQueries`, require exactly one vector per query, and retain every existing finite-vector check.

- [ ] **Step 5: Verify fusion, permission, and context tests**

```powershell
npm --workspace apps/core test -- retrieval-candidate-fusion.test.ts document-retrieval-context.test.ts
```

Expected: both suites pass; single-query cases still make one embedding/search and dual-query cases make two searches with one batched embedding call.

- [ ] **Step 6: Commit**

```powershell
git add apps/core/src/memory/retrieval-candidate-fusion.ts apps/core/src/memory/document-retrieval-context.ts apps/core/tests/retrieval-candidate-fusion.test.ts apps/core/tests/document-retrieval-context.test.ts
git commit -m "feat: fuse answer retrieval candidates"
```

### Task 3: Select a coherent source-aware evidence window

**Files:**
- Create: `apps/core/src/memory/source-aware-fragment-selector.ts`
- Create: `apps/core/tests/source-aware-fragment-selector.test.ts`
- Modify: `apps/core/src/memory/document-retrieval-context.ts:45-160`
- Modify: `apps/core/src/runtime/answer-draft-runtime.ts:100-115`
- Modify: `apps/core/tests/document-retrieval-context.test.ts`

**Interfaces:**
- Consumes: the fused ranked candidates, primary query, final fragment limit, and optional `listFragmentsForSnapshot(snapshotId)`.
- Produces: `selectSourceAwareFragments(input): Promise<RetrievedDocumentFragment[]>` with at most three fragments per source and at most the requested total.

- [ ] **Step 1: Write a production-shaped failing Quello selector test**

```ts
it("keeps overview and evolution evidence from the named Quello source", async () => {
  const selected = await selectSourceAwareFragments({
    queryText: "Quello 的电子宠物是如何自己产生目标的？",
    fragmentLimit: 8,
    rankedFragments: [
      fragment("watch-1", "watch", 0, "Apple Watch"),
      fragment("diary-1", "diary", 0, "Diary"),
      fragment("watch-2", "watch", 1, "Apple Watch"),
      fragment("diary-2", "diary", 1, "Diary"),
      fragment("quello-overview", "quello", 0, "Quello Life Engine（生命粒子引擎）副本"),
      fragment("notes-1", "notes", 0, "Notes"),
      fragment("watch-3", "watch", 2, "Apple Watch"),
      fragment("diary-3", "diary", 2, "Diary"),
      fragment("notes-2", "notes", 1, "Notes"),
      fragment("quello-evolution", "quello", 3, "Quello Life Engine（生命粒子引擎）副本"),
    ],
  });
  expect(selected.map(({ id }) => id)).toEqual(expect.arrayContaining([
    "quello-overview",
    "quello-evolution",
  ]));
  expect(selected.filter(({ documentSourceId }) => documentSourceId === "watch").length)
    .toBeLessThanOrEqual(3);
});

function fragment(
  id: string,
  documentSourceId: string,
  chunkIndex: number,
  sourceTitle: string,
): RetrievedDocumentFragment {
  return {
    id,
    documentSourceId,
    documentSnapshotId: `snapshot-${documentSourceId}`,
    sourceUri: `https://example.com/${documentSourceId}`,
    chunkIndex,
    text: id,
    contentHash: `hash-${id}`,
    embedding: [],
    embeddingProfileId: "static-dev-6d",
    createdAt: new Date("2026-08-11T00:00:00.000Z"),
    sourceType: "feishu_wiki",
    sourceTitle,
  };
}
```

- [ ] **Step 2: Run the selector suite and verify RED**

```powershell
npm --workspace apps/core test -- source-aware-fragment-selector.test.ts
```

Expected: FAIL because the selector module does not exist.

- [ ] **Step 3: Implement title-aware round-robin selection**

```ts
const MAX_FRAGMENTS_PER_SOURCE = 3;

export type SourceAwareSelectionInput = {
  queryText: string;
  rankedFragments: readonly RetrievedDocumentFragment[];
  fragmentLimit: number;
  listFragmentsForSnapshot?: (snapshotId: string) => Promise<DocumentFragment[]>;
};

type SourceGroup = {
  bestRank: number;
  titleMatched: boolean;
  fragments: RetrievedDocumentFragment[];
};

export async function selectSourceAwareFragments(
  input: SourceAwareSelectionInput,
): Promise<RetrievedDocumentFragment[]> {
  const groups = groupRankedFragments(input.rankedFragments, input.queryText)
    .sort((left, right) =>
      Number(right.titleMatched) - Number(left.titleMatched) ||
      left.bestRank - right.bestRank);
  const selected: RetrievedDocumentFragment[] = [];
  const selectedKeys = new Set<string>();
  const selectedBySource = new Map<string, number>();
  for (let round = 0; round < MAX_FRAGMENTS_PER_SOURCE; round += 1) {
    for (const group of groups) {
      const fragment = group.fragments[round];
      if (fragment !== undefined) {
        pushUnique(selected, selectedKeys, selectedBySource, fragment, input.fragmentLimit);
      }
      if (selected.length >= input.fragmentLimit) return selected;
    }
  }
  return appendBoundedNeighbors(selected, selectedKeys, selectedBySource, input);
}

function groupRankedFragments(
  rankedFragments: readonly RetrievedDocumentFragment[],
  queryText: string,
): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  rankedFragments.forEach((fragment, rank) => {
    const existing = groups.get(fragment.documentSourceId);
    const titleMatched = sourceTitleMatchesQuestion(fragment.sourceTitle, queryText);
    if (existing === undefined) {
      groups.set(fragment.documentSourceId, {
        bestRank: rank,
        titleMatched,
        fragments: [fragment],
      });
    } else {
      existing.titleMatched ||= titleMatched;
      existing.fragments.push(fragment);
    }
  });
  return [...groups.values()];
}

function sourceTitleMatchesQuestion(title: string | undefined, question: string): boolean {
  if (title === undefined) return false;
  const normalizedQuestion = question.normalize("NFKC").toLocaleLowerCase();
  return title.normalize("NFKC").toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/gu)
    .filter((token) => [...token].length >= 3)
    .some((token) => normalizedQuestion.includes(token));
}

function pushUnique(
  selected: RetrievedDocumentFragment[],
  selectedKeys: Set<string>,
  selectedBySource: Map<string, number>,
  fragment: RetrievedDocumentFragment,
  limit: number,
): void {
  const key = `${fragment.documentSourceId}\u0000${fragment.id}`;
  const sourceCount = selectedBySource.get(fragment.documentSourceId) ?? 0;
  if (
    selected.length >= limit ||
    selectedKeys.has(key) ||
    sourceCount >= MAX_FRAGMENTS_PER_SOURCE
  ) return;
  selected.push(fragment);
  selectedKeys.add(key);
  selectedBySource.set(fragment.documentSourceId, sourceCount + 1);
}
```

Implement title matching by splitting the normalized title into Unicode letter/number tokens, keeping tokens of at least three code points, and treating a token contained in the normalized question as a bounded ranking boost.

- [ ] **Step 4: Add same-snapshot neighbor completion without crossing source boundaries**

```ts
async function appendBoundedNeighbors(
  selected: RetrievedDocumentFragment[],
  selectedKeys: Set<string>,
  selectedBySource: Map<string, number>,
  input: SourceAwareSelectionInput,
): Promise<RetrievedDocumentFragment[]> {
  if (input.listFragmentsForSnapshot === undefined) return selected;
  for (const seed of [...selected]) {
    if (selected.length >= input.fragmentLimit) break;
    const snapshotFragments = await input.listFragmentsForSnapshot(seed.documentSnapshotId);
    for (const neighbor of snapshotFragments.filter(({ chunkIndex }) =>
      Math.abs(chunkIndex - seed.chunkIndex) === 1)) {
      if (neighbor.documentSourceId !== seed.documentSourceId) continue;
      pushUnique(selected, selectedKeys, selectedBySource, {
        ...neighbor,
        sourceTitle: seed.sourceTitle,
        sourceType: seed.sourceType,
      }, input.fragmentLimit);
    }
  }
  return selected;
}
```

Only run neighbor completion for a source already allowed by the source-level permission guard, and never exceed three fragments for that source or the global limit.

- [ ] **Step 5: Wire selection before and after live permission filtering**

Use pre-permission selection only to identify denied source IDs. Run final selection on allowed fused candidates, then fetch neighbors only for allowed sources. Extend the context-builder repository dependency to:

```ts
Pick<DocumentFragmentRepository, "searchSimilarFragments">
  & Partial<Pick<DocumentFragmentRepository, "listFragmentsForSnapshot">>
```

Production runtime passes both repository methods; existing narrow test doubles may omit neighbor lookup.

- [ ] **Step 6: Run retrieval, selector, runtime, and permission regressions**

```powershell
npm --workspace apps/core test -- source-aware-fragment-selector.test.ts document-retrieval-context.test.ts answer-draft-runtime.test.ts feishu-document-permission-checker.test.ts
```

Expected: all selected suites pass; the Quello fixture retains both required fragments and denied text never appears in prompt context.

- [ ] **Step 7: Commit**

```powershell
git add apps/core/src/memory/source-aware-fragment-selector.ts apps/core/src/memory/document-retrieval-context.ts apps/core/src/runtime/answer-draft-runtime.ts apps/core/tests/source-aware-fragment-selector.test.ts apps/core/tests/document-retrieval-context.test.ts apps/core/tests/answer-draft-runtime.test.ts
git commit -m "feat: assemble source-aware answer evidence"
```

### Task 4: Define and validate the evidence-plan contract

**Files:**
- Create: `apps/core/src/agent/evidence-plan.ts`
- Create: `apps/core/tests/evidence-plan.test.ts`

**Interfaces:**
- Produces: `EvidencePlan`, `EvidencePlanningDocument`, `EvidencePlanValidationError`, `parseEvidencePlanContent(content, allowedRefs)`, and `citedRefsForEvidencePlan(plan)`.
- Later tasks consume these exact exported names.

- [ ] **Step 1: Write failing state-matrix and invalid-reference tests**

```ts
it.each([
  ["explicit", "high"],
  ["complete_inference", "medium"],
  ["partial", "low"],
] as const)("accepts a valid %s company-fact plan", (evidenceState, confidence) => {
  const plan = parseEvidencePlanContent(JSON.stringify({
    taskMode: "company_fact",
    evidenceState,
    premises: [{ citationRef: "D1", statement: "Supported premise" }],
    proposedAnswer: "Bounded answer",
    missingInformation: evidenceState === "partial" ? ["Missing mechanism detail"] : [],
    confidence,
  }), ["D1"]);
  expect(plan.evidenceState).toBe(evidenceState);
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
```

- [ ] **Step 2: Run the new suite and verify RED**

```powershell
npm --workspace apps/core test -- evidence-plan.test.ts
```

Expected: FAIL because the contract module does not exist.

- [ ] **Step 3: Add discriminated plan types**

The shared `EvidencePlan` union below remains useful for direct-task execution metadata and legacy
test doubles. It does not widen the provider contract: under the authoritative review amendment,
the actual evidence-planner response schema and provider accept `company_fact` only.

```ts
export type EvidencePlanningDocument = {
  citationRef: string;
  source: string;
  text: string;
};

export type EvidenceState = "explicit" | "complete_inference" | "partial" | "none";
export type EvidenceConfidence = "high" | "medium" | "low";
export type EvidencePremise = { citationRef: string; statement: string };

export type EvidencePlan = {
  taskMode: "direct_task" | "company_fact";
  evidenceState: EvidenceState | null;
  premises: EvidencePremise[];
  proposedAnswer: string | null;
  missingInformation: string[];
  confidence: EvidenceConfidence | null;
};

export class EvidencePlanValidationError extends Error {}
```

- [ ] **Step 4: Implement strict JSON shape and state validation**

Reject unknown keys. Enforce the design matrix with these conditions:

```ts
if (taskMode === "direct_task") {
  requirePlanCondition(
    evidenceState === null &&
      premises.length === 0 &&
      proposedAnswer === null &&
      missingInformation.length === 0 &&
      confidence === null,
    "direct task evidence fields are invalid",
  );
}
if (evidenceState === "explicit" || evidenceState === "complete_inference") {
  requirePlanCondition(premises.length > 0, "evidence plan requires a premise");
  requirePlanCondition(proposedAnswer !== null, "evidence plan requires an answer");
  requirePlanCondition(missingInformation.length === 0, "complete evidence cannot be missing");
  requirePlanCondition(
    confidence === "high" || confidence === "medium",
    "complete evidence confidence is invalid",
  );
}
if (evidenceState === "partial") {
  requirePlanCondition(
    premises.length > 0 && proposedAnswer !== null,
    "partial evidence requires a premise and answer",
  );
  requirePlanCondition(missingInformation.length > 0, "partial evidence requires a gap");
  requirePlanCondition(
    confidence === "low" || confidence === "medium",
    "partial evidence confidence is invalid",
  );
}
if (evidenceState === "none") {
  requirePlanCondition(
    premises.length === 0 && proposedAnswer === null,
    "no-evidence plan cannot contain a factual answer",
  );
  requirePlanCondition(
    missingInformation.length > 0 && confidence === "low",
    "no-evidence plan requires a low-confidence gap",
  );
}

function requirePlanCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new EvidencePlanValidationError(message);
}
```

Bound plans to twelve premises, twelve missing items, 1,200 characters per premise/missing item, and 8,000 proposed-answer characters. Deduplicate and return citation refs in prompt order.

- [ ] **Step 5: Run the plan suite and verify GREEN**

```powershell
npm --workspace apps/core test -- evidence-plan.test.ts
```

Expected: valid states pass; malformed JSON, unknown fields, blank strings, duplicates, excess lengths, and out-of-window refs fail.

- [ ] **Step 6: Commit**

```powershell
git add apps/core/src/agent/evidence-plan.ts apps/core/tests/evidence-plan.test.ts
git commit -m "feat: validate structured evidence plans"
```

### Task 5: Extract the bounded OpenAI-compatible chat client

**Files:**
- Create: `apps/core/src/model/openai-compatible-chat-completions-client.ts`
- Modify: `apps/core/src/model/openai-compatible-model-provider.ts`
- Test: `apps/core/tests/openai-compatible-model-provider.test.ts`

**Interfaces:**
- Produces: `OpenAICompatibleChatCompletionsClient.complete(messages): Promise<string>` and `createOpenAICompatibleChatCompletionsClient(dependencies)`.
- Preserves: every existing direct-answer transport, timeout, retry, error, size, finish-reason, and citation behavior.

- [ ] **Step 1: Add a failing request-delegation regression**

Inject a client double into the direct provider and assert the existing system and user messages are passed to `complete` while citation parsing remains local:

```ts
const client = { complete: vi.fn(async () =>
  'Answer\n<iris_citations>["D1"]</iris_citations>') };
const provider = createOpenAICompatibleModelProvider({ config: config(), client });
await expect(provider.generateAnswerDraft({
  question: "Question",
  promptContext: '<document citation_ref="D1">Fact</document>',
})).resolves.toEqual({ answerText: "Answer", citedSourceRefs: ["D1"] });
expect(client.complete).toHaveBeenCalledOnce();
```

- [ ] **Step 2: Run the delegation test and verify RED**

```powershell
npm --workspace apps/core test -- openai-compatible-model-provider.test.ts -t "delegates bounded chat completion"
```

Expected: FAIL because the provider has no `client` dependency.

- [ ] **Step 3: Move transport into the shared client**

```ts
export type OpenAICompatibleChatMessage = {
  role: "system" | "user";
  content: string;
};

export interface OpenAICompatibleChatCompletionsClient {
  complete(messages: readonly OpenAICompatibleChatMessage[]): Promise<string>;
}
```

Move the existing URL normalization, request body, bounded JSON read, finish-reason validation, timeout, retry/backoff, abort handling, and provider error preservation into the client without changing their constants or messages. Keep answer/citation parsing in `openai-compatible-model-provider.ts`.

- [ ] **Step 4: Run the full provider suite**

```powershell
npm --workspace apps/core test -- openai-compatible-model-provider.test.ts
```

Expected: all existing and new tests pass, including deadline, retry, quota-detail, malformed-response, response-size, and citation cases.

- [ ] **Step 5: Commit**

```powershell
git add apps/core/src/model/openai-compatible-chat-completions-client.ts apps/core/src/model/openai-compatible-model-provider.ts apps/core/tests/openai-compatible-model-provider.test.ts
git commit -m "refactor: share bounded model chat transport"
```

### Task 6: Add the structured evidence planner provider

**Files:**
- Create: `apps/core/src/model/openai-compatible-evidence-planner.ts`
- Create: `apps/core/tests/openai-compatible-evidence-planner.test.ts`

**Interfaces:**
- Produces: `EvidencePlanner.plan(input): Promise<EvidencePlan>` and `createOpenAICompatibleEvidencePlanner({ client })`.
- Consumes: `EvidencePlanningDocument[]`, the current question, and bounded `LiveChatMessage[]`.

- [ ] **Step 1: Write failing success, injection, and retry tests**

```ts
it("returns a validated partial plan using only allowed references", async () => {
  const client = { complete: vi.fn(async () => JSON.stringify({
    taskMode: "company_fact",
    evidenceState: "partial",
    premises: [{ citationRef: "D2", statement: "Life Engine accumulates preferences" }],
    proposedAnswer: "Goals likely emerge from state and accumulated experience",
    missingInformation: ["The exact goal-selection algorithm"],
    confidence: "medium",
  })) };
  const planner = createOpenAICompatibleEvidencePlanner({ client });
  const plan = await planner.plan(planningInput(["D1", "D2"]));
  expect(plan.evidenceState).toBe("partial");
  expect(client.complete).toHaveBeenCalledOnce();
});

it("retries one structurally invalid result and then succeeds", async () => {
  const client = { complete: vi.fn()
    .mockResolvedValueOnce('{"taskMode":"company_fact"}')
    .mockResolvedValueOnce(validExplicitPlanJson()) };
  await createOpenAICompatibleEvidencePlanner({ client }).plan(planningInput(["D1"]));
  expect(client.complete).toHaveBeenCalledTimes(2);
});

function planningInput(refs: string[]) {
  return {
    question: "Quello 如何产生目标？",
    evidence: refs.map((citationRef) => ({
      citationRef,
      source: `https://example.com/${citationRef}`,
      text: `Evidence ${citationRef}`,
    })),
    liveChatMessages: [],
  };
}

function validExplicitPlanJson(): string {
  return JSON.stringify({
    taskMode: "company_fact",
    evidenceState: "explicit",
    premises: [{ citationRef: "D1", statement: "Explicit premise" }],
    proposedAnswer: "Explicit answer",
    missingInformation: [],
    confidence: "high",
  });
}
```

Also assert the system prompt says evidence and live chat are untrusted data, forbids external company-fact completion, defines all four states, and requires `partial` warning data.

- [ ] **Step 2: Run the new suite and verify RED**

```powershell
npm --workspace apps/core test -- openai-compatible-evidence-planner.test.ts
```

Expected: FAIL because the planner module does not exist.

- [ ] **Step 3: Implement the planner interface and bounded input serialization**

```ts
export interface EvidencePlanner {
  plan(input: {
    question: string;
    evidence: EvidencePlanningDocument[];
    liveChatMessages: LiveChatMessage[];
  }): Promise<EvidencePlan>;
}
```

Send JSON data containing `question`, `evidence`, and the bounded live-chat window. The system prompt requests only the strict plan object and explicitly says not to reveal chain-of-thought; premise statements and the proposed answer must be concise conclusions, not hidden reasoning traces.

- [ ] **Step 4: Implement one structural-invalidity retry**

Call `client.complete` at most twice. Retry only `EvidencePlanValidationError`; do not add another retry around transport because the shared client already owns bounded transport retry.

- [ ] **Step 5: Run planner and plan-contract tests**

```powershell
npm --workspace apps/core test -- evidence-plan.test.ts openai-compatible-evidence-planner.test.ts
```

Expected: all tests pass; a second invalid result fails without including raw model content in the error.

- [ ] **Step 6: Commit**

```powershell
git add apps/core/src/model/openai-compatible-evidence-planner.ts apps/core/tests/openai-compatible-evidence-planner.test.ts
git commit -m "feat: add structured answer evidence planner"
```

### Task 7: Add the grounded-answer renderer provider

**Files:**
- Create: `apps/core/src/model/openai-compatible-grounded-answer-renderer.ts`
- Create: `apps/core/tests/openai-compatible-grounded-answer-renderer.test.ts`

**Interfaces:**
- Produces: `GroundedAnswerRenderer.render(input): Promise<GroundedAnswerRenderResult>` and `createOpenAICompatibleGroundedAnswerRenderer({ client })`.
- Consumes: a validated company-fact `EvidencePlan`, only its cited evidence documents, the current question, and bounded live chat.

- [ ] **Step 1: Write failing renderer contract tests**

```ts
it("accepts a partial answer only when state and confidence echo the plan", async () => {
  const client = { complete: vi.fn(async () => JSON.stringify({
    answerText: "现有资料没有写出完整算法。基于现有证据，我的推测是目标会随状态和经验逐步形成（中等置信度）。",
    evidenceState: "partial",
    confidence: "medium",
  })) };
  const result = await createOpenAICompatibleGroundedAnswerRenderer({ client }).render(
    groundedRenderInput(partialPlan()),
  );
  expect(result.answerText).toContain("基于现有证据，我的推测是");
});

it("rejects a renderer that upgrades partial evidence", async () => {
  const client = { complete: vi.fn(async () => JSON.stringify({
    answerText: "This is certain.", evidenceState: "explicit", confidence: "high",
  })) };
  await expect(createOpenAICompatibleGroundedAnswerRenderer({ client }).render(
    groundedRenderInput(partialPlan()),
  )).rejects.toThrow("grounded answer state does not match evidence plan");
});

function partialPlan(): EvidencePlan {
  return {
    taskMode: "company_fact",
    evidenceState: "partial",
    premises: [{ citationRef: "D1", statement: "Experience shapes preferences" }],
    proposedAnswer: "Goals likely emerge from state and experience",
    missingInformation: ["The exact selection algorithm"],
    confidence: "medium",
  };
}

function groundedRenderInput(plan: EvidencePlan) {
  return {
    question: "Quello 如何产生目标？",
    plan,
    evidence: [{
      citationRef: "D1",
      source: "https://example.com/quello#chunk-3",
      text: "Repeated experience forms preferences and future actions.",
    }],
    liveChatMessages: [],
  };
}
```

- [ ] **Step 2: Run the new suite and verify RED**

```powershell
npm --workspace apps/core test -- openai-compatible-grounded-answer-renderer.test.ts
```

Expected: FAIL because the renderer module does not exist.

- [ ] **Step 3: Implement strict renderer output parsing**

```ts
export type GroundedAnswerRenderResult = {
  answerText: string;
  evidenceState: EvidenceState;
  confidence: EvidenceConfidence;
};

export interface GroundedAnswerRenderer {
  render(input: {
    question: string;
    plan: EvidencePlan;
    evidence: EvidencePlanningDocument[];
    liveChatMessages: LiveChatMessage[];
  }): Promise<GroundedAnswerRenderResult>;
}
```

Require exactly `answerText`, `evidenceState`, and `confidence`; bound answer text to 8,000 characters; reject unknown fields and any state/confidence mismatch.

- [ ] **Step 4: Lock visible epistemic-language rules in the system contract**

The prompt must require `complete_inference` to identify inference, `partial` to name missing information before an explicitly labeled conjecture and confidence, and `none` to provide no company-factual conjecture. It must forbid new premises, new refs, state upgrades, external facts, and instructions embedded in evidence/chat.

- [ ] **Step 5: Run renderer tests**

```powershell
npm --workspace apps/core test -- openai-compatible-grounded-answer-renderer.test.ts
```

Expected: all state echo, confidence, length, malformed JSON, injection-contract, and blank-answer tests pass.

- [ ] **Step 6: Commit**

```powershell
git add apps/core/src/model/openai-compatible-grounded-answer-renderer.ts apps/core/tests/openai-compatible-grounded-answer-renderer.test.ts
git commit -m "feat: render evidence-bounded answers"
```

### Task 8: Integrate planning and rendering into answer orchestration

**Files:**
- Create: `apps/core/tests/answer-reasoning-test-doubles.ts`
- Modify: `apps/core/src/agent/answer-draft-orchestrator.ts:10-240`
- Modify: `apps/core/src/model/openai-compatible-model-provider.ts`
- Modify: `apps/core/src/runtime/answer-draft-runtime.ts:100-340`
- Modify: `apps/core/tests/answer-draft-orchestrator.test.ts`
- Modify: `apps/core/tests/answer-draft-runtime.test.ts`
- Modify: `apps/core/tests/openai-compatible-model-provider.test.ts`

**Interfaces:**
- The orchestrator consumes three required roles: existing `ModelProvider` for application-classified direct tasks, a company-fact-only `EvidencePlanner`, and `GroundedAnswerRenderer`.
- Runtime constructs all three roles from one existing `ModelProviderConfig`; no new environment variable is introduced.
- `AnswerDraftResult.citedSourceRefs` for company facts comes only from `documentCitationRefsForEvidencePlan(plan)`.

- [ ] **Step 1: Add reusable typed test doubles**

```ts
export function directTaskPlan(): EvidencePlan {
  return {
    taskMode: "direct_task",
    evidenceState: null,
    premises: [],
    proposedAnswer: null,
    missingInformation: [],
    confidence: null,
  };
}

export function createReasoningDoubles(plan = directTaskPlan()) {
  return {
    planner: { plan: vi.fn(async () => plan) },
    renderer: { render: vi.fn(async () => {
      throw new Error("renderer must not run for direct tasks");
    }) },
  };
}
```

This was the original test-double shape. Under the review amendment, a `directTaskPlan` double is
never a permitted planner result: direct-task tests use an explicit application-classified request
and assert that the planner is not called; company-fact tests use a planner that can return only
`company_fact`.

- [ ] **Step 2: Write failing orchestration tests for all company evidence states**

Add focused tests that prove:

```ts
expect(planner.plan).toHaveBeenCalledWith({
  question,
  evidence: [
    expect.objectContaining({ citationRef: "D1", text: "Quello overview" }),
    expect.objectContaining({ citationRef: "D2", text: "Quello evolution" }),
  ],
  liveChatMessages,
});
expect(renderer.render).toHaveBeenCalledWith(expect.objectContaining({
  evidence: [expect.objectContaining({ citationRef: "D2" })],
}));
expect(result.citedSourceRefs).toEqual(["D2"]);
```

For `partial`, assert the renderer is called and only cited premise evidence is passed. For `none`, assert no citations. For permission denial, assert planner, renderer, and direct model are all skipped. For an application-classified direct task, assert only the existing direct model runs and planning is skipped.

- [ ] **Step 3: Run focused orchestrator tests and verify RED**

```powershell
npm --workspace apps/core test -- answer-draft-orchestrator.test.ts -t "evidence plan|partial|direct task|permission"
```

Expected: new company-state tests fail because the orchestrator still invokes only the direct model.

- [ ] **Step 4: Implement the two-stage branch**

```ts
const directTask = classifyDirectTask(question);
if (directTask?.kind === "literal_output") {
  return literalAnswer(directTask.payload, createDirectTaskContext());
}
if (directTask?.kind === "model_transform") {
  return runDirectModel(question, createDirectTaskContext());
}

const context = await buildCompanyContext(question);
const evidence = buildPlanningEvidence(question, context);
const plan = await planner.plan({ question, evidence, liveChatMessages: context.liveChatMessages });
if (plan.taskMode !== "company_fact") {
  throw new Error("company-fact evidence planner returned an invalid task mode");
}
const selectedRefs = citedRefsForEvidencePlan(plan);
const citedSourceRefs = documentCitationRefsForEvidencePlan(plan);
const citedEvidence = evidence.filter(({ citationRef }) => selectedRefs.includes(citationRef));
const rendered = await renderer.render({
  question,
  plan,
  evidence: citedEvidence,
  liveChatMessages: context.liveChatMessages,
});
return { answerText: rendered.answerText, citedSourceRefs };
```

Classification must run before stored-chat loading, retrieval, permission inspection, or context
assembly. Match the full instruction before the first delimiter against a strict grammar; do not
use permissive suffix regexes. Exact-output payloads are returned literally without a provider
request. All direct-task results expose canonical empty context metadata, while meta-answer format
wrappers and references to previous/attached/above context remain company-factual.

Expose the bounded selected live-chat messages in `DocumentRetrievalContextResult` so planner and renderer receive exactly the already-sanitized prompt window, not raw request data.

```ts
export type DocumentRetrievalContextResult = {
  promptContext: string;
  allowedFragments: RetrievedDocumentFragment[];
  deniedDocumentIds: string[];
  retrievedFragmentCount: number;
  liveChatMessages: LiveChatMessage[];
  usedGroupMemories: PromptGroupMemory[];
  usedDiscussionThreads?: PromptDiscussionThread[];
  usedActionItems?: PromptActionItem[];
};
```

- [ ] **Step 5: Add separate content-free provider observations**

Keep ledger `phase: "sampling"`; use operation keys `provider:planner:*` and `provider:renderer:*` with metadata `{ stage: "evidence_planning" }` and `{ stage: "answer_rendering" }`. Turn completion metadata may include task mode, evidence state, confidence, candidate count, source count, and selected fragment count, but no question, evidence, answer, or model error text.

- [ ] **Step 6: Compose providers in runtime**

Create a shared chat client from the existing `ModelProviderConfig`, then construct:

```ts
const chatClient = createOpenAICompatibleChatCompletionsClient({ config: modelConfig });
const model = createOpenAICompatibleModelProvider({ config: modelConfig, client: chatClient });
const planner = createOpenAICompatibleEvidencePlanner({ client: chatClient });
const renderer = createOpenAICompatibleGroundedAnswerRenderer({ client: chatClient });
```

Preserve dependency injection with `createEvidencePlanner` and `createGroundedAnswerRenderer` factories so runtime tests never make network requests. Do not change environment configuration.

- [ ] **Step 7: Run orchestration/runtime/provider regressions**

```powershell
npm --workspace apps/core test -- answer-draft-orchestrator.test.ts answer-draft-runtime.test.ts openai-compatible-model-provider.test.ts openai-compatible-evidence-planner.test.ts openai-compatible-grounded-answer-renderer.test.ts
```

Expected: all suites pass; observations have distinct stage metadata, and existing direct output/citation behavior remains unchanged.

- [ ] **Step 8: Commit**

```powershell
git add apps/core/src/agent/answer-draft-orchestrator.ts apps/core/src/model/openai-compatible-model-provider.ts apps/core/src/runtime/answer-draft-runtime.ts apps/core/tests/answer-reasoning-test-doubles.ts apps/core/tests/answer-draft-orchestrator.test.ts apps/core/tests/answer-draft-runtime.test.ts apps/core/tests/openai-compatible-model-provider.test.ts
git commit -m "feat: plan evidence before answering"
```

### Task 9: Prove citation, permission, and production-shaped behavior

**Files:**
- Modify: `apps/core/tests/answer-draft-runtime.test.ts`
- Modify: `apps/core/tests/answer-source-citation-renderer.test.ts`
- Modify: `apps/core/tests/feishu-mention-answer-responder.test.ts`
- Modify: `apps/core/tests/answer-reply-delivery-service.test.ts`

**Interfaces:**
- Consumes: the integrated two-stage `AnswerDraftResult`.
- Produces: end-to-end proof that planner refs become existing source traces and are revalidated before Feishu delivery.

- [ ] **Step 1: Add a failing production-shaped Quello runtime test**

Seed fused retrieval results in the same rank pattern observed in production: Quello overview at primary rank five, evolution at rank ten, with diary/watch noise around them. Assert:

```ts
expect(result.allowedFragments.map(({ id }) => id)).toEqual(expect.arrayContaining([
  "quello-overview",
  "quello-evolution",
]));
expect(planner.plan).toHaveBeenCalledWith(expect.objectContaining({
  evidence: expect.arrayContaining([
    expect.objectContaining({ text: expect.stringContaining("Life Engine") }),
    expect.objectContaining({ text: expect.stringContaining("Tick") }),
  ]),
}));
expect(result.citedSourceRefs).toEqual([quelloOverviewRef, quelloEvolutionRef]);
```

- [ ] **Step 2: Run the production-shaped test and verify RED if any integration is missing**

```powershell
npm --workspace apps/core test -- answer-draft-runtime.test.ts -t "Quello"
```

Expected: PASS only after query fusion, source selection, planner, renderer, and citation mapping all work together.

- [ ] **Step 3: Add citation and permission boundary cases**

Verify a planner-selected Quello ref creates a Quello source trace and visible footer, a related-source ref cannot appear unless selected by the plan, and revoking the Quello source between preparation and send produces `ANSWER_PERMISSION_CHANGED_NOTICE` without sending the prepared conclusion.

- [ ] **Step 4: Run the complete boundary set**

```powershell
npm --workspace apps/core test -- answer-draft-runtime.test.ts answer-source-citation-renderer.test.ts feishu-mention-answer-responder.test.ts answer-reply-delivery-service.test.ts feishu-document-permission-checker.test.ts
```

Expected: all suites pass; no denied text, hidden prompt, invalid ref, or unverified source reaches a reply.

- [ ] **Step 5: Commit**

```powershell
git add apps/core/tests/answer-draft-runtime.test.ts apps/core/tests/answer-source-citation-renderer.test.ts apps/core/tests/feishu-mention-answer-responder.test.ts apps/core/tests/answer-reply-delivery-service.test.ts
git commit -m "test: cover grounded inference delivery"
```

### Task 10: Verify, review, publish, and run the allowlisted pilot

**Files:**
- Verify all files changed by Tasks 1-9.
- Update ignored operational evidence: `.superpowers/sdd/2026-08-11-iris-grounded-inference-answering/task-3-report.md`.
- Do not modify production data or rollout scope.

**Interfaces:**
- Produces: one reviewed exact candidate SHA on PR #30, verified locally and in CI, then accepted or rolled back in the existing pilot group.

- [ ] **Step 1: Prove ancestry, diff scope, and clean tracked state**

```powershell
$ErrorActionPreference = "Stop"
$baseline = "4aaa38bed1bf98a1d4fce5decd025597012cea3f"
$candidate = (git rev-parse HEAD).Trim()
git merge-base --is-ancestor $baseline $candidate
if ($LASTEXITCODE -ne 0) { throw "Candidate lost the approved master ancestry" }
git diff --check "$baseline...$candidate"
git status --short
```

Expected: ancestry succeeds, `git diff --check` is silent, and the isolated implementation worktree has no uncommitted tracked change.

- [ ] **Step 2: Run focused reasoning and security suites**

```powershell
npm --workspace apps/core test -- retrieval-candidate-fusion.test.ts source-aware-fragment-selector.test.ts evidence-plan.test.ts openai-compatible-model-provider.test.ts openai-compatible-evidence-planner.test.ts openai-compatible-grounded-answer-renderer.test.ts document-retrieval-context.test.ts answer-draft-orchestrator.test.ts answer-draft-runtime.test.ts answer-source-citation-renderer.test.ts answer-reply-delivery-service.test.ts feishu-document-permission-checker.test.ts feishu-mention-answer-responder.test.ts
```

Expected: every selected suite passes with zero skipped release gate.

- [ ] **Step 3: Run the complete repository verification**

```powershell
npm run verify
```

Expected: Core typecheck/build/tests, Python tests, pilot/readiness checks, Compose validation, and formatting/diff checks all exit zero.

- [ ] **Step 4: Perform a fresh-eyes code review and resolve only release blockers**

Review the exact baseline diff for permission expansion, evidence leakage, citation mismapping, unbounded retries, direct-task regressions, and hidden data in observations. Fix blockers and rerun affected gates. Record non-blocking hardening findings in the backlog rather than expanding this feature indefinitely.

- [ ] **Step 5: Push the exact candidate and require exact-SHA CI**

```powershell
$ErrorActionPreference = "Stop"
$candidate = (git rev-parse HEAD).Trim()
git push origin HEAD:codex/iris-grounded-inference-answering
gh pr checks 30 --watch
$remote = (git ls-remote origin refs/heads/codex/iris-grounded-inference-answering).Split()[0]
if ($remote -ne $candidate) { throw "Remote branch differs from reviewed candidate" }
```

Expected: Core and AI Worker checks pass for exactly `$candidate`.

- [ ] **Step 6: Deploy only to the existing allowlisted pilot and run live acceptance**

Before deploying, capture the currently running image SHA and verify the pilot allowlist. Deploy the exact reviewed SHA, then ask:

```text
@Iris Quello 的电子宠物是如何自己产生目标的？
```

Accept only if the reply uses the relevant Quello source, explains inference or partial evidence visibly, gives a bounded conjecture when partial, invents no undocumented algorithm/score/threshold, and displays only currently readable supporting sources. Run paired related-subject, zero-evidence, and permission-revocation checks.

- [ ] **Step 7: Verify operational health or roll back immediately**

Confirm public health, readiness, Caddy, runtime controller state, queue drain, all DLQs, unresolved answer deliveries, and nonpilot disablement. If any security, citation, core behavior, or health gate fails, restore the captured image SHA and repeat the same health checks. Leave production in the approved pilot state with no failsafe timer.

- [ ] **Step 8: Record acceptance evidence and final candidate SHA**

Update `.superpowers/sdd/2026-08-11-iris-grounded-inference-answering/task-3-report.md` with incoming/reply message IDs, planner evidence state, selected source IDs, displayed references, exact image SHA, CI results, queue/DLQ state, and rollback outcome if used. Do not store document bodies, secrets, or hidden model reasoning.
