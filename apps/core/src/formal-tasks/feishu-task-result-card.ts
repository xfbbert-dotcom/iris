import { createHash } from "node:crypto";

import {
  KNOWLEDGE_CARD_JSON_MAX_BYTES,
  KNOWLEDGE_CARD_MAX_COMPONENTS,
} from "../knowledge-cards/knowledge-card.js";

import type { FeishuTaskResultPresentationContext } from
  "./formal-task-execution-repository.js";

export type FeishuTaskResultCard = {
  card: Record<string, unknown>;
  json: string;
  contentHash: string;
  componentCount: number;
};

export class FeishuTaskResultCardBindingError extends Error {
  constructor() {
    super("formal task result presentation does not match its creation fact");
    this.name = "FeishuTaskResultCardBindingError";
  }
}

export function renderFeishuTaskResultCard(
  input: FeishuTaskResultPresentationContext,
): FeishuTaskResultCard {
  const { presentation, creation } = input;
  if (
    presentation.creationId !== creation.id ||
    presentation.proposalId !== creation.proposalId ||
    presentation.groupId !== creation.sourceGroupId ||
    presentation.state !== "pending_send"
  ) throw new FeishuTaskResultCardBindingError();
  const title = requireBoundedText("title", creation.title, 256);
  const assignee = requireReference("assigneeOpenId", creation.assigneeOpenId);
  const remoteTaskGuid = requireReference("remoteTaskGuid", creation.remoteTaskGuid);
  const remoteTaskId = requireReference("remoteTaskId", creation.remoteTaskId);
  const remoteTaskUrl = requireFeishuTaskUrl(creation.remoteTaskUrl);
  const taskSpecHash = requireHash("taskSpecHash", creation.taskSpecHash);
  const due = creation.dueAt === undefined ? "none" : requireDate(creation.dueAt).toISOString();
  const reminder = creation.reminderMinutes === undefined
    ? "none"
    : `${requireReminder(creation.reminderMinutes)} minutes before due time`;
  const content = [
    `Task: ${title}`,
    `Assignee: <at id=${assignee}></at>`,
    `Due: ${due}`,
    `Reminder: ${reminder}`,
    `Open task: [View in Feishu](${remoteTaskUrl})`,
    `Remote task GUID: ${remoteTaskGuid}`,
    `Remote task ID: ${remoteTaskId}`,
    `Draft ID: ${requireReference("draftId", creation.draftId)}`,
    `Draft revision: ${requirePositiveInteger("draftRevision", creation.draftRevision)}`,
    `Task-spec fingerprint: ${taskSpecHash.slice(0, 12)}`,
    `Created at: ${requireDate(creation.completedAt).toISOString()}`,
  ].join("\n");
  const card: Record<string, unknown> = {
    schema: "2.0",
    header: {
      template: "green",
      title: { tag: "plain_text", content: "Formal task created" },
    },
    body: { elements: [{ tag: "markdown", content }] },
  };
  const componentCount = 1;
  if (componentCount > KNOWLEDGE_CARD_MAX_COMPONENTS) {
    throw new Error("formal task result card has too many components");
  }
  const json = JSON.stringify(card);
  if (Buffer.byteLength(json, "utf8") > KNOWLEDGE_CARD_JSON_MAX_BYTES) {
    throw new Error("formal task result card is too large");
  }
  return {
    card,
    json,
    contentHash: createHash("sha256").update(json).digest("hex"),
    componentCount,
  };
}

function requireFeishuTaskUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) throw new Error("task URL is invalid");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("task URL is invalid");
  }
  if (
    url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "" ||
    !(url.hostname === "feishu.cn" || url.hostname.endsWith(".feishu.cn"))
  ) throw new Error("task URL is invalid");
  return url.toString();
}

function requireBoundedText(name: string, value: unknown, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  if (
    value.trim() !== value || value.length < 1 || [...value].length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new Error(`${name} is invalid`);
  return value;
}

function requireReference(name: string, value: unknown): string {
  const normalized = requireBoundedText(name, value, 512);
  if (/\s/u.test(normalized)) throw new Error(`${name} is invalid`);
  return normalized;
}

function requireHash(name: string, value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireReminder(value: unknown): 0 | 30 | 60 | 1440 {
  if (!([0, 30, 60, 1440] as const).includes(value as 0 | 30 | 60 | 1440)) {
    throw new Error("reminderMinutes is invalid");
  }
  return value as 0 | 30 | 60 | 1440;
}

function requirePositiveInteger(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${name} is invalid`);
  return Number(value);
}

function requireDate(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("date is invalid");
  return new Date(value);
}
