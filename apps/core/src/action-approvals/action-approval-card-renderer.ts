import {
  KNOWLEDGE_CARD_JSON_MAX_BYTES,
  KNOWLEDGE_CARD_MAX_COMPONENTS,
  KNOWLEDGE_CARD_REASON_MAX_CHARS,
  type ActionProposalCardAction,
} from "../knowledge-cards/knowledge-card.js";

import type {
  ActionApprovalPresentation,
  ActionApprovalRequirement,
  FormalTaskActionProposalContext,
  ActionProposalContext,
  PublicationTargetPolicy,
} from "./action-proposal-repository.js";
import type { FeishuTaskTargetPolicy } from "../formal-tasks/formal-task-repository.js";

const FEISHU_INPUT_MAX_LENGTH = 1_000;

export type ActionApprovalCardRenderInput = {
  context: ActionProposalContext;
  requirement: ActionApprovalRequirement;
  policy: PublicationTargetPolicy | FeishuTaskTargetPolicy;
  presentation: ActionApprovalPresentation;
  reviewPublicOrigin?: string;
};

export type ActionApprovalCardRenderResult = {
  card: Record<string, unknown>;
  json: string;
  componentCount: number;
};

export class ActionApprovalCardBindingError extends Error {
  constructor() {
    super("action approval card facts do not match");
    this.name = "ActionApprovalCardBindingError";
  }
}

export function renderActionApprovalCard(
  input: ActionApprovalCardRenderInput,
): ActionApprovalCardRenderResult {
  assertExactBinding(input);
  const isFormalTask = isFormalTaskActionProposalContext(input.context);
  let componentCount = 0;
  const component = <T extends Record<string, unknown>>(value: T): T => {
    componentCount += 1;
    return value;
  };
  const { proposal } = input.context;
  const callbackValue = (action: ActionProposalCardAction) => ({
    kind: "action_proposal_approval",
    action,
    presentationId: input.presentation.id,
    proposalId: proposal.id,
    requirementId: input.requirement.id,
    proposalVersion: String(proposal.version),
    subjectRevision: String(proposal.subjectRevision),
    subjectVersion: String(proposal.subjectVersion),
    targetPolicyVersion: String(proposal.targetPolicyVersion),
  });
  const formElements: Record<string, unknown>[] = [
    component({
      tag: "input",
      name: "reason",
      input_type: "multiline_text",
      rows: 3,
      max_length: Math.min(KNOWLEDGE_CARD_REASON_MAX_CHARS, FEISHU_INPUT_MAX_LENGTH),
      required: false,
      label: {
        tag: "plain_text",
        content: "退回修改或拒绝时，请填写原因（最多 1,000 字）",
      },
      placeholder: {
        tag: "plain_text",
        content: "请说明需要修改的内容或拒绝原因",
      },
    }),
    component({
      tag: "button",
      name: "approve",
      text: { tag: "plain_text", content: isFormalTask ? "批准创建" : "批准发布" },
      type: "primary",
      form_action_type: "submit",
      behaviors: [{ type: "callback", value: callbackValue("approve") }],
    }),
    component({
      tag: "button",
      name: "request_revision",
      text: { tag: "plain_text", content: "退回修改" },
      type: "default",
      form_action_type: "submit",
      behaviors: [{ type: "callback", value: callbackValue("request_revision") }],
    }),
    component({
      tag: "button",
      name: "reject",
      text: { tag: "plain_text", content: "拒绝" },
      type: "danger",
      form_action_type: "submit",
      behaviors: [{ type: "callback", value: callbackValue("reject") }],
      confirm: {
        title: {
          tag: "plain_text",
          content: proposal.actionType === "create_feishu_task" ? "拒绝创建任务" : "拒绝发布",
        },
        text: {
          tag: "plain_text",
          content: "确认拒绝吗？你填写的原因会被记录。",
        },
      },
    }),
  ];
  const metadata = (isFormalTask
    ? [
        "Iris / 飞书任务审批",
        `操作：${actionDescription(proposal.actionType)}`,
        "风险：高（批准后将创建真实飞书任务）",
        ...formalTaskMetadata(input.context),
      ]
    : [
        "Iris / 知识发布审批",
        `操作：${actionDescription(proposal.actionType)}`,
        `风险：${riskDescription(proposal.riskLevel)}`,
        `发布目标：${requireDisplayName(input.policy.displayName)}`,
        ...(input.context.managedTarget === undefined ? [] : [
          `托管页面：${requireDisplayName(input.context.managedTarget.managedPageId)}`,
          `[打开目标知识库页面](${requireSafeTargetUrl(input.context.managedTarget.targetSourceUri)})`,
        ]),
      ]).join("\n");
  const requirementSummary = input.context.requirements
    .map((requirement) => requirementDescription(requirement, isFormalTask))
    .join("\n");
  const bodyElements: Record<string, unknown>[] = [
    component({ tag: "markdown", content: metadata }),
    component({ tag: "markdown", content: requirementSummary }),
  ];
  const reviewUrl = buildReviewUrl(input.reviewPublicOrigin, proposal.id);
  if (reviewUrl !== undefined) {
    bodyElements.push(component({
      tag: "markdown",
      content: `[${proposal.actionType === "create_feishu_task" ? "查看完整任务并完成审阅" : "查看完整正文并完成审阅"}](${reviewUrl})`,
    }));
  }
  bodyElements.push(component({
    tag: "form",
    name: "actionProposalReview",
    elements: formElements,
  }));
  if (componentCount > KNOWLEDGE_CARD_MAX_COMPONENTS) {
    throw new Error("action approval card has too many components");
  }
  const card: Record<string, unknown> = {
    schema: "2.0",
    header: {
      template: proposal.riskLevel === "high" ? "red" : "orange",
      title: {
        tag: "plain_text",
        content: proposal.actionType === "create_feishu_task"
          ? "审批飞书任务"
          : "审批知识发布",
      },
    },
    body: { elements: bodyElements },
  };
  const json = JSON.stringify(card);
  if (Buffer.byteLength(json, "utf8") > KNOWLEDGE_CARD_JSON_MAX_BYTES) {
    throw new Error("action approval card is too large");
  }
  return { card, json, componentCount };
}

