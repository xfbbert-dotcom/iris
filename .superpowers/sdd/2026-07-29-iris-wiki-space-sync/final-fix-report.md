# Iris Wiki Space Sync Final Fix Report

Date: 2026-07-29
Branch: `codex/iris-wiki-space-sync`
Scope: Single final-review fix wave; no production deployment and no hosted-model call.

## Outcome

All five Important and all three bounded Minor findings are fixed within the approved modular-monolith
architecture. The worker remains default-off, registration remains local and asynchronous, public
`/internal/*` ingress remains closed, and no document evidence, tenant, authorization, or live
permission boundary was changed.

Real PostgreSQL coverage also exposed two prerequisite defects not called out separately in the
review: the `claimNext` UPDATE alias used a PostgreSQL keyword and due `synced` rows were never
claimable. Both were required to prove repeated periodic refreshes and were fixed in the same
repository boundary.

## Root Causes And Fixes

### 1. Attempt series never reset

Root cause: `claimNext` incremented `attempt_count`, while `complete`, `requestScan`, and re-enable
transitions retained the accumulated value. Also, `claimNext` considered only `pending` and
`retry_wait` due rows, so a successfully completed `synced` row could not start its next periodic
refresh even after the counter was corrected.

Fix:

- reset `attempt_count` to zero on successful completion;
- reset it on manual rescan and enabled recovery;
- claim due `synced` rows as the next periodic scan;
- include `synced` in migration `0041`'s due-work partial index;
- prove seven successful refreshes with `maxAttempts=5` against real PostgreSQL.

### 2. Exhausted expired leases remained scanning

Root cause: the candidate query filtered on `attempt_count < maxAttempts` before doing anything with
an expired scanning row. A process crash after the final claim therefore made the row permanently
ineligible.

Fix: `claimNext` now begins with a data-modifying CTE that atomically moves every enabled, expired,
exhausted scanning row to `dead_letter`, clears its lease, records completion time, increments
revision, and stores the safe `lease_expired` classification. A two-repository concurrent
PostgreSQL test proves the final claim is terminally classified once and never reclaimed.

### 3. Scanner returned partial success for invariant breaches

Root cause: foreign-space nodes, known children at maximum depth, and known nodes/pages beyond the
node cap were counted as skipped or truncated. The worker therefore completed a partial traversal
as `synced`.

Fix:

- extend the typed safe classification union with `cross_space_node`,
  `depth_limit_exceeded`, and `node_limit_exceeded`;
- throw non-retriable `WikiSpaceSyncError` instances at the first observed breach;
- retain the existing 500-node, depth-20, page-size-50 hard bounds;
- prove scanner rejection and worker dead-letter behavior for all three classifications.

Unsupported object types remain counted and skipped as designed.

### 4. Fetch and parsing failures were conflated

Root cause: one broad catch wrapped `fetch`, HTTP handling, and bounded JSON parsing. Every
non-`AbortError` exception that was not already typed became terminal `invalid_response`.

Fix: isolate the `fetch` await from response parsing. Rejected transport promises now become
retriable `request_failed`; aborts remain retriable `timeout`; malformed and oversized bodies remain
terminal `invalid_response`. Tests keep transport rejection and invalid JSON on separate paths and
do not expose the rejected error text.

### 5. Constitution defaults drifted

Root cause: initial implementation values were copied consistently across files, but they were the
unapproved one-hour/one-minute/three-attempt values.

Fix: align Core, Compose fallbacks, pilot example, CI environment, runtime tests, operator README,
and runbook to:

- refresh: `21600000` ms (6 hours);
- lease: `600000` ms (10 minutes);
- maximum attempts: `5`.

`IRIS_WIKI_SPACE_SYNC_ENABLED=false` is unchanged.

### 6. Enabled re-registration was read-only

Root cause: `INSERT ... ON CONFLICT DO NOTHING` was followed only by `SELECT`, regardless of the
existing enabled state.

