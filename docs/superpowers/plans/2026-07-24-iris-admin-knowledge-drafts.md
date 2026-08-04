# Iris Admin Knowledge Drafts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a minimal knowledge-draft queue to the Admin Console so internal operators can inspect draft status counts, list pending drafts, and request revision or rejection without shell scripts.

**Architecture:** Reuse existing `/internal/knowledge-drafts/*` APIs from the static `/admin` console. The first slice shows redacted queue metadata only and routes human decisions to existing transition endpoints; full rich editing and publication execution remain governed by Feishu cards/OAuth flows.

**Tech Stack:** Fastify, TypeScript, browser-native HTML/CSS/JavaScript, existing knowledge-draft internal APIs.

## Global Constraints

- Do not introduce a frontend framework or new runtime dependency.
- Do not expose `/internal/*` publicly; Caddy remains exact static `/admin` assets only.
- Do not render full draft content in the queue list.
- Do not bypass Feishu card/OAuth approval semantics for high-impact publication.
- Existing internal APIs remain the source of truth.

---

### Task 1: Knowledge Draft Queue In Static Assets

**Files:**
- Modify: `apps/core/src/admin-console/admin-console-assets.ts`
- Test: `apps/core/tests/admin-console-assets.test.ts`

**Interfaces:**
- Consumes: `GET /internal/knowledge-drafts/status`
- Consumes: `GET /internal/knowledge-drafts?limit=20`
- Consumes: `POST /internal/knowledge-drafts/:id/request-revision`
- Consumes: `POST /internal/knowledge-drafts/:id/reject`
- Produces: knowledge-draft queue panel in `/admin`

- [x] **Step 1: Write failing tests**

Add an asset test that asserts:

```ts
it("renders a redacted knowledge draft governance queue", () => {
  const html = renderAdminConsoleHtml();
  const script = renderAdminConsoleScript();

  expect(html).toContain("Knowledge Drafts");
  expect(html).toContain("knowledge-draft-table");
  expect(script).toContain("/internal/knowledge-drafts/status");
  expect(script).toContain("/internal/knowledge-drafts?limit=20");
  expect(script).toContain("/request-revision");
  expect(script).toContain("/reject");
  expect(script).not.toContain("currentRevision.content");
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/core test -- admin-console-assets.test.ts`

Expected: FAIL because the console does not yet include the knowledge-draft queue.

- [x] **Step 3: Implement minimal queue**

Extend HTML with:
- `section.knowledge-draft-panel`;
- `dl#knowledge-draft-status`;
- `table#knowledge-draft-table`;
- `tbody#knowledge-draft-rows`;
- status and group filters.

Extend JS with:
- `refreshKnowledgeDrafts()`;
- `renderKnowledgeDraftStatus(status)`;
- `renderKnowledgeDrafts(drafts)`;
- `transitionKnowledgeDraft(draft, action)`.

Render only:
- draft id;
- source group id;
- status;
- risk level;
- current revision number;
- title;
- updated at.

- [x] **Step 4: Run focused tests**

Run: `npm --workspace apps/core test -- admin-console-assets.test.ts admin-console-api.test.ts knowledge-draft-api.test.ts`

Expected: PASS.

### Task 2: Documentation And Verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md`
- Modify: `docs/pull-requests/2026-07-23-iris-proactive-signal-preview.md`

- [x] **Step 1: Update docs**

Record that the Admin Console now includes a minimal knowledge-draft queue for status inspection and safe revision/rejection transitions, while full publication approval remains with the governed Feishu/OAuth path.

- [x] **Step 2: Verify**

Run:
- `npm --workspace apps/core test -- admin-console-assets.test.ts admin-console-api.test.ts knowledge-draft-api.test.ts`
- `npm --workspace apps/core test`
- `npm --workspace apps/core run typecheck`
- `npm --workspace apps/core run build`
- `node --test scripts/pilot-compose.test.mjs`
- `git diff --check`

Expected: all pass, with only existing Windows CRLF warnings allowed.
