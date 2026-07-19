import {
  normalizeApprovalInteractionJob,
  type ApprovalInteractionJob,
} from "../knowledge-cards/knowledge-card.js";
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
  stage: "envelope_rejected" | "decode_rejected" | "decoded_identity_rejected" | "challenge_accepted";
  statusCode: 200 | 401;
  hasTimestamp: boolean;
  hasNonce: boolean;
  hasSignature: boolean;
  encrypted: boolean;
};

export type FeishuCardActionGatewayDependencies = {
  queue: ApprovalInteractionEnqueuer;
  verifyRequest: RequestVerifier;
  decodeRequest?: RequestDecoder;
  verifyDecodedRequest?: RequestVerifier;
  onDiagnostic?: (diagnostic: FeishuCardActionCallbackDiagnostic) => void;
  now?: () => Date;
};

export function createFeishuCardActionGateway(dependencies: FeishuCardActionGatewayDependencies) {
  const now = dependencies.now ?? (() => new Date());

  return {
    async handleCallback(request: FeishuCardActionCallbackRequest): Promise<FeishuCardActionCallbackResponse> {
      if (!await passesVerifier(dependencies.verifyRequest, request)) {
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
      if (action === undefined) return rejectedResponse(400);

      const job = createJob(action, now());
      const outcome = await enqueueWithinDeadline(dependencies.queue, job);
      if (outcome === "accepted") return acceptedResponse();
      return outcome === "rejected" ? enqueueFailureResponse() : enqueueUncertaintyResponse();
    },
  };
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

function createJob(action: ParsedFeishuCardAction, receivedAt: Date): ApprovalInteractionJob {
  return normalizeApprovalInteractionJob({
    idempotencyKey: `feishu-card:${action.appId}:${action.eventId}`,
    eventId: action.eventId,
    appId: action.appId,
    actorOpenId: action.actorOpenId,
    chatId: action.chatId,
    ...(action.messageId === undefined ? {} : { messageId: action.messageId }),
    presentationId: action.presentationId,
    draftId: action.draftId,
    revisionNumber: action.revisionNumber,
    draftVersion: action.draftVersion,
    action: action.action,
    ...(action.reason === undefined ? {} : { reason: action.reason }),
    ...(action.rejectionConfirmed === undefined ? {} : { rejectionConfirmed: action.rejectionConfirmed }),
    receivedAt,
    attempts: 0,
  });
}

async function enqueueWithinDeadline(
  queue: ApprovalInteractionEnqueuer,
  job: ApprovalInteractionJob,
): Promise<"accepted" | "rejected" | "uncertain"> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const enqueue = Promise.resolve()
    .then(() => queue.enqueue(job))
    .then(
      () => "accepted" as const,
      () => "rejected" as const,
    );
  const timeout = new Promise<"uncertain">((resolve) => {
    timeoutId = setTimeout(() => resolve("uncertain"), ENQUEUE_TIMEOUT_MS);
  });

  try {
    return await Promise.race([enqueue, timeout]);
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
