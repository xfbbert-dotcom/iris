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
    expect(script).toContain("await refreshProactiveFeedbackSummary()");
    expect(script).toContain("toFixed(1)");
    expect(script).not.toContain("actorFingerprint");
    expect(script).not.toContain("messageId");
    expect(script).not.toContain("evidenceMessageIds");
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
