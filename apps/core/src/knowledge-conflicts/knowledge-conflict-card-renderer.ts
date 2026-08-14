import { createHash } from "node:crypto";

import type { DocumentSource } from "../documents/document-source-registry.js";
import type { KnowledgeConflictCandidate } from "./knowledge-conflict.js";

export const KNOWLEDGE_CONFLICT_CARD_JSON_MAX_BYTES = 24 * 1024;
export const KNOWLEDGE_CONFLICT_CARD_MAX_COMPONENTS = 12;

const MAX_IDENTIFIER_CHARS = 512;
const MAX_NONCE_CHARS = 128;
const MAX_SUBJECT_CODE_POINTS = 180;
const MAX_STATEMENT_CODE_POINTS = 720;
const MAX_TARGET_CODE_POINTS = 180;
const MAX_SOURCE_URL_CHARS = 2_048;

export type KnowledgeConflictCardRenderInput = {
  candidate: KnowledgeConflictCandidate;
  source: DocumentSource;
  nonce: string;
};

export type KnowledgeConflictCardRenderResult = {
  card: Record<string, unknown>;
  json: string;
  componentCount: number;
};

export class KnowledgeConflictCardBindingError extends Error {
  constructor() {
    super("knowledge conflict card binding is invalid");
    this.name = "KnowledgeConflictCardBindingError";
  }
}

export function createKnowledgeConflictCallbackNonce(deliveryId: string): string {
  const normalized = requireIdentifier(deliveryId);
  return createHash("sha256")
    .update(`knowledge-conflict-callback:${normalized}`)
    .digest("hex")
    .slice(0, 32);
}

export function renderKnowledgeConflictCard(
  input: KnowledgeConflictCardRenderInput,
): KnowledgeConflictCardRenderResult {
  assertBinding(input);
  const candidate = input.candidate;
  const callbackVersion = candidate.version + 1;
  const nonce = requireNonce(input.nonce);
  let componentCount = 0;
  const component = <T extends Record<string, unknown>>(value: T): T => {
    componentCount += 1;
    return value;
  };
  const callbackValue = (action: "create_update_draft" | "not_a_conflict") => ({
    kind: "knowledge_conflict_confirmation",
    action,
    candidateId: requireIdentifier(candidate.id),
    candidateVersion: String(callbackVersion),
    groupId: requireIdentifier(candidate.groupId),
    nonce,
  });

  const documentLabels = [...new Set(candidate.plan.knowledgeBaseCitationRefs)].sort(referenceOrder);
  const groupLabels = [...new Set(candidate.plan.groupCitationRefs)].sort(groupReferenceOrder);
  const safeUri = safeSourceUri(input.source.sourceUri);
  const targetName = visibleText(
    input.source.title ?? "Authorized Wiki document",
    MAX_TARGET_CODE_POINTS,
  );
  const target = safeUri === undefined
    ? escapeFeishuMarkdown(targetName)
    : `[${escapeFeishuMarkdown(targetName)}](${safeUri})`;
  const versionLabel = visibleText(
    candidate.targetSourceVersion ?? `snapshot ${candidate.targetSnapshotId}`,
    MAX_TARGET_CODE_POINTS,
  );

  const buttons = [
    component({
      tag: "button",
      name: "create_update_draft",
      text: { tag: "plain_text", content: "生成更新草稿" },
      type: "primary",
      form_action_type: "submit",
      behaviors: [{ type: "callback", value: callbackValue("create_update_draft") }],
    }),
    component({
      tag: "button",
      name: "not_a_conflict",
      text: { tag: "plain_text", content: "不是冲突" },
      type: "default",
      form_action_type: "submit",
      behaviors: [{ type: "callback", value: callbackValue("not_a_conflict") }],
    }),
  ];
  const bodyElements = [
    component({
      tag: "markdown",
      content: [
        "**Possible knowledge conflict — review required**",
        "No winner has been selected. This is not an official update.",
        `**Subject:** ${escapedVisible(candidate.plan.subject, MAX_SUBJECT_CODE_POINTS)}`,
      ].join("\n"),
    }),
    component({
      tag: "markdown",
      content: `**Current synchronized knowledge (${escapeFeishuMarkdown(versionLabel)}):**\n${
        escapedVisible(candidate.plan.knowledgeBaseStatement, MAX_STATEMENT_CODE_POINTS)
      }`,
    }),
    component({
      tag: "markdown",
      content: `**Newer group conclusion (group evidence, not official knowledge):**\n${
        escapedVisible(candidate.plan.groupConclusionStatement, MAX_STATEMENT_CODE_POINTS)
      }`,
    }),
    component({
      tag: "markdown",
      content: `**Material difference:**\n${
        escapedVisible(candidate.plan.difference, MAX_STATEMENT_CODE_POINTS)
      }`,
    }),
    component({
      tag: "markdown",
      content: `**Proposed update for review:**\n${
        escapedVisible(candidate.plan.suggestedUpdate, MAX_STATEMENT_CODE_POINTS)
      }`,
    }),
    component({
      tag: "markdown",
      content: [
        `**Target:** ${target}`,
        `Document evidence: ${documentLabels.join(", ")}`,
        `Group evidence: ${groupLabels.join(", ")}`,
      ].join("\n"),
    }),
    component({ tag: "form", name: "knowledgeConflictConfirmation", elements: buttons }),
  ];
  if (componentCount > KNOWLEDGE_CONFLICT_CARD_MAX_COMPONENTS) {
    throw new Error("knowledge conflict card has too many components");
  }
  const card: Record<string, unknown> = {
    schema: "2.0",
    header: {
      template: "orange",
      title: { tag: "plain_text", content: "Iris knowledge conflict review" },
    },
    body: { elements: bodyElements },
  };
  const json = JSON.stringify(card);
  if (Buffer.byteLength(json, "utf8") > KNOWLEDGE_CONFLICT_CARD_JSON_MAX_BYTES) {
    throw new Error("knowledge conflict card is too large");
  }
  return { card, json, componentCount };
}

