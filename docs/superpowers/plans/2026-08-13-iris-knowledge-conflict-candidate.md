# Iris Knowledge Conflict Candidate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the whitepaper's first knowledge-conflict loop by turning an eligible, newer group conclusion and a contradictory authorized Wiki snapshot into a durable operator-reviewed candidate, a member-confirmed `knowledge_conflict` draft, and a visible conflict answer state without granting the detector any publication authority.

**Architecture:** Add a focused `knowledge-conflicts` module inside the Core modular monolith. PostgreSQL owns discovery inbox, candidate, exact evidence, event, delivery, interaction, and answer-receipt facts. A bounded worker retrieves only knowledge-draft-eligible authorized Wiki evidence behind live permission checks, calls a strict OpenAI-compatible detector, and persists only current conflicts. Existing Admin authentication, Feishu card callback ingress, Redis approval-interaction queue, knowledge-draft governance, knowledge-card confirmation, action approval, and publication paths are extended rather than duplicated. Answer-time conflict exposure is deterministic from an already persisted current candidate; the ordinary evidence planner cannot invent `conflict`.

**Tech Stack:** TypeScript 5.5, Node.js 24, Fastify 5, Zod 4, PostgreSQL 16, Redis 7, Vitest 2, OpenAI-compatible strict JSON Schema, Feishu OpenAPI and JSON 2.0 interactive cards.

## Global Constraints

- Build from `origin/master@64305009bf19cf289740d1a23316ef48d09f53b5` in branch `codex/iris-knowledge-conflict-loop`.
- Follow `docs/superpowers/specs/2026-08-13-iris-knowledge-conflict-candidate-design.md`; stop after its automated and ten-step live-pilot gates pass.
- Use forward migration `0046_knowledge_conflict_candidates.sql`. Do not edit applied migrations `0001` through `0045`.
- Keep `IRIS_KNOWLEDGE_CONFLICT_ENABLED=false` and an empty `IRIS_KNOWLEDGE_CONFLICT_GROUP_ALLOWLIST` in committed pilot defaults.
- Scan only active, group-scoped `decision`, `workflow`, or `term` memories with confidence at least `0.80`, importance at least `3`, and at least one current conversation-message reference.
- Retrieve only `authorized_wiki_document` sources that are synced, locally readable or unknown, allowed for knowledge drafts, and inside a currently enabled publication target available to the source group.
- Run live Feishu permission checks before detector text access and again before candidate persistence, answer injection, delivery, and callback mutation.
- Treat a group conclusion as newer only when every source message `sentAt` is strictly later than the target snapshot `fetchedAt`. Unknown ordering is `insufficient_evidence`, never `conflict`.
- A detector response can create only a candidate. Detection cannot send a card, create a draft, approve publication, or write Wiki content.
- Operator approval is version-bound and creates at most one delivery outbox row. Group callback actor identity comes from authenticated Feishu context and must pass current membership checks.
- `create_update_draft` creates exactly one medium-risk `knowledge_conflict` draft with exact message, group-memory, and document-source evidence, then calls the existing knowledge-card presentation service.
- Do not add an in-place Wiki update action. The existing publication path may create a governed page; exact-revision Wiki mutation remains a separate capability.
- Redis jobs, status responses, readiness, logs, and dead-letter summaries remain content-free. They must not contain statements, source text, prompts, actor Open IDs, tokens, secrets, or raw provider errors.
- Append-only evidence, candidate events, interactions, and answer-conflict receipts are never updated or deleted by ordinary runtime code.
- `outcome_unknown` delivery rows require operator reconciliation and are never blindly retried.
- Preserve all existing direct-task and `explicit`, `complete_inference`, `partial`, and `none` answer behavior.
- After the exit gates pass, record non-blocking refinements in the follow-up backlog instead of extending this capability.

---

## File Structure

Create focused modules under `apps/core/src/knowledge-conflicts/`:

- `knowledge-conflict.ts`: bounded detector plan, candidate, status, evidence, and normalization contracts.
- `knowledge-conflict-repository.ts`: persistence ports, stable conflicts, status counts, and claim/result types.
- `postgres-knowledge-conflict-repository.ts`: inbox discovery/claim/retry, candidate transactions, governance, delivery, interaction, and overlap reads.
- `knowledge-conflict-evidence-builder.ts`: eligible-memory load, knowledge-purpose retrieval, live permission ordering, chronology, and current-state fingerprint.
- `openai-compatible-knowledge-conflict-detector.ts`: strict schema request, local parse, and one invalid-response correction.
- `knowledge-conflict-scanner.ts`: one claimed scan orchestration and terminal/retry classification.
- `knowledge-conflict-scanner-loop.ts`: bounded polling lifecycle and content-free snapshot.
- `knowledge-conflict-card-renderer.ts`: deterministic review card and committed-result cards.
- `knowledge-conflict-dispatcher.ts`: outbox revalidation and Feishu send state machine.
- `knowledge-conflict-dispatcher-loop.ts`: bounded delivery polling lifecycle.
- `knowledge-conflict-interaction-worker.ts`: membership/evidence/runtime rechecks, dismiss, and draft conversion.
- `knowledge-conflict-api.ts`: authenticated group-scoped candidate, event, scan-DLQ, approval, and reconciliation routes.
- `knowledge-conflict-answer-provider.ts`: exact current overlap lookup and deterministic `conflict` evidence plan construction.

Create `apps/core/src/runtime/knowledge-conflict-runtime.ts` for the shared Postgres dependencies, scanner, dispatcher, callback worker, status, and close order. Extend the existing Feishu callback queue and knowledge-draft evidence model; do not add a second callback endpoint or a second knowledge-draft presentation system.

---

### Task 1: Freeze Domain, Migration, And Evidence Contracts

**Files:**
- Create: `apps/core/migrations/0046_knowledge_conflict_candidates.sql`
- Create: `apps/core/src/knowledge-conflicts/knowledge-conflict.ts`
- Create: `apps/core/src/knowledge-conflicts/knowledge-conflict-repository.ts`
- Create: `apps/core/tests/knowledge-conflict.test.ts`
- Modify: `apps/core/tests/migration-runner.test.ts`
- Modify: `apps/core/src/knowledge-governance/knowledge-draft.ts`
- Modify: `apps/core/src/knowledge-governance/knowledge-draft-repository.ts`
- Modify: `apps/core/src/knowledge-governance/postgres-knowledge-draft-repository.ts`
- Modify: `apps/core/src/knowledge-governance/postgres-knowledge-draft-evidence.ts`
- Modify: `apps/core/src/answer-replies/answer-reply-repository.ts`
- Modify: `apps/core/tests/postgres-knowledge-draft-repository.test.ts`

**Interfaces:**
- Produces `KnowledgeConflictPlan`, `KnowledgeConflictCandidate`, `KnowledgeConflictEvidenceReference`, `KnowledgeConflictRepository`, and stable validation/conflict errors.
- Extends knowledge-draft evidence with an exact `group_memory` reference.
- Reserves an optional content-free `knowledgeConflictCandidateId` on answer reply preparation.

- [ ] **Step 1: Write failing domain and migration tests**

```ts
it("accepts a fully referenced conflict plan", () => {
  expect(parseKnowledgeConflictPlan(JSON.stringify({
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
  }), new Set(["M1", "C1", "D1"]))).toMatchObject({ outcome: "conflict" });
});

it("rejects conflict without a source-message reference", () => {
  expect(() => parseKnowledgeConflictPlan(conflictJson({ groupCitationRefs: ["M1"] }),
    new Set(["M1", "D1"]))).toThrow("source-message");
});
```

