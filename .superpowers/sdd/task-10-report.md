# Task 10 Report: Deployment Wiring And Local Verification

## Scope And Status

Completed Task 10 Steps 1-5 only. Pilot defaults, deployment contracts, coverage truth, operations
documentation, the real-Feishu acceptance runbook, the Task 1 live mention-replacement assertion,
targeted real-service integration, executable acceptance, and full local verification are complete.
Step 6 independent reviews, Step 7 real Feishu gray acceptance, and Step 8 publication remain for
the controller. No production/VPS deployment, online allowlist change, real Feishu message, push, or
PR was performed.

IRIS-CORE-002 and IRIS-CORE-003 are code implemented and locally verified for current-group
semantic thread/action state, but real Feishu gray acceptance is pending. IRIS-CORE-005 and
IRIS-CORE-006 remain missing because proactive speech and follow-up are not implemented.

The established deployable example is `.env.pilot.example`. The Task 10 plan originally named the
nonexistent `deploy/pilot/.env.example`; the plan now records the repository's executable path, and
no duplicate example file was created.

## Deployment Contract RED And GREEN

RED command:

```powershell
node --test --test-concurrency=1 scripts/pilot-compose.test.mjs
```

Result: exit 1; 10 tests, 8 passed, 2 failed, 0 skipped. Failures were the missing
`IRIS_THREAD_EXTRACTION_GROUP_IDS` assignment and missing
`docs/runbooks/iris-semantic-thread-action-memory-acceptance.md`.

After adding exact disabled defaults to Compose, `deploy/pilot/ci.env`, and
`.env.pilot.example`, the env-only focused contract passed 1/1:

```powershell
node --test --test-concurrency=1 --test-name-pattern="keeps semantic thread and action extraction disabled by default" scripts/pilot-compose.test.mjs
```

Final GREEN command:

```powershell
node --test --test-concurrency=1 scripts/pilot-compose.test.mjs
```

Result: exit 0; 10/10 passed, 0 skipped. The rendered Core environment contains blank thread/action
allowlists, candidate floor `0.65`, apply/min confidence `0.85`; AI Worker has no published port or
edge network; Caddy has no AI Worker or internal route; the runbook contract requires zero event,
extraction, DLQ, and projection-repair counts and `proactiveSpeech=false`.

## Serial Real-Service Gate

Started disposable `iris-task10-postgres` and `iris-task10-redis` on loopback ports `55432` and
`56379`, with named volume `iris-task10-postgres-data`. Set `IRIS_TEST_DATABASE_URL` and
`IRIS_TEST_REDIS_URL`, then ran with file parallelism disabled and one worker:

```powershell
npm exec --workspace apps/core -- vitest run --fileParallelism=false --maxWorkers=1 tests/postgres-conversation-message-repository.test.ts tests/postgres-conversation-state-repository.test.ts tests/conversation-state-context-provider.test.ts tests/postgres-group-memory-repository.test.ts tests/postgres-memory-extraction-repository.test.ts tests/redis-memory-extraction-queue.test.ts tests/memory-extraction-runtime.test.ts
```

Result: exit 0; 7/7 files, 239/239 tests, 0 skipped. This includes the Task 1 live PostgreSQL
two-write contract: the same message and mention key was written with `ou_original`, then
`ou_replacement`; the persisted result contained exactly one row with `ou_replacement`.

Cleanup ran in `finally`: both disposable containers and the named volume were removed.
`task10_container_residue=0` and `task10_volume_residue=0`.

Focused post-gate commands:

```powershell
npm run typecheck
git diff --check
```

Both exited 0. Diff-check emitted only Git's CRLF checkout notices and no whitespace errors.

## Executable Acceptance

```powershell
npm run test:acceptance:conversation-state
```

