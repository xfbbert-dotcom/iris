import { createHash } from "node:crypto";
import type { AssistantDocumentSourceBinding } from "../memory/context-assembly.js";
import type { LocalMessageSourceBinding } from "../memory/local-message-source.js";

export const PD_PILOT_CHAT = "oc_637a9aca45f01943477f4e17f1fc5b9a";

export type PdPolicy = { chatId: string; version: number; enabled: boolean; operatorId: string };
export type PdSource =
  | { kind: "message"; ref: string; binding: LocalMessageSourceBinding }
  | { kind: "document"; ref: string; binding: AssistantDocumentSourceBinding };
export type PdIssue = {
  id: string; chatId: string; description: string;
  state: "observing" | "surfaced" | "resolved" | "user_paused";
  version: number; basisVersion: number; lastObservation: string;
  lastReasoning: string; lastSuggestion: string; basisSources: PdSource[];
  hasUnknownDelivery: boolean;
};
export type PdJob = {
  id: string; chatId: string; messageId: string; contentHash: string;
  policyVersion: number; leaseToken: string; attempt: number;
  purpose: "assessment" | "feedback";
  feedback?: { action: "pause" | "resume"; replyMessageId: string; actorOpenId: string; irisMentionKey?: string };
};
export type PdContext = {
  chatId: string; triggerMessageId: string; policy: PdPolicy;
  contextVersion: number; catalogVersion: number;
  sources: PdSource[]; items: { ref: string; text: string }[]; issues: PdIssue[];
};
export type PdAssessment = {
  decision: "intervene" | "skip";
  reason: "material_issue" | "no_work_value" | "insufficient_basis" | "already_handled" | "duplicate" | "resolved";
  issueRef: { kind: "existing"; id: string } | { kind: "new"; description: string } | null;
  evidenceRefs: string[]; observation: string; reasoning: string; suggestion: string;
  uncertainty: "fact" | "qualified_inference";
  materialChange: { kind: "none" | "new_issue" | "new_evidence"; explanation: string; evidenceRefs: string[] };
};
export type PdDraft = { text: string; evidenceRefs: string[] };
export type PdDelivery = {
  id: string; chatId: string; issueId: string; issueVersion: number;
  basisVersion: number; policyVersion: number; contextVersion: number;
  triggerMessageId: string; text: string; sources: PdSource[]; uuid: string;
  state: "prepared" | "sending" | "sent" | "cancelled" | "outcome_unknown";
  leaseToken: string;
};
export type PdStatus = {
  pending: number; failed: number; deadLetter: number; unknown: number; lastSuccessAt: Date | null;
};

// Canonical binding keys make identity independent of object construction and source
// ordering. The complete document snapshot/grant binding participates in the hash.
export function createPdSourceRef(source:
  | { kind: "message"; binding: LocalMessageSourceBinding }
  | { kind: "document"; binding: AssistantDocumentSourceBinding },
): string {
  const binding = Object.fromEntries(Object.entries(source.binding)
    .filter(([, value]) => value !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  return `${source.kind}:${createHash("sha256").update(JSON.stringify(binding), "utf8").digest("hex")}`;
}