In `migration-runner.test.ts`, read `0046_knowledge_conflict_candidates.sql` and assert the exact table names, status checks, unique keys, append-only triggers, the `group_memory` evidence constraint, and the answer delivery candidate reference.

- [ ] **Step 2: Run the focused tests and verify RED**

```powershell
npm --workspace apps/core test -- knowledge-conflict.test.ts migration-runner.test.ts
```

Expected: FAIL because the conflict contracts and migration do not exist.

- [ ] **Step 3: Implement bounded domain values**

```ts
export const KNOWLEDGE_CONFLICT_OUTCOMES = [
  "conflict", "no_conflict", "insufficient_evidence",
] as const;
export const KNOWLEDGE_CONFLICT_CANDIDATE_STATUSES = [
  "pending_review", "dismissed", "approved_for_delivery",
  "delivered", "draft_created", "superseded",
] as const;
export const KNOWLEDGE_CONFLICT_SCAN_STATUSES = [
  "pending", "processing", "retry", "completed", "dead_lettered",
] as const;
export const KNOWLEDGE_CONFLICT_DELIVERY_STATUSES = [
  "pending", "processing", "external_attempting", "sent",
  "failed", "outcome_unknown", "cancelled",
] as const;

export type KnowledgeConflictPlan = {
  outcome: "conflict" | "no_conflict" | "insufficient_evidence";
  subject: string;
  knowledgeBaseStatement: string | null;
  knowledgeBaseCitationRefs: string[];
  groupConclusionStatement: string | null;
  groupCitationRefs: string[];
  difference: string | null;
  suggestedUpdate: string | null;
  targetDocumentRef: string | null;
  missingEvidence: string[];
  confidence: "high" | "medium" | "low";
};
```

Enforce exact fields, NFC-trimmed bounded strings, unique/sorted refs, `D1..D12`, `M1`, `C1..C10`, and outcome-specific invariants. `conflict` requires `M1`, at least one `C*`, at least one `D*`, a target in the document refs, and medium/high confidence. `no_conflict` and `insufficient_evidence` contain no difference, target, or suggestion.

- [ ] **Step 4: Add migration `0046_knowledge_conflict_candidates.sql`**

Create:

- `knowledge_conflict_scan_inbox`, unique on `(group_memory_id, memory_updated_at)`, with claim lease, bounded attempts, next attempt, terminal outcome, and content-free error code;
- `knowledge_conflict_candidates`, unique on `idempotency_key`, with exact memory/source/snapshot fingerprints and the six candidate states;
- append-only `knowledge_conflict_evidence`, unique on `(candidate_id, evidence_type, reference_id)` for message, memory, document source, snapshot, and fragment identities;
- append-only `knowledge_conflict_candidate_events` with operation key, actor type/reference, versions, reason code, and time;
- `knowledge_conflict_delivery_outbox`, unique on `candidate_id`, with external-attempt and reconciliation fields;
- append-only `knowledge_conflict_interactions`, unique on callback operation key, with action/result and optional draft ID;
- append-only `answer_reply_knowledge_conflicts`, unique on `delivery_id`, binding an answer receipt to one candidate;
- a nullable `knowledge_conflict_candidate_id` identity field on `answer_reply_deliveries`, included in preparation identity;
- a forward alteration of `knowledge_draft_evidence` so `group_memory` requires source group and `source_updated_at`, while document evidence keeps its existing rule.

Use existing `knowledge_draft_append_only_guard()` triggers. Keep candidate summaries bounded and do not persist prompts, denied content, or raw model responses.

```sql
CREATE UNIQUE INDEX knowledge_conflict_one_live_evidence_idx
  ON knowledge_conflict_candidates (
    group_memory_id, memory_updated_at, target_snapshot_id, target_content_hash,
    detector_contract_version
  );

CREATE UNIQUE INDEX knowledge_conflict_one_delivery_idx
  ON knowledge_conflict_delivery_outbox (candidate_id);
```

- [ ] **Step 5: Extend the knowledge-draft evidence union**

```ts
type GroupMemoryEvidence = {
  type: "group_memory";
  id: string;
  groupId: string;
  expectedUpdatedAt: Date;
};
```

Persist and reload `group_memory` evidence through `source_group_id` and `source_updated_at`. In `findInvalidKnowledgeDraftEvidence`, require the memory to exist, remain `active`, remain in the source group, and match `expectedUpdatedAt` exactly. Add `memory_missing`, `memory_superseded`, and `memory_timestamp_changed` to `KnowledgeDraftEvidenceInvalidReason` if the existing union lacks equivalent stable reasons.

- [ ] **Step 6: Run GREEN tests and commit**

```powershell
npm --workspace apps/core test -- knowledge-conflict.test.ts migration-runner.test.ts knowledge-draft-state-machine.test.ts postgres-knowledge-draft-repository.test.ts
git add apps/core/migrations/0046_knowledge_conflict_candidates.sql apps/core/src/knowledge-conflicts/knowledge-conflict.ts apps/core/src/knowledge-conflicts/knowledge-conflict-repository.ts apps/core/src/knowledge-governance/knowledge-draft.ts apps/core/src/knowledge-governance/knowledge-draft-repository.ts apps/core/src/knowledge-governance/postgres-knowledge-draft-repository.ts apps/core/src/knowledge-governance/postgres-knowledge-draft-evidence.ts apps/core/src/answer-replies/answer-reply-repository.ts apps/core/tests/knowledge-conflict.test.ts apps/core/tests/migration-runner.test.ts apps/core/tests/postgres-knowledge-draft-repository.test.ts
git commit -m "feat(core): define knowledge conflict facts"
```

Expected: focused tests PASS; no earlier evidence variant changes behavior.

---

### Task 2: Implement Durable Scan And Candidate Persistence

**Files:**
- Create: `apps/core/src/knowledge-conflicts/postgres-knowledge-conflict-repository.ts`
- Create: `apps/core/tests/postgres-knowledge-conflict-repository.test.ts`
- Modify: `apps/core/src/knowledge-conflicts/knowledge-conflict-repository.ts`

**Interfaces:**
- Produces discovery, claim, lease recovery, retry/dead-letter, replay/delete, candidate persistence, current-state validation, governance transition, delivery, interaction, overlap, event, and count methods.

- [ ] **Step 1: Write failing inbox lifecycle tests**

Cover eligible discovery, ineligible category/scope/confidence/importance/no-evidence, allowlist exclusion, duplicate discovery, new corrected memory identity, superseded memory exclusion, `SKIP LOCKED` claims, expired lease recovery, bounded retry, dead-letter, replay, and delete.

```ts
const claim = await repository.claimNextScan({
  workerId: "conflict-scanner-1",
  at: instant("2026-08-13T02:00:00Z"),
  leaseUntil: instant("2026-08-13T02:00:30Z"),
});
expect(claim?.scan.status).toBe("processing");
expect(claim?.memory.id).toBe("memory-1");
```

- [ ] **Step 2: Run RED**

```powershell
npm --workspace apps/core test -- postgres-knowledge-conflict-repository.test.ts
```

Expected: FAIL because the Postgres adapter does not exist.

- [ ] **Step 3: Implement discovery and scan transitions**

