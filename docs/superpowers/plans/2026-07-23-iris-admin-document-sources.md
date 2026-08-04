# Iris Admin Document Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add document-source governance to the lightweight Admin Console so internal operators can inspect Iris-visible documents, pause answering or knowledge-draft generation per source, and request a manual sync without shell scripts.

**Architecture:** Reuse the existing `/internal/document-sync/*` APIs and extend only the static `/admin` shell, CSS, and JavaScript. The console keeps the same operator-supplied bearer token model, fetches document-source summaries with latest snapshot health, and applies source policy changes through the existing policy endpoint.

**Tech Stack:** Fastify, TypeScript, browser-native HTML/CSS/JavaScript, existing document-sync internal APIs.

## Global Constraints

- Do not introduce a frontend framework or new runtime dependency.
- Do not expose `/internal/*` publicly; Caddy must continue to expose only exact static `/admin` assets.
- Do not render document body text in the admin source list; use summary metadata and capped previews only if a later explicit task adds a review view.
- Do not create a new admin authorization model in this slice.
- Existing internal APIs remain the source of truth.

---

### Task 1: Document Source Controls In Static Assets

**Files:**
- Modify: `apps/core/src/admin-console/admin-console-assets.ts`
- Test: `apps/core/tests/admin-console-assets.test.ts`

**Interfaces:**
- Consumes: `GET /internal/document-sync/sources?includeLatestSnapshot=true`
- Consumes: `PATCH /internal/document-sync/sources/:id/policy`
- Consumes: `POST /internal/document-sync/sources/:id/enqueue`
- Produces: document-source filters, table, policy toggles, and manual-sync button in `/admin`

- [x] **Step 1: Write failing tests**

Add tests that assert:

```ts
it("renders document source governance regions without document body text", () => {
  const html = renderAdminConsoleHtml();
  const script = renderAdminConsoleScript();

  expect(html).toContain("Document Sources");
  expect(html).toContain("document-source-table");
  expect(script).toContain("/internal/document-sync/sources?includeLatestSnapshot=true");
  expect(script).toContain("/internal/document-sync/sources/");
  expect(script).toContain("/policy");
  expect(script).toContain("/enqueue");
  expect(script).not.toContain("bodyText");
  expect(script).not.toContain("rawContent");
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/core test -- admin-console-assets.test.ts`

Expected: FAIL because the current console has no document-source governance region.

- [x] **Step 3: Implement minimal document-source UI**

Extend the static HTML with:
- source type filter;
- source id text filter;
- refresh button;
- `table#document-source-table`;
- `div#document-source-empty`.

Extend JS with:
- `refreshDocumentSources()`;
- `renderDocumentSources(sources)`;
- `updateDocumentSourcePolicy(sourceId, patch)`;
- `enqueueDocumentSource(sourceId)`.

Use only summary fields already returned by the source API:
- `id`;
- `sourceType`;
- `title`;
- `sourceUri`;
- `syncState`;
- `answeringEnabled`;
- `knowledgeDraftsEnabled`;
- `permissionState`;
- `syncHealth.status`;
- `latestSnapshot.observedAt`.

- [x] **Step 4: Run focused tests**

Run: `npm --workspace apps/core test -- admin-console-assets.test.ts admin-console-api.test.ts`

Expected: PASS.

### Task 2: API Contract Coverage From Console Assumptions

**Files:**
- Modify: `apps/core/tests/admin-console-api.test.ts`

**Interfaces:**
- Consumes: existing `buildApp`
- Produces: regression tests that `/admin` remains public-static only while document-sync APIs stay bearer-protected

- [x] **Step 1: Write failing or tightening tests**

Add tests that assert:

```ts
it("does not expose document-source governance without the internal bearer token", async () => {
  const app = buildApp({ internalApiToken: "operator-secret" });

  const unauthorizedList = await app.inject({
    method: "GET",
    url: "/internal/document-sync/sources?includeLatestSnapshot=true",
  });
  const unauthorizedPolicy = await app.inject({
    method: "PATCH",
    url: "/internal/document-sync/sources/source-1/policy",
    payload: { answeringEnabled: false },
  });

  expect(unauthorizedList.statusCode).toBe(401);
  expect(unauthorizedPolicy.statusCode).toBe(401);

  await app.close();
});
```

- [x] **Step 2: Run test**

Run: `npm --workspace apps/core test -- admin-console-api.test.ts`

Expected: PASS if the existing bearer guard already covers document-sync routes; FAIL if the guard is accidentally bypassed.

### Task 3: Docs And Verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md`
- Modify: `docs/pull-requests/2026-07-23-iris-proactive-signal-preview.md`

- [x] **Step 1: Update docs**

Record that the Admin Console now includes a first document-source governance view for source inspection, answering/knowledge-draft policy toggles, and manual sync requests.

- [x] **Step 2: Verify**

Run:
- `npm --workspace apps/core test -- admin-console-assets.test.ts admin-console-api.test.ts answer-draft-api.test.ts`
- `npm --workspace apps/core test`
- `npm --workspace apps/core run typecheck`
- `npm --workspace apps/core run build`
- `node --test scripts/pilot-compose.test.mjs`
- `git diff --check`

Expected: all pass, with only existing Windows CRLF warnings allowed.
