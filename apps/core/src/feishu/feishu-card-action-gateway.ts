import {
  normalizeApprovalInteractionJob,
  type ApprovalInteractionJob,
} from "../knowledge-cards/knowledge-card.js";
import {
  parseFeishuCardAction,
  type ParsedFeishuCardAction,
} from "./feishu-card-action.js";

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

export type FeishuCardActionGatewayDependencies = {
  queue: ApprovalInteractionEnqueuer;
  verifyRequest: RequestVerifier;
  now?: () => Date;
};

export function createFeishuCardActionGateway(dependencies: FeishuCardActionGatewayDependencies) {
  const now = dependencies.now ?? (() => new Date());

  return {
    async handleCallback(request: FeishuCardActionCallbackRequest): Promise<FeishuCardActionCallbackResponse> {
      let verified = false;
      try {
        verified = await dependencies.verifyRequest(request);
      } catch {
        return rejectedResponse(401);
      }
      if (!verified) return rejectedResponse(401);

      const action = parseFeishuCardAction(request.body);
      if (action === undefined) return rejectedResponse(400);

      const job = createJob(action, now());
      const enqueued = await enqueueWithinDeadline(dependencies.queue, job);
      return enqueued ? acceptedResponse() : enqueueFailureResponse();
    },
  };
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
): Promise<boolean> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error("approval interaction enqueue timed out")), ENQUEUE_TIMEOUT_MS);
  });

  try {
    await Promise.race([queue.enqueue(job), timeout]);
    return true;
  } catch {
    return false;
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

function rejectedResponse(statusCode: 400 | 401): FeishuCardActionCallbackResponse {
  return { statusCode, body: { ok: false } };
}
