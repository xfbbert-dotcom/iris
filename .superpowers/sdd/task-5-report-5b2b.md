# Task 5 Report: Exact Review Required Before Approval

## Completed

- Added required `requireReviewAttestation: boolean` fields to approval preflight and mutation inputs.
- Added `ActionProposalReviewRequiredError` with a stable message and worker mapping to `review_required`.
- When the gate is enabled, `approve` checks an exact current attestation during preflight and again in the final transaction immediately before writing `action_approvals`.
- `request_revision` and `reject` remain outside the attestation gate.
- `IRIS_ACTION_REVIEW_ENABLED=true` enables the worker gate; any other value leaves 5B-2A behavior enabled without the review requirement.
- The interaction worker acknowledges `review_required` and renders: `请先打开完整正文审阅页并完成审阅`.

## TDD Evidence

1. Added worker, interaction, runtime, and Postgres repository expectations before production implementation.
2. Confirmed the initial focused unit run failed because the new gate was not forwarded, the review error was classified as retryable, the interaction card was absent, and runtime did not supply the flag.
3. Implemented the minimum wiring and enforcement, then confirmed the focused unit suite and typecheck pass.

## Verification

- PASS: `npm --workspace apps/core test -- tests/action-approval-worker.test.ts tests/approval-interaction-worker.test.ts tests/postgres-action-review-repository.test.ts tests/action-approval-runtime.test.ts --no-file-parallelism`
  - 64 passed, 10 skipped.
- PASS: `npm --workspace apps/core run typecheck`
- BLOCKED externally: the 10 skipped repository acceptance tests require `IRIS_TEST_DATABASE_URL`. `docker compose -f docker-compose.acceptance.yml up -d postgres` could not connect to Docker Desktop, and the local Docker service is stopped and could not be started by the current session.

## Scope

- Did not modify Task 6, Caddy, docs, tmp artifacts, or `pnpm-lock.yaml`.
