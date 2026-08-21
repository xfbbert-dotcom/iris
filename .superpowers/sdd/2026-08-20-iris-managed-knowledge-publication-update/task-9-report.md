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
- Checkpoint limitation: the approved metadata and reconciliation surfaces were completed in the continuation below.

## Completion appendix (68bcc590..HEAD)

### Implemented

- Added a repository-level metadata projection for an existing-page update: managed target/page IDs and state, source ID, safe Feishu Wiki URL, expected/current revisions, current/proposed hashes, execution state/fingerprint/timestamps/reasons, and append-only typed execution-event summaries. The query deliberately omits draft/body text, remote document and block tokens, client/access tokens, operation keys, and raw provider errors.
- Added `POST /internal/managed-knowledge-updates/:id/reconcile`. It remains behind the existing internal bearer middleware, requires `x-iris-operator`, rejects unknown fields, requires exact execution/page versions plus an idempotent operation key, locks both durable rows, accepts only unresolved eligible execution states, and appends auditable operator reconciliation events. It reuses the existing Task 8 reconciler; no parallel worker was introduced.
- Added an explicit API whitelist projection, so even an accidental extra repository field cannot escape the response. The consolidated status endpoint now separately whitelists the nested managed-update runtime snapshot before exposing it to readiness/status consumers.
- Added the Admin Console managed-update inspector. It displays metadata only (action/proposal lifecycle, policy, page/source, revisions/hashes/fingerprint, freshness barrier, execution/event timestamps and states); untrusted strings are rendered via DOM text nodes, and only the canonical safe Wiki URL can become a link. Its operator action uses the bearer session plus `x-iris-operator`, expected versions, and a generated operation key; failures show a generic content-free message.
- Updated the legacy consolidated-status test contract to include the new default-off `managedKnowledgeUpdates` component.

### Continuation TDD evidence

1. RED: the initial metadata route test (`npm exec --workspace apps/core -- vitest run tests/action-proposal-api.test.ts`) observed missing managed metadata and `404` for reconciliation before the route/producer implementation. GREEN: metadata and reconciliation API tests passed (7 tests).
2. RED: `npm exec --workspace apps/core -- vitest run tests/admin-console-assets.test.ts --reporter=dot` initially reported `Invalid or unexpected token` in the generated console script; after correcting template-string escaping, the new reconciliation privacy test failed with `Error: raw timeout body`. GREEN: the handler now contains that failure and the file passed 51 tests.
3. RED: `npm exec --workspace apps/core -- vitest run tests/postgres-managed-knowledge-page-repository.test.ts --reporter=dot` failed because the metadata view lacked current revision, request fingerprint, and immutable event summaries. GREEN: it passed 21 tests with one configured-Postgres test skipped.
4. RED: `npm exec --workspace apps/core -- vitest run tests/action-proposal-api.test.ts --reporter=dot` showed injected `Approved body`, `docx_secret`, `tenant-token`, and `raw timeout body` in the API response. GREEN: the boundary whitelist passed.
5. RED: `npm exec --workspace apps/core -- vitest run tests/internal-readiness-api.test.ts --reporter=dot` showed injected managed-update body/token/raw-error fields nested under `actionApprovals` in `/internal/status`. GREEN: the app-level runtime snapshot whitelist passed all 18 tests.
6. RED: the Admin Console event-display assertion failed because immutable event history was not rendered. GREEN: it now renders typed event/reason/timestamp summaries and the browser behavior test passed.

### Final verification

- `npm exec --workspace apps/core -- vitest run tests/action-proposal-api.test.ts tests/internal-rollout-readiness.test.ts tests/admin-console-assets.test.ts tests/admin-console-api.test.ts tests/internal-readiness-api.test.ts tests/server-startup.test.ts tests/postgres-managed-knowledge-page-repository.test.ts tests/action-approval-runtime.test.ts tests/runtime-config.test.ts --reporter=dot` — passed: 193 tests, 1 configured-Postgres skip.
- `npm run pilot:config` — passed; rendered `IRIS_MANAGED_KNOWLEDGE_UPDATE_ENABLED: "false"` and `IRIS_MANAGED_KNOWLEDGE_UPDATE_GROUP_ALLOWLIST: ""` in the Core service.
- `npm run test:pilot` — final process exit `0`; 174 passed, 1 Docker-daemon probe skipped, duration `361357ms`.
- `npm exec --workspace apps/core -- tsc --noEmit` — passed.
- `git diff --check` — passed with no whitespace errors (Git printed only CRLF conversion warnings).
- The initial full-suite diagnostic completed with 3,666 passed, 287 configured-environment skips, and 2 failures in `answer-draft-api.test.ts` because its pre-Task-9 exact snapshot still expected 12 components. I updated those two expectations for the intentional default-off 13th component; the follow-up targeted command `npm exec --workspace apps/core -- vitest run tests/admin-console-assets.test.ts tests/action-proposal-api.test.ts tests/internal-readiness-api.test.ts tests/answer-draft-api.test.ts tests/postgres-managed-knowledge-page-repository.test.ts --reporter=dot` passed 263 tests with 1 configured-Postgres skip.
- Final acceptance: `npm test -- --reporter=dot` — passed: 199 test files, 3 configured-environment skips; 3,668 passed and 287 skipped tests (3,955 total). npm printed a non-failing warning that `--reporter` is an unknown npm config, but the workspace Vitest suite completed with exit 0.
- Final read-only `git status --short` was clean; final `git diff --check` passed with no output.

### Files changed

Across `2b0cdfc3..HEAD`: the checkpoint files listed above plus `apps/core/src/action-approvals/managed-knowledge-page-repository.ts`, `apps/core/src/action-approvals/postgres-managed-knowledge-page-repository.ts`, `apps/core/tests/postgres-managed-knowledge-page-repository.test.ts`, and the updated `apps/core/tests/answer-draft-api.test.ts` status-contract assertions. The continuation also modifies the API/runtime/app/Admin Console and their behavior tests listed in the Task 9 brief.

### Self-review

- Default-off parsing and pilot wiring remain unchanged; no live Feishu request/mutation was made.
- Enabled readiness still requires 0055 and typed content-free unresolved counts; disabled readiness remains healthy.
- New claims remain subject to existing capability/deployment/allowlist gates. The reconciliation route intentionally operates only on durable unresolved work, so disabled claim gates cannot abandon an uncertain outcome.
- API, status/readiness, and UI metadata are whitelist-projected; no body, raw Feishu payload/error, access token, document token, or block token is returned or rendered.
- Reconciliation is bearer-protected, operator-audited, version-bound, operation-key idempotent, and fail-closed on ineligible state/version conflict.

### Concerns

- `IRIS_TEST_DATABASE_URL` and `DATABASE_URL` are absent locally. Configured-Postgres integration cases were therefore honestly skipped; local repository boundary behavior is covered by the injected data-source tests.
- The earlier cleanup-policy rejection was not retried: no deletion, move, or broad cleanup was attempted. The final read-only worktree status is clean and lists no temporary directories.
