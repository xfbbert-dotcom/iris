# Iris Audit Operator Hint Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow internal audit event queries to filter by `operatorHint`.

**Architecture:** Extend the existing audit query parser with an optional sanitized `operatorHint`
filter, reuse the same matching helper for raw events, and apply the filter inside
`InMemoryAuditLog.summarizeRecent()` before grouping.

**Tech Stack:** Fastify, Vitest, TypeScript, Markdown.

---

### Task 1: Query Filtering

**Files:**
- Modify: `apps/core/src/audit/audit-log.ts`
- Modify: `apps/core/src/app.ts`
- Modify: `apps/core/tests/runtime-control-api.test.ts`

- [x] **Step 1: Write failing raw event filter coverage**

Add a runtime-control API test that records one event with `X-Iris-Operator: alice@example.com` and
one event with `X-Iris-Operator: bob@example.com`, then queries:

```text
/internal/audit/events?limit=20&type=runtime_control_updated&operatorHint=alice%40example.com
```

Expected before implementation: response metadata does not include the `operatorHint` filter and
both events are returned.

- [x] **Step 2: Extend audit query types**

Add `operatorHint?: string` to `AuditEventSummaryQuery`.

- [x] **Step 3: Parse and validate the filter**

Use the existing `readOperatorHint()` sanitizer for `value.operatorHint`. Reject invalid non-empty
filter values with `400 { "ok": false, "error": "invalid_request" }`.

- [x] **Step 4: Apply the filter to raw events and summaries**

Update `matchesAuditEventQuery()` and `InMemoryAuditLog.summarizeRecent()` so
`operatorHint` must match exactly when supplied.

- [x] **Step 5: Expose the filter in response metadata**

Add `operatorHint` to the `meta.filters` object when it is supplied.

- [x] **Step 6: Run focused tests**

Run:

```powershell
npm test --workspace apps/core -- runtime-control-api.test.ts -t "filters runtime control audit events by operator hint"
npm test --workspace apps/core -- runtime-control-api.test.ts answer-draft-api.test.ts audit-log.test.ts
```

Expected: both commands exit 0.

### Task 2: Documentation And Verification

**Files:**
- Modify: `docs/operations/internal-rollout-runbook.md`
- Modify: `docs/superpowers/specs/2026-07-04-iris-runtime-control-audit-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-audit-operator-hint-filter.md`

- [x] **Step 1: Document the filter**

Document `operatorHint` audit filtering in the rollout runbook and runtime-control audit design.

- [x] **Step 2: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

- [ ] **Step 3: Commit, push, and verify PR checks**

Commit the audit filter update, push `codex/iris-document-source-registry`, update PR #3, and
confirm GitHub Actions returns Core and AI Worker success.
