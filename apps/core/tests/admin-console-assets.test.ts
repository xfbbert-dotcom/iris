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
  className = "";
  disabled = false;
  id = "";
  textContent = "";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}
