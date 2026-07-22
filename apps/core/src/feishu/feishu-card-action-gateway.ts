import {
  normalizeApprovalInteractionJob,
  normalizeApprovalInteractionIntentIdentity,
  type ApprovalInteractionIntentIdentity,
  type ApprovalInteractionJob,
} from "../knowledge-cards/knowledge-card.js";
import type { ApprovalInteractionIntentStore } from "../knowledge-cards/approval-interaction-intent-store.js";
import {
  parseFeishuCardAction,
  type ParsedFeishuCardAction,
} from "./feishu-card-action.js";
import { isFeishuUrlVerificationPayload } from "./feishu-auth.js";

const ENQUEUE_TIMEOUT_MS = 1_000;

export type FeishuCardActionCallbackRequest = {
  headers: Record<string, string | undefined>;
  body: unknown;
  rawBody?: string;
};

export type FeishuCardActionCallbackResponse = {
  statusCode: 200 | 400 | 401;
  body: unknown;
};

export type ApprovalInteractionEnqueuer = {
  enqueue(job: ApprovalInteractionJob): Promise<"enqueued" | "duplicate">;
};

type RequestVerifier = (request: FeishuCardActionCallbackRequest) => Promise<boolean> | boolean;
type RequestDecoder = (
  request: FeishuCardActionCallbackRequest,
) => Promise<FeishuCardActionCallbackRequest | undefined> | FeishuCardActionCallbackRequest | undefined;

export type FeishuCardActionCallbackDiagnostic = {
  stage:
    | "envelope_rejected"
    | "decode_rejected"
    | "decoded_identity_rejected"
    | "action_rejected"
    | "challenge_accepted"
    | "unsigned_encrypted_challenge_accepted";
  statusCode: 200 | 400 | 401;
  hasTimestamp: boolean;
  hasNonce: boolean;
  hasSignature: boolean;
  encrypted: boolean;
  actionShape?: FeishuCardActionShapeDiagnostic;
};

type FeishuCardActionShapeDiagnostic = {
  bodyRecord: boolean;
  bodyKeyCount: number;
  headerRecord: boolean;
  headerKeyCount: number;
  eventRecord: boolean;
  eventKeyCount: number;
  operatorRecord: boolean;
  operatorKeyCount: number;
  contextRecord: boolean;
  contextKeyCount: number;
  actionRecord: boolean;
  actionKeyCount: number;
  callbackValueRecord: boolean;
  callbackValueKeyCount: number;
  callbackValueType: string;
  formValueRecord: boolean;
  formValueKeyCount: number;
  hasReason: boolean;
  reasonType: string;
  hasName: boolean;
  nameType: string;
  hasTimezone: boolean;
  timezoneType: string;
  schemaV2: boolean;
  eventTypeCardAction: boolean;
  hostImMessage: boolean;
  actionTagButton: boolean;
  callbackKindRecognized: boolean;
  callbackActionRecognized: boolean;
  nameMatchesCallbackAction: boolean;
  callbackIdentifiersValid: boolean;
  callbackVersionsCanonical: boolean;
  reasonLength: number | null;
  reasonNonEmpty: boolean;
};

export type FeishuCardActionGatewayDependencies = {
  queue: ApprovalInteractionEnqueuer;
  intentStore?: Pick<ApprovalInteractionIntentStore, "persistIntent">;
  verifyRequest: RequestVerifier;
  decodeRequest?: RequestDecoder;
  verifyDecodedRequest?: RequestVerifier;
  allowUnsignedEncryptedUrlVerification?: boolean;
  onDiagnostic?: (diagnostic: FeishuCardActionCallbackDiagnostic) => void;
  now?: () => Date;
};