Fix: after an insert conflict, atomically update an enabled row to `pending`, reset attempts, set the
new due time, clear any lease, and increment revision. A disabled conflict skips the update and is
returned exactly as stored. Real PostgreSQL covers both branches.

### 7. Pre-mutation Admin Console state could survive

Root cause: operation generation reflected request start order. A manual GET started after a PATCH
but before commit could render old state and become newer than the mutation's follow-up GET,
suppressing the authoritative refresh.

Fix: track concurrent wiki-space mutations and make every wiki-space GET started during a mutation
wait until all in-flight mutations settle. Mutation requests can still overlap, existing operation
generation protections remain in place, and normal refresh loading remains synchronous when no
mutation exists. The regression test starts PATCH, starts refresh, resolves the old-state ordering,
then proves no list request was sent before commit and the disabled state survives.

### 8. Compose override test used fallback-equivalent values

Root cause: the test rendered only `deploy/pilot/ci.env`, whose values matched every YAML fallback.

Fix: render a second Compose config with distinct valid sentinel overrides for interval, refresh,
lease, depth, and attempts, and assert the exact interpolated `core.environment` values.

## RED Evidence

### Repository behavior

Command:

```powershell
$env:IRIS_TEST_DATABASE_URL='postgres://iris:iris@127.0.0.1:5432/iris'
npm --workspace @iris/core test -- wiki-space-authorization-repository
```

Initial result: `4 failed, 5 passed`; real PostgreSQL first rejected the existing UPDATE alias with
`syntax error at or near "authorization"`. After replacing the reserved alias so the target cases
could execute, the unchanged command still failed `4 failed, 5 passed` for the intended reasons:
success retained attempt 1, rescan retained attempt 1, final expired claim remained `scanning`, and
enabled re-registration remained `dead_letter`.

### Scanner, worker, client, config, and console

Command:

```powershell
npm --workspace @iris/core test -- wiki-space-scanner wiki-space-sync-worker feishu-wiki-space-client runtime-config admin-console-assets
```

Result: `10 failed, 66 passed`.

- four scanner cases resolved partial results instead of rejecting;
- three worker cases reported `synced` instead of the required dead-letter classifications;
- fetch rejection was `invalid_response`/non-retriable instead of `request_failed`/retriable;
- runtime returned `3600000`, `60000`, and `3`;
- the Admin Console issued list request 2 before the PATCH committed.

### Compose

Command:

```powershell
node --test scripts/pilot-compose.test.mjs
```

Result: `2 failed, 22 passed`. The default assertion received `3600000` instead of `21600000`, and
the sentinel override assertion received fallback `1000` instead of override `12345`.

### Due-work index

Command:

```powershell
npm --workspace @iris/core test -- migration-runner
```

Result: `1 failed, 22 passed, 5 skipped`; migration `0041` lacked `synced` in the due-work partial
index predicate.

## GREEN Evidence

### Focused real PostgreSQL repository

```powershell
$env:IRIS_TEST_DATABASE_URL='postgres://iris:iris@127.0.0.1:5432/iris'
npm --workspace @iris/core test -- wiki-space-authorization-repository
```

Result: `1 file passed; 9 tests passed`, including seven periodic successes, both recovery APIs,
concurrent final-lease expiry, enabled re-registration, and exact disabled preservation.

### Focused Core boundaries

```powershell
npm --workspace @iris/core test -- document-sync-runtime wiki-space-scanner wiki-space-sync-worker feishu-wiki-space-client runtime-config admin-console-assets wiki-space-api migration-runner
```

Result: `9 files passed; 136 tests passed; 5 opt-in PostgreSQL tests skipped`.

### Compose and pilot config

```powershell
node --test scripts/pilot-compose.test.mjs
npm run pilot:config
```

Results: Compose `24/24` passed; pilot config rendered successfully with wiki sync disabled and
`21600000`/`600000`/`5`.

Additional pilot checks:

