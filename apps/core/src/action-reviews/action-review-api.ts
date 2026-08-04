import { createHash, timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyReply } from "fastify";

import {
  ACTION_REVIEW_OAUTH_COOKIE_NAME,
  ACTION_REVIEW_SESSION_COOKIE_NAME,
} from "./action-review-session.js";
import {
  actionReviewSecurityHeaders,
  renderActionReviewPage,
  renderActionReviewRecordedPage,
  renderActionReviewUnavailablePage,
} from "./action-review-renderer.js";
import type { ActionReviewRuntime } from "../runtime/action-review-runtime.js";

const maxProposalIdChars = 512;
const maxFormBytes = 2_048;

export function registerActionReviewApi(
  app: FastifyInstance,
  runtime: ActionReviewRuntime | undefined,
  { now = () => new Date() }: { now?: () => Date } = {},
): void {
  if (runtime === undefined) return;

  void app.register(async (reviewApp) => {
    reviewApp.setErrorHandler((error, _request, reply) => {
      const statusCode = readErrorStatusCode(error) === 413 ? 413 : 500;
      return sendUnavailable(reply, statusCode);
    });
    reviewApp.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string", bodyLimit: maxFormBytes },
      (_request, body, done) => done(null, body),
    );

    reviewApp.get("/review/action-proposals/:proposalId", async (request, reply) => {
      const proposalId = readProposalId((request.params as { proposalId?: unknown }).proposalId);
      if (proposalId === undefined) return sendUnavailable(reply, 404);

      const sessionCookie = readCookie(request.headers.cookie, ACTION_REVIEW_SESSION_COOKIE_NAME);
      const session = sessionCookie === undefined
        ? undefined
        : runtime.codec.readReviewSession(sessionCookie, proposalId);
      if (session === undefined) {
        const transaction = runtime.codec.createOAuthTransaction(proposalId);
        const authorizationUrl = runtime.oauthClient.buildAuthorizationUrl({
          state: transaction.state,
          codeChallenge: transaction.codeChallenge,
        });
        return reply
          .header("set-cookie", runtime.codec.serializeOAuthTransactionCookie(transaction.cookieValue))
          .redirect(authorizationUrl.toString(), 302);
      }

      try {
        const context = await runtime.repository.getAuthorizedReviewContext({
          proposalId,
          actorOpenId: session.actorOpenId,
        });
        if (context === undefined) {
          logReviewDiagnostic("session_context_unavailable", { proposalId, actorOpenId: session.actorOpenId });
          return sendUnavailable(reply, 403);
        }
        return sendHtml(reply, 200, renderActionReviewPage({ context, csrfToken: session.csrfToken }));
      } catch (error) {
        logReviewDiagnostic("session_context_error", { proposalId, error });
        return sendUnavailable(reply, 403);
      }
    });

    reviewApp.get("/review/oauth/callback", async (request, reply) => {
      const query = request.query as Record<string, unknown>;
      const state = readSingleString(query.state);
      const code = readSingleString(query.code);
      const oauthCookie = readCookie(request.headers.cookie, ACTION_REVIEW_OAUTH_COOKIE_NAME);
      const clearCookie = runtime.codec.clearOAuthTransactionCookie();
      const transaction = state === undefined || oauthCookie === undefined
        ? undefined
        : runtime.codec.readOAuthTransaction(oauthCookie, state);
      if (transaction === undefined || code === undefined || query.error !== undefined) {
        logReviewDiagnostic("oauth_callback_invalid", {
          hasState: state !== undefined,
          hasCode: code !== undefined,
          hasOAuthCookie: oauthCookie !== undefined,
          hasOAuthError: query.error !== undefined,
        });
        reply.header("set-cookie", clearCookie);
        return sendUnavailable(reply, 403);
      }

      try {
        const { actorOpenId } = await runtime.oauthClient.exchangeCode({
          code,
          codeVerifier: transaction.codeVerifier,
        });
        const context = await runtime.repository.getAuthorizedReviewContext({
          proposalId: transaction.proposalId,
          actorOpenId,
        });
        if (context === undefined) {
          logReviewDiagnostic("oauth_context_unavailable", {
            proposalId: transaction.proposalId,
            actorOpenId,
          });
          reply.header("set-cookie", clearCookie);
          return sendUnavailable(reply, 403);
        }
        const session = runtime.codec.createReviewSession({
          proposalId: transaction.proposalId,
          actorOpenId,
        });
        return reply
          .header("set-cookie", [
            clearCookie,
            runtime.codec.serializeReviewSessionCookie(session.cookieValue),
          ])
          .redirect(`/review/action-proposals/${encodeURIComponent(transaction.proposalId)}`, 303);
      } catch (error) {
        logReviewDiagnostic("oauth_exchange_or_context_error", {
          proposalId: transaction.proposalId,
          error,
        });
        reply.header("set-cookie", clearCookie);
        return sendUnavailable(reply, 403);
      }
    });

    reviewApp.post(
      "/review/action-proposals/:proposalId/attest",
      { bodyLimit: maxFormBytes },
      async (request, reply) => {
        const proposalId = readProposalId((request.params as { proposalId?: unknown }).proposalId);
        const form = parseAttestationForm(request.body);
        if (proposalId === undefined || form === undefined) return sendUnavailable(reply, 400);
        const sessionCookie = readCookie(request.headers.cookie, ACTION_REVIEW_SESSION_COOKIE_NAME);
        const session = sessionCookie === undefined
          ? undefined
          : runtime.codec.readReviewSession(sessionCookie, proposalId);
        if (session === undefined || !sameString(session.csrfToken, form.csrfToken)) {
          return sendUnavailable(reply, 403);
        }

        try {
          const context = await runtime.repository.getAuthorizedReviewContext({
            proposalId,
            actorOpenId: session.actorOpenId,
          });
          if (context === undefined) return sendUnavailable(reply, 403);
          const operationKey = `action-review:${createHash("sha256")
            .update(`${session.sessionId}\u0000${proposalId}\u0000${context.proposalVersion}\u0000${context.contentHash}`)
            .digest("hex")}`;
          await runtime.repository.recordReviewAttestation({
            proposalId,
            actorOpenId: session.actorOpenId,
            expectedProposalVersion: context.proposalVersion,
            expectedSubjectRevision: context.subjectRevision,
            expectedSubjectVersion: context.subjectVersion,
            expectedContentHash: context.contentHash,
            sessionIdHash: createHash("sha256").update(session.sessionId).digest("hex"),
            operationKey,
            at: now(),
          });
          return sendHtml(reply, 200, renderActionReviewRecordedPage());
        } catch {
          return sendUnavailable(reply, 403);
        }
      },
    );
  });
}

