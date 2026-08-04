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
      draftId: "draft-1",
      subjectRevision: 3,
      subjectVersion: 11,
      title: `Pilot <title> & \"quoted\" 'draft'`,
      content: `<script>alert(1)</script>\nBody & \"quoted\" 'text'`,
      contentHash: "a".repeat(64),
      riskLevel: "medium",
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
    expect(html).toContain("审批要求");
    expect(html).toContain("目标");
    expect(html).not.toContain("ou_owner");
    expect(html).toContain('<form method="post" action="/review/action-proposals/proposal-1/attest">');
    expect(html.match(/<form\b/gu)).toHaveLength(1);
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

function reviewContext(): ActionReviewContext {
  return {
    proposalId: "proposal-1",
    proposalVersion: 7,
    draftId: "draft-1",
    subjectRevision: 3,
    subjectVersion: 11,
    title: "Pilot SOP",
    content: "Full draft body",
    contentHash: "a".repeat(64),
    riskLevel: "medium",
    targetDisplayName: "Knowledge base",
    requirements: [{ kind: "designated_owner", state: "pending" }],
  };
}