Result: exit 0; gates 1-8 PASS in 54.3 seconds. The harness proved candidate promotion, resolve and
reopen, canonical merge and cross-group isolation, commitment/action completion, suggestion and
brainstorm rejection, answer-context candidate exclusion, replay/concurrency/cooldown/disablement,
and correction with prior event evidence. Its isolated Compose cleanup completed.

## Full Verification

The first `npm run verify` attempt stopped in Core with 90 files passed, 2 failed; 1773 tests passed,
2 failed, and 67 skipped. The two failures were stale exact-shape expectations in `env.test.ts` and
`answer-draft-orchestrator.test.ts`. Focused reproduction confirmed 100 passed and 2 failed. The
minimal expectation update then passed 2/2 files and 102/102 tests.

The next full attempt passed Core and Python, then pilot reached 99 passed and 2 failed because two
Windows backup failure drills hit the harness's 30-second process timeout and `rmSync` observed a
transient `EPERM` while Git Bash descendants released their temp working directories. No matching
process remained after inspection. The two exact scenarios then passed independently, 2/2 with no
skip, in 11.2 and 12.1 seconds. No timeout was relaxed and no production behavior changed.

Final fresh command:

```powershell
npm run verify
```

Result: exit 0 with:

- `git diff --check`: pass, CRLF checkout notices only;
- TypeScript typecheck: pass;
- Core build: pass;
- Core: 92/92 files, 1775 passed, 67 service-gated skipped, 0 failed;
- Python AI Worker: 167/167 passed;
- pilot: 101/101 passed, 0 skipped;
- root Compose config: pass;
- rollout readiness: 13/13 checks passed, status `ready`;
- pilot Compose config: pass with exact blank allowlists and `0.65`/`0.85` thresholds.

The 67 normal Core-suite skips are existing service-gated tests because `npm run verify` does not set
live Postgres/Redis test URLs: migration runner 5, conversation-state repository 13, Redis extraction
queue 2, Postgres extraction repository 34, document fragments 1, Postgres document sources 2,
Postgres group memory 3, document snapshots 1, extraction runtime 2, conversation-message repository
1, and conversation-state context provider 3. The Task 10 serial service command above executed the
conversation-state/extraction subset against real Postgres/Redis with 239/239 and no skips.

## Documentation And Rollout Truth

The acceptance runbook is written but unexecuted. It requires one approved group, ordinary
non-mention discussion, evidence promotion, explicit commitment and owner, one mention question,
completion, reopening, no unsolicited message, no cross-group state, runtime/readiness health, and
zero event/extraction/document/reindex queues, DLQs, and projection repairs. It keeps AI Worker and
operator routes private and persists `proactiveSpeech=false` before gray activation.

## Deferred Review Notes

Per the Task 10 brief, these Task 8 Minor notes were not changed and remain for final broad-review
triage:

1. Strengthen real-PG literal `_` and `%` tests with independent decoys and single-term queries.
2. Add behavioral PostgreSQL ranking coverage for lexical overlap before activity before ID tie-break.
3. Use one checked-out PostgreSQL client with `finally` restoration for the cross-group
   `session_replication_role` fixture.

## Controller Actions Still Required

1. Run Task 10 Step 6 two-stage independent requirements and code-quality review against the local
   commit and this evidence.
2. Only after review, execute the runbook manually in one approved real Feishu group while keeping
   every other allowlist blank and proactive speech disabled.
3. Record the real gray result, update final status without claiming IRIS-CORE-005/006 or complete
   Iris, then perform the controller-owned commit/push/Draft PR steps.

## First-Stage Review Fixes

The first-stage review identified three Important findings and one gray-safety Minor. They were
closed with a docs/static-contract-only change; no migration or runtime implementation was changed.

### Review Contract RED And GREEN

RED command, run before changing the semantic thread/action acceptance runbook:

```powershell
node --test scripts/pilot-compose.test.mjs
```

