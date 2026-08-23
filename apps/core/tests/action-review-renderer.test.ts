import { describe, expect, it } from "vitest";

import type { ActionReviewContext } from "../src/action-approvals/action-proposal-repository.js";
import {
  actionReviewSecurityHeaders,
  renderActionReviewPage,
  renderActionReviewRecordedPage,
  renderActionReviewUnavailablePage,
} from "../src/action-reviews/action-review-renderer.js";

describe("action review renderer", () => {
  it("renders one deterministic, escaped full-draft review with the exact attestation form", () => {
    const context: ActionReviewContext = {
      proposalId: "proposal-1",
      proposalVersion: 7,
      actionType: "publish_knowledge_draft",
      actionTargetFingerprint: "b".repeat(64),
      draftId: "draft-1",
      subjectRevision: 3,
      subjectVersion: 11,
      title: `Pilot <title> & \"quoted\" 'draft'`,
      content: `<script>alert(1)</script>\nBody & \"quoted\" 'text'`,
      contentHash: "a".repeat(64),
      riskLevel: "medium",
      targetPolicyId: "policy-1",
      targetPolicyVersion: 3,
      targetDisplayName: `Knowledge <target> & \"quoted\" 'name'`,
      requirements: [{ kind: "designated_owner", state: "pending" }],
    };

    const input = { context, csrfToken: `csrf<&>\"'` };
    const html = renderActionReviewPage(input);

    expect(renderActionReviewPage(input)).toBe(html);
    expect(html).toContain("完整正文");
    expect(html).toContain("Pilot &lt;title&gt; &amp; &quot;quoted&quot; &#39;draft&#39;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("csrf&lt;&amp;&gt;&quot;&#39;");
    expect(html).toContain(context.contentHash);
    expect(html).toContain("修订版本");
    expect(html).toContain("草稿版本");
    expect(html).toContain("提案版本");
    expect(html).toContain("风险");
    expect(html).toContain("审批状态");
    expect(html).toContain("目标");
    expect(html).toContain("发布新的知识库页面");
    expect(html).toContain("技术校验信息");
    expect(html).toContain('<details class="technical-details">');
    expect(html).not.toContain('<details class="technical-details" open>');
    expect(html).toContain(context.actionTargetFingerprint);
    expect(html).not.toContain("ou_owner");
    expect(html).toContain('<form method="post" action="/review/action-proposals/proposal-1/attest">');
    expect(html.match(/<form\b/gu)).toHaveLength(1);
  });

  it("renders the exact managed target and single-block replacement warning for updates", () => {
    const context: ActionReviewContext = {
      ...reviewContext(),
      actionType: "update_knowledge_publication",
      actionTargetFingerprint: "c".repeat(64),
      managedTarget: {
        managedPageId: "managed-1",
        managedPageVersion: 4,
        documentSourceId: "source-1",
        targetSourceUri: "https://example.test/wiki/managed-1",
        targetSnapshotId: "snapshot-1",
        targetSnapshotHash: "d".repeat(64),
        conflictCandidateId: "candidate-1",
        conflictCandidateVersion: 7,
        remoteDocumentToken: "doc-1",
        managedBodyBlockId: "blk_body",
        expectedRemoteRevisionId: "12",
        currentBodyContentHash: "e".repeat(64),
        authorizationGroupId: "group-1",
      },
    };

    const html = renderActionReviewPage({ context, csrfToken: "csrf-1" });

    expect(html).toContain("替换现有知识库页面中由 Iris 管理的正文区域");
    expect(html).toContain("managed-1");
    expect(html).toContain("blk_body");
    expect(html).toContain("snapshot-1");
    expect(html).toContain(context.actionTargetFingerprint);
    expect(html).toContain('href="https://example.test/wiki/managed-1"');
  });

  it("renders the full exact formal-task specification for assignee review", () => {
    const context = {
      proposalId: "task-proposal-1",
      proposalVersion: 1,
      actionType: "create_feishu_task",
      actionTargetFingerprint: "c".repeat(64),
      draftId: "formal-task-1",
      subjectRevision: 2,
      subjectVersion: 4,
      title: "Ship <pilot>",
      description: "Archive & verify the exact acceptance evidence.",
      taskSpecHash: "d".repeat(64),
      assigneeOpenId: "ou_assignee",
      dueAt: new Date("2026-08-24T06:00:00.000Z"),
      reminderMinutes: 30,
      sourceGroupId: "oc_pilot",
      riskLevel: "high",
      targetPolicyId: "task-policy-1",
      targetPolicyVersion: 3,
      targetDisplayName: "Pilot tasks",
      requirements: [{ kind: "designated_owner", state: "pending" }],
    } as unknown as ActionReviewContext;

    const html = renderActionReviewPage({ context, csrfToken: "csrf-task" });

    expect(html).toContain("创建一个真实飞书任务");
    expect(html).toContain("高风险（确认后将创建真实飞书任务）");
    expect(html).toContain("Ship &lt;pilot&gt;");
    expect(html).toContain("Archive &amp; verify the exact acceptance evidence.");
    expect(html).toContain("你（当前审批人）");
    expect(html).toContain("2026年8月24日 14:00");
    expect(html).toContain("提前30分钟");
    expect(html).toContain("你的审批：待处理");
    expect(html).toContain("确认已审阅");
    expect(html).not.toContain("ou_assignee");
    expect(html).toContain("task-policy-1 / 3");
    expect(html).toContain("d".repeat(64));
    expect(html).toContain("c".repeat(64));
    const technicalDetailsStart = html.indexOf('<details class="technical-details">');
    expect(technicalDetailsStart).toBeGreaterThan(0);
    expect(html.indexOf("d".repeat(64))).toBeGreaterThan(technicalDetailsStart);
    expect(html.indexOf("task-policy-1 / 3")).toBeGreaterThan(technicalDetailsStart);
  });

  it("uses semantic, local-only markup that keeps long values readable on narrow screens", () => {
    const html = renderActionReviewPage({ context: reviewContext(), csrfToken: "csrf-1" });

    expect(html).toMatch(/<header\b/iu);
    expect(html).toMatch(/<main\b/iu);
    expect(html).toMatch(/<article\b/iu);
    expect(html).toMatch(/<aside\b/iu);
    expect(html).toContain("<dl>");
    expect(html).toContain("<pre class=\"draft-content\">");
    expect(html).toContain("white-space: pre-wrap");
    expect(html).toContain("overflow-wrap: anywhere");
    expect(html).toContain("@media (max-width: 720px)");
    expect(html).toContain("grid-template-columns: 1fr");
    expect(html).not.toMatch(/<(?:script|img|link)\b/iu);
    expect(html).not.toMatch(/https?:\/\//iu);
    expect(html).not.toContain('class="card"');
  });

  it("renders non-actionable recorded and unavailable pages", () => {
    expect(renderActionReviewRecordedPage()).toContain("审阅已记录");
    expect(renderActionReviewRecordedPage()).not.toContain("<form");
    expect(renderActionReviewUnavailablePage()).toContain("审阅不可用");
    expect(renderActionReviewUnavailablePage()).not.toContain("<form");
  });

  it("exports the review response security headers", () => {
    expect(actionReviewSecurityHeaders).toEqual({
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });
  });
});

function reviewContext(): ActionReviewContext & { actionType: "publish_knowledge_draft" } {
  return {
    proposalId: "proposal-1",
    proposalVersion: 7,
    actionType: "publish_knowledge_draft",
    actionTargetFingerprint: "b".repeat(64),
    draftId: "draft-1",
    subjectRevision: 3,
    subjectVersion: 11,
    title: "Pilot SOP",
    content: "Full draft body",
    contentHash: "a".repeat(64),
    riskLevel: "medium",
    targetPolicyId: "policy-1",
    targetPolicyVersion: 3,
    targetDisplayName: "Knowledge base",
    requirements: [{ kind: "designated_owner", state: "pending" }],
  };
}
