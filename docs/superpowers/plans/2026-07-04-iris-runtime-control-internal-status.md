# Iris Runtime Control Internal Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface global Iris enablement in the consolidated `/internal/status` snapshot.

**Architecture:** Keep `RuntimeController` as the authority. Add a `runtimeControl` component to
the consolidated internal status response by reading `runtimeController.getSnapshot()` at request
time.

**Tech Stack:** Fastify, Vitest, Markdown.

---

### Task 1: Status Behavior

**Files:**
- Modify: `apps/core/src/app.ts`
- Modify: `apps/core/tests/runtime-control-api.test.ts`
- Modify: `apps/core/tests/answer-draft-api.test.ts`

- [x] **Step 1: Add a failing runtime-control status test**

Disable Iris globally, call `GET /internal/status`, and assert that
`components.runtimeControl.status` is `"disabled"` with the expected global snapshot fields.

- [x] **Step 2: Add the runtime-control component**

Read `runtimeController.getSnapshot()` inside the `/internal/status` route and include a
`runtimeControl` component with `enabled`, `globalEnabled`, `disabledGroupIds`, and
`disabledGroupCount`.

- [x] **Step 3: Update exact status snapshots**

Adjust consolidated status expectations for the extra component count, order, healthy count, and
status counts.

- [x] **Step 4: Run focused tests**

Run:

```powershell
npm test --workspace apps/core -- answer-draft-api.test.ts -t "GET /internal/status"
npm test --workspace apps/core -- runtime-control-api.test.ts
```

Expected: both commands exit 0.

### Task 2: Documentation And Verification

**Files:**
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`
- Modify: `docs/operations/internal-rollout-runbook.md`
- Create: `docs/superpowers/specs/2026-07-04-iris-runtime-control-internal-status-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-runtime-control-internal-status.md`

- [x] **Step 1: Update architecture and runbook docs**

Document that consolidated status includes runtime-control state and that
`components.runtimeControl.status: "disabled"` means Iris is globally off.

- [x] **Step 2: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

- [x] **Step 3: Commit, push, and verify PR checks**

Commit the status and docs update, push `codex/iris-document-source-registry`, update PR #3, and
confirm GitHub Actions returns Core and AI Worker success.
