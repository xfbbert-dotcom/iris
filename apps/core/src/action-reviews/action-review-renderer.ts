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
  const isFormalTask = context.actionType === "create_feishu_task";
  const requirements = context.requirements
    .map(
      (requirement) => `
          <div class="requirement">
            ${escapeHtml(requirementDescription(requirement.kind, requirement.state, isFormalTask))}
          </div>`,
    )
    .join("");
  const actionDescription = context.actionType === "publish_knowledge_draft"
    ? "发布新的知识库页面"
    : context.actionType === "update_knowledge_publication"
      ? "替换现有知识库页面中由 Iris 管理的正文区域"
      : "创建一个真实飞书任务";
  const managedTargetDetails = context.managedTarget === undefined
    ? ""
    : renderManagedTargetDetails(context.managedTarget);
  const reviewedBody = isFormalTask
    ? context.description
    : context.content;
  const taskBusinessDetails = isFormalTask
    ? renderFormalTaskBusinessDetails(context)
    : "";
  const taskTechnicalDetails = isFormalTask
    ? renderFormalTaskTechnicalDetails(context)
    : "";

  return renderDocument({
    pageTitle: "完整正文审阅",
    body: `
      <header>
        <div class="page-width">
          <p class="eyebrow">${isFormalTask ? "待审批飞书任务" : "待审批知识草稿"}</p>
          <h1>${escapeHtml(context.title)}</h1>
        </div>
      </header>
      <main class="page-width review-layout">
        <article aria-labelledby="draft-body-heading">
          <h2 id="draft-body-heading">${isFormalTask ? "完整任务描述" : "完整正文"}</h2>
          <pre class="draft-content">${escapeHtml(reviewedBody)}</pre>
        </article>
        <aside aria-label="审阅摘要">
          <h2>审阅摘要</h2>
          <dl class="business-summary">
            <dt>操作</dt>
            <dd>${escapeHtml(actionDescription)}</dd>
            ${context.actionType === "update_knowledge_publication"
              ? '<dt>影响</dt><dd class="warning">确认后，只会替换由 Iris 管理的正文区域。</dd>'
              : ""}
            <dt>风险</dt>
            <dd class="${isFormalTask ? "warning" : ""}">${escapeHtml(riskDescription(context.riskLevel, isFormalTask))}</dd>
            <dt>目标</dt>
            <dd class="value-wrap">${escapeHtml(isFormalTask ? "当前飞书任务" : context.targetDisplayName)}</dd>
            ${taskBusinessDetails}
            <dt>审批状态</dt>
            <dd><div class="requirements">${requirements}</div></dd>
          </dl>
          <details class="technical-details">
            <summary>技术校验信息</summary>
            <dl>
            ${isFormalTask
              ? ""
              : `<dt>内容哈希</dt><dd class="value-wrap">${escapeHtml(context.contentHash)}</dd>`}
            <dt>行动目标指纹</dt>
            <dd class="value-wrap">${escapeHtml(context.actionTargetFingerprint)}</dd>
            <dt>修订版本</dt>
            <dd>${escapeHtml(context.subjectRevision)}</dd>
            <dt>草稿版本</dt>
            <dd>${escapeHtml(context.subjectVersion)}</dd>
            <dt>提案版本</dt>
            <dd>${escapeHtml(context.proposalVersion)}</dd>
            <dt>目标策略</dt>
            <dd class="value-wrap">${escapeHtml(context.targetPolicyId)} / ${escapeHtml(context.targetPolicyVersion)}</dd>
            ${taskTechnicalDetails}
            ${managedTargetDetails}
            </dl>
          </details>
          <form method="post" action="${escapeHtml(formAction)}">
            <input type="hidden" name="csrfToken" value="${escapeHtml(input.csrfToken)}">
            <button type="submit">确认已审阅</button>
          </form>
        </aside>
      </main>`,
  });
}

function renderFormalTaskBusinessDetails(
  context: Extract<ActionReviewContext, { actionType: "create_feishu_task" }>,
): string {
  return `
            <dt>负责人</dt>
            <dd>你（当前审批人）</dd>
            <dt>截止时间</dt>
            <dd>${escapeHtml(context.dueAt === undefined ? "未设置" : formatChinaDateTime(context.dueAt))}</dd>
            <dt>提醒</dt>
            <dd>${escapeHtml(reminderDescription(context.reminderMinutes))}</dd>`;
}

