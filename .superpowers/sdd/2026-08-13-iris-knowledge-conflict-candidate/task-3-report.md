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
