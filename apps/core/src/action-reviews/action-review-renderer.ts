import type { ActionReviewContext } from "../action-approvals/action-proposal-repository.js";

export const actionReviewSecurityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

export function renderActionReviewPage(input: {
  context: ActionReviewContext;
  csrfToken: string;
}): string {
  const { context } = input;
  const formAction = `/review/action-proposals/${encodeURIComponent(context.proposalId)}/attest`;
  const requirements = context.requirements
    .map(
      (requirement) => `
          <div class="requirement">
            <dt>类型</dt>
            <dd>${escapeHtml(requirement.kind)}</dd>
            <dt>状态</dt>
            <dd>${escapeHtml(requirement.state)}</dd>
          </div>`,
    )
    .join("");

  return renderDocument({
    pageTitle: "完整正文审阅",
    body: `
      <header>
        <div class="page-width">
          <p class="eyebrow">待审批知识草稿</p>
          <h1>${escapeHtml(context.title)}</h1>
        </div>
      </header>
      <main class="page-width review-layout">
        <article aria-labelledby="draft-body-heading">
          <h2 id="draft-body-heading">完整正文</h2>
          <pre class="draft-content">${escapeHtml(context.content)}</pre>
        </article>
        <aside aria-label="审阅摘要">
          <h2>审阅摘要</h2>
          <dl>
            <dt>内容哈希</dt>
            <dd class="value-wrap">${escapeHtml(context.contentHash)}</dd>
            <dt>修订版本</dt>
            <dd>${escapeHtml(context.subjectRevision)}</dd>
            <dt>草稿版本</dt>
            <dd>${escapeHtml(context.subjectVersion)}</dd>
            <dt>提案版本</dt>
            <dd>${escapeHtml(context.proposalVersion)}</dd>
            <dt>风险</dt>
            <dd>${escapeHtml(context.riskLevel)}</dd>
            <dt>目标</dt>
            <dd class="value-wrap">${escapeHtml(context.targetDisplayName)}</dd>
            <dt>审批要求</dt>
            <dd>
              <dl class="requirements">${requirements}</dl>
            </dd>
          </dl>
          <form method="post" action="${escapeHtml(formAction)}">
            <input type="hidden" name="csrfToken" value="${escapeHtml(input.csrfToken)}">
            <button type="submit">已完成审阅</button>
          </form>
        </aside>
      </main>`,
  });
}

export function renderActionReviewRecordedPage(): string {
  return renderDocument({
    pageTitle: "审阅已记录",
    body: `
      <main class="page-width message-page">
        <h1>审阅已记录</h1>
        <p>请返回飞书卡片完成审批。</p>
      </main>`,
  });
}

export function renderActionReviewUnavailablePage(): string {
  return renderDocument({
    pageTitle: "审阅不可用",
    body: `
      <main class="page-width message-page">
        <h1>审阅不可用</h1>
        <p>当前草稿无法审阅。</p>
      </main>`,
  });
}

function renderDocument(input: { pageTitle: string; body: string }): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(input.pageTitle)}</title>
    <style>
      :root { color-scheme: light; font-family: Arial, sans-serif; color: #1f2933; background: #f7fafc; }
      * { box-sizing: border-box; }
      body { margin: 0; line-height: 1.5; }
      header { border-bottom: 1px solid #cbd5e1; background: #ffffff; }
      .page-width { width: min(100% - 32px, 1120px); margin: 0 auto; }
      header .page-width { padding: 24px 0; }
      h1, h2, p { margin-top: 0; }
      h1 { margin-bottom: 0; font-size: 1.5rem; }
      h2 { font-size: 1.125rem; }
      .eyebrow { margin-bottom: 4px; color: #52606d; font-size: 0.875rem; }
      .review-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(260px, 340px); gap: 32px; padding: 32px 0; }
      article, aside { min-width: 0; }
      aside { border-top: 3px solid #2f855a; padding-top: 16px; }
      .draft-content { margin: 0; padding: 16px; border: 1px solid #cbd5e1; background: #ffffff; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; font: inherit; }
      dl { margin: 0; }
      dt { margin-top: 16px; color: #52606d; font-weight: 700; }
      dt:first-child { margin-top: 0; }
      dd { margin: 4px 0 0; }
      .value-wrap { overflow-wrap: anywhere; word-break: break-word; }
      .requirements { display: grid; gap: 4px; }
      .requirement { border-left: 3px solid #cbd5e1; padding-left: 12px; }
      .requirement dt { margin-top: 8px; }
      form { margin-top: 24px; }
      button { min-height: 40px; border: 1px solid #1f5f43; border-radius: 4px; padding: 8px 16px; color: #ffffff; background: #1f5f43; font: inherit; cursor: pointer; }
      button:focus-visible { outline: 3px solid #f6ad55; outline-offset: 2px; }
      .message-page { padding: 48px 0; }
      @media (max-width: 720px) {
        .review-layout { grid-template-columns: 1fr; gap: 24px; padding: 24px 0; }
        .page-width { width: min(100% - 24px, 1120px); }
      }
    </style>
  </head>
  <body>${input.body}
  </body>
</html>`;
}

function escapeHtml(value: string | number): string {
  return String(value).replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}
