# Iris Runtime Control Operator Hint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional human-readable operator hint to runtime-control audit events.

**Architecture:** Read `X-Iris-Operator` on runtime-control mutation routes, trim and validate it as
a diagnostic label, and copy it into `runtime_control_updated.operatorHint`. The header is not used
for authentication or authorization.

**Tech Stack:** Fastify, Vitest, TypeScript, Markdown.

---

### Task 1: Operator Hint Audit Field

**Files:**
- Modify: `apps/core/src/audit/audit-log.ts`
- Modify: `apps/core/src/app.ts`
- Modify: `apps/core/tests/runtime-control-api.test.ts`

- [x] **Step 1: Write failing operator hint coverage**

Add a runtime-control API test that sends:

```typescript
headers: {
  "x-iris-operator": " alice@example.com ",
}
```

Then query `/internal/audit/events?limit=1&type=runtime_control_updated` and expect the event to
include:

```typescript
operatorHint: "alice@example.com"
```

Expected before implementation: the event exists but does not include `operatorHint`.

- [x] **Step 2: Extend runtime-control audit events**

Add `operatorHint?: string` to `RuntimeControlAuditEvent`.

- [x] **Step 3: Parse the operator hint**

Add a helper that returns a trimmed string only when the header is a non-empty string of 120
characters or less and does not include CR/LF characters.

- [x] **Step 4: Pass the hint into audit writes**

Read the hint from `request.headers["x-iris-operator"]` in global, group, and capability mutation
routes, then pass it to `recordRuntimeControlAuditEvent()`.

- [x] **Step 5: Run focused tests**

Run:

```powershell
npm test --workspace apps/core -- runtime-control-api.test.ts -t "operator hint"
npm test --workspace apps/core -- runtime-control-api.test.ts
```

Expected: both commands exit 0.

### Task 2: Documentation And Verification

**Files:**
- Modify: `docs/operations/internal-rollout-runbook.md`
- Modify: `docs/superpowers/specs/2026-07-04-iris-runtime-control-audit-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-runtime-control-operator-hint.md`

- [x] **Step 1: Document the diagnostic-only header**

Document `X-Iris-Operator` as an optional audit hint and explicitly state it is not authentication.

- [x] **Step 2: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

- [ ] **Step 3: Commit, push, and verify PR checks**

Commit the operator hint update, push `codex/iris-document-source-registry`, update PR #3, and
confirm GitHub Actions returns Core and AI Worker success.