Use one transaction per batch. Discovery selects directly from `group_memories`, joins current non-tombstoned `conversation_messages`, filters the approved categories/thresholds/allowlist, and anti-joins the inbox identity. Claims use `FOR UPDATE SKIP LOCKED`; only the lease owner can complete/fail a processing row.

```ts
discoverEligibleScans(input: {
  groupIds: readonly string[];
  limit: number;
  at: Date;
}): Promise<{ discovered: number; existing: number }>;

failScan(input: {
  scanId: string;
  workerId: string;
  classification: "retryable" | "permanent";
  errorCode: string;
  retryAt?: Date;
  at: Date;
}): Promise<{ status: "retry" | "dead_lettered" }>;
```

- [ ] **Step 4: Write failing candidate transaction tests**

Cover identical replay, conflicting operation identity, stale memory/source/snapshot rejection, exact evidence inserts, candidate/event append-only facts, superseding live candidates, version-bound dismiss/approve, one delivery, outbox claim/begin/complete/fail/reconcile, duplicate interaction, and exact overlap reads.

- [ ] **Step 5: Implement atomic candidate/governance/delivery methods**

`recordDetectionResult` locks scan, memory, source, and snapshot in deterministic order. It rechecks active memory, evidence messages/tombstones, source policy/timestamp, latest snapshot/content hash/version, and a caller-supplied live-permission attestation timestamp before inserting. A non-conflict completes only the scan. A conflict inserts candidate, evidence, event, and completes the scan in one transaction.

`approveForDelivery` uses optimistic candidate versioning and inserts exactly one pending outbox row. `dismissCandidate` and callback dismissal share the same stable transition primitive but record distinct actor types. `findCurrentOverlap` returns a candidate only when both exact memory ID and exact document-source/snapshot identity are present.

- [ ] **Step 6: Run GREEN and commit**

```powershell
npm --workspace apps/core test -- postgres-knowledge-conflict-repository.test.ts
git add apps/core/src/knowledge-conflicts/knowledge-conflict-repository.ts apps/core/src/knowledge-conflicts/postgres-knowledge-conflict-repository.ts apps/core/tests/postgres-knowledge-conflict-repository.test.ts
git commit -m "feat(core): persist knowledge conflict lifecycle"
```

---

### Task 3: Add Knowledge-Purpose Retrieval And Chronology

**Files:**
- Create: `apps/core/src/knowledge-conflicts/knowledge-conflict-evidence-builder.ts`
- Create: `apps/core/tests/knowledge-conflict-evidence-builder.test.ts`
- Modify: `apps/core/src/documents/document-fragment-repository.ts`
- Modify: `apps/core/tests/document-fragment-repository.test.ts`
- Modify: `apps/core/src/conversation/conversation-message-repository.ts`
- Modify: `apps/core/src/conversation/postgres-conversation-message-repository.ts`
- Modify: `apps/core/tests/postgres-conversation-message-repository.test.ts`

**Interfaces:**
- Adds `usage?: "answering" | "knowledge_drafts"` to semantic fragment search, defaulting to `answering`.
- Adds exact message lookup for source evidence.
- Produces a detector input only after policy, chronology, source-window, and live-permission gates pass.

- [ ] **Step 1: Write failing repository-purpose tests**

Assert `usage: "knowledge_drafts"` filters on `can_use_for_knowledge_drafts = true` rather than `can_use_for_answering`, while the omitted usage keeps existing answer SQL and behavior.

- [ ] **Step 2: Write failing evidence-builder tests**

Cover:

- only authorized Wiki sources in target-policy spaces;
- `synced` plus `readable|unknown`, blank-fragment exclusion, max three fragments per source, max twelve total;
- live permission before returning any fragment text;
- permission denial returns `permission_blocked` without detector input;
- every evidence message strictly later than target snapshot;
- equal/earlier/missing/tombstoned/wrong-group message returns `insufficient_evidence`;
- exact source ID, source `updatedAt`, snapshot ID/version/hash/fetchedAt, fragment IDs/hashes, memory ID/updatedAt, and message IDs/times in the current fingerprint.

- [ ] **Step 3: Run RED**

```powershell
npm --workspace apps/core test -- document-fragment-repository.test.ts knowledge-conflict-evidence-builder.test.ts
```

- [ ] **Step 4: Implement purpose-specific search and exact message reads**

```ts
export type SearchSimilarFragmentsInput = {
  embeddingProfileId: string;
  embedding: number[];
  limit: number;
  sourceTypes?: DocumentSourceType[];
  groupId?: string;
  usage?: "answering" | "knowledge_drafts";
};
```

Select the boolean column from a fixed enum mapping; never interpolate caller-provided SQL identifiers. Add `findByIds({ chatId, ids })` to `ConversationMessageRepository` with deterministic ID ordering and tombstone visibility handled by the evidence builder.

- [ ] **Step 5: Implement the evidence builder**

```ts
export type KnowledgeConflictEvidenceBuildResult =
  | { outcome: "ready"; input: KnowledgeConflictDetectionInput; fingerprint: CurrentConflictFingerprint }
  | { outcome: "insufficient_evidence"; reasonCode: string }
  | { outcome: "permission_blocked"; reasonCode: string }
  | { outcome: "retryable_failure"; reasonCode: string };
```

Embed only normalized memory content. Load the group's enabled publication target policy and restrict Wiki sources to its authorized space. Retrieve IDs/metadata first, call the existing Feishu permission checker per unique source, and only then materialize selected fragment text into `DetectionInput`. Treat permission checker exceptions as fail-closed and content-free.

- [ ] **Step 6: Run GREEN and commit**

```powershell
npm --workspace apps/core test -- document-fragment-repository.test.ts knowledge-conflict-evidence-builder.test.ts postgres-conversation-message-repository.test.ts
git add apps/core/src/documents/document-fragment-repository.ts apps/core/src/conversation/conversation-message-repository.ts apps/core/src/conversation/postgres-conversation-message-repository.ts apps/core/src/knowledge-conflicts/knowledge-conflict-evidence-builder.ts apps/core/tests/document-fragment-repository.test.ts apps/core/tests/knowledge-conflict-evidence-builder.test.ts
git commit -m "feat(core): build authorized conflict evidence"
```

---

### Task 4: Implement The Strict Conflict Detector

**Files:**
- Create: `apps/core/src/knowledge-conflicts/openai-compatible-knowledge-conflict-detector.ts`
- Create: `apps/core/tests/openai-compatible-knowledge-conflict-detector.test.ts`
- Modify: `apps/core/src/knowledge-conflicts/knowledge-conflict.ts`

**Interfaces:**
- Produces `KnowledgeConflictDetector.detect(input): Promise<KnowledgeConflictPlan>`.
- Uses the existing OpenAI-compatible chat-completions client and a strict JSON Schema response format.

- [ ] **Step 1: Write failing parser/provider tests**

Test valid three outcomes; malformed JSON; unknown/missing fields; oversized values; duplicate/out-of-window refs; target not in document refs; missing memory/message/document refs; mixed subject; embedded prompt injection treated as data; one invalid response followed by valid; two invalid responses fail closed; transport errors propagate without correction retry.

- [ ] **Step 2: Run RED**

```powershell
npm --workspace apps/core test -- openai-compatible-knowledge-conflict-detector.test.ts knowledge-conflict.test.ts
```

- [ ] **Step 3: Implement strict schema and prompt**

