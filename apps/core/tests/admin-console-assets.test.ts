import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";

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
    expect(html).toContain('value="authorized_wiki_document"');
    expect(html).toContain('value="user_submitted_document"');
    expect(html).toContain("user-document-source-uri");
    expect(html).toContain("user-document-submitter");
    expect(script).toContain("/internal/document-sync/sources?includeLatestSnapshot=true");
    expect(script).toContain("/internal/document-sync/sources/");
    expect(script).toContain("/internal/document-sync/user-submitted-documents");
    expect(script).toContain("/policy");
    expect(script).toContain("/enqueue");
    expect(script).not.toContain("bodyText");
    expect(script).not.toContain("rawContent");
  });

  it("renders compact wiki space controls adjacent to document sources", () => {
    const html = renderAdminConsoleHtml();
    const css = renderAdminConsoleCss();
    const script = renderAdminConsoleScript();

    expect(html).toContain("Wiki Spaces");
    expect(html.indexOf('class="document-source-panel"')).toBeLessThan(html.indexOf('class="wiki-space-panel"'));
    expect(html).toContain("wiki-space-root-source-uri");
    expect(html).toContain("wiki-space-form");
    expect(html).toContain("wiki-space-refresh");
    expect(html).toContain("wiki-space-rows");
    expect(html).toContain("wiki-space-loading");
    expect(html).toContain("wiki-space-error");
    expect(html).toContain("wiki-space-empty");
    expect(html).toContain('title="Refresh wiki spaces"');
    expect(css).toContain(".wiki-space-table");
    expect(css).toContain("table-layout: fixed");
    expect(script).toContain("/internal/document-sync/wiki-spaces?limit=20");
    expect(script).toContain('rescanButton.title = "Rescan wiki space"');
    expect(script).toContain("checkbox.type = \"checkbox\"");
    expect(script).not.toContain(".innerHTML");
  });

  it("registers a wiki root and refreshes the authorization list", async () => {
    const fetch = vi.fn((path: string) => {
      if (path === "/internal/document-sync/wiki-spaces") {
        return Promise.resolve(jsonResponse({ ok: true, authorization: wikiSpace("space-1") }));
      }
      if (path === "/internal/document-sync/wiki-spaces?limit=20") {
        return Promise.resolve(jsonResponse({ ok: true, wikiSpaces: [] }));
      }
      throw new Error("unexpected_request");
    });
    const console = runAdminConsole(fetch);
    const rootSourceUri = "https://tenant.feishu.cn/wiki/root_1?from=space";
    console.element("wiki-space-root-source-uri").value = rootSourceUri;

    await console.trigger("wiki-space-form", "submit");

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "/internal/document-sync/wiki-spaces",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ rootSourceUri }) }),
    );
    expect(fetch).toHaveBeenNthCalledWith(2, "/internal/document-sync/wiki-spaces?limit=20", expect.anything());
    expect(console.element("wiki-space-root-source-uri").value).toBe("");
    expect(console.element("event-log").children[0]!.textContent).toContain("Wiki space registered: space-1");
  });

  it("keeps only the latest wiki space refresh when requests resolve out of order", async () => {
    const first = deferred<ResponseStub>();
    const second = deferred<ResponseStub>();
    const responses = [first, second];
    const fetch = vi.fn(() => {
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected_request");
      return response.promise;
    });
    const console = runAdminConsole(fetch);

    const firstRefresh = console.trigger("wiki-space-refresh", "click");
    expect(console.element("wiki-space-loading").textContent).toBe("Loading wiki spaces...");
    const secondRefresh = console.trigger("wiki-space-refresh", "click");
    second.resolve(jsonResponse({ ok: true, wikiSpaces: [wikiSpace("space-b", { title: "current" })] }));
    await secondRefresh;
    first.resolve(jsonResponse({ ok: true, wikiSpaces: [wikiSpace("space-a", { title: "stale" })] }));
    await firstRefresh;

    const rows = console.element("wiki-space-rows");
    expect(rows.children).toHaveLength(1);
    expect(rows.children[0]!.children[0]!.children[0]!.textContent).toBe("current");
    expect(console.element("wiki-space-loading").textContent).toBe("");
  });

  it("renders wiki server strings through DOM text nodes", async () => {
    const console = runAdminConsole(() => Promise.resolve(jsonResponse({
      ok: true,
      wikiSpaces: [wikiSpace("space-b", { title: "<img src=x onerror=alert(1)>" })],
    })));

    await console.trigger("wiki-space-refresh", "click");

    expect(console.element("wiki-space-rows").children[0]!.children[0]!.children[0]!.textContent).toBe(
      "<img src=x onerror=alert(1)>",
    );
  });

  it("reports a wiki space loading failure without an empty state", async () => {
    const failedConsole = runAdminConsole(() => Promise.reject(new Error("wiki_space_operation_failed")));
    await failedConsole.trigger("wiki-space-refresh", "click");
    expect(failedConsole.element("wiki-space-error").textContent).toBe(
      "Unable to load wiki spaces: wiki_space_operation_failed",
    );
    expect(failedConsole.element("wiki-space-empty").textContent).toBe("");
  });

  it("rescans a wiki space and persists enabled changes through the Task 5 endpoints", async () => {
    const authorization = wikiSpace("space/1");
    const fetch = vi.fn((path: string) => {
      if (path === "/internal/document-sync/wiki-spaces?limit=20") {
        return Promise.resolve(jsonResponse({ ok: true, wikiSpaces: [authorization] }));
      }
      if (path === "/internal/document-sync/wiki-spaces/space%2F1/rescan") {
        return Promise.resolve(jsonResponse({ ok: true, authorization }));
      }
      if (path === "/internal/document-sync/wiki-spaces/space%2F1") {
        return Promise.resolve(jsonResponse({ ok: true, authorization: { ...authorization, enabled: false } }));
      }
      throw new Error("unexpected_request");
    });
    const console = runAdminConsole(fetch);

    await console.trigger("wiki-space-refresh", "click");
    const rescanButton = console.allElements().find((element) => element.title === "Rescan wiki space");
    const enabled = console.allElements().find((element) => element.type === "checkbox");
    expect(rescanButton).toBeDefined();
    expect(enabled).toBeDefined();

    await rescanButton!.trigger("click");
    enabled!.checked = false;
    await enabled!.trigger("change");

    expect(fetch).toHaveBeenCalledWith(
      "/internal/document-sync/wiki-spaces/space%2F1/rescan",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
    expect(fetch).toHaveBeenCalledWith(
      "/internal/document-sync/wiki-spaces/space%2F1",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ enabled: false }) }),
    );
  });

  it("keeps a persisted enabled change when the subsequent list refresh fails", async () => {
    const authorization = wikiSpace("space-1");
    let listRequestCount = 0;
    const fetch = vi.fn((path: string) => {
      if (path === "/internal/document-sync/wiki-spaces?limit=20") {
        listRequestCount += 1;
        return listRequestCount === 1
          ? Promise.resolve(jsonResponse({ ok: true, wikiSpaces: [authorization] }))
          : Promise.reject(new Error("list_after_enabled_update_failed"));
      }
      if (path === "/internal/document-sync/wiki-spaces/space-1") {
        return Promise.resolve(jsonResponse({
          ok: true,
          authorization: { ...authorization, enabled: false },
        }));
      }
      throw new Error("unexpected_request");
    });
    const console = runAdminConsole(fetch);
    await console.trigger("wiki-space-refresh", "click");
    const rows = console.element("wiki-space-rows");
    const renderedRow = rows.children[0]!;
    const enabled = renderedRow.children[4]!.children[0]!.children[0]!;

    enabled.checked = false;
    await enabled.trigger("change");

    expect(rows.children).toHaveLength(1);
    expect(rows.children[0]).toBe(renderedRow);
    expect(rows.children[0]!.children[4]!.children[0]!.children[0]!.checked).toBe(false);
    expect(console.element("wiki-space-error").textContent).toBe(
      "Unable to refresh wiki spaces after enabled update: list_after_enabled_update_failed",
    );
    expect(console.element("connection-state").textContent).toBe("Refresh warning");
    expect(console.element("event-log").children.some((item) =>
      item.textContent.includes("Wiki space disabled: space-1")
    )).toBe(true);
    expect(console.element("event-log").children.some((item) =>
      item.textContent.includes("Wiki space enabled update failed:")
    )).toBe(false);
  });

  it("keeps the last successful empty state when a later list refresh fails", async () => {
    let listRequestCount = 0;
    const console = runAdminConsole(() => {
      listRequestCount += 1;
      return listRequestCount === 1
        ? Promise.resolve(jsonResponse({ ok: true, wikiSpaces: [] }))
        : Promise.reject(new Error("later_list_failed"));
    });
    await console.trigger("wiki-space-refresh", "click");
    expect(console.element("wiki-space-empty").textContent).toBe("No wiki spaces registered.");

    await console.trigger("wiki-space-refresh", "click");

    expect(console.element("wiki-space-rows").children).toHaveLength(0);
    expect(console.element("wiki-space-empty").textContent).toBe("No wiki spaces registered.");
    expect(console.element("wiki-space-error").textContent).toBe(
      "Unable to load wiki spaces: later_list_failed",
    );
  });

  it.each([
    ["fails", errorResponse(500, "older_enabled_refresh_failed")],
    ["succeeds", jsonResponse({ ok: true, wikiSpaces: [wikiSpace("space-1", { enabled: false })] })],
  ])("keeps newer action feedback when an older enabled refresh %s", async (_outcome, olderRefreshResponse) => {
    const authorization = wikiSpace("space-1");
    const olderRefresh = deferred<ResponseStub>();
    const olderRefreshStarted = deferred<void>();
    const newerRegistration = deferred<ResponseStub>();
    let listRequestCount = 0;
    const fetch = vi.fn((path: string) => {
      if (path === "/internal/document-sync/wiki-spaces?limit=20") {
        listRequestCount += 1;
        if (listRequestCount === 1) {
          return Promise.resolve(jsonResponse({ ok: true, wikiSpaces: [authorization] }));
        }
        olderRefreshStarted.resolve(undefined);
        return olderRefresh.promise;
      }
      if (path === "/internal/document-sync/wiki-spaces/space-1") {
        return Promise.resolve(jsonResponse({
          ok: true,
          authorization: { ...authorization, enabled: false },
        }));
      }
      if (path === "/internal/document-sync/wiki-spaces") return newerRegistration.promise;
      throw new Error("unexpected_request");
    });
    const console = runAdminConsole(fetch);
    await console.trigger("wiki-space-refresh", "click");
    const enabled = console.element("wiki-space-rows").children[0]!
      .children[4]!.children[0]!.children[0]!;

    enabled.checked = false;
    const olderAction = enabled.trigger("change");
    await olderRefreshStarted.promise;
    console.element("wiki-space-root-source-uri").value = "https://tenant.feishu.cn/wiki/root_2";
    const newerAction = console.trigger("wiki-space-form", "submit");
    newerRegistration.resolve(errorResponse(500, "newer_registration_failed"));
    await newerAction;
    expect(console.element("wiki-space-error").textContent).toBe(
      "Unable to register wiki space: newer_registration_failed",
    );

    olderRefresh.resolve(olderRefreshResponse);
    await olderAction;

    expect(console.element("wiki-space-error").textContent).toBe(
      "Unable to register wiki space: newer_registration_failed",
    );
    expect(console.element("connection-state").textContent).toBe("Request failed");
  });

  it("does not render an older action refresh after a newer mutation starts", async () => {
    const authorization = wikiSpace("space-1");
    const olderRefresh = deferred<ResponseStub>();
    const olderRefreshStarted = deferred<void>();
    const newerRegistration = deferred<ResponseStub>();
    let listRequestCount = 0;
    const fetch = vi.fn((path: string) => {
      if (path === "/internal/document-sync/wiki-spaces?limit=20") {
        listRequestCount += 1;
        if (listRequestCount === 1) {
          return Promise.resolve(jsonResponse({ ok: true, wikiSpaces: [authorization] }));
        }
        olderRefreshStarted.resolve(undefined);
        return olderRefresh.promise;
      }
      if (path === "/internal/document-sync/wiki-spaces/space-1") {
        return Promise.resolve(jsonResponse({
          ok: true,
          authorization: { ...authorization, enabled: false },
        }));
      }
      if (path === "/internal/document-sync/wiki-spaces") return newerRegistration.promise;
      throw new Error("unexpected_request");
    });
    const console = runAdminConsole(fetch);
    await console.trigger("wiki-space-refresh", "click");
    const rows = console.element("wiki-space-rows");
    const renderedRow = rows.children[0]!;
    const enabled = renderedRow.children[4]!.children[0]!.children[0]!;

    enabled.checked = false;
    const olderAction = enabled.trigger("change");
    await olderRefreshStarted.promise;
    console.element("wiki-space-root-source-uri").value = "https://tenant.feishu.cn/wiki/root_2";
    const newerAction = console.trigger("wiki-space-form", "submit");
    expect(listRequestCount).toBe(2);

    olderRefresh.resolve(jsonResponse({ ok: true, wikiSpaces: [] }));
    await olderAction;

    expect(listRequestCount).toBe(2);
    expect(rows.children).toHaveLength(1);
    expect(rows.children[0]).toBe(renderedRow);
    expect(rows.children[0]!.children[4]!.children[0]!.children[0]!.checked).toBe(false);
    expect(console.element("wiki-space-empty").textContent).toBe("");

    newerRegistration.resolve(errorResponse(500, "newer_registration_failed"));
    await newerAction;
  });

  it("keeps newer action feedback when an older manual refresh fails", async () => {
    const olderRefresh = deferred<ResponseStub>();
    const newerRegistration = deferred<ResponseStub>();
    let listRequestCount = 0;
    const fetch = vi.fn((path: string) => {
      if (path === "/internal/document-sync/wiki-spaces?limit=20") {
        listRequestCount += 1;
        return listRequestCount === 1
          ? Promise.resolve(jsonResponse({ ok: true, wikiSpaces: [wikiSpace("space-1")] }))
          : olderRefresh.promise;
      }
      if (path === "/internal/document-sync/wiki-spaces") return newerRegistration.promise;
      throw new Error("unexpected_request");
    });
    const console = runAdminConsole(fetch);
    await console.trigger("wiki-space-refresh", "click");

    const olderAction = console.trigger("wiki-space-refresh", "click");
    console.element("wiki-space-root-source-uri").value = "https://tenant.feishu.cn/wiki/root_2";
    const newerAction = console.trigger("wiki-space-form", "submit");
    newerRegistration.resolve(errorResponse(500, "newer_registration_failed"));
    await newerAction;
    olderRefresh.resolve(errorResponse(500, "older_manual_refresh_failed"));
    await olderAction;

    expect(console.element("wiki-space-error").textContent).toBe(
      "Unable to register wiki space: newer_registration_failed",
    );
    expect(console.element("connection-state").textContent).toBe("Request failed");
  });

  it("keeps newer rescan feedback when an older registration request fails", async () => {
    const olderRegistration = deferred<ResponseStub>();
    const newerRescan = deferred<ResponseStub>();
    const fetch = vi.fn((path: string) => {
      if (path === "/internal/document-sync/wiki-spaces?limit=20") {
        return Promise.resolve(jsonResponse({ ok: true, wikiSpaces: [wikiSpace("space-1")] }));
      }
      if (path === "/internal/document-sync/wiki-spaces") return olderRegistration.promise;
      if (path === "/internal/document-sync/wiki-spaces/space-1/rescan") return newerRescan.promise;
      throw new Error("unexpected_request");
    });
    const console = runAdminConsole(fetch);
    await console.trigger("wiki-space-refresh", "click");
    console.element("wiki-space-root-source-uri").value = "https://tenant.feishu.cn/wiki/root_2";

    const olderAction = console.trigger("wiki-space-form", "submit");
    const rescanButton = console.allElements().find((element) => element.title === "Rescan wiki space");
    const newerAction = rescanButton!.trigger("click");
    newerRescan.resolve(errorResponse(500, "newer_rescan_failed"));
    await newerAction;
    olderRegistration.resolve(errorResponse(500, "older_registration_failed"));
    await olderAction;

    expect(console.element("wiki-space-error").textContent).toBe(
      "Unable to rescan wiki space: newer_rescan_failed",
    );
    expect(console.element("connection-state").textContent).toBe("Request failed");
  });

  it("gives the icon-only rescan control an explicit accessible name and tooltip", async () => {
    const console = runAdminConsole(() => Promise.resolve(jsonResponse({
      ok: true,
      wikiSpaces: [wikiSpace("space-1")],
    })));

    await console.trigger("wiki-space-refresh", "click");
    const rescanButton = console.allElements().find((element) => element.title === "Rescan wiki space");

    expect(rescanButton).toBeDefined();
    expect(rescanButton!.getAttribute("aria-label")).toBe("Rescan wiki space");
    expect(rescanButton!.title).toBe("Rescan wiki space");
  });

  it("shows registration errors in the alert until the next refresh starts", async () => {
    const nextRefresh = deferred<ResponseStub>();
    const fetch = vi.fn((path: string) => {
      if (path === "/internal/document-sync/wiki-spaces") {
        return Promise.resolve(errorResponse(500, "registration_<img src=x onerror=alert(1)>"));
      }
      if (path === "/internal/document-sync/wiki-spaces?limit=20") return nextRefresh.promise;
      throw new Error("unexpected_request");
    });
    const console = runAdminConsole(fetch);
    console.element("wiki-space-root-source-uri").value = "https://tenant.feishu.cn/wiki/root_1";

    await console.trigger("wiki-space-form", "submit");

    expect(console.element("wiki-space-error").textContent).toBe(
      "Unable to register wiki space: registration_<img src=x onerror=alert(1)>",
    );
    const refresh = console.trigger("wiki-space-refresh", "click");
    expect(console.element("wiki-space-error").textContent).toBe("");
    nextRefresh.resolve(jsonResponse({ ok: true, wikiSpaces: [] }));
    await refresh;
    expect(console.element("wiki-space-error").textContent).toBe("");
  });

  it("shows rescan request errors in the wiki space alert", async () => {
    const authorization = wikiSpace("space-1");
    const fetch = vi.fn((path: string) => {
      if (path === "/internal/document-sync/wiki-spaces?limit=20") {
        return Promise.resolve(jsonResponse({ ok: true, wikiSpaces: [authorization] }));
      }
      if (path === "/internal/document-sync/wiki-spaces/space-1/rescan") {
        return Promise.resolve(errorResponse(500, "rescan_request_failed"));
      }
      throw new Error("unexpected_request");
    });
    const console = runAdminConsole(fetch);
    await console.trigger("wiki-space-refresh", "click");
    const rescanButton = console.allElements().find((element) => element.title === "Rescan wiki space");

    await rescanButton!.trigger("click");

    expect(console.element("wiki-space-error").textContent).toBe(
      "Unable to rescan wiki space: rescan_request_failed",
    );
  });

  it("shows enabled PATCH errors in the alert and restores the persisted checkbox state", async () => {
    const authorization = wikiSpace("space-1");
    const fetch = vi.fn((path: string) => {
      if (path === "/internal/document-sync/wiki-spaces?limit=20") {
        return Promise.resolve(jsonResponse({ ok: true, wikiSpaces: [authorization] }));
      }
      if (path === "/internal/document-sync/wiki-spaces/space-1") {
        return Promise.resolve(errorResponse(500, "enabled_patch_failed"));
      }
      throw new Error("unexpected_request");
    });
    const console = runAdminConsole(fetch);
    await console.trigger("wiki-space-refresh", "click");
    const enabled = console.allElements().find((element) => element.type === "checkbox");

    enabled!.checked = false;
    await enabled!.trigger("change");

    expect(enabled!.checked).toBe(true);
    expect(console.element("wiki-space-error").textContent).toBe(
      "Unable to update wiki space enabled state: enabled_patch_failed",
    );
  });

  it("reports a post-rescan list failure as a refresh warning", async () => {
    const authorization = wikiSpace("space-1");
    let listRequestCount = 0;
    const fetch = vi.fn((path: string) => {
      if (path === "/internal/document-sync/wiki-spaces?limit=20") {
        listRequestCount += 1;
        return listRequestCount === 1
          ? Promise.resolve(jsonResponse({ ok: true, wikiSpaces: [authorization] }))
          : Promise.reject(new Error("list_after_rescan_failed"));
      }
      if (path === "/internal/document-sync/wiki-spaces/space-1/rescan") {
        return Promise.resolve(jsonResponse({ ok: true, authorization }));
      }
      throw new Error("unexpected_request");
    });
    const console = runAdminConsole(fetch);
    await console.trigger("wiki-space-refresh", "click");
    const rescanButton = console.allElements().find((element) => element.title === "Rescan wiki space");

    await rescanButton!.trigger("click");

    expect(console.element("wiki-space-error").textContent).toBe(
      "Unable to refresh wiki spaces after rescan: list_after_rescan_failed",
    );
    expect(console.element("connection-state").textContent).toBe("Refresh warning");
    expect(console.element("event-log").children.some((item) =>
      item.textContent.includes("Wiki space rescan requested: space-1")
    )).toBe(true);
    expect(console.element("event-log").children.some((item) =>
      item.textContent.includes("Wiki space rescan failed:")
    )).toBe(false);
  });

  it("reports a post-registration list failure as a refresh warning", async () => {
    const authorization = wikiSpace("space-1");
    const fetch = vi.fn((path: string) => {
      if (path === "/internal/document-sync/wiki-spaces") {
        return Promise.resolve(jsonResponse({ ok: true, authorization }));
      }
      if (path === "/internal/document-sync/wiki-spaces?limit=20") {
        return Promise.reject(new Error("list_after_registration_failed"));
      }
      throw new Error("unexpected_request");
    });
    const console = runAdminConsole(fetch);
    console.element("wiki-space-root-source-uri").value = "https://tenant.feishu.cn/wiki/root_1";

    await console.trigger("wiki-space-form", "submit");

    expect(console.element("wiki-space-error").textContent).toBe(
      "Unable to refresh wiki spaces after registration: list_after_registration_failed",
    );
    expect(console.element("connection-state").textContent).toBe("Refresh warning");
    expect(console.element("event-log").children.some((item) =>
      item.textContent.includes("Wiki space registered: space-1")
    )).toBe(true);
    expect(console.element("event-log").children.some((item) =>
      item.textContent.includes("Wiki space registration failed:")
    )).toBe(false);
  });

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

  it("renders proactive candidate governance without direct Feishu send controls", () => {
    const html = renderAdminConsoleHtml();
    const script = renderAdminConsoleScript();

    expect(html).toContain("Proactive Candidates");
    expect(html).toContain("proactive-candidate-table");
    expect(script).toContain("Proactive planner");
    expect(script).toContain("summarizeProactivePlanner");
    expect(script).toContain("summarizeProactiveDelivery");
    expect(script).toContain("/internal/proactive-signals/groups/");
    expect(script).toContain("/scan");
    expect(script).toContain("/candidates?limit=20");
    expect(script).toContain("/dismiss");
    expect(script).toContain("/approve-delivery");
    expect(script).not.toContain("sendMessage");
  });

  it("renders group-scoped proactive feedback aggregates without feedback details", () => {
    const html = renderAdminConsoleHtml();
    const script = renderAdminConsoleScript();

    expect(html).toContain("proactive-feedback-summary");
    expect(script).toContain("/feedback-summary");
    expect(script).toContain("Total feedback");
    expect(script).toContain("Helpful");
    expect(script).toContain("Irrelevant");
    expect(script).toContain("Helpful rate");
    expect(script).toContain("Active suppressions");
    expect(script).toContain("Last feedback");
    expect(script).toContain("readProactiveGroupId");
    expect(script).toContain("refreshProactiveFeedbackSummary");
    expect(script).toContain("refreshProactiveFeedbackSummary(groupId, generation)");
    expect(script).toContain("toFixed(1)");
    expect(script).not.toContain("actorFingerprint");
    expect(script).not.toContain("messageId");
    expect(script).not.toContain("evidenceMessageIds");
  });

  it("keeps only the current group refresh when proactive requests resolve out of order", async () => {
    const firstCandidates = deferred<ResponseStub>();
    const firstSummary = deferred<ResponseStub>();
    const secondCandidates = deferred<ResponseStub>();
    const secondSummary = deferred<ResponseStub>();
    const responses = [firstCandidates, firstSummary, secondCandidates, secondSummary];
    const fetch = vi.fn(() => {
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected_request");
      return response.promise;
    });
    const console = runAdminConsole(fetch);
    console.element("proactive-candidate-group").value = "group-a";

    const firstRefresh = console.trigger("proactive-candidate-refresh", "click");
    expect(fetch).toHaveBeenCalledTimes(2);

    console.element("proactive-candidate-group").value = "group-b";
    const secondRefresh = console.trigger("proactive-candidate-refresh", "click");
    expect(fetch).toHaveBeenCalledTimes(4);

    secondCandidates.resolve(jsonResponse({ ok: true, candidates: [candidate("candidate-b")] }));
    secondSummary.resolve(jsonResponse(feedbackSummary("group-b", 8)));
    await secondRefresh;
    firstCandidates.resolve(jsonResponse({ ok: true, candidates: [candidate("candidate-a")] }));
    firstSummary.resolve(jsonResponse(feedbackSummary("group-a", 1)));
    await firstRefresh;

    const rows = console.element("proactive-candidate-rows");
    expect(rows.children).toHaveLength(1);
    expect(rows.children[0]!.children[0]!.children[1]!.textContent).toBe("candidate-b");
    expect(metricValues(console.element("proactive-feedback-summary"))).toContain("8");
  });

  it("ignores a stale candidate request failure after the current group succeeds", async () => {
    const firstCandidates = deferred<ResponseStub>();
    const firstSummary = deferred<ResponseStub>();
    const secondCandidates = deferred<ResponseStub>();
    const secondSummary = deferred<ResponseStub>();
    const responses = [firstCandidates, firstSummary, secondCandidates, secondSummary];
    const fetch = vi.fn(() => {
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected_request");
      return response.promise;
    });
    const console = runAdminConsole(fetch);
    console.element("proactive-candidate-group").value = "group-a";

    const firstRefresh = console.trigger("proactive-candidate-refresh", "click");
    console.element("proactive-candidate-group").value = "group-b";
    const secondRefresh = console.trigger("proactive-candidate-refresh", "click");

    secondCandidates.resolve(jsonResponse({ ok: true, candidates: [candidate("candidate-b")] }));
    secondSummary.resolve(jsonResponse(feedbackSummary("group-b", 8)));
    await secondRefresh;
    firstSummary.resolve(jsonResponse(feedbackSummary("group-a", 1)));
    firstCandidates.reject(new Error("stale_candidate_failure"));
    await firstRefresh;

    const rows = console.element("proactive-candidate-rows");
    expect(rows.children).toHaveLength(1);
    expect(rows.children[0]!.children[0]!.children[1]!.textContent).toBe("candidate-b");
    expect(console.element("connection-state").textContent).not.toBe("Request failed");
    expect(console.element("event-log").children.some((item) =>
      item.textContent.includes("stale_candidate_failure"),
    )).toBe(false);
  });

  it("clears unavailable feedback after a successful dismissal without reporting the dismissal as failed", async () => {
    let refreshCount = 0;
    const fetch = vi.fn((path: string) => {
      if (path.endsWith("/dismiss")) return Promise.resolve(jsonResponse({ ok: true, status: "dismissed" }));
      if (path.includes("/candidates")) {
        refreshCount += 1;
        return Promise.resolve(jsonResponse({
          ok: true,
          candidates: refreshCount === 1 ? [candidate("candidate-a")] : [],
        }));
      }
      if (path.endsWith("/feedback-summary")) {
        return refreshCount === 1
          ? Promise.resolve(jsonResponse(feedbackSummary("group-a", 3)))
          : Promise.reject(new Error("summary_unavailable"));
      }
      throw new Error("unexpected_request");
    });
    const console = runAdminConsole(fetch);
    console.element("proactive-candidate-group").value = "group-a";

    await console.trigger("proactive-candidate-refresh", "click");
    const dismiss = console.allElements().find((element) => element.textContent === "Dismiss");
    expect(dismiss).toBeDefined();
    await dismiss!.trigger("click");

    expect(console.element("connection-state").textContent).toBe("Refresh warning");
    expect(metricValues(console.element("proactive-feedback-summary"))).toEqual([
      "--", "--", "--", "--", "--", "--",
    ]);
    expect(console.element("event-log").children.some((item) => item.textContent.includes("Dismiss recorded"))).toBe(true);
    expect(console.element("event-log").children.some((item) => item.textContent.includes("Dismiss failed"))).toBe(false);
  });

  it("uses wrapped, responsive metrics for the proactive feedback summary", () => {
    const css = renderAdminConsoleCss();
    const script = renderAdminConsoleScript();

    expect(css).toContain(".compact-status");
    expect(css).toContain(".proactive-feedback-summary");
    expect(css).toContain("repeat(auto-fit, minmax(min(140px, 100%), 1fr))");
    expect(script).toContain("proactive-feedback-metric");
  });

  it("renders an internal MVP gate summary from existing status without mutating runtime", () => {
    const html = renderAdminConsoleHtml();
    const script = renderAdminConsoleScript();

    expect(html).toContain("Internal MVP Gate");
    expect(html).toContain("mvp-gate-table");
    expect(html).toContain("mvp-gate-summary");
    expect(script).toContain("renderMvpGate");
    expect(script).toContain("Shared group context");
    expect(script).toContain("Semantic memory");
    expect(script).toContain("Document reading");
    expect(script).toContain("Knowledge publication");
    expect(script).toContain("Proactive delivery");
    expect(script).toContain("Emergency stop");
    expect(script).toContain("semantic gray pending");
    expect(script).toContain("real Feishu pending");
    const mvpGateRenderer = script.slice(
      script.indexOf("function renderMvpGate"),
      script.indexOf("function renderCapabilityControls"),
    );
    expect(mvpGateRenderer).not.toContain("requestJson(");
    expect(mvpGateRenderer).not.toContain("/internal/runtime-control/global");
    expect(mvpGateRenderer).not.toContain("/internal/action-proposals/approve");
  });

  it("renders audit summary governance without raw message bodies", () => {
    const html = renderAdminConsoleHtml();
    const script = renderAdminConsoleScript();

    expect(html).toContain("Audit Summary");
    expect(html).toContain("audit-summary-table");
    expect(script).toContain("/internal/audit/events/summary?limit=20");
    expect(script).toContain("audit-summary-type");
    expect(script).toContain("permission_guard_denied");
    expect(script).toContain("runtime_control_updated");
    expect(script).not.toContain("messageBody");
    expect(script).not.toContain("rawText");
  });

  it("renders publication queue governance without direct approval or content disclosure", () => {
    const html = renderAdminConsoleHtml();
    const script = renderAdminConsoleScript();

    expect(html).toContain("Publication Queue");
    expect(html).toContain("publication-queue-table");
    expect(script).toContain("/internal/action-proposals?status=pending_approval,approved,executing,failed,reconciliation_required&limit=20");
    expect(script).toContain("/internal/action-proposals/");
    expect(script).toContain("/request-revision");
    expect(script).toContain("/reject");
    expect(script).not.toContain("/internal/action-proposals/approve");
    expect(script).not.toContain("Approve publication");
    expect(script).not.toContain("draft.content");
    expect(script).not.toContain("currentRevision.content");
  });
});

