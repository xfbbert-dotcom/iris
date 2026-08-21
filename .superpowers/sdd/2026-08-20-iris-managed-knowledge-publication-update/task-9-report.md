# Task 9 Report: Metadata Admin, Readiness, and Default-Off Deployment Contract

## Implemented

- Added strict `IRIS_MANAGED_KNOWLEDGE_UPDATE_ENABLED` / `IRIS_MANAGED_KNOWLEDGE_UPDATE_GROUP_ALLOWLIST` parsing. It defaults off and rejects invalid booleans, blank entries, duplicate entries, and enabled empty allowlists.
- Wired the parsed enabled configuration and the actual document-sync queue into Task 8's existing action-approval runtime entrypoint. No parallel worker is created.
- Added content-free managed-update runtime snapshot readiness: migration `0055_managed_update_execution_identity.sql`, worker state, and outcome-unknown/reconciliation-required counts.
- Added an explicit default-off readiness check that fails closed for missing worker/migration/review/document-sync dependencies or unresolved outcomes.
- Added managed-update component status, capability label, and default-off example/pilot Compose contract.

## TDD evidence

1. RED: `npm exec --workspace apps/core -- vitest run tests/runtime-config.test.ts`
   - failed: `readManagedKnowledgeUpdateDeploymentConfig is not a function`.
   GREEN: same command passed, 20 tests.
2. RED: `npm exec --workspace apps/core -- vitest run tests/internal-rollout-readiness.test.ts`
   - failed because `managedKnowledgeUpdates` readiness check was absent.
   GREEN: readiness and config tests passed, 58 tests.
3. RED: `npm exec --workspace apps/core -- vitest run tests/action-approval-runtime.test.ts`
   - failed because migration/count fields were absent from the managed-update runtime snapshot.
   GREEN: runtime/readiness tests passed, 44 tests.
4. RED: `npm exec --workspace apps/core -- vitest run tests/internal-readiness-api.test.ts`
   - failed because app composition did not inject the parsed contract and actual sync queue.
   GREEN: same command passed, 17 tests.

## Verification

- Focused suite: 168 tests passed across the Task 9/API/readiness/runtime files.
- `npm exec --workspace apps/core -- tsc --noEmit`: passed.
- `npm run pilot:config`: passed; rendered Core environment includes `IRIS_MANAGED_KNOWLEDGE_UPDATE_ENABLED: "false"` and empty allowlist.
- `npm run test:pilot` was started; this environment returned its test runner banner after the 30-second command yield without a final exit status, so it is not claimed as passed.
- Configured PostgreSQL tests were not run: `IRIS_TEST_DATABASE_URL` / `DATABASE_URL` are absent locally.

## Files changed

`apps/core/src/config/env.ts`, `apps/core/src/runtime/document-sync-runtime.ts`, `apps/core/src/runtime/action-approval-runtime.ts`, `apps/core/src/admin/internal-rollout-readiness.ts`, `apps/core/src/app.ts`, `apps/core/src/admin-console/admin-console-assets.ts`, relevant focused tests, `.env.example`, `deploy/pilot/ci.env`, `deploy/pilot/docker-compose.yml`, and `scripts/pilot-compose.test.mjs`.

## Self-review and concerns

- No live Feishu call or mutation was made. Deployment remains default-off.
- Runtime/readiness exposes only migration boolean, loop state, and aggregate typed counters; it includes no content, Feishu payload, token, document/block token, or raw error.
- Follow-up backlog: the approved Task 9 brief also calls for managed page/execution metadata listing and an operator reconciliation action. Those routes require a minimal metadata query/reconciliation producer on the managed-page repository and are not included in this partial implementation.
