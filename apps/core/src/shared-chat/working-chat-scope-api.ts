import type { FastifyInstance, FastifyReply } from "fastify";
import {
  WorkingChatScopeConflictError,
  normalizeWorkingChatScopeReplacement,
  type ReplaceWorkingChatScopeInput,
  type WorkingChatScopeRepository,
} from "./working-chat-scope.js";

// Authentication itself is enforced by the app's shared /internal onRequest hook.
export function registerWorkingChatScopeApi(app: FastifyInstance,
  repository: WorkingChatScopeRepository | undefined,
  { authenticationConfigured, now = () => new Date() }: {
    authenticationConfigured: boolean; now?: () => Date;
  }): void {
  function available(reply: FastifyReply): boolean {
    if (!authenticationConfigured) {
      reply.code(503).send({ ok: false, error: "working_chat_scope_auth_unavailable" });
      return false;
    }
    if (repository === undefined) {
      reply.code(503).send({ ok: false, error: "working_chat_scope_unavailable" });
      return false;
    }
    return true;
  }
  app.get("/internal/working-chat-scope", async (_request, reply) => {
    if (!available(reply)) return;
    try { return { ok: true, scope: (await repository!.get()) ?? null }; }
    catch { return reply.code(503).send({ ok: false, error: "working_chat_scope_unavailable" }); }
  });
  app.put("/internal/working-chat-scope", async (request, reply) => {
    if (!available(reply)) return;
    const body = unwrapBody(request.body);
    let input: ReplaceWorkingChatScopeInput;
    try {
      if (!isRecord(body) || Object.keys(body).length !== 4
        || !["expectedVersion", "state", "groups", "updatedBy"].every(key => Object.hasOwn(body, key))) {
        throw new Error("invalid scope input");
      }
      input = normalizeWorkingChatScopeReplacement({ ...body, at: now() } as ReplaceWorkingChatScopeInput);
    } catch { return reply.code(400).send({ ok: false, error: "invalid_request" }); }
    try { return { ok: true, scope: await repository!.replace(input) }; }
    catch (error) {
      if (error instanceof WorkingChatScopeConflictError) {
        return reply.code(409).send({ ok: false, error: "working_chat_scope_conflict" });
      }
      return reply.code(503).send({ ok: false, error: "working_chat_scope_unavailable" });
    }
  });
}

function unwrapBody(body: unknown): unknown {
  return isRecord(body) && Object.hasOwn(body, "parsedBody") && typeof body.rawBody === "string"
    ? body.parsedBody : body;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
