# Task 9 Report: Operator Inspection and Executable Conversation-State Acceptance

## Scope

Implemented the five authenticated, read-only conversation-state operator routes, app lifecycle wiring, focused API coverage, and a real HTTP acceptance harness using Core, Event Worker, Postgres migrations, Redis, the extraction runtime, and the Python Worker. Only the OpenAI-compatible model endpoint is deterministic fake. No Task 10 deployment, Caddy, documentation, or real Feishu work was performed.

## TDD Evidence

### Operator API

- RED: `npm exec --workspace apps/core -- vitest run tests/conversation-state-api.test.ts` failed because `conversation-state-api.ts` did not exist.
- GREEN: the same command passed 9/9 tests.
- Coverage includes all five routes under bearer auth, fail-closed behavior without configured auth, bounded identifiers and limits, current-group entity filters, candidate inspection, event evidence/version fields, content-free status, scoped SQL that does not select message text, and generic error responses that do not leak database details.

### Core/Python v2 Contract

The real acceptance path exposed pre-existing Core/Python v2 drift that prevented any executable gate from reaching projection:

- RED: Core sent `capabilities`; Python required `enabled_operation_families`.
- RED: Core omitted `mentions` for messages without mentions; Python required `mentions: []`.
- GREEN: focused HTTP client tests passed after the exact request contract was corrected.
- Gate 8 RED additionally proved that Core rejected every valid thread correction because its exact-field parser excluded the correction value field.
- GREEN: a valid summary correction is now parsed; focused HTTP client tests pass 101/101.

### Acceptance Gates

Each gate first failed for the missing fixture or behavior, then passed through the real runtime path:

1. RED: no candidate was created. GREEN: ordinary evidence created candidate v1 and later evidence promoted the same thread to open v2.
2. RED: the thread remained open. GREEN: explicit completion resolved v3 and later discussion reopened v4.
3. RED: merge candidates were absent. GREEN: deterministic canonical merge produced no cycle and did not merge the Group B candidate.
4. RED: no action was created. GREEN: one commitment created one open action v1 and completion updated the same action to completed v2.
5. RED: rejected action count stayed 0 instead of increasing by 2. GREEN: suggestion and brainstorming operations were both rejected and created zero actions.
6. RED: the answer-specific open action was absent. GREEN: answer context contained the relevant open Atlas thread and bound open action while Group A candidate/merged content and Group B candidate content were absent.
7. RED: concurrent delivery produced a thread delta of 0 before its fake fixture existed. GREEN: replay made no writes/calls; concurrent delivery made exactly one projection; shared 429 cooldown made no extra call during cooldown and drained both authorized writes after bounded synthetic-clock advances; disable-before-apply skipped a valid held write and made no backfill after re-enable. Projection deltas remained exact even when extraction-run batching legally varied.
8. RED: canonical summary remained unchanged, then the valid correction exposed the Core parser defect above. GREEN: natural-language correction updated the open thread to v5 while all four prior event IDs, versions, and evidence arrays remained queryable, and the new corrected event carried its own evidence.

## Final Commands

- `npm exec --workspace apps/core -- vitest run tests/conversation-state-api.test.ts`: PASS, 9/9.
- `npm exec --workspace apps/core -- vitest run tests/http-ai-worker-memory-extraction-client.test.ts`: PASS, 101/101.
- `docker compose -f docker-compose.acceptance.yml config`: PASS.
- `npm run typecheck`: PASS.
- `git diff --check`: PASS (only Git line-ending notices).

## Consecutive Acceptance Runs

Command for both runs: `npm run test:acceptance:conversation-state`.

### Run 1

- Exit code 0; gates 1-8 PASS; harness gate time 30.5s.
- Gate results: 1 PASS, 2 PASS, 3 PASS, 4 PASS, 5 PASS, 6 PASS, 7 PASS, 8 PASS.
- Every drain required event pending/DLQ, extraction pending/processing/delayed/DLQ, and projection repair pending/processing/failed counts to be zero.
- `finally` executed `docker compose down -v --remove-orphans`; per-project container and volume assertions passed.