```ts
const responseFormat = {
  type: "json_schema" as const,
  json_schema: {
    name: "iris_knowledge_conflict",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: [
        "outcome", "subject", "knowledgeBaseStatement",
        "knowledgeBaseCitationRefs", "groupConclusionStatement",
        "groupCitationRefs", "difference", "suggestedUpdate",
        "targetDocumentRef", "missingEvidence", "confidence",
      ],
      properties: {
        outcome: { type: "string", enum: ["conflict", "no_conflict", "insufficient_evidence"] },
        knowledgeBaseCitationRefs: { type: "array", maxItems: 12, items: { type: "string", enum: documentRefs } },
        groupCitationRefs: { type: "array", maxItems: 11, items: { type: "string", enum: groupRefs } },
        targetDocumentRef: { type: ["string", "null"], enum: [...documentRefs, null] },
      },
    },
  },
};
```

Complete all remaining property schemas with bounded local validation. The system prompt states that every memory/message/document field is untrusted evidence; the model must compare the same exact subject, cannot choose official truth, and cannot authorize actions. Retry once only for `KnowledgeConflictValidationError`, with a fresh correction prompt that contains the local validation reason but not the raw invalid response.

- [ ] **Step 4: Run GREEN and commit**

```powershell
npm --workspace apps/core test -- openai-compatible-knowledge-conflict-detector.test.ts knowledge-conflict.test.ts
git add apps/core/src/knowledge-conflicts/knowledge-conflict.ts apps/core/src/knowledge-conflicts/openai-compatible-knowledge-conflict-detector.ts apps/core/tests/openai-compatible-knowledge-conflict-detector.test.ts
git commit -m "feat(core): detect structured knowledge conflicts"
```

---

### Task 5: Build The Scanner, Retry Loop, And DLQ Operations

**Files:**
- Create: `apps/core/src/knowledge-conflicts/knowledge-conflict-scanner.ts`
- Create: `apps/core/src/knowledge-conflicts/knowledge-conflict-scanner-loop.ts`
- Create: `apps/core/tests/knowledge-conflict-scanner.test.ts`
- Create: `apps/core/tests/knowledge-conflict-scanner-loop.test.ts`
- Modify: `apps/core/src/knowledge-conflicts/knowledge-conflict-repository.ts`

**Interfaces:**
- Produces `scanBatch({ limit })`, `start`, `stop`, and content-free snapshots.
- Enforces the application gate before discovery, retrieval, model invocation, and persistence.

- [ ] **Step 1: Write failing scanner tests**

Cover default-off/no-group no-op; discovery then claim; insufficient and permission-blocked terminal outcomes; no-conflict without candidate; conflict candidate with exact evidence; stale fingerprint after model call; provider retry and exhaustion; one subject failure not blocking the next; deterministic backoff; closed loop cannot restart.

- [ ] **Step 2: Run RED**

```powershell
npm --workspace apps/core test -- knowledge-conflict-scanner.test.ts knowledge-conflict-scanner-loop.test.ts
```

- [ ] **Step 3: Implement orchestration and classifications**

```ts
export type KnowledgeConflictScannerBatchResult = {
  discovered: number;
  claimed: number;
  conflict: number;
  noConflict: number;
  insufficientEvidence: number;
  permissionBlocked: number;
  retrying: number;
  deadLettered: number;
  superseded: number;
};
```

Run discovery before bounded claims. Recheck `canUseKnowledgeConflict(groupId)` for every claim and immediately before `recordDetectionResult`. Map capacity/transport/invalid-twice to retry; malformed persisted facts and impossible identities to permanent failure; stale facts to `superseded` completion. Use capped exponential backoff based only on attempt count.

- [ ] **Step 4: Implement polling lifecycle**

Follow existing scanner-loop lifecycle conventions: serialized batches, idempotent start/stop, no overlapping timer callbacks, startup error surfaced, later errors reflected in `latestBatch` and passed to `onError`, content-free counters only.

- [ ] **Step 5: Run GREEN and commit**

```powershell
npm --workspace apps/core test -- knowledge-conflict-scanner.test.ts knowledge-conflict-scanner-loop.test.ts
git add apps/core/src/knowledge-conflicts/knowledge-conflict-scanner.ts apps/core/src/knowledge-conflicts/knowledge-conflict-scanner-loop.ts apps/core/src/knowledge-conflicts/knowledge-conflict-repository.ts apps/core/tests/knowledge-conflict-scanner.test.ts apps/core/tests/knowledge-conflict-scanner-loop.test.ts
git commit -m "feat(core): scan knowledge conflict candidates"
```

---

### Task 6: Add Operator Governance API And Admin Console

**Files:**
- Create: `apps/core/src/knowledge-conflicts/knowledge-conflict-api.ts`
- Create: `apps/core/tests/knowledge-conflict-api.test.ts`
- Modify: `apps/core/src/admin-console/admin-console-assets.ts`
- Modify: `apps/core/tests/admin-console-assets.test.ts`
- Modify: `apps/core/src/app.ts`

**Interfaces:**
- Adds authenticated internal routes for candidate list/detail/events, dismiss, approve-delivery, scan dead letters, replay/delete, and delivery reconciliation.
- Adds a bounded Admin Console panel using the same internal bearer session.

- [ ] **Step 1: Write failing API tests**

Test missing runtime 503, invalid group/version/limit/reason 400, not found 404, version race 409, exact replay 200, approve creates one delivery, dismiss reason required, detail includes evidence identities but no source bodies, and DLQ responses contain no content.

Routes:

```text
GET  /internal/knowledge-conflicts/groups/:groupId/candidates?status=&limit=
GET  /internal/knowledge-conflicts/groups/:groupId/candidates/:candidateId
GET  /internal/knowledge-conflicts/groups/:groupId/candidates/:candidateId/events
POST /internal/knowledge-conflicts/groups/:groupId/candidates/:candidateId/dismiss
POST /internal/knowledge-conflicts/groups/:groupId/candidates/:candidateId/approve-delivery
GET  /internal/knowledge-conflicts/scans/dead-letters?limit=
POST /internal/knowledge-conflicts/scans/dead-letters/:scanId/replay
DELETE /internal/knowledge-conflicts/scans/dead-letters/:scanId
POST /internal/knowledge-conflicts/deliveries/:deliveryId/reconcile
```

- [ ] **Step 2: Run RED**

```powershell
npm --workspace apps/core test -- knowledge-conflict-api.test.ts admin-console-assets.test.ts
```

- [ ] **Step 3: Implement API with operator identity and optimistic versions**

Read operator identity from the existing authenticated internal request decoration/header convention. Bodies accept exact candidate version and a bounded reason or reconciliation outcome; they never accept an actor Open ID. Map stable repository errors explicitly and return `{ ok, outcome, candidateId, candidateVersion, deliveryId? }` only.

- [ ] **Step 4: Add the Admin panel**

Show group, subject, both bounded statements, difference, suggested update, confidence, target title/URI, snapshot/version labels, evidence IDs, current validation result, and candidate version. Add `Dismiss` and `Approve one delivery` controls with confirmation. Do not render hidden source bodies, prompts, actor IDs, tokens, or raw errors.

- [ ] **Step 5: Run GREEN and commit**

