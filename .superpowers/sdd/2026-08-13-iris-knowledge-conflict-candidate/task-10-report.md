# Task 10 Report: Runtime Composition, Flags, Status, And Readiness

## Status

DONE_WITH_CONCERNS

Task 10 is implemented and committed. The default-off knowledge-conflict runtime, guarded startup
and close lifecycle, shared answer/callback/API wiring, content-free status, and fail-closed rollout
readiness pass the focused, relevant, and full Core gates. The remaining concerns are environmental:
`IRIS_TEST_DATABASE_URL` was unset, so conditional PostgreSQL cases were skipped, and no live Feishu
or Redis integration was exercised. No live deployment or pilot claim is made.

## Implementation Commit

- `991fe22eeef2ef4579ef106d777e3815f4483061` — `feat(core): compose knowledge conflict runtime`
- This report is committed separately so it records the immutable implementation SHA.

## Delivered Behavior

- Added an exact default-off `readKnowledgeConflictRuntimeConfig`. Disabled configuration opens no
  resources. Enabled configuration requires the existing database, model, supported-dimension
  embedding, Feishu, Redis, knowledge-card, and action-approval dependencies.
- Requires an explicit, nonempty, unique conflict-group allowlist and verifies that every conflict
  group is present in both the knowledge-card and action-approval group lists. Timer, batch, lease,
  attempt, and retry settings are bounded and retry maximum must not be below retry base.
- Added one production runtime that composes the PostgreSQL conflict repository and existing
  source/snapshot/fragment/message/publication/draft readers, embedding profile/provider, Feishu
  token/permission/membership/card adapters, detector, evidence builder, scanner, dispatcher,
  interaction worker, current validator, and answer provider.
- Runtime lifecycle is fail closed. The scanner starts before the dispatcher, and app composition
  starts both only after the existing knowledge-card and action-approval runtimes. Startup rejection
  reaches Fastify readiness and server startup; cleanup closes dispatcher and scanner loops before
  the owned PostgreSQL pool and closes each resource once.
- Runtime availability requires a started lifecycle, exact group allowlist membership, global/group
  processing, document-read, retrieval, draft-generation, and proactive-speech gates. Evidence and
  answer use stage-specific gates, so disabling proactive speech blocks unsolicited delivery without
  suppressing a user-requested conflict answer.
- The runtime is created before the answer and knowledge-card workers. Its answer provider is shared
  with the answer runtime, its repository/current validator serve the existing operator API, and its
  interaction delegate is bound to the existing approval callback worker.
- Knowledge-card presentation is resolved lazily after the card runtime is assigned. An unresolved
  or throwing getter returns the existing retryable `internal_error` result for update-draft actions
  and never bypasses presentation.
- Added content-free internal status containing only lifecycle snapshots, allowlist cardinality, and
  scan/candidate/delivery/interaction/reconciliation counts. Status read failures are sanitized and
  no group, candidate, actor, prompt, source text, model content, token, or secret is exposed.
- Added fail-closed rollout readiness. Disabled passes; enabled fails for absent status, missing
  migration 0046, stopped loops, unreadable or invalid counts, inconsistent reconciliation counts,
  dead-lettered scans, terminal delivery failures, or outcome-unknown rows.
- Preserved the existing public routes and manual conflict-API dependency injection contract. No
  migration, deployment, runbook, or Task 11+ work was added. The existing runtime-close helper did
  not require modification; Task 10 uses it for ordered, idempotent cleanup.

## TDD Evidence

### Initial RED

```powershell
npm --workspace apps/core test -- runtime-config.test.ts knowledge-conflict-runtime.test.ts server-startup.test.ts internal-status-snapshot.test.ts internal-rollout-readiness.test.ts
```

Exit 1. The new tests failed at collection because `readKnowledgeConflictRuntimeConfig` and
`runtime/knowledge-conflict-runtime.ts` did not exist. The previously existing related cases still
reported 59 passes. This established the missing configuration and runtime composition boundary
before implementation.

### Focused GREEN

```powershell
npm --workspace apps/core test -- runtime-config.test.ts knowledge-conflict-runtime.test.ts server-startup.test.ts internal-status-snapshot.test.ts internal-rollout-readiness.test.ts internal-readiness-api.test.ts runtime-close.test.ts answer-draft-runtime.test.ts knowledge-conflict-api.test.ts knowledge-conflict-interaction-worker.test.ts knowledge-conflict-answer-provider.test.ts
```

Exit 0: 11 files passed; 200 tests passed with no failures or skips.

### Relevant Regression GREEN

```powershell
npm --workspace apps/core test -- answer-draft-api.test.ts
```

Exit 0: 1 file passed; 163 tests passed. This includes the exact internal-status response regressions
affected by the new disabled `knowledgeConflicts` component.

## Final Repository Gates

```powershell
npm --workspace apps/core test
```

Exit 0: 185 files passed and 3 conditional files skipped; 3,345 tests passed and 250 skipped
(3,595 total).

```powershell
npm --workspace apps/core run typecheck
npm --workspace apps/core run build
git diff --check
git diff --cached --check
```

All exited 0. Diff checks emitted only the repository's LF-to-CRLF checkout warnings and no
whitespace errors.

## Self-Review

- Verified disabled configuration returns before dependency validation or resource construction.
- Verified allowlist membership and every runtime-control gate fail closed on blank, foreign, or
  throwing input, and that availability remains closed before startup and after close/failure.
- Verified scanner startup precedes dispatcher startup and app startup orders knowledge cards,
  action approvals, knowledge conflicts, proactive runtimes, then the event worker.
- Verified proactive disablement closes delivery while answer and evidence stage gates remain open.
- Verified a missing migration is reported without querying unavailable conflict tables, while
  count read errors become a generic unavailable status.
- Verified lazy presentation cannot be interpreted as permission to create a draft without its
  existing card presentation path.
- Verified normal close, startup failure cleanup, and app cleanup stop conflict loops before the
  card runtime's Redis/PostgreSQL resources and the conflict runtime's PostgreSQL pool exactly once.
- Verified status/readiness assertions contain counts and fixed reason codes only, with no raw IDs,
  content, SQL/provider errors, credentials, or Feishu identity.

## Concerns

- `IRIS_TEST_DATABASE_URL` was unset. The 250 skips include conditional PostgreSQL cases, so migration
  presence, durable count queries, row-state readiness, and loop behavior against a live database
  remain CI/Task 12 gates.
- No live Feishu permission, membership, interactive-card, callback, or Redis queue operation was
  performed. Those adapters are composed from existing tested modules, but no live integration claim
  is made.
- Readiness intentionally blocks enabled rollout on any missing migration, stopped loop, unreadable
  count, scan dead letter, terminal failure, or outcome-unknown row. Operational recovery guidance is
  outside Task 10 and remains for the subsequent runbook/deployment work.