type ResponseStub = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
};

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Array<(event: { preventDefault(): void }) => unknown>>();
  readonly dataset: Record<string, string | undefined> = {};
  private readonly attributes = new Map<string, string>();
  className = "";
  disabled = false;
  checked = false;
  id = "";
  textContent = "";
  title = "";
  type = "";
  value = "";

  append(...children: FakeElement[]) {
    this.children.push(...children);
  }

  prepend(...children: FakeElement[]) {
    this.children.unshift(...children);
  }

  replaceChildren(...children: FakeElement[]) {
    this.children.splice(0, this.children.length, ...children);
  }

  addEventListener(event: string, listener: (event: { preventDefault(): void }) => unknown) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name);
  }

  async trigger(event: string) {
    for (const listener of this.listeners.get(event) ?? []) {
      await listener({ preventDefault() {} });
    }
  }

  get lastChild() {
    return this.children[this.children.length - 1] ?? null;
  }
}

class FakeDocument {
  private readonly elements = new Map<string, FakeElement>();
  private readonly created: FakeElement[] = [];

  getElementById(id: string) {
    let element = this.elements.get(id);
    if (element === undefined) {
      element = new FakeElement();
      element.id = id;
      this.elements.set(id, element);
      this.created.push(element);
    }
    return element;
  }

