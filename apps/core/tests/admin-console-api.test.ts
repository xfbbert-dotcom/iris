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
    expect(css.headers["cache-control"]).toBe("public, max-age=300");
    expect(css.body).not.toContain("operator-secret");
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toContain("javascript");
    expect(js.headers["cache-control"]).toBe("public, max-age=300");
    expect(js.body).toContain("/internal/runtime-control/status");
    expect(js.body).not.toContain("operator-secret");

    await app.close();
  });

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
});