- `node --test scripts/pilot-smoke-lib.test.mjs`: `40/40` passed.
- `node --test scripts/pilot-operations.test.mjs`: `31/31` passed.

### Full Core and compile gates

```powershell
npm --workspace @iris/core test
npm --workspace @iris/core run typecheck
npm --workspace @iris/core run build
git diff --check
```

Results:

- full Core: `153 files passed, 2 skipped; 2553 tests passed, 178 opt-in tests skipped`;
- typecheck: exit 0;
- build: exit 0;
- diff check: exit 0, with only the repository's existing LF-to-CRLF working-copy warnings.

No command invoked Gemini, another hosted model, or production deployment.

## Changed Paths

- `.env.pilot.example`
- `apps/core/migrations/0041_wiki_space_authorizations.sql`
- `apps/core/src/admin-console/admin-console-assets.ts`
- `apps/core/src/config/env.ts`
- `apps/core/src/documents/feishu-wiki-space-client.ts`
- `apps/core/src/documents/wiki-space-authorization-repository.ts`
- `apps/core/src/documents/wiki-space-scanner.ts`
- `apps/core/tests/admin-console-assets.test.ts`
- `apps/core/tests/document-sync-runtime.test.ts`
- `apps/core/tests/feishu-wiki-space-client.test.ts`
- `apps/core/tests/migration-runner.test.ts`
- `apps/core/tests/runtime-config.test.ts`
- `apps/core/tests/wiki-space-authorization-repository.test.ts`
- `apps/core/tests/wiki-space-scanner.test.ts`
- `apps/core/tests/wiki-space-sync-worker.test.ts`
- `deploy/pilot/README.md`
- `deploy/pilot/ci.env`
- `deploy/pilot/docker-compose.yml`
- `docs/runbooks/iris-wiki-space-sync.md`
- `scripts/pilot-compose.test.mjs`
- `.superpowers/sdd/2026-07-29-iris-wiki-space-sync/final-fix-report.md`

## Self-Review

- Architecture: changes stay inside the existing repository/client/scanner/worker/runtime/Admin
  Console/Compose boundaries; no new service, queue, document model, or provider was introduced.
- State safety: all administrative and worker transitions retain revision fencing. Expired final
  leases are terminally classified in the same SQL statement that looks for the next claim.
- Scheduling: attempts now model a consecutive failed series, and due successful rows are indexed
  and claimable.
- Fail closed: foreign-space and traversal overflow evidence now stops the scan terminally;
  unsupported object types remain the only bounded skip path.
- Error hygiene: all persisted and returned classifications are bounded safe strings; raw transport
  errors, response bodies, tokens, and secrets are not propagated.
- Registration: API behavior remains HTTP 202 and the repository path performs no Feishu network
  call. Existing API tests remain green.
- Authorization/evidence: no source evidence, tenant, group, live permission guard, or append-only
  evidence code changed.
- Ingress/rollout: `IRIS_WIKI_SPACE_SYNC_ENABLED=false` remains in CI/example/Compose, and Caddy's
  exact public boundary was not changed.
- Admin race: refreshes wait only while mutations are active; existing out-of-order mutation/error
  generation tests and the new ordering race all pass.
- Configuration: a stale-value search found no old wiki defaults in executable/config/runbook
  surfaces, and sentinel overrides prove Compose interpolation rather than fallback coincidence.

## Concerns

`npm run test:pilot` did not complete within five minutes. Isolating the files showed the wiki
Compose test, pilot smoke library, and pilot operation tests passing, while
`scripts/pilot-backup-behavior.test.mjs` also remained running past three minutes with negligible
CPU. The orphaned runner was terminated and its verified workspace-local temporary directory was
removed. This backup-harness timeout is unrelated to the wiki-space changes and is not hardened in
this bounded fix wave.

Migration `0041` was updated in place to align its partial index because this feature branch has not
been deployed. No production database migration or deployment was run.
