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
});