function logReviewDiagnostic(
  reason: string,
  input: {
    proposalId?: string;
    actorOpenId?: string;
    hasState?: boolean;
    hasCode?: boolean;
    hasOAuthCookie?: boolean;
    hasOAuthError?: boolean;
    error?: unknown;
  },
): void {
  const fields = {
    reason,
    ...(input.proposalId === undefined ? {} : { proposalHash: shortHash(input.proposalId) }),
    ...(input.actorOpenId === undefined ? {} : { actorHash: shortHash(input.actorOpenId) }),
    ...(input.hasState === undefined ? {} : { hasState: input.hasState }),
    ...(input.hasCode === undefined ? {} : { hasCode: input.hasCode }),
    ...(input.hasOAuthCookie === undefined ? {} : { hasOAuthCookie: input.hasOAuthCookie }),
    ...(input.hasOAuthError === undefined ? {} : { hasOAuthError: input.hasOAuthError }),
    ...(input.error === undefined ? {} : { error: safeErrorName(input.error) }),
  };
  console.warn(`iris_action_review_unavailable ${JSON.stringify(fields)}`);
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function safeErrorName(error: unknown): string {
  if (error instanceof Error) return `${error.name}:${error.message}`;
  return typeof error;
}

function sendUnavailable(reply: FastifyReply, statusCode: number) {
  return sendHtml(reply, statusCode, renderActionReviewUnavailablePage());
}

function sendHtml(reply: FastifyReply, statusCode: number, html: string) {
  for (const [name, value] of Object.entries(actionReviewSecurityHeaders)) {
    reply.header(name, value);
  }
  return reply.code(statusCode).type("text/html; charset=utf-8").send(html);
}

function readProposalId(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxProposalIdChars &&
    value.trim() === value
    ? value
    : undefined;
}

function readSingleString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 4096
    ? value
    : undefined;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  const matches = header.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return undefined;
  const value = matches[0].slice(name.length + 1);
  return value.length > 0 && value.length <= 8192 ? value : undefined;
}

function parseAttestationForm(body: unknown): { csrfToken: string } | undefined {
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > maxFormBytes) return undefined;
  const form = new URLSearchParams(body);
  if ([...form.keys()].some((key) => key !== "csrfToken")) return undefined;
  const csrfValues = form.getAll("csrfToken");
  if (csrfValues.length !== 1 || csrfValues[0].length === 0 || csrfValues[0].length > 512) {
    return undefined;
  }
  return { csrfToken: csrfValues[0] };
}

function sameString(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function readErrorStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) {
    return undefined;
  }
  return typeof error.statusCode === "number" ? error.statusCode : undefined;
}
