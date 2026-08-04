# Iris Lightweight Admin Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add a minimal browser Admin Console so a small internal team can inspect Iris health and operate runtime-control switches without shell scripts.

**Architecture:** Serve a static console shell from Core at `/admin`, with separate CSS and JS routes. The shell contains no operator data and no token; the operator enters the existing `IRIS_INTERNAL_API_TOKEN`, and browser JS calls the already-authenticated `/internal/*` APIs with `Authorization: Bearer <token>`.

**Tech Stack:** Fastify, TypeScript, browser-native HTML/CSS/JavaScript, existing runtime-control and status APIs.

## Global Constraints

- Do not introduce a frontend framework or new runtime dependency.
- Do not create a second admin authorization model in this slice.
- Do not expose `/internal/*` without the existing bearer guard.
- Do not put secrets, internal API tokens, source content, message text, or document bodies into static assets.
- The console is an operator convenience layer; existing APIs remain the source of truth.

---

### Task 1: Static Admin Console Assets

**Files:**
- Create: `apps/core/src/admin-console/admin-console-assets.ts`
- Test: `apps/core/tests/admin-console-assets.test.ts`

**Interfaces:**
- Produces: `renderAdminConsoleHtml(): string`, `renderAdminConsoleCss(): string`, `renderAdminConsoleScript(): string`

- [x] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from "vitest";
import {
  renderAdminConsoleCss,
  renderAdminConsoleHtml,
  renderAdminConsoleScript,
} from "../src/admin-console/admin-console-assets.js";

describe("admin console assets", () => {
  it("renders a static shell without secrets or inline internal data", () => {
    const html = renderAdminConsoleHtml();

    expect(html).toContain("<title>Iris Admin Console</title>");
    expect(html).toContain('href="/admin/console.css"');
    expect(html).toContain('src="/admin/console.js"');
    expect(html).not.toContain("IRIS_INTERNAL_API_TOKEN");
    expect(html).not.toContain("Bearer ");
    expect(html).not.toContain("/internal/status");
  });

  it("renders browser script that calls existing internal APIs with operator-supplied bearer auth", () => {
    const script = renderAdminConsoleScript();

    expect(script).toContain("/internal/status");
    expect(script).toContain("/internal/runtime-control/status");
    expect(script).toContain("Authorization");
    expect(script).toContain("x-iris-operator");
    expect(script).not.toContain("IRIS_INTERNAL_API_TOKEN");
  });

  it("renders scoped CSS for a work-focused operator surface", () => {
    const css = renderAdminConsoleCss();

    expect(css).toContain(".admin-shell");
    expect(css).toContain(".status-grid");
    expect(css).not.toContain("url(");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/core test -- admin-console-assets.test.ts`

Expected: FAIL because `admin-console-assets.ts` does not exist.

- [x] **Step 3: Implement assets**

Create functions returning static HTML/CSS/JS. JS must:
- keep token in `sessionStorage`;
- call `/internal/status`, `/internal/readiness`, and `/internal/runtime-control/status`;
- support global enable/disable, group enable/disable, and capability toggles;
- send `Authorization` and `x-iris-operator` headers;
- never log or render the token.

- [x] **Step 4: Run test to verify it passes**

Run: `npm --workspace apps/core test -- admin-console-assets.test.ts`

Expected: PASS.

### Task 2: Fastify Routes

**Files:**
- Modify: `apps/core/src/app.ts`
- Test: `apps/core/tests/admin-console-api.test.ts`

**Interfaces:**
- Consumes: `renderAdminConsoleHtml`, `renderAdminConsoleCss`, `renderAdminConsoleScript`
- Produces: `GET /admin`, `GET /admin/console.css`, `GET /admin/console.js`

- [x] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("Admin Console routes", () => {
  it("serves the static console shell without weakening internal API auth", async () => {
    const app = buildApp({ internalApiToken: "operator-secret" });

    const page = await app.inject({ method: "GET", url: "/admin" });
    const unauthorizedInternal = await app.inject({ method: "GET", url: "/internal/status" });

    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.body).toContain("Iris Admin Console");
    expect(page.body).not.toContain("operator-secret");
    expect(unauthorizedInternal.statusCode).toBe(401);

    await app.close();
  });

  it("serves static console assets with bounded cache and no token material", async () => {
    const app = buildApp({ internalApiToken: "operator-secret" });

    const css = await app.inject({ method: "GET", url: "/admin/console.css" });
    const js = await app.inject({ method: "GET", url: "/admin/console.js" });

    expect(css.statusCode).toBe(200);
    expect(css.headers["content-type"]).toContain("text/css");
    expect(css.body).not.toContain("operator-secret");
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toContain("javascript");
    expect(js.body).toContain("/internal/runtime-control/status");
    expect(js.body).not.toContain("operator-secret");

    await app.close();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/core test -- admin-console-api.test.ts`

Expected: FAIL because `/admin` routes are missing.

- [x] **Step 3: Implement routes**

Import the asset renderers in `app.ts` and register three `GET` routes before internal API routes. Set:
- HTML: `content-type: text/html; charset=utf-8`, `cache-control: no-store`
- CSS: `content-type: text/css; charset=utf-8`, `cache-control: public, max-age=300`
- JS: `content-type: application/javascript; charset=utf-8`, `cache-control: public, max-age=300`

- [x] **Step 4: Run test to verify it passes**

Run: `npm --workspace apps/core test -- admin-console-api.test.ts admin-console-assets.test.ts answer-draft-api.test.ts runtime-control-api.test.ts`

Expected: PASS.

### Task 3: Documentation And Verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md`
- Modify: `docs/pull-requests/2026-07-23-iris-proactive-signal-preview.md`

- [x] **Step 1: Update docs**

Record that IRIS-CORE-014 now has a minimal browser console for status/runtime-control, while richer audit/source/proposal operations remain backlog.

- [x] **Step 2: Verify**

Run:
- `npm --workspace apps/core test`
- `npm --workspace apps/core run typecheck`
- `npm --workspace apps/core run build`
- `git diff --check`

Expected: all pass, with only existing Windows CRLF warnings allowed.