export function createFeishuCardActionGateway(dependencies: FeishuCardActionGatewayDependencies) {
  const now = dependencies.now ?? (() => new Date());

  return {
    async handleCallback(request: FeishuCardActionCallbackRequest): Promise<FeishuCardActionCallbackResponse> {
      if (!await passesVerifier(dependencies.verifyRequest, request)) {
        if (canAttemptUnsignedEncryptedUrlVerification(dependencies, request)) {
          let decodedRequest: FeishuCardActionCallbackRequest | undefined;
          try {
            decodedRequest = await dependencies.decodeRequest(request);
          } catch {
            decodedRequest = undefined;
          }
          if (decodedRequest === undefined) {
            reportDiagnostic(dependencies.onDiagnostic, {
              stage: "decode_rejected",
              statusCode: 401,
              ...requestShape(request),
            });
            return rejectedResponse(401);
          }
          if (!await passesVerifier(dependencies.verifyDecodedRequest, decodedRequest)) {
            reportDiagnostic(dependencies.onDiagnostic, {
              stage: "decoded_identity_rejected",
              statusCode: 401,
              ...requestShape(request),
            });
            return rejectedResponse(401);
          }
          if (isFeishuUrlVerificationPayload(decodedRequest.body)) {
            reportDiagnostic(dependencies.onDiagnostic, {
              stage: "unsigned_encrypted_challenge_accepted",
              statusCode: 200,
              ...requestShape(request),
            });
            return {
              statusCode: 200,
              body: { challenge: decodedRequest.body.challenge },
            };
          }
        }
        reportDiagnostic(dependencies.onDiagnostic, {
          stage: "envelope_rejected",
          statusCode: 401,
          ...requestShape(request),
        });
        return rejectedResponse(401);
      }

      let decodedRequest = request;
      if (dependencies.decodeRequest !== undefined) {
        try {
          const decoded = await dependencies.decodeRequest(request);
          if (decoded === undefined) {
            reportDiagnostic(dependencies.onDiagnostic, {
              stage: "decode_rejected",
              statusCode: 401,
              ...requestShape(request),
            });
            return rejectedResponse(401);
          }
          decodedRequest = decoded;
        } catch {
          reportDiagnostic(dependencies.onDiagnostic, {
            stage: "decode_rejected",
            statusCode: 401,
            ...requestShape(request),
          });
          return rejectedResponse(401);
        }
      }
      if (
        dependencies.verifyDecodedRequest !== undefined &&
        !await passesVerifier(dependencies.verifyDecodedRequest, decodedRequest)
      ) {
        reportDiagnostic(dependencies.onDiagnostic, {
          stage: "decoded_identity_rejected",
          statusCode: 401,
          ...requestShape(request),
        });
        return rejectedResponse(401);
      }

      if (isFeishuUrlVerificationPayload(decodedRequest.body)) {
        reportDiagnostic(dependencies.onDiagnostic, {
          stage: "challenge_accepted",
          statusCode: 200,
          ...requestShape(request),
        });
        return {
          statusCode: 200,
          body: { challenge: decodedRequest.body.challenge },
        };
      }

      const action = parseFeishuCardAction(decodedRequest.body);
      if (action === undefined) {
        reportDiagnostic(dependencies.onDiagnostic, {
          stage: "action_rejected",
          statusCode: 400,
          ...requestShape(request),
          actionShape: safelyDescribeActionShape(decodedRequest.body),
        });
        return rejectedResponse(400);
      }

      const outcome = await submitWithinDeadline({
        action,
        receivedAt: now(),
        queue: dependencies.queue,
        intentStore: dependencies.intentStore,
      });
      if (outcome === "accepted") return acceptedResponse();
      return outcome === "rejected" ? enqueueFailureResponse() : enqueueUncertaintyResponse();
    },
  };
}

function canAttemptUnsignedEncryptedUrlVerification(
  dependencies: FeishuCardActionGatewayDependencies,
  request: FeishuCardActionCallbackRequest,
): dependencies is FeishuCardActionGatewayDependencies & {
  decodeRequest: RequestDecoder;
  verifyDecodedRequest: RequestVerifier;
} {
  return dependencies.allowUnsignedEncryptedUrlVerification === true &&
    dependencies.decodeRequest !== undefined &&
    dependencies.verifyDecodedRequest !== undefined &&
    isEncryptedWrapper(request.body) &&
    request.headers["x-lark-request-timestamp"] === undefined &&
    request.headers["x-lark-request-nonce"] === undefined &&
    request.headers["x-lark-signature"] === undefined;
}

function requestShape(request: FeishuCardActionCallbackRequest): Pick<
  FeishuCardActionCallbackDiagnostic,
  "hasTimestamp" | "hasNonce" | "hasSignature" | "encrypted"
> {
  return {
    hasTimestamp: request.headers["x-lark-request-timestamp"] !== undefined,
    hasNonce: request.headers["x-lark-request-nonce"] !== undefined,
    hasSignature: request.headers["x-lark-signature"] !== undefined,
    encrypted: isEncryptedWrapper(request.body),
  };
}

function isEncryptedWrapper(body: unknown): boolean {
  return typeof body === "object" && body !== null &&
    Object.keys(body).length === 1 && typeof (body as Record<string, unknown>).encrypt === "string";
}