```powershell
npm --workspace apps/core test -- knowledge-conflict-api.test.ts admin-console-assets.test.ts admin-console-api.test.ts
git add apps/core/src/knowledge-conflicts/knowledge-conflict-api.ts apps/core/src/admin-console/admin-console-assets.ts apps/core/src/app.ts apps/core/tests/knowledge-conflict-api.test.ts apps/core/tests/admin-console-assets.test.ts
git commit -m "feat(core): review knowledge conflict candidates"
```

---

### Task 7: Deliver One Version-Bound Conflict Card

**Files:**
- Create: `apps/core/src/knowledge-conflicts/knowledge-conflict-card-renderer.ts`
- Create: `apps/core/src/knowledge-conflicts/knowledge-conflict-dispatcher.ts`
- Create: `apps/core/src/knowledge-conflicts/knowledge-conflict-dispatcher-loop.ts`
- Create: `apps/core/tests/knowledge-conflict-card-renderer.test.ts`
- Create: `apps/core/tests/knowledge-conflict-dispatcher.test.ts`
- Create: `apps/core/tests/knowledge-conflict-dispatcher-loop.test.ts`

**Interfaces:**
- Renders callback actions `create_update_draft` and `not_a_conflict`.
- Claims approved delivery rows, revalidates policy/runtime/evidence, sends once, and classifies external outcomes.

- [ ] **Step 1: Write failing renderer tests**

Assert both sides/difference/suggestion, uncertainty label, current safe source link only, byte/component limits, no actor IDs, and exact content-free callback value:

```ts
expect(button.value).toEqual({
  kind: "knowledge_conflict_confirmation",
  action: "create_update_draft",
  candidateId: "candidate-1",
  candidateVersion: "3",
  groupId: "oc_group",
  nonce: "nonce-1",
});
```

The card is rendered while the approved candidate is version 2, but binds `candidateVersion: "3"`, the exact version that `completeDelivery` must atomically commit with status `delivered` after a successful send. An outcome-unknown send leaves the candidate at version 2, so its callback fails closed until explicit reconciliation commits version 3.

- [ ] **Step 2: Write failing dispatcher tests**

Cover no send before operator approval; global/group/proactive/retrieval/draft gate disablement; stale memory/source/snapshot/version; live permission denial; bot not in group; deterministic send UUID; sent completion; request-not-sent retry; permanent remote rejection; outcome unknown reconciliation; duplicate claim after sent no-op.

- [ ] **Step 3: Run RED**

```powershell
npm --workspace apps/core test -- knowledge-conflict-card-renderer.test.ts knowledge-conflict-dispatcher.test.ts knowledge-conflict-dispatcher-loop.test.ts
```

- [ ] **Step 4: Implement card and dispatcher**

Call `beginDeliveryAttempt` immediately before the external API. Re-read all gates and candidate evidence after claim. Use the existing Feishu interactive card client with a stable UUID derived from delivery ID. Classify failures using the same `request_not_sent | retryable | permanent | outcome_unknown` boundary used by governed card delivery; never retry `outcome_unknown`.

- [ ] **Step 5: Implement dispatcher loop and commit**

```powershell
npm --workspace apps/core test -- knowledge-conflict-card-renderer.test.ts knowledge-conflict-dispatcher.test.ts knowledge-conflict-dispatcher-loop.test.ts
git add apps/core/src/knowledge-conflicts/knowledge-conflict-card-renderer.ts apps/core/src/knowledge-conflicts/knowledge-conflict-dispatcher.ts apps/core/src/knowledge-conflicts/knowledge-conflict-dispatcher-loop.ts apps/core/tests/knowledge-conflict-card-renderer.test.ts apps/core/tests/knowledge-conflict-dispatcher.test.ts apps/core/tests/knowledge-conflict-dispatcher-loop.test.ts
git commit -m "feat(core): deliver reviewed conflict cards"
```

---

### Task 8: Handle Authenticated Member Actions And Create One Draft

**Files:**
- Create: `apps/core/src/knowledge-conflicts/knowledge-conflict-interaction-worker.ts`
- Create: `apps/core/tests/knowledge-conflict-interaction-worker.test.ts`
- Modify: `apps/core/src/knowledge-cards/knowledge-card.ts`
- Modify: `apps/core/src/knowledge-cards/approval-interaction-worker.ts`
- Modify: `apps/core/src/runtime/knowledge-card-runtime.ts`
- Modify: `apps/core/src/feishu/feishu-card-action.ts`
- Modify: `apps/core/src/feishu/feishu-card-action-gateway.ts`
- Modify: `apps/core/tests/knowledge-card.test.ts`
- Modify: `apps/core/tests/approval-interaction-worker.test.ts`
- Modify: `apps/core/tests/feishu-card-action.test.ts`
- Modify: `apps/core/tests/feishu-card-action-gateway.test.ts`

**Interfaces:**
- Extends `ApprovalInteractionJob` with `knowledge_conflict_confirmation`.
- Delegates the job from the existing approval worker to `KnowledgeConflictInteractionWorker`.
- Creates a stable knowledge draft and existing presentation on `create_update_draft`.

- [ ] **Step 1: Write failing parser/queue tests**

Accept only the six exact callback fields plus version strings and bounded nonce. Reject unknown fields, noncanonical versions, group/message binding mismatch, form reasons, fake actor fields, and unrecognized actions. Verify Redis normalization/round-trip/dead-letter stays content-free.

```ts
export type KnowledgeConflictConfirmationInteractionJob = ApprovalInteractionJobCommon & {
  kind: "knowledge_conflict_confirmation";
  candidateId: string;
  candidateVersion: number;
  groupId: string;
  nonce: string;
  action: "create_update_draft" | "not_a_conflict";
};
```

- [ ] **Step 2: Write failing worker tests**

Cover bot actor, nonmember, membership outage, runtime disable, stale delivery/candidate/evidence, permission revocation, duplicate callback, conflicting callback under same operation key, dismiss action, stable draft identity, draft-created/presentation-failed retry, and exact medium-risk draft contents/evidence.

- [ ] **Step 3: Run RED**

```powershell
npm --workspace apps/core test -- knowledge-conflict-interaction-worker.test.ts knowledge-card.test.ts approval-interaction-worker.test.ts feishu-card-action.test.ts feishu-card-action-gateway.test.ts redis-approval-interaction-queue.test.ts
```

- [ ] **Step 4: Implement callback plumbing**

Extend the discriminated union, parser diagnostics, gateway job creation, Redis validator, and approval worker switch. The external callback value has exactly `kind`, `action`, `candidateId`, `candidateVersion`, `groupId`, and `nonce`; the gateway derives the internal common `presentationId` from `candidateId`, and the repository resolves the unique delivery then verifies the callback's Feishu message context. Do not change public callback URLs or authentication. `knowledge_conflict_confirmation` requires no free-text intent and therefore does not use the intent store.

- [ ] **Step 5: Implement exact draft conversion**

The worker checks runtime, exact group/message/delivery/candidate/version/nonce binding, non-bot actor, live membership, current evidence, current permission, and target policy immediately before mutation.

Build:

```ts
const revision: KnowledgeDraftRevisionInput = {
  sourceGroupId: candidate.groupId,
  title: `Knowledge update: ${candidate.subject}`,
  content: renderConflictDraftBody(candidate),
  riskLevel: "medium",
  reviewer: { type: "feishu_user", ref: job.actorOpenId },
  suggestedPublication: targetPolicySuggestion,
  evidence: [
    ...messageIds.map((id) => ({ type: "conversation_message" as const, id, groupId: candidate.groupId })),
    { type: "group_memory", id: candidate.groupMemoryId, groupId: candidate.groupId,
      expectedUpdatedAt: candidate.memoryUpdatedAt },
    { type: "document_source", id: candidate.targetDocumentSourceId,
      expectedUpdatedAt: candidate.targetSourceUpdatedAt },
  ],
};
```

