# Iris Admin Proactive Candidates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add proactive-candidate governance to the Admin Console so internal operators can scan a pilot group, inspect pending proactive suggestions, dismiss them, or approve delivery through existing fail-closed APIs.

**Architecture:** Extend the static `/admin` console to reuse `/internal/proactive-signals/groups/:groupId/*` endpoints. The console requires an explicit group id, never auto-scans all groups, and keeps proactive speech governed by existing runtime-control and delivery gates.

**Tech Stack:** Fastify, TypeScript, browser-native HTML/CSS/JavaScript, existing proactive-signal internal APIs.

## Global Constraints

- Do not introduce a frontend framework or new runtime dependency.
- Do not expose `/internal/*` publicly; Caddy remains exact static `/admin` assets only.
- Do not send Feishu messages directly from the console; only approve a candidate into the existing delivery queue.
- Require an explicit group id before scanning, listing, dismissing, or approving candidates.
- Existing internal APIs remain the source of truth.

---

### Task 1: Proactive Candidate Governance In Static Assets

**Files:**
- Modify: `apps/core/src/admin-console/admin-console-assets.ts`
- Test: `apps/core/tests/admin-console-assets.test.ts`

**Interfaces:**
- Consumes: `POST /internal/proactive-signals/groups/:groupId/scan`
- Consumes: `GET /internal/proactive-signals/groups/:groupId/candidates?limit=20`
- Consumes: `POST /internal/proactive-signals/groups/:groupId/candidates/:idempotencyKey/dismiss`
- Consumes: `POST /internal/proactive-signals/groups/:groupId/candidates/:idempotencyKey/approve-delivery`
- Produces: proactive candidate governance panel in `/admin`

- [x] **Step 1: Write failing tests**

Add an asset test that asserts:

```ts
it("renders proactive candidate governance without direct Feishu send controls", () => {
  const html = renderAdminConsoleHtml();
  const script = renderAdminConsoleScript();

  expect(html).toContain("Proactive Candidates");
  expect(html).toContain("proactive-candidate-table");
  expect(script).toContain("/internal/proactive-signals/groups/");
  expect(script).toContain("/scan");
  expect(script).toContain("/candidates?limit=20");
  expect(script).toContain("/dismiss");
  expect(script).toContain("/approve-delivery");
  expect(script).not.toContain("sendMessage");
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/core test -- admin-console-assets.test.ts`

Expected: FAIL because the console has no proactive candidate panel.

- [x] **Step 3: Implement minimal panel**

Extend HTML with:
- group id input;
- scan button;
- refresh button;
- `table#proactive-candidate-table`;
- `tbody#proactive-candidate-rows`.

Extend JS with:
- `readProactiveGroupId()`;
- `scanProactiveCandidates()`;
- `refreshProactiveCandidates()`;
- `renderProactiveCandidates(candidates)`;
- `transitionProactiveCandidate(candidate, action)`.

Render:
- idempotency key;
- kind;
- priority;
- entity type/id/version;
- suggested mode;
- last relevant at;
- actions: dismiss, approve delivery.

- [x] **Step 4: Run focused tests**

Run: `npm --workspace apps/core test -- admin-console-assets.test.ts admin-console-api.test.ts proactive-signal-api.test.ts`

Expected: PASS.

### Task 2: Documentation And Verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md`
- Modify: `docs/pull-requests/2026-07-23-iris-proactive-signal-preview.md`

- [x] **Step 1: Update docs**

Record that Admin Console now includes proactive-candidate governance, while real delivery remains governed by runtime-control and delivery worker gates.

- [x] **Step 2: Verify**

Run:
- `npm --workspace apps/core test -- admin-console-assets.test.ts admin-console-api.test.ts proactive-signal-api.test.ts`
- `npm --workspace apps/core test`
- `npm --workspace apps/core run typecheck`
- `npm --workspace apps/core run build`
- `node --test scripts/pilot-compose.test.mjs`
- `git diff --check`

Expected: all pass, with only existing Windows CRLF warnings allowed.
