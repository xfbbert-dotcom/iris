import type {
  KnowledgeDraftEventType,
  KnowledgeDraftStatus,
} from "./knowledge-draft.js";

type TransitionResult = { ok: true } | { ok: false; code: string };

export function initialKnowledgeDraftStatus(input: {
  sourceGroupId?: string;
}): KnowledgeDraftStatus {
  return input.sourceGroupId?.trim() ? "pending_confirmation" : "pending_review";
}

export function validateKnowledgeDraftTransition(input: {
  from: KnowledgeDraftStatus;
  to: KnowledgeDraftStatus;
  eventType: KnowledgeDraftEventType;
  sourceGroupId?: string;
}): TransitionResult {
  if (input.from === "rejected" || input.from === "published") {
    return { ok: false, code: "knowledge_draft_terminal" };
  }

  if (input.eventType === "rejected" && input.to === "rejected") {
    return { ok: true };
  }
  if (
    input.eventType === "revision_requested" &&
    input.to === "needs_revision" &&
    (input.from === "pending_confirmation" || input.from === "pending_review")
  ) return { ok: true };
  if (input.eventType === "revised") {
    const requiredStatus = input.sourceGroupId?.trim()
      ? "pending_confirmation"
      : "pending_review";
    if (
      input.to === requiredStatus &&
      (input.from === requiredStatus || input.from === "needs_revision")
    ) return { ok: true };
  }

  return { ok: false, code: "invalid_knowledge_draft_transition" };
}