Derive draft ID/creation operation key and presentation operation key from candidate ID. Commit interaction plus `draft_created` candidate transition only after `createDraft` returns applied/already-applied. If presentation fails, retry `presentKnowledgeDraft` using the same draft/presentation identity without creating a second draft. `not_a_conflict` commits one interaction and dismisses only that candidate.

- [ ] **Step 6: Run GREEN and commit**

```powershell
npm --workspace apps/core test -- knowledge-conflict-interaction-worker.test.ts knowledge-card.test.ts approval-interaction-worker.test.ts feishu-card-action.test.ts feishu-card-action-gateway.test.ts redis-approval-interaction-queue.test.ts
git add apps/core/src/knowledge-conflicts/knowledge-conflict-interaction-worker.ts apps/core/src/knowledge-cards/knowledge-card.ts apps/core/src/knowledge-cards/approval-interaction-worker.ts apps/core/src/runtime/knowledge-card-runtime.ts apps/core/src/feishu/feishu-card-action.ts apps/core/src/feishu/feishu-card-action-gateway.ts apps/core/tests/knowledge-conflict-interaction-worker.test.ts apps/core/tests/knowledge-card.test.ts apps/core/tests/approval-interaction-worker.test.ts apps/core/tests/feishu-card-action.test.ts apps/core/tests/feishu-card-action-gateway.test.ts
git commit -m "feat(core): convert conflicts into governed drafts"
```

---

### Task 9: Expose Current Conflicts In Grounded Answers And Receipts

**Files:**
- Create: `apps/core/src/knowledge-conflicts/knowledge-conflict-answer-provider.ts`
- Create: `apps/core/tests/knowledge-conflict-answer-provider.test.ts`
- Modify: `apps/core/src/agent/evidence-plan.ts`
- Modify: `apps/core/src/agent/answer-draft-orchestrator.ts`
- Modify: `apps/core/src/model/openai-compatible-evidence-planner.ts`
- Modify: `apps/core/src/model/openai-compatible-grounded-answer-renderer.ts`
- Modify: `apps/core/src/runtime/answer-draft-runtime.ts`
- Modify: `apps/core/src/conversation/feishu-mention-answer-responder.ts`
- Modify: `apps/core/src/answer-replies/answer-reply-delivery-service.ts`
- Modify: `apps/core/src/answer-replies/postgres-answer-reply-repository.ts`
- Modify: `apps/core/src/answer-replies/answer-reply-receipt-validator.ts`
- Modify: `apps/core/src/answer-replies/answer-reply-api.ts`
- Modify: `apps/core/tests/evidence-plan.test.ts`
- Modify: `apps/core/tests/answer-draft-orchestrator.test.ts`
- Modify: `apps/core/tests/openai-compatible-evidence-planner.test.ts`
- Modify: `apps/core/tests/openai-compatible-grounded-answer-renderer.test.ts`
- Modify: `apps/core/tests/feishu-mention-answer-responder.test.ts`
- Modify: `apps/core/tests/answer-reply-delivery-service.test.ts`
- Modify: `apps/core/tests/postgres-answer-reply-repository.test.ts`

**Interfaces:**
- Adds `conflict` to application evidence state validation and renderer output.
- Keeps `conflict` absent from the model planner's response schema and parser path.
- Adds optional `knowledgeConflictCandidateId` to answer result/preparation/receipt identity.

- [ ] **Step 1: Write failing evidence-plan tests**

Create a dedicated deterministic builder rather than allowing JSON parse to originate conflict:

```ts
const result = createConflictEvidencePlan({
  candidateId: "candidate-1",
  knowledgePremise: { citationRef: "D1", statement: "Current KB threshold is 5,000." },
  groupPremise: { citationRef: "M1", statement: "New group threshold is 10,000." },
  proposedAnswer: "Conflict found: the KB says 5,000; the newer group conclusion says 10,000.",
  confidence: "high",
});
expect(result.plan.evidenceState).toBe("conflict");
```

Require at least one `D*` and one group ref, no missing information, medium/high matching candidate confidence, no resolution, and exact candidate ID in the wrapper. Assert `parseEvidencePlanContent` rejects model JSON with `evidenceState: "conflict"`, and the planner JSON Schema does not list it.

- [ ] **Step 2: Write failing answer-provider/orchestrator tests**

Cover exact overlap forcing deterministic conflict before planner invocation; no candidate/unrelated/dismissed/superseded/stale/permission-denied candidate falling through to ordinary planner; both sides visible; no winner; only document refs in `citedSourceRefs`; candidate ID in answer result and observer metadata.

- [ ] **Step 3: Write failing receipt tests**

Assert the responder passes candidate ID into preparation; repository stores the candidate FK and append-only `answer_reply_knowledge_conflicts` row; exact replay with same ID succeeds; changed/removed candidate ID conflicts; receipt APIs expose only the ID, never candidate text.

- [ ] **Step 4: Run RED**

```powershell
npm --workspace apps/core test -- evidence-plan.test.ts knowledge-conflict-answer-provider.test.ts answer-draft-orchestrator.test.ts openai-compatible-evidence-planner.test.ts openai-compatible-grounded-answer-renderer.test.ts feishu-mention-answer-responder.test.ts answer-reply-delivery-service.test.ts postgres-answer-reply-repository.test.ts
```

- [ ] **Step 5: Implement deterministic answer override**

After context assembly and permission filtering, build the ordinary evidence array, then call the provider with exact `usedGroupMemories` and `allowedFragments`. If a current overlap exists, map the candidate's target source to its `D*` ref and memory to its `M*` ref, construct the conflict plan locally, and skip evidence-planner sampling. Still run the bounded renderer with a conflict-specific instruction:

```text
Label this as a possible conflict. State the current synchronized knowledge and the newer group
conclusion separately, describe the material difference, and offer the reviewed update-draft path.
Do not select a winner, merge the statements, or increase confidence.
```

Extend renderer validation to accept `conflict`; keep planner schema enums unchanged. Add candidate ID to `AnswerDraftResult` and turn-completed metadata.

- [ ] **Step 6: Persist answer receipt identity**

Thread optional candidate ID through `PreparedAnswer`, `PrepareAnswerReplyInput`, semantic fingerprinting, Postgres insert/load, receipt validation, and internal receipt API. Insert `answer_reply_knowledge_conflicts` in the same preparation transaction. Existing receipts with null candidate remain valid.

- [ ] **Step 7: Run GREEN and commit**

