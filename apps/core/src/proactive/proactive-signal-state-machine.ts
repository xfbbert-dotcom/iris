import type { ProactiveSignalCandidate } from "./proactive-signal-candidate.js";

const MAX_ACTOR_CHARS = 512;
const MAX_REASON_CHARS = 512;

export type ProactiveSignalTransition =
  | {
      type: "dismiss";
      expectedVersion: number;
      dismissedBy: string;
      dismissalReason?: string;
      at: Date;
    }
  | {
      type: "expire";
      expectedVersion: number;
      at: Date;
    };

export class ProactiveSignalTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProactiveSignalTransitionError";
  }
}

export function applyProactiveSignalTransition(
  candidate: ProactiveSignalCandidate,
  transition: ProactiveSignalTransition,
): ProactiveSignalCandidate {
  if (candidate.status !== "pending") {
    throw new ProactiveSignalTransitionError("only pending proactive candidates can transition");
  }
  if (
    !Number.isSafeInteger(transition.expectedVersion) ||
    transition.expectedVersion < 1 ||
    candidate.version !== transition.expectedVersion
  ) {
    throw new ProactiveSignalTransitionError("proactive candidate version conflict");
  }
  const at = requireDate("transition time", transition.at);
  if (at.getTime() < candidate.updatedAt.getTime()) {
    throw new ProactiveSignalTransitionError("transition time precedes current candidate state");
  }

  if (transition.type === "expire") {
    return {
      ...candidate,
      status: "expired",
      version: candidate.version + 1,
      expiredAt: at,
      updatedAt: at,
    };
  }

  const dismissedBy = requireBoundedString(
    "dismissedBy",
    transition.dismissedBy,
    MAX_ACTOR_CHARS,
  );
  const dismissalReason = transition.dismissalReason === undefined
    ? undefined
    : requireBoundedString("dismissalReason", transition.dismissalReason, MAX_REASON_CHARS);
  return {
    ...candidate,
    status: "dismissed",
    version: candidate.version + 1,
    dismissedAt: at,
    dismissedBy,
    ...(dismissalReason === undefined ? {} : { dismissalReason }),
    updatedAt: at,
  };
}

function requireDate(label: string, value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new ProactiveSignalTransitionError(`${label} is invalid`);
  }
  return new Date(value);
}

function requireBoundedString(label: string, value: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maxLength) {
    throw new ProactiveSignalTransitionError(`${label} is invalid`);
  }
  return normalized;
}