function assertBinding(input: KnowledgeConflictCardRenderInput): void {
  const candidate = input.candidate;
  const source = input.source;
  if (candidate.status !== "approved_for_delivery"
    || !Number.isSafeInteger(candidate.version)
    || candidate.version < 1
    || candidate.version >= Number.MAX_SAFE_INTEGER
    || candidate.plan.outcome !== "conflict"
    || candidate.plan.knowledgeBaseStatement === null
    || candidate.plan.groupConclusionStatement === null
    || candidate.plan.difference === null
    || candidate.plan.suggestedUpdate === null
    || candidate.targetDocumentSourceId !== source.id
    || source.sourceType !== "authorized_wiki_document"
    || source.syncState !== "synced"
    || (source.permissionState !== "readable" && source.permissionState !== "unknown")
    || !source.canUseForKnowledgeDrafts
    || !sameDate(candidate.targetSourceUpdatedAt, source.updatedAt)) {
    throw new KnowledgeConflictCardBindingError();
  }
  requireIdentifier(candidate.id);
  requireIdentifier(candidate.groupId);
  requireIdentifier(candidate.targetSnapshotId);
}

function sameDate(left: Date, right: Date): boolean {
  return validDate(left) && validDate(right) && left.getTime() === right.getTime();
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function escapedVisible(value: string | null, maximum: number): string {
  if (typeof value !== "string") throw new KnowledgeConflictCardBindingError();
  return escapeFeishuMarkdown(visibleText(value, maximum));
}

function visibleText(value: string, maximum: number): string {
  if (typeof value !== "string") throw new KnowledgeConflictCardBindingError();
  const normalized = value.normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) throw new KnowledgeConflictCardBindingError();
  const characters = Array.from(normalized);
  return characters.length <= maximum
    ? normalized
    : `${characters.slice(0, maximum - 1).join("")}…`;
}

function escapeFeishuMarkdown(value: string): string {
  return value
    .replace(/[<>]/gu, (character) => character === "<" ? "＜" : "＞")
    .replace(/([\\`*_{}\[\]()#+\-.!|~])/gu, "\\$1");
}

function safeSourceUri(value: string): string | undefined {
  if (typeof value !== "string" || value.length > MAX_SOURCE_URL_CHARS) return undefined;
  if (/[\u0000-\u001f\u007f-\u009f\s]/u.test(value)
    || /%(?![0-9a-f]{2})/iu.test(value)
    || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(value)
    || /%c2%(?:8[0-9a-f]|9[0-9a-f])/iu.test(value)) return undefined;
  try {
    const uri = new URL(value);
    if (uri.protocol !== "https:" || uri.username !== "" || uri.password !== "") return undefined;
    uri.hash = "";
    return uri.toString().replace(/\(/gu, "%28").replace(/\)/gu, "%29");
  } catch {
    return undefined;
  }
}

function requireIdentifier(value: string): string {
  if (typeof value !== "string") throw new KnowledgeConflictCardBindingError();
  const normalized = value.normalize("NFC").trim();
  if (normalized.length < 1
    || normalized.length > MAX_IDENTIFIER_CHARS
    || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new KnowledgeConflictCardBindingError();
  }
  return normalized;
}

function requireNonce(value: string): string {
  const normalized = requireIdentifier(value);
  if (normalized.length > MAX_NONCE_CHARS) throw new KnowledgeConflictCardBindingError();
  return normalized;
}

function referenceOrder(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true });
}

function groupReferenceOrder(left: string, right: string): number {
  const kindDelta = (left.startsWith("M") ? 0 : 1) - (right.startsWith("M") ? 0 : 1);
  return kindDelta !== 0 ? kindDelta : referenceOrder(left, right);
}