  createElement() {
    const element = new FakeElement();
    this.created.push(element);
    return element;
  }

  querySelectorAll() {
    return [];
  }

  allElements() {
    return this.created;
  }
}

function runAdminConsole(fetch: (path: string, options?: unknown) => Promise<ResponseStub>) {
  const document = new FakeDocument();
  const session = new Map<string, string>();
  vm.runInNewContext(renderAdminConsoleScript(), {
    Date,
    Error,
    JSON,
    Promise,
    Set,
    URLSearchParams,
    document,
    encodeURIComponent,
    fetch,
    sessionStorage: {
      getItem(key: string) { return session.get(key) ?? null; },
      setItem(key: string, value: string) { session.set(key, value); },
    },
    window: { prompt() { return null; } },
  });
  return {
    allElements: () => document.allElements(),
    element: (id: string) => document.getElementById(id),
    trigger: (id: string, event: string) => document.getElementById(id).trigger(event),
  };
}

function candidate(idempotencyKey: string) {
  return {
    idempotencyKey,
    kind: "quiet_open_thread",
    priority: "medium",
    entityType: "thread",
    entityId: "thread-a",
    entityVersion: 1,
    suggestedMode: "ask_for_thread_update",
    lastRelevantAt: "2026-07-27T00:00:00.000Z",
  };
}

function feedbackSummary(groupId: string, helpfulCount: number) {
  return {
    ok: true,
    groupId,
    totalCount: helpfulCount,
    helpfulCount,
    irrelevantCount: 0,
    helpfulRate: 1,
    activeSuppressionCount: 0,
    lastFeedbackAt: "2026-07-27T00:00:00.000Z",
  };
}

function wikiSpace(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    rootSourceUri: "https://tenant.feishu.cn/wiki/root_1?from=space",
    rootNodeToken: "root_1",
    title: "Operations Wiki",
    enabled: true,
    scanState: "synced",
    attemptCount: 0,
    nextScanAt: "2026-07-30T00:00:00.000Z",
    discoveredNodeCount: 4,
    registeredDocumentCount: 3,
    skippedNodeCount: 1,
    revision: 1,
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}

function metricValues(summary: FakeElement) {
  return summary.children.map((metric) => metric.children[1]?.textContent);
}

function jsonResponse(body: unknown): ResponseStub {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  };
}

function errorResponse(status: number, error: string): ResponseStub {
  return {
    ok: false,
    status,
    text: async () => JSON.stringify({ ok: false, error }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}