Result: exit 1; 12 tests, 9 passed, 3 failed, 0 skipped. The three failures proved the runbook lacked
the marked global-enable boundary and exhaustive group/status gate, an executable fail-closed
rollback helper, and exact `iris:documents:sync:processing` /
`iris:reindex:documents:processing` LLEN gates.

Final GREEN command:

```powershell
node --test --test-concurrency=1 scripts/pilot-compose.test.mjs
```

Result: exit 0; 12/12 passed, 0 skipped. The new contracts require:

- authoritative current bot membership plus deduplicated PostgreSQL history/current-state inventory
  from `conversation_messages`, `group_memories`, `discussion_threads`, and `action_items`;
- durable disable of every known non-pilot group and exact `disabledGroupIds` comparison before
  global enable;
- PATCH `proactiveSpeech=false`, followed by a fresh runtime-control status GET and strict false gate;
- a post-enable control-group ordinary-message plus mention negative test with unchanged
  message/state/memory/projection counts and no reply;
- best-effort ordered rollback in `finally`, aggregate primary/cleanup errors, and normal-success
  cleanup unless the controller explicitly keeps the accepted runtime live;
- exact Redis LLEN zero gates for document-sync and document-reindex processing lists.

Focused runbook/static command:

```powershell
node --test --test-name-pattern="requires exhaustive|requires best-effort|requires zero conversation-state" scripts/pilot-compose.test.mjs
```

Result: exit 0; 3/3 passed, 0 skipped. Node selected only the three named contracts; there were no
service-gated skips. A PowerShell parser pass inspected all runbook code fences: 8 blocks parsed,
0 syntax errors.

### Review Verification

```powershell
npm run typecheck
```

Result: exit 0; Core `tsc --noEmit` passed.

The review scope changed only the runbook and its static deployment contract, so `npm run verify`
was intentionally not rerun per the review instruction. `git diff --check` exited 0 with CRLF
checkout notices only and no whitespace errors. No production/VPS deployment, allowlist mutation,
real Feishu message, push, or PR occurred. Docker inspection reported
`task10_container_residue=0` and `task10_volume_residue=0`.

Real Feishu gray acceptance is still pending and remains controller-owned. IRIS-CORE-002/003 remain
code implemented only; IRIS-CORE-005/006 remain missing, with proactive speech and follow-up disabled.

## Reindex Processing-Key Review Fix

Controller review found that the runbook and its static contract used a transposed namespace key,
while the runtime source of truth in
`apps/core/src/reindex/redis-document-reindex-queue.ts` declares
`DEFAULT_PROCESSING_KEY = "iris:reindex:documents:processing"`. Redis `LLEN` on the former key could
return zero without inspecting the real in-flight list, so this was a gray-release false-green risk.

The contract was changed first to read the runtime source, extract `DEFAULT_PROCESSING_KEY`, assert
its expected deployed value, and require the runbook's `LLEN` command to use that extracted value.

RED command:

```powershell
node --test --test-name-pattern="requires zero conversation-state" scripts/pilot-compose.test.mjs
```

Result before the runbook edit: exit 1; 1 test, 0 passed, 1 failed, 0 skipped. The assertion failed
because the runbook did not contain `LLEN iris:reindex:documents:processing`.

GREEN command after replacing every runbook/report reference:

```powershell
node --test --test-name-pattern="requires zero conversation-state" scripts/pilot-compose.test.mjs
```

Result: exit 0; 1/1 passed, 0 skipped.

Covering suite:

```powershell
node --test --test-concurrency=1 scripts/pilot-compose.test.mjs
```

Result: exit 0; 12/12 passed, 0 skipped. PowerShell parser verification inspected 8 runbook code
fences with 0 syntax errors. No migration, runtime implementation, deployment, real Feishu message,
push, or PR was performed.

`git diff --check` exited 0 with CRLF checkout notices only. A scoped `rg` audit found no legacy
transposed key in the runbook, contract, or report, and confirmed the corrected key against the
runtime `DEFAULT_PROCESSING_KEY` declaration.
