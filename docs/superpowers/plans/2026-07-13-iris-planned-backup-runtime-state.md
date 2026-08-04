# Iris Planned Backup Runtime State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the pre-backup global runtime and public-ingress state after a successful planned backup while every failure remains disabled and closed to public traffic.

**Architecture:** Capture runtime state through the authenticated internal API from inside Core and capture Caddy state through Docker Compose. Restart Core in fail-closed mode before publishing the encrypted artifact, then restore the prior enabled state and Caddy only after successful atomic publication.

**Tech Stack:** Bash, Docker Compose, Node.js built-in `fetch`, Node.js test runner, age, Postgres, Redis.

## Global Constraints

- Unexpected restarts and failed maintenance must leave `globalEnabled: false`.
- Runtime-control credentials must never be printed or parsed into the host shell.
- Caddy must not start after a failed backup.
- Backup publication must remain encrypted, non-empty, atomic, and protected by `flock`.
- Production remains closed to public Feishu traffic until the existing Gemini recovery gate passes.

---

### Task 1: Lock The Maintenance Contract With Tests

**Files:**
- Modify: `scripts/pilot-operations.test.mjs`

**Interfaces:**
- Consumes: `deploy/pilot/backup.sh` as UTF-8 Bash source.
- Produces: ordering assertions for state capture, fail-closed Core startup, atomic publication, runtime restoration, and conditional Caddy restoration.

- [x] **Step 1: Add failing source-contract tests**

Add assertions that require the script to read `/internal/runtime-control/status` before stopping
services, restart Core alone and validate `globalEnabled: false`, publish before any re-enable, restore
only a previously enabled runtime, conditionally restore Caddy, and exclude both actions from cleanup.

- [x] **Step 2: Run the focused test and verify RED**

Run: `node --test scripts/pilot-operations.test.mjs`

Expected: FAIL because `backup.sh` currently restarts `core caddy` together and never captures or
restores runtime state.

### Task 2: Implement Safe Planned-State Restoration

**Files:**
- Modify: `deploy/pilot/backup.sh`
- Modify: `docs/operations/internal-rollout-runbook.md`

**Interfaces:**
- Consumes: authenticated `GET /internal/runtime-control/status` and `POST /internal/runtime-control/global`.
- Produces: one encrypted paired backup and a restored pre-maintenance enabled/Caddy state only on complete success.

- [x] **Step 1: Add container-local runtime-control helpers**

Implement Bash helpers that invoke Node inside Core. Each request reads
`process.env.IRIS_INTERNAL_API_TOKEN`, rejects missing credentials or non-2xx responses, and returns
or verifies only the expected boolean state.

- [x] **Step 2: Reorder backup and cleanup**

Capture state before stopping services; make the `EXIT` trap remove temporary files, stop Caddy, and
start Core alone when recovery is required. Restart and verify Core disabled before encryption,
publish atomically, restore a prior enabled state, and restore Caddy only when it was running before.

- [x] **Step 3: Document the operator-visible semantics**

Explain in the rollout runbook that successful planned backups preserve state, failed backups remain
disabled with Caddy stopped, and unplanned restarts continue to require explicit enablement.

- [x] **Step 4: Run focused verification and verify GREEN**

Run: `node --test scripts/pilot-operations.test.mjs`

Expected: all operation-script tests pass, including Bash syntax validation.

### Task 3: Verify, Review, And Drill Production

**Files:**
- Verify only: repository test suites and deployed `/usr/local/sbin/iris-backup`

**Interfaces:**
- Consumes: reviewed repository script and the existing VPS SSH access.
- Produces: test evidence, review findings, a deployed script, and two safe production drill results.

- [x] **Step 1: Run repository verification**

Run the pilot operations test, `npm run test:pilot`, readiness tests, Core tests, AI Worker tests, and
Docker Compose configuration validation with the installed Docker executable.

- [x] **Step 2: Request independent code review**

Review the diff specifically for secret exposure, state-restoration ordering, cleanup failure paths,
and accidental Caddy startup. Resolve all P0-P3 findings and repeat verification.

- [x] **Step 3: Deploy the exact reviewed script**

Copy `deploy/pilot/backup.sh` from the approved release to `/usr/local/sbin/iris-backup`, set mode
`0700`, and verify its SHA-256 against the local file.

- [x] **Step 4: Run the disabled-state drill**

With Iris disabled and Caddy stopped, run a backup and assert the encrypted artifact is non-empty,
Core is healthy and disabled, and Caddy remains stopped.

- [x] **Step 5: Run the isolated enabled-state drill**

Enable Iris through the internal API while Caddy remains stopped, run a backup, assert Iris returns
enabled while Caddy remains stopped, then explicitly disable Iris again and verify the final state.

## Implementation Record

Completed on 2026-07-13 on branch `codex/iris-task-evidence-prompt`.

- TDD RED reproduced state-capture, Caddy-cleanup, state-verification, temporary-cleanup, and CRLF
  deployment failures before each corresponding fix.
- Final pilot suite: 32 tests passed, including 13 executable backup behavior cases.
- Full repository verification: Core 1095 passed with 4 skipped, AI Worker 7 passed, readiness 13/13,
  TypeScript typecheck/build passed, and Docker Compose configuration parsed successfully.
- Independent review findings were resolved for capture arming, verified cleanup, `errexit` masking,
  cleanup ordering, and executable failure-injection coverage.
- Deployed `/usr/local/sbin/iris-backup` SHA-256:
  `1f51b9c5d92afd49e704ffe3495daf800b52468f1b25390fa323bc5c1bb44ac9`.
- Disabled-state drill produced `iris-20260713T043843Z.bundle.tar.age` and preserved disabled Core
  with Caddy stopped.
- Isolated enabled-state drill produced `iris-20260713T044245Z.bundle.tar.age`, restored the enabled
  runtime while Caddy remained stopped, and then explicitly returned the runtime to disabled.
- The second drill backup was copied off-host with matching SHA-256
  `4cebb876c6217288118734892af110e9d3fd674c65471d98a3220fd562598ece`, decrypted locally, and
  validated with `pg_restore --list` and `redis-check-rdb`.
- Final VPS state: Core/Postgres/Redis healthy, Caddy stopped, global runtime disabled, all event,
  document-sync, and reindex pending/DLQ counts zero.
