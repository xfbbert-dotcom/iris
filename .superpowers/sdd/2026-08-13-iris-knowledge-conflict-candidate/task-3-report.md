# Task 3 Report: Knowledge-Purpose Retrieval And Chronology

## Status

`DONE_WITH_CONCERNS`

Task 3 is implemented and verified. No Task 4 detector, worker, governance, card, answer-injection,
or publication behavior was added.

## Commits

- `a8f296f51d6386b741424bbc9f363f55caca0c8a` — `feat(core): retrieve conflict chronology`
- `d59ddb38123fc6e2a8aa8de896b3d78c603ea563` — `fix(core): gate conflict text after permission`

## Files

- `apps/core/src/documents/document-fragment-repository.ts`
- `apps/core/src/conversation/conversation-message-repository.ts`
- `apps/core/src/conversation/postgres-conversation-message-repository.ts`
- `apps/core/src/knowledge-conflicts/knowledge-conflict-evidence-builder.ts`
- `apps/core/tests/document-fragment-repository.test.ts`
- `apps/core/tests/postgres-conversation-message-repository.test.ts`
- `apps/core/tests/knowledge-conflict-evidence-builder.test.ts`
- `apps/core/tests/event-worker-runtime.test.ts`
- `apps/core/tests/runtime-startup-promise.test.ts`

## Implemented Behavior

- Semantic fragment search accepts the closed purposes `answering` and `knowledge_drafts`; omitted
  purpose preserves answering behavior, while invalid runtime values fail before profile or SQL reads.
- Knowledge candidate retrieval is metadata-only and source-balanced in SQL: at most three candidates
  per document source are admitted before the bounded global candidate window.
- Exact fragment text is loaded by immutable fragment IDs only after every selected source passes a
  live Feishu permission check.
- Exact conversation-message lookup is bounded, deterministic, group-scoped, and exposes current
  deletion-tombstone state.
- Evidence building embeds only normalized memory content and requires one unambiguous enabled
  medium-risk target policy for the source group.
- Only synced `authorized_wiki_document` sources in the target policy space, locally `readable` or
  `unknown`, and enabled for knowledge drafts can contribute.
- Every source message must exist, remain in the source group, not be tombstoned, contain evidence
  text, and be strictly later than each included snapshot's `fetchedAt`.
- Detector input is bounded to twelve fragments and three per source, with exact memory, message,
  source, snapshot, source-version, snapshot-hash, fragment, and fragment-hash fingerprints.
- Permission errors, saturated target-policy reads, source-ID substitution, stale fragment identity,
  and provider/repository failures fail closed with content-free reason codes.

## TDD Evidence

### Initial RED

Command:

```powershell
npm --workspace apps/core test -- document-fragment-repository.test.ts knowledge-conflict-evidence-builder.test.ts postgres-conversation-message-repository.test.ts
```

Observed expected failures:

- evidence-builder module did not exist;
- `findByIds` did not exist;
- knowledge-purpose retrieval still used answering policy.

### Review-Fix RED

Command:

```powershell
npm --workspace apps/core test -- document-fragment-repository.test.ts knowledge-conflict-evidence-builder.test.ts
```

Observed 11 expected failures because metadata-only/source-balanced candidate retrieval, exact text
materialization, policy-saturation handling, and source-ID validation did not yet exist.

The invalid-runtime-purpose mutation was independently watched fail:

```powershell
npm --workspace apps/core test -- document-fragment-repository.test.ts -t "__proto__"
```

Observed: the call incorrectly resolved instead of rejecting before the closed mapping was fixed.

### Focused GREEN

Command:

```powershell
npm --workspace apps/core test -- document-fragment-repository.test.ts knowledge-conflict-evidence-builder.test.ts postgres-conversation-message-repository.test.ts
```

Result: 74 passed, 5 skipped; 0 failed.

### Relevant Regression GREEN

Command included document retrieval, source-aware selection, Tasks 1-2 conflict contracts and
persistence, and affected runtime composition tests.

Result: 160 passed, 13 skipped; 0 failed.

### Full Core GREEN

```powershell
npm --workspace apps/core test
```

Result: 173 test files passed, 2 skipped; 3,016 tests passed, 242 skipped; 0 failed.

### Compile And Diff Gates

```powershell
npm --workspace apps/core run typecheck
npm --workspace apps/core run build
git diff --check
```

All commands exited 0 on the final code commits.

## Self-Review

- Confirmed document text is absent from the ranking query and cannot be fetched until live
  permission succeeds for every admitted source.
- Confirmed source diversity is enforced before the global limit, so one page cannot consume the
  candidate window.
- Confirmed the builder reuses the existing semantic repository and source-aware selector rather
  than creating an ad hoc retrieval path.
- Confirmed exact message group/tombstone checks and strict `sentAt > fetchedAt` chronology.
- Confirmed output fingerprints preserve Task 1-2 immutable identities and current policy metadata.
- Confirmed omitted search purpose leaves all existing answering call sites unchanged.
- Confirmed failures contain stable reason codes only and never raw provider errors or denied text.
- Confirmed no plan, spec, ledger, brief, migration, Task 4, or external-side-effect surface changed.