function describeActionShape(body: unknown): FeishuCardActionShapeDiagnostic {
  const bodyRecord = asRecord(body);
  const header = asRecord(bodyRecord?.header);
  const event = asRecord(bodyRecord?.event);
  const operator = asRecord(event?.operator);
  const context = asRecord(event?.context);
  const action = asRecord(event?.action);
  const callbackValue = asRecord(action?.value);
  const formValue = asRecord(action?.form_value);
  const callbackKind = callbackValue?.kind;
  const callbackAction = callbackValue?.action;
  const reason = formValue?.reason;

  return {
    bodyRecord: bodyRecord !== undefined,
    bodyKeyCount: keyCount(bodyRecord),
    headerRecord: header !== undefined,
    headerKeyCount: keyCount(header),
    eventRecord: event !== undefined,
    eventKeyCount: keyCount(event),
    operatorRecord: operator !== undefined,
    operatorKeyCount: keyCount(operator),
    contextRecord: context !== undefined,
    contextKeyCount: keyCount(context),
    actionRecord: action !== undefined,
    actionKeyCount: keyCount(action),
    callbackValueRecord: callbackValue !== undefined,
    callbackValueKeyCount: keyCount(callbackValue),
    callbackValueType: valueType(action?.value),
    formValueRecord: formValue !== undefined,
    formValueKeyCount: keyCount(formValue),
    hasReason: formValue !== undefined && Object.hasOwn(formValue, "reason"),
    reasonType: valueType(formValue?.reason),
    hasName: action !== undefined && Object.hasOwn(action, "name"),
    nameType: valueType(action?.name),
    hasTimezone: action !== undefined && Object.hasOwn(action, "timezone"),
    timezoneType: valueType(action?.timezone),
    schemaV2: bodyRecord?.schema === "2.0",
    eventTypeCardAction: header?.event_type === "card.action.trigger",
    hostImMessage: event?.host === "im_message",
    actionTagButton: action?.tag === "button",
    callbackKindRecognized:
      callbackKind === "knowledge_draft_confirmation" || callbackKind === "action_proposal_approval",
    callbackActionRecognized: isRecognizedDiagnosticAction(callbackKind, callbackAction),
    nameMatchesCallbackAction:
      typeof action?.name === "string" && action.name === callbackAction,
    callbackIdentifiersValid: hasValidDiagnosticIdentifiers(callbackValue),
    callbackVersionsCanonical: hasCanonicalDiagnosticVersions(callbackValue),
    reasonLength: typeof reason === "string" ? [...reason.trim()].length : null,
    reasonNonEmpty: typeof reason === "string" && reason.trim().length > 0,
  };
}

function isRecognizedDiagnosticAction(kind: unknown, action: unknown): boolean {
  if (kind === "knowledge_draft_confirmation") {
    return action === "confirm" || action === "request_revision" || action === "reject";
  }
  if (kind === "action_proposal_approval") {
    return action === "approve" || action === "request_revision" || action === "reject";
  }
  return false;
}

function hasValidDiagnosticIdentifiers(value: Record<string, unknown> | undefined): boolean {
  if (value?.kind === "knowledge_draft_confirmation") {
    return [value.presentationId, value.draftId].every(isDiagnosticReference);
  }
  if (value?.kind === "action_proposal_approval") {
    return [value.presentationId, value.proposalId, value.requirementId].every(isDiagnosticReference);
  }
  return false;
}

function hasCanonicalDiagnosticVersions(value: Record<string, unknown> | undefined): boolean {
  if (value?.kind === "knowledge_draft_confirmation") {
    return [value.revisionNumber, value.draftVersion].every(isCanonicalPositiveIntegerString);
  }
  if (value?.kind === "action_proposal_approval") {
    return [
      value.proposalVersion,
      value.subjectRevision,
      value.subjectVersion,
      value.targetPolicyVersion,
    ].every(isCanonicalPositiveIntegerString);
  }
  return false;
}

function isDiagnosticReference(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= 512;
}

function isCanonicalPositiveIntegerString(value: unknown): boolean {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) return false;
  return Number.isSafeInteger(Number(value));
}