```powershell
npm --workspace apps/core test -- evidence-plan.test.ts knowledge-conflict-answer-provider.test.ts answer-draft-orchestrator.test.ts openai-compatible-evidence-planner.test.ts openai-compatible-grounded-answer-renderer.test.ts feishu-mention-answer-responder.test.ts answer-reply-delivery-service.test.ts postgres-answer-reply-repository.test.ts answer-reply-api.test.ts
git add apps/core/src/knowledge-conflicts/knowledge-conflict-answer-provider.ts apps/core/src/agent/evidence-plan.ts apps/core/src/agent/answer-draft-orchestrator.ts apps/core/src/model/openai-compatible-evidence-planner.ts apps/core/src/model/openai-compatible-grounded-answer-renderer.ts apps/core/src/runtime/answer-draft-runtime.ts apps/core/src/conversation/feishu-mention-answer-responder.ts apps/core/src/answer-replies/answer-reply-repository.ts apps/core/src/answer-replies/answer-reply-delivery-service.ts apps/core/src/answer-replies/postgres-answer-reply-repository.ts apps/core/src/answer-replies/answer-reply-receipt-validator.ts apps/core/src/answer-replies/answer-reply-api.ts apps/core/tests/knowledge-conflict-answer-provider.test.ts apps/core/tests/evidence-plan.test.ts apps/core/tests/answer-draft-orchestrator.test.ts apps/core/tests/openai-compatible-evidence-planner.test.ts apps/core/tests/openai-compatible-grounded-answer-renderer.test.ts apps/core/tests/feishu-mention-answer-responder.test.ts apps/core/tests/answer-reply-delivery-service.test.ts apps/core/tests/postgres-answer-reply-repository.test.ts apps/core/tests/answer-reply-api.test.ts
git commit -m "feat(core): expose conflicts in grounded answers"
```

---

### Task 10: Compose Runtime, Flags, Status, And Readiness

**Files:**
- Create: `apps/core/src/runtime/knowledge-conflict-runtime.ts`
- Create: `apps/core/tests/knowledge-conflict-runtime.test.ts`
- Modify: `apps/core/src/config/env.ts`
- Modify: `apps/core/tests/runtime-config.test.ts`
- Modify: `apps/core/src/app.ts`
- Modify: `apps/core/tests/server-startup.test.ts`
- Modify: `apps/core/tests/internal-status-snapshot.test.ts`
- Modify: `apps/core/src/admin/internal-rollout-readiness.ts`
- Modify: `apps/core/tests/internal-rollout-readiness.test.ts`
- Modify: `apps/core/src/runtime/runtime-close.ts`

**Interfaces:**
- Produces one default-off runtime with scanner, dispatcher, interaction delegate, answer provider, repository, status, lazy access to the existing presentation runtime, and orderly close.
- Adds content-free `/internal/status` and fail-closed readiness checks.

- [ ] **Step 1: Write failing config tests**

```ts
expect(readKnowledgeConflictRuntimeConfig({})).toEqual({ enabled: false });
expect(() => readKnowledgeConflictRuntimeConfig({
  IRIS_KNOWLEDGE_CONFLICT_ENABLED: "true",
  IRIS_KNOWLEDGE_CONFLICT_GROUP_ALLOWLIST: "",
})).toThrow("ALLOWLIST");
```

When enabled, require valid Database/model/embedding/Feishu/Redis dependencies, knowledge cards, action approvals, explicit nonempty unique groups, safe timer/batch/lease/attempt bounds, and ensure conflict groups are subsets of knowledge-card/action-approval group lists.

- [ ] **Step 2: Write failing runtime/lifecycle tests**

Cover disabled returns undefined without opening resources; required dependency failures close earlier resources once; scanner starts after knowledge cards/action approvals; dispatcher starts after scanner startup; status count failures degrade; close order stops loops before Redis/Postgres; startup rejection reaches app readiness and server startup.

- [ ] **Step 3: Run RED**

```powershell
npm --workspace apps/core test -- runtime-config.test.ts knowledge-conflict-runtime.test.ts server-startup.test.ts internal-status-snapshot.test.ts internal-rollout-readiness.test.ts
```

- [ ] **Step 4: Implement runtime composition**

Build shared Postgres repositories, source/snapshot/fragment/message/group-memory readers, embedding provider/profile, Feishu token/permission/membership/card clients, detector client, scanner/dispatcher loops, and interaction worker. The conflict runtime owns its own adapters over the shared Postgres facts. Accept `getKnowledgeCardPresentationRuntime()` as a lazy dependency so it can be constructed before the existing knowledge-card worker, but require that dependency to resolve before a callback can present a created draft. Expose:

```ts
export type KnowledgeConflictRuntime = {
  repository: KnowledgeConflictRepository;
  answerProvider: KnowledgeConflictAnswerProvider;
  interactionWorker: KnowledgeConflictInteractionWorker;
  canUseKnowledgeConflict(groupId: string): boolean;
  start(): Promise<void>;
  getStatus(): Promise<KnowledgeConflictRuntimeStatus>;
  close(): Promise<void>;
};
```

The constructor dependency includes:

```ts
getKnowledgeCardPresentationRuntime(): KnowledgeDraftPresentationRuntime | undefined;
```

The interaction worker returns the existing retryable `internal_error` result if the getter is unresolved; it never treats startup order as permission to skip presentation.

`canUseKnowledgeConflict` requires lifecycle started, allowlist membership, global/group runtime enabled, document read, knowledge retrieval, knowledge-draft generation, and proactive speech for delivery. The evidence builder and answer provider additionally use the existing stage-specific gates so a disabled proactive gate does not suppress a user-requested conflict answer, while it does suppress unsolicited delivery.

- [ ] **Step 5: Wire app, status, and readiness**

Create the conflict runtime before answer-draft and knowledge-card worker construction. Pass its answer provider into the answer runtime and its interaction delegate into the existing approval worker. The lazy presentation getter resolves only after `knowledgeCardRuntime` has been assigned. Start the conflict scanner/dispatcher only after knowledge-card and action-approval runtimes have started. Register API with the repository/runtime. Add content-free counts for scan states, candidate states, outbox states, interaction results, and reconciliation. Readiness passes when disabled; when enabled it fails for missing migration, stopped loops, unreadable counts, dead letters, terminal failures, or `outcome_unknown` rows.

- [ ] **Step 6: Run GREEN and commit**

```powershell
npm --workspace apps/core test -- runtime-config.test.ts knowledge-conflict-runtime.test.ts server-startup.test.ts internal-status-snapshot.test.ts internal-rollout-readiness.test.ts internal-readiness-api.test.ts runtime-close.test.ts
git add apps/core/src/runtime/knowledge-conflict-runtime.ts apps/core/src/config/env.ts apps/core/src/app.ts apps/core/src/admin/internal-rollout-readiness.ts apps/core/src/runtime/runtime-close.ts apps/core/tests/knowledge-conflict-runtime.test.ts apps/core/tests/runtime-config.test.ts apps/core/tests/server-startup.test.ts apps/core/tests/internal-status-snapshot.test.ts apps/core/tests/internal-rollout-readiness.test.ts
git commit -m "feat(core): compose knowledge conflict runtime"
```

---

### Task 11: Add Boundary Tests, Defaults, And Operator Runbook

**Files:**
- Create: `docs/runbooks/iris-knowledge-conflict-acceptance.md`
- Create: `docs/pull-requests/2026-08-13-iris-knowledge-conflict-candidate.md`
- Modify: `deploy/pilot/ci.env`
- Modify: `deploy/pilot/docker-compose.yml`
- Modify: `scripts/pilot-compose.test.mjs`
- Modify: `scripts/pilot-smoke-lib.test.mjs`
- Modify: `scripts/pilot-operations.test.mjs`
- Modify: `README.md`

**Interfaces:**
- Freezes default-off Compose behavior and an exact-SHA, one-group live acceptance/rollback procedure.

- [ ] **Step 1: Write failing pilot contract tests**

Assert committed defaults include:

