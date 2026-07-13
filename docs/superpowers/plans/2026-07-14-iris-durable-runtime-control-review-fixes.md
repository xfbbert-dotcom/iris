# Iris Durable Runtime Control Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every whole-branch review finding with fail-closed runtime, ingress, restore, and startup cleanup behavior.

**Architecture:** The pilot smoke remains one Node process but gains an explicit post-restore mode that owns Caddy lifecycle and cleanup. Restore uses the proven GNU `timeout` plus Docker Compose wrapper pattern and verified Caddy stop retries. Core startup extends its existing cleanup-promise handoff through synchronous app composition with one injectable guard seam immediately before `onClose` takes ownership.

**Tech Stack:** Node.js 22+, TypeScript 5.5, Fastify 5, Vitest, Bash, GNU coreutils `timeout`, Docker Compose, Node test runner.

## Global Constraints

- Follow RED/GREEN TDD for every behavior change and retain the failing output in the final report.
- Preserve durable intent versus process-local live activation, authenticated internal routes, hidden public internal routes, encrypted stdin restore, atomic backup publication, and Caddy-last activation.
- Do not deploy, access a VPS, push, or invent deployment evidence.
- Keep `buildApp` synchronous and preserve `startServer`'s startup-cleanup promise handoff.
- Work with existing branch edits and do not revert unrelated work.

---

### Task 1: Extend Startup Cleanup Ownership

**Files:**
- Modify: `apps/core/tests/server-startup.test.ts`
- Modify: `apps/core/src/app.ts`

**Interfaces:**
- Add optional `BuildAppDependencies.onBeforeRuntimeCloseOwnership(): void` as the narrow injectable composition-failure seam.
- Extend `scheduleRuntimeStartupCleanup` to close a constructed Feishu gateway before worker and answer runtimes.

- [ ] Add a `startServer` regression that starts all workers, throws immediately before `onClose` installation, blocks one worker close, and asserts runtime-control close waits.
- [ ] Run `npm --workspace apps/core test -- server-startup.test.ts` and record the expected RED failure because the seam is not invoked.
- [ ] Guard synchronous composition from answer runtime creation through successful `onClose` installation, handing its cleanup promise to `startServer` on any throw.
- [ ] Re-run the focused test and record GREEN with all startup and cleanup errors flattened in causal order.

### Task 2: Make Pilot Smoke Fail Closed

**Files:**
- Modify: `scripts/pilot-smoke-lib.test.mjs`
- Modify: `scripts/pilot-smoke.mjs`
- Modify: `scripts/pilot-operations.test.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `deploy/pilot/README.md`

**Interfaces:**
- Add CLI mode `--post-restore`, compatible with the existing optional decimal timeout.
- Add bounded durable-disable retries and bounded Docker Compose process-tree commands for Caddy `up`, `stop`, `kill`, and `ps` verification.

- [ ] Add behavioral tests for private-first post-restore ordering and for an ambiguous committed enable followed by pre-mutation disable transport failures.
- [ ] In the failure test, make the first Caddy stop command hang with a child process; assert nonzero exit, stopped Caddy, primary and cleanup evidence, sanitized output, and no surviving PIDs.
- [ ] Add workflow/runbook contract assertions and run the focused Node tests to record RED.
- [ ] Implement the single-process two-phase flow, disable retries, and independently verified Caddy shutdown.
- [ ] Update CI restore drill and runbook, then rerun focused tests for GREEN.

### Task 3: Bound And Verify Restore

**Files:**
- Create: `scripts/pilot-restore-behavior.test.mjs`
- Modify: `scripts/pilot-operations.test.mjs`
- Modify: `deploy/pilot/restore-from-stdin.sh`
- Modify: `deploy/pilot/README.md`
- Modify: `package.json`

**Interfaces:**
- Add validated `IRIS_RESTORE_COMMAND_TIMEOUT_SECONDS` (`1..1800`) and `IRIS_RESTORE_CLEANUP_RETRY_DELAY_SECONDS` (`0..10`).
- Route every Docker Compose operation through `run_compose`; make `stop_caddy_verified` perform exactly three stop-and-verify attempts, a bounded kill, and a final stopped-state check.

- [ ] Add an executable fake-Docker behavior harness for daemon hang, process-tree hang, partial Caddy stop, migration failure, and Core restart failure.
- [ ] Assert bounded exit, fail-closed Caddy state, no target database swap before stop proof, and no surviving fake Docker parent/child.
- [ ] Run restore behavior and contract tests to record RED against the unbounded script.
- [ ] Add validated deadlines, fail-closed cleanup, verified Caddy stop before the production swap, and bounded staging cleanup.
- [ ] Update the encrypted-stdin runbook and rerun restore tests for GREEN.

### Task 4: Verify, Report, And Commit

**Files:**
- Create: `.superpowers/sdd/final-review-fix-report.md`

- [ ] Run focused new tests and `npm run test:pilot`.
- [ ] Run `npm test`, `npm run test:python`, `npm run typecheck`, `npm run build`, Bash syntax checks, readiness, root and pilot Compose config, and `git diff --check`.
- [ ] Review the final diff for scope, secret sanitization, process cleanup, and all review requirements.
- [ ] Write the report with RED/GREEN evidence, changed files, verification output, commits, and remaining concerns.
- [ ] Commit coherent reviewed changes without pushing.