function assertExactBinding(input: ActionApprovalCardRenderInput): void {
  const { proposal, requirements } = input.context;
  const requirement = requirements.find((item) => item.id === input.requirement.id);
  if (
    proposal.status !== "pending_approval" ||
    input.presentation.state !== "pending_send" ||
    input.presentation.proposalId !== proposal.id ||
    input.presentation.requirementId !== input.requirement.id ||
    input.presentation.proposalVersion !== proposal.version ||
    requirement === undefined ||
    requirement !== input.requirement ||
    input.requirement.proposalId !== proposal.id ||
    input.requirement.state !== "pending" ||
    !isPresentationRecipientBound(input.requirement, input.presentation.recipientOpenId) ||
    input.requirement.targetPolicyId !== proposal.targetPolicyId ||
    input.requirement.targetPolicyVersion !== proposal.targetPolicyVersion ||
    input.policy.id !== proposal.targetPolicyId ||
    input.policy.version !== proposal.targetPolicyVersion ||
    !input.policy.enabled ||
    !policyMatchesProposal(input) ||
    (proposal.actionType === "publish_knowledge_draft" && input.context.managedTarget !== undefined) ||
    (proposal.actionType === "update_knowledge_publication" && input.context.managedTarget === undefined)
  ) {
    throw new ActionApprovalCardBindingError();
  }
}

function policyMatchesProposal(input: ActionApprovalCardRenderInput): boolean {
  if (isFormalTaskActionProposalContext(input.context)) {
    return "sourceGroupId" in input.policy &&
      input.policy.sourceGroupId === input.context.formalTask.sourceGroupId &&
      input.policy.allowedAssigneeOpenIds.includes(input.context.formalTask.assigneeOpenId) &&
      input.context.formalTask.assigneeOpenId === input.presentation.recipientOpenId;
  }
  return "spaceId" in input.policy;
}

function formalTaskMetadata(context: ActionProposalContext): string[] {
  if (!isFormalTaskActionProposalContext(context)) return [];
  return [
    `任务标题：${requireDisplayName(context.formalTask.title)}`,
    "负责人：你（当前审批人）",
    `截止时间：${context.formalTask.dueAt === undefined
      ? "未设置"
      : formatChinaDateTime(context.formalTask.dueAt)}`,
    `提醒：${reminderDescription(context.formalTask.reminderMinutes)}`,
  ];
}

function isFormalTaskActionProposalContext(
  context: ActionProposalContext,
): context is FormalTaskActionProposalContext {
  return context.proposal.subjectType === "formal_task_draft";
}

function actionDescription(actionType: ActionProposalContext["proposal"]["actionType"]): string {
  return actionType === "publish_knowledge_draft"
    ? "发布新的知识库页面"
    : actionType === "update_knowledge_publication"
      ? "替换现有知识库页面中由 Iris 管理的正文区域"
      : "创建一个真实飞书任务";
}

function riskDescription(riskLevel: ActionProposalContext["proposal"]["riskLevel"]): string {
  return riskLevel === "high" ? "高" : riskLevel === "medium" ? "中" : "低";
}

function requirementDescription(
  requirement: ActionApprovalRequirement,
  isFormalTask: boolean,
): string {
  const label = requirement.kind === "group_confirmation"
    ? "群内确认"
    : isFormalTask
      ? "你的审批"
      : requirement.kind === "designated_owner"
        ? "负责人审批"
        : "授权负责人审批";
  const state = requirement.state === "satisfied"
    ? "已完成"
    : requirement.state === "pending"
      ? "待处理"
      : "已失效";
  return `${label}：${state}`;
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

function requireSafeTargetUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ActionApprovalCardBindingError();
  }
  if (
    !(url.protocol === "https:" || url.protocol === "http:") ||
    url.username !== "" ||
    url.password !== ""
  ) throw new ActionApprovalCardBindingError();
  return url.toString().replaceAll("(", "%28").replaceAll(")", "%29");
}

function isPresentationRecipientBound(
  requirement: ActionApprovalRequirement,
  recipientOpenId: string,
): boolean {
  if (requirement.kind === "designated_owner") {
    return requirement.roleRefType === "feishu_user" && requirement.roleRef === recipientOpenId;
  }
  return requirement.kind === "iris_admin_or_authorized_owner";
}

function buildReviewUrl(origin: string | undefined, proposalId: string): string | undefined {
  if (origin === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new ActionApprovalCardBindingError();
  }
  if (
    !(url.protocol === "https:" || url.protocol === "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new ActionApprovalCardBindingError();
  }
  return `${url.origin}/review/action-proposals/${encodeURIComponent(proposalId)}`;
}

function requireDisplayName(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || [...normalized].length > 512) {
    throw new ActionApprovalCardBindingError();
  }
  return normalized;
}