### Run 2

- Exit code 0; gates 1-8 PASS; harness gate time 31.3s.
- Gate results: 1 PASS, 2 PASS, 3 PASS, 4 PASS, 5 PASS, 6 PASS, 7 PASS, 8 PASS.
- Every drain required event pending/DLQ, extraction pending/processing/delayed/DLQ, and projection repair pending/processing/failed counts to be zero.
- `finally` executed `docker compose down -v --remove-orphans`; per-project container and volume assertions passed.

## Cleanup Evidence

- The user-interrupted run was audited before work resumed by filtering Docker labels for `iris-conversation-state-acceptance-*`: 0 containers and 0 volumes remained, so no unrelated resources were touched.
- A final independent Docker label audit after both formal runs reported `acceptance_containers=0` and `acceptance_volumes=0`.

## Self-Review

- Auth: all routes are behind the existing internal bearer hook and fail closed when no token is configured.
- Group boundaries: group entity lists are SQL-scoped to the requested group; event lists are bounded and parent-scoped; cross-group merge and answer leakage are executable assertions.
- Leakage: status is count-only; responses and SQL contain no raw conversation message text; generic errors hide backend details.
- Idempotency: replay, concurrent delivery, 429 retry, and runtime disablement assert exact projection deltas rather than merely asserting no exception.
- Cleanup: every path has `finally` teardown, and successful runs assert both containers and volumes are absent.
- Public-edge `/internal/*` Caddy rejection remains a Task 10 deployment verification boundary as required by the brief; no Caddy change was made here.

## Independent Review Fixes

The four accepted Important findings were fixed without entering Task 10.

### RED

- Raw-event drain: focused helper test failed because `eventWaiting=0` and `eventProcessing=1` incorrectly returned drained (`true`).
- Closed count delta: focused helper test failed because an unexpected `actions +1` was ignored when the caller listed only another field.
- Cleanup visibility: focused helper tests failed because `compose ps -q` did not detect an injected stopped container and a primary error hid the injected cleanup error. Helper RED result: 4/4 failed.
- Mention boundary: 20 unique mentions already serialized successfully as the valid boundary; 21 mentions and duplicate mention keys both reached HTTP instead of failing closed. HTTP client RED result: 102 passed, 2 failed.

### GREEN

- Every acceptance drain now reads `LLEN iris:events:raw:processing` from the real Redis instance. Drain completion requires all ten counts to be zero: raw-event waiting/processing/DLQ, extraction pending/processing/delayed/DLQ, and projection pending/processing/failed. Drain errors serialize counts only.
- Gate 7 now deep-compares the complete ten-field conversation-state count object for replay, concurrent delivery, 429 cooldown, cross-group isolation, disable-before-apply, and no-backfill. Every expected object explicitly includes zero deltas for unauthorized action/action-event/action-evidence writes.
- Core accepts exactly 20 unique mention keys per message, rejects 21, rejects duplicate keys even when open IDs differ, validates exact mention shape/identifiers, performs no truncation or deduplication, and returns only content-free `invalid_response` before HTTP. Messages without mentions still serialize `mentions: []`.
- Cleanup audits use project-label `docker ps -aq` and project-label volume listing. All cleanup steps are attempted, and primary plus cleanup failures are returned together in one `AggregateError`.
- Focused GREEN: acceptance helpers 4/4, operator API 9/9, HTTP client 104/104, typecheck PASS, compose config PASS, and diff-check PASS.

### Review-Fix Acceptance Runs

- Run 1: `npm run test:acceptance:conversation-state`, exit 0, gates 1-8 PASS, 28.8s; independent audit `containers=0 volumes=0`.
- Run 2: `npm run test:acceptance:conversation-state`, exit 0, gates 1-8 PASS, 29.4s; independent audit `containers=0 volumes=0`.