```dotenv
IRIS_KNOWLEDGE_CONFLICT_ENABLED=false
IRIS_KNOWLEDGE_CONFLICT_GROUP_ALLOWLIST=
```

Assert Compose passes both variables to Core, smoke rejects a true default or nonempty allowlist, public Caddy still exposes no `/internal/knowledge-conflicts/*`, and rollback stops queue growth while preserving Postgres facts.

- [ ] **Step 2: Run RED**

```powershell
npm run test:pilot
npm run pilot:config
```

- [ ] **Step 3: Update deployment defaults and boundary tests**

Keep all committed values off/empty. Do not include real group IDs, tokens, Wiki URLs, or credentials. Add no new public route.

- [ ] **Step 4: Write the executable acceptance runbook**

The runbook must:

1. record the exact local SHA/image digest and require a clean worktree;
2. inventory every bot group and select exactly one pilot plus at least one nonpilot control;
3. confirm flags off, queues/DLQs/outboxes/reconciliation empty, and current readiness green;
4. create or identify one controlled authorized Wiki page/snapshot and a normal pilot conversation with a strictly later incompatible conclusion;
5. privately enable only the pilot allowlist and required capabilities, then verify status/readiness;
6. prove exactly one scan/candidate with exact evidence bindings;
7. ask an ordinary question and prove the answer exposes both sides without resolution;
8. prove no conflict card before operator approval, then approve exactly one delivery;
9. exercise member draft creation, duplicate delivery/callback replay, no-conflict control, related-subject control, nonmember denial, and permission/snapshot revocation;
10. verify one medium-risk `knowledge_conflict` draft enters the existing confirmation/review/publication path, every queue drains, no unknown/terminal failures remain, and nonpilot groups have zero new facts;
11. disable the conflict flag/allowlist and durable group/global capabilities unless a separate daily-pilot decision is recorded;
12. record only IDs, versions, hashes, counts, timestamps, image digest, and observed pass/fail facts—never message/document bodies or secrets.

Every failure after enablement invokes rollback: stop Caddy, disable the conflict flag and allowlist, durable-disable pilot/global and write capabilities, recreate Core, verify no new claims/sends, retain append-only facts, and report the failed step.

- [ ] **Step 5: Update README and PR evidence template**

Describe the loop as pending until live acceptance succeeds. Explicitly state that it creates a governed update draft and does not edit the existing Wiki page in place.

- [ ] **Step 6: Run GREEN and commit**

```powershell
npm run test:pilot
npm run readiness -- --env-file deploy/pilot/ci.env
npm run pilot:config
git diff --check
git add deploy/pilot/ci.env deploy/pilot/docker-compose.yml scripts/pilot-compose.test.mjs scripts/pilot-smoke-lib.test.mjs scripts/pilot-operations.test.mjs docs/runbooks/iris-knowledge-conflict-acceptance.md docs/pull-requests/2026-08-13-iris-knowledge-conflict-candidate.md README.md
git commit -m "docs: add knowledge conflict acceptance gate"
```

Expected: pilot tests PASS; readiness reports the safely disabled feature; Compose renders false/empty defaults.

---

### Task 12: Verify Exact SHA, Review, And Close With A Real Pilot

**Files:**
- Modify after observed results: `docs/pull-requests/2026-08-13-iris-knowledge-conflict-candidate.md`
- Modify after observed results: `docs/runbooks/iris-knowledge-conflict-acceptance.md`
- Create after successful pilot: `docs/pilots/2026-08-13-iris-knowledge-conflict-acceptance.md`

**Exit rule:** Do not claim closure from code or local tests. Closure requires an exact reviewed SHA, green repository gates, and all ten design-spec live acceptance outcomes.

- [ ] **Step 1: Run focused Core suites from a clean process**

```powershell
npm --workspace apps/core test -- knowledge-conflict.test.ts postgres-knowledge-conflict-repository.test.ts knowledge-conflict-evidence-builder.test.ts openai-compatible-knowledge-conflict-detector.test.ts knowledge-conflict-scanner.test.ts knowledge-conflict-scanner-loop.test.ts knowledge-conflict-api.test.ts knowledge-conflict-card-renderer.test.ts knowledge-conflict-dispatcher.test.ts knowledge-conflict-dispatcher-loop.test.ts knowledge-conflict-interaction-worker.test.ts knowledge-conflict-answer-provider.test.ts
```

Expected: all focused suites PASS with no skips attributable to missing code. Database integration cases may use the repository's established `IRIS_TEST_DATABASE_URL` convention and must pass in CI with Postgres.

- [ ] **Step 2: Run the complete local gate**

```powershell
npm run verify
git status --short
```

Expected: `git diff --check`, TypeScript typecheck/build, Core tests, Python tests, pilot tests, Compose config, readiness, and pilot config all exit 0. Worktree contains only the intentional evidence-document updates before their commit.

- [ ] **Step 3: Perform an independent code review**

Use `superpowers:requesting-code-review`. Review against every design section and specifically inspect permission-before-text ordering, exact chronology, stale revalidation, append-only triggers, idempotency conflicts, outcome-unknown behavior, callback identity/membership, deterministic answer override, receipt binding, default-off rollout, and public-route boundaries. Fix release blockers with RED/GREEN regression tests; record non-blocking hardening separately.

- [ ] **Step 4: Commit review fixes and rerun the complete gate**

```powershell
npm run verify
git diff --check
git status --short
git rev-parse HEAD
```

Record the exact SHA only after the tree is clean.

- [ ] **Step 5: Require exact-SHA CI**

Push the branch through the repository's normal workflow and require every check for the exact SHA to pass. Do not accept a green run for an ancestor or a locally modified tree.

- [ ] **Step 6: Execute the live Feishu runbook**

Follow `docs/runbooks/iris-knowledge-conflict-acceptance.md` with one approved pilot group and one nonpilot control. Stop immediately and roll back for a permission leak, unrelated-source substitution, duplicate external side effect, false-certainty answer, unknown delivery outcome, or stale-evidence mutation.

- [ ] **Step 7: Record content-free pilot evidence and restore safe state**

Write `docs/pilots/2026-08-13-iris-knowledge-conflict-acceptance.md` with exact SHA/image digest, test/CI links or run IDs, group-role labels rather than raw IDs, candidate/delivery/draft IDs or hashes as allowed by repository policy, source snapshot/version/hash, counts, timestamps, each of the ten acceptance results, rollback state, and remaining follow-up backlog. Do not copy source statements, messages, tokens, or secrets.

- [ ] **Step 8: Commit evidence and mark the subproject closed only if all gates passed**

```powershell
git add docs/pilots/2026-08-13-iris-knowledge-conflict-acceptance.md docs/pull-requests/2026-08-13-iris-knowledge-conflict-candidate.md docs/runbooks/iris-knowledge-conflict-acceptance.md
git commit -m "docs: record knowledge conflict pilot acceptance"
git status --short
```

If any required live step failed, record the failure and rollback instead; keep the capability status open and do not use the closure wording.

---

## Follow-Up Backlog After Closure

- Governed exact-revision in-place Wiki update with a new high-impact action, idempotent Feishu `client_token`, and outcome-unknown reconciliation.
- Broader historical scans, more memory categories, cross-group comparison, bulk review, analytics, and multilingual cards.
- Semantic precision improvements only when pilot false-positive/false-negative evidence justifies them.
- No automatic model-selected official truth and no generic microservice extraction without a new architecture decision.
