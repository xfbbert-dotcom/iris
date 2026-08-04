# Iris Admin Audit Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an audit summary view to the Admin Console so internal operators can inspect recent security and operator events without reading raw message bodies.

**Architecture:** Extend the static `/admin` console to reuse the existing authenticated `/internal/audit/events/summary` endpoint. The console renders aggregate metadata only, keeps the internal bearer-token boundary unchanged, and does not introduce a new audit store.

**Tech Stack:** Fastify, TypeScript, browser-native HTML/CSS/JavaScript, existing in-memory audit API.

## Global Constraints

- Do not introduce a frontend framework or new runtime dependency.
- Do not expose `/internal/*` publicly; Caddy remains exact static `/admin` assets only.
- Do not render raw message text, prompt text, tokens, card JSON, or document body text.
- Existing internal APIs remain the source of truth.

---

### Task 1: Audit Summary Panel In Static Assets

**Files:**
- Modify: `apps/core/src/admin-console/admin-console-assets.ts`
- Test: `apps/core/tests/admin-console-assets.test.ts`

**Interfaces:**
- Consumes: `GET /internal/audit/events/summary?limit=20`
- Produces: aggregate audit summary panel in `/admin`

- [x] **Step 1: Write the failing test**

Add an asset test that asserts the console renders `Audit Summary`, `audit-summary-table`, calls `/internal/audit/events/summary?limit=20`, includes common audit type filters, and does not contain raw message body keys.

- [x] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/core test -- admin-console-assets.test.ts`

Expected: FAIL because the console has no audit summary panel.

- [x] **Step 3: Implement minimal panel**

Extend HTML with:
- event type select;
- document id filter;
- limit input;
- refresh button;
- summary meta definition list;
- `table#audit-summary-table`;
- `tbody#audit-summary-rows`.

Extend JS with:
- `auditSummaryPath()`;
- `renderAuditSummaryMeta(meta)`;
- `renderAuditSummaries(summaries)`;
- `refreshAuditSummaries()`;
- a small allowlist for common audit event types.

- [x] **Step 4: Run focused tests**

Run: `npm --workspace apps/core test -- admin-console-assets.test.ts`

Expected: PASS.

### Task 2: Documentation And Verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md`
- Modify: `docs/pull-requests/2026-07-23-iris-proactive-signal-preview.md`

- [x] **Step 1: Update docs**

Record that Admin Console now includes audit summary viewing while durable audit storage and formal admin identity remain future work.

- [x] **Step 2: Verify**

Run:
- `npm --workspace apps/core test -- admin-console-assets.test.ts admin-console-api.test.ts answer-draft-api.test.ts`
- `npm --workspace apps/core test`
- `npm --workspace apps/core run typecheck`
- `npm --workspace apps/core run build`
- `node --test scripts/pilot-compose.test.mjs`
- `git diff --check`

Expected: all pass, with only existing Windows CRLF warnings allowed.