function safelyDescribeActionShape(body: unknown): FeishuCardActionShapeDiagnostic | undefined {
  try {
    return describeActionShape(body);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function keyCount(value: Record<string, unknown> | undefined): number {
  return value === undefined ? 0 : Object.keys(value).length;
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function reportDiagnostic(
  observer: ((diagnostic: FeishuCardActionCallbackDiagnostic) => void) | undefined,
  diagnostic: FeishuCardActionCallbackDiagnostic,
): void {
  try {
    observer?.(diagnostic);
  } catch {
    // Diagnostics must never alter callback authentication or acknowledgement.
  }
}

async function passesVerifier(
  verifier: RequestVerifier,
  request: FeishuCardActionCallbackRequest,
): Promise<boolean> {
  try {
    return await verifier(request);
  } catch {
    return false;
  }
}

async function createJob(
  action: ParsedFeishuCardAction,
  receivedAt: Date,
  intentStore: Pick<ApprovalInteractionIntentStore, "persistIntent"> | undefined,
): Promise<ApprovalInteractionJob> {
  const common = {
    kind: action.kind,
    idempotencyKey: `feishu-card:${action.appId}:${action.eventId}`,
    eventId: action.eventId,
    appId: action.appId,
    actorOpenId: action.actorOpenId,
    chatId: action.chatId,
    ...(action.messageId === undefined ? {} : { messageId: action.messageId }),
    presentationId: action.presentationId,
    action: action.action,
  };
  let interaction: ApprovalInteractionIntentIdentity;
  if (action.kind === "knowledge_draft_confirmation") {
    interaction = normalizeApprovalInteractionIntentIdentity({
      ...common,
      kind: action.kind,
      draftId: action.draftId,
      revisionNumber: action.revisionNumber,
      draftVersion: action.draftVersion,
    });
  } else {
    interaction = normalizeApprovalInteractionIntentIdentity({
      ...common,
      kind: action.kind,
      proposalId: action.proposalId,
      requirementId: action.requirementId,
      proposalVersion: action.proposalVersion,
      subjectRevision: action.subjectRevision,
      subjectVersion: action.subjectVersion,
      targetPolicyVersion: action.targetPolicyVersion,
    });
  }
  if (action.reason === undefined) {
    return normalizeApprovalInteractionJob({ ...interaction, receivedAt, attempts: 0 });
  }
  if (intentStore === undefined) throw new Error("approval interaction intent store is unavailable");
  const persisted = await intentStore.persistIntent({
    interaction,
    reason: action.reason,
    ...(action.rejectionConfirmed === undefined
      ? {}
      : { rejectionConfirmed: action.rejectionConfirmed }),
    at: receivedAt,
  });
  return normalizeApprovalInteractionJob({
    ...interaction,
    intentId: persisted.id,
    receivedAt,
    attempts: 0,
  });
}

async function submitWithinDeadline({
  action,
  receivedAt,
  queue,
  intentStore,
}: {
  action: ParsedFeishuCardAction;
  receivedAt: Date;
  queue: ApprovalInteractionEnqueuer;
  intentStore: Pick<ApprovalInteractionIntentStore, "persistIntent"> | undefined;
}): Promise<"accepted" | "rejected" | "uncertain"> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const submission = Promise.resolve()
    .then(async () => {
      const job = await createJob(action, receivedAt, intentStore);
      await queue.enqueue(job);
    })
    .then(
      () => "accepted" as const,
      () => "rejected" as const,
    );
  const timeout = new Promise<"uncertain">((resolve) => {
    timeoutId = setTimeout(() => resolve("uncertain"), ENQUEUE_TIMEOUT_MS);
  });

  try {
    return await Promise.race([submission, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function acceptedResponse(): FeishuCardActionCallbackResponse {
  return {
    statusCode: 200,
    body: { toast: { type: "info", content: "\u5df2\u6536\u5230\uff0c\u6b63\u5728\u6838\u9a8c" } },
  };
}

function enqueueFailureResponse(): FeishuCardActionCallbackResponse {
  return {
    statusCode: 200,
    body: { toast: { type: "error", content: "\u64cd\u4f5c\u672a\u63d0\u4ea4\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5" } },
  };
}

function enqueueUncertaintyResponse(): FeishuCardActionCallbackResponse {
  return {
    statusCode: 200,
    body: {
      toast: {
        type: "error",
        content: "\u63d0\u4ea4\u72b6\u6001\u672a\u786e\u8ba4\uff0c\u8bf7\u52ff\u91cd\u590d\u70b9\u51fb\uff1b\u8bf7\u4ee5\u5361\u7247\u6700\u7ec8\u72b6\u6001\u4e3a\u51c6",
      },
    },
  };
}

function rejectedResponse(statusCode: 400 | 401): FeishuCardActionCallbackResponse {
  return { statusCode, body: { ok: false } };
}