An independent review initially found permission-before-text and source-diversity blockers. Commit
`d59ddb38123fc6e2a8aa8de896b3d78c603ea563` addressed every Critical, Important, and Minor finding;
the fix review returned `ADDRESSED` and assessed the task ready subject to CI database coverage.

## Concerns

- `DATABASE_URL` and `IRIS_TEST_DATABASE_URL` were unavailable locally. The new real-Postgres tests
  for source-balanced metadata retrieval/exact text materialization and tombstone/group isolation,
  plus existing database suites, were therefore skipped. They are committed and must run in CI or a
  service-enabled environment.
- No non-blocking hardening work was added beyond the approved Task 3 gates.

## Fix Round 1

### Status And Commit

`DONE_WITH_CONCERNS`

- `b181fca45de943c4d15934c5b074431e928d5afb` — `fix(core): filter conflict evidence before limits`

### Files

- `apps/core/src/documents/document-fragment-repository.ts`
- `apps/core/src/documents/document-snapshot-repository.ts`
- `apps/core/src/knowledge-conflicts/knowledge-conflict-evidence-builder.ts`
- `apps/core/tests/document-fragment-repository.test.ts`
- `apps/core/tests/document-snapshot-repository.test.ts`
- `apps/core/tests/knowledge-conflict-evidence-builder.test.ts`
- `apps/core/tests/knowledge-conflict-evidence-builder-postgres.test.ts`

### Review Findings Addressed

- Added a latest-snapshot metadata reader with an explicit column list that excludes `body_text` and
  `error_message`. The evidence builder now validates current snapshot identity, version, hash, and
  fetch time with this metadata-only read before live permission, and it cannot request exact
  fragment text until every selected source passes permission.
- Extended the knowledge-candidate query contract with the exact authorized space. For
  knowledge-draft candidates, `sync_state = 'synced'` and the exact `authorized_space_id` are now
  enforced inside the ranked SQL CTE before per-source ranking and the global limit. Default
  answering retrieval remains unchanged.
- Added deterministic SQL/ordering regressions, a bounded-window starvation fixture with 39
  higher-ranked wrong-space or unsynced candidates ahead of the eligible source, and a conditional
  real-Postgres denied-permission trace that rejects any snapshot-body or exact fragment-text query.

### RED Evidence

Command:

```powershell
npm --workspace apps/core test -- document-snapshot-repository.test.ts document-fragment-repository.test.ts knowledge-conflict-evidence-builder.test.ts
```

Observed 9 expected failures: the metadata-only snapshot method did not exist; candidate SQL lacked
pre-limit synced/exact-space predicates; and the builder still invoked the body-bearing snapshot
method, so the required metadata/snapshot/permission/text trace could not complete.

### Focused GREEN

```powershell
npm --workspace apps/core test -- document-snapshot-repository.test.ts document-fragment-repository.test.ts knowledge-conflict-evidence-builder.test.ts knowledge-conflict-evidence-builder-postgres.test.ts
```

Result: 63 passed, 6 skipped; 0 failed. The six skipped cases are conditional database tests because
`DATABASE_URL` is unavailable locally.

### Relevant Regression GREEN

```powershell
npm --workspace apps/core test -- document-fragment-repository.test.ts document-snapshot-repository.test.ts document-retrieval-context.test.ts source-aware-fragment-selector.test.ts knowledge-conflict.test.ts knowledge-conflict-evidence-builder.test.ts knowledge-conflict-evidence-builder-postgres.test.ts postgres-knowledge-conflict-repository.test.ts postgres-conversation-message-repository.test.ts event-worker-runtime.test.ts runtime-startup-promise.test.ts
```

Result: 179 passed, 17 skipped; 0 failed.

### Full Core, Compile, Build, And Diff Gates

```powershell
npm --workspace apps/core test
npm --workspace apps/core run typecheck
npm --workspace apps/core run build
git diff --check
```

Results: full Core had 173 files passed, 3 skipped; 3,018 tests passed, 244 skipped; 0 failed.
Typecheck, build, and diff check each exited 0.

### Self-Review

- Confirmed the only pre-permission snapshot read has an explicit body-free projection and the
  denied builder path never calls `findFragmentsByIds`.
- Confirmed exact target space and synced state occur before `row_number`, `source_rank <= 3`, and
  the global `limit`, so unrelated metadata cannot consume the bounded window.
- Confirmed candidate and post-load validation retain exact source, snapshot, source-version,
  snapshot-hash, fragment, and fragment-hash identities from Tasks 1-2.
- Confirmed source diversity, target-policy saturation, runtime purpose validation, message
  tombstones/group isolation, strict chronology, and default answering behavior remain covered.
- Confirmed no plan, spec, ledger, brief, migration, or Task 4+ surface changed.

### Concerns

- `DATABASE_URL` remains unavailable locally, so the new conditional real-Postgres starvation and
  denied-body-read tests were skipped. They are committed for CI or a service-enabled environment;
  all unit behavior, relevant regression, full Core, typecheck, build, and diff gates passed locally.