function renderFormalTaskTechnicalDetails(
  context: Extract<ActionReviewContext, { actionType: "create_feishu_task" }>,
): string {
  return `
            <dt>任务规范哈希</dt>
            <dd class="value-wrap">${escapeHtml(context.taskSpecHash)}</dd>`;
}

function requirementDescription(
  kind: ActionReviewContext["requirements"][number]["kind"],
  state: ActionReviewContext["requirements"][number]["state"],
  isFormalTask: boolean,
): string {
  const label = kind === "group_confirmation"
    ? "群内确认"
    : isFormalTask
      ? "你的审批"
      : kind === "designated_owner"
        ? "负责人审批"
        : "授权负责人审批";
  const stateLabel = state === "satisfied" ? "已完成" : state === "pending" ? "待处理" : "已失效";
  return `${label}：${stateLabel}`;
}

function riskDescription(
  riskLevel: ActionReviewContext["riskLevel"],
  isFormalTask: boolean,
): string {
  if (isFormalTask) return "高风险（确认后将创建真实飞书任务）";
  return riskLevel === "high" ? "高风险" : riskLevel === "medium" ? "中风险" : "低风险";
}

function formatChinaDateTime(value: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(value);
}

function reminderDescription(minutes: number | undefined): string {
  if (minutes === undefined) return "未设置";
  if (minutes === 0) return "到期时";
  if (minutes === 60) return "提前1小时";
  if (minutes === 1_440) return "提前1天";
  return `提前${minutes}分钟`;
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
      :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: #17212b; background: #f4f7f9; }
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
      aside { border-top: 3px solid #2f855a; padding: 18px; background: #ffffff; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.06); }
      .draft-content { margin: 0; padding: 16px; border: 1px solid #cbd5e1; background: #ffffff; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; font: inherit; }
      dl { margin: 0; }
      dt { margin-top: 16px; color: #52606d; font-weight: 700; }
      dt:first-child { margin-top: 0; }
      dd { margin: 4px 0 0; }
      .value-wrap { overflow-wrap: anywhere; word-break: break-word; }
      .warning { border-left: 3px solid #c2410c; padding-left: 12px; color: #9a3412; font-weight: 700; }
      .requirements { display: grid; gap: 8px; }
      .requirement { border-left: 3px solid #86b59d; padding: 7px 10px; background: #f1f8f4; }
      .technical-details { margin-top: 24px; border-top: 1px solid #dbe3e8; padding-top: 16px; color: #52606d; }
      .technical-details summary { color: #334e3f; font-weight: 700; cursor: pointer; }
      .technical-details dl { margin-top: 12px; font-size: 0.875rem; }
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

function renderManagedTargetDetails(target: NonNullable<ActionReviewContext["managedTarget"]>): string {
  const targetUrl = requireSafeTargetUrl(target.targetSourceUri);
  return `
            <dt>托管页面</dt>
            <dd class="value-wrap"><a href="${escapeHtml(targetUrl)}">${escapeHtml(target.managedPageId)}</a></dd>
            <dt>托管页面版本</dt>
            <dd>${escapeHtml(target.managedPageVersion)}</dd>
            <dt>文档来源</dt>
            <dd class="value-wrap">${escapeHtml(target.documentSourceId)}</dd>
            <dt>目标快照</dt>
            <dd class="value-wrap">${escapeHtml(target.targetSnapshotId)} / ${escapeHtml(target.targetSnapshotHash)}</dd>
            <dt>冲突候选</dt>
            <dd class="value-wrap">${escapeHtml(target.conflictCandidateId)} / ${escapeHtml(target.conflictCandidateVersion)}</dd>
            <dt>远程文档</dt>
            <dd class="value-wrap">${escapeHtml(target.remoteDocumentToken)}</dd>
            <dt>托管正文块</dt>
            <dd class="value-wrap">${escapeHtml(target.managedBodyBlockId)}</dd>
            <dt>预期远程修订</dt>
            <dd class="value-wrap">${escapeHtml(target.expectedRemoteRevisionId)}</dd>
            <dt>当前正文哈希</dt>
            <dd class="value-wrap">${escapeHtml(target.currentBodyContentHash)}</dd>
            <dt>授权组</dt>
            <dd class="value-wrap">${escapeHtml(target.authorizationGroupId)}</dd>`;
}

function requireSafeTargetUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("action review target URI is invalid");
  }
  if (
    !(url.protocol === "https:" || url.protocol === "http:") ||
    url.username !== "" ||
    url.password !== ""
  ) throw new Error("action review target URI is invalid");
  return url.toString();
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
