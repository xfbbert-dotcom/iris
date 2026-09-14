import type { FastifyInstance, FastifyReply } from "fastify";
import { PD_PILOT_CHAT } from "./contracts.js";
import type { ProactiveDiscussionRuntime } from "../runtime/proactive-discussion-runtime.js";

export function readInternalApiAuditActor(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const actor = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(actor)) throw new Error("IRIS_INTERNAL_API_AUDIT_ACTOR must be a bounded credential role label");
  return `internal-api:${actor}`;
}

// The app's common /internal onRequest hook authenticates the bearer credential.
export function registerProactiveDiscussionApi(app: FastifyInstance, runtime: ProactiveDiscussionRuntime | undefined,
  { authenticationConfigured, auditActor, now = () => new Date() }: {
    authenticationConfigured: boolean; auditActor?: string; now?: () => Date;
  }) {
  const unavailable = (reply: FastifyReply) => reply.code(503).send({ ok: false, error: "proactive_discussion_unavailable" });
  const invalid = (reply: FastifyReply) => reply.code(400).send({ ok: false, error: "invalid_request" });
  const conflict = (reply: FastifyReply) => reply.code(409).send({ ok: false, error: "proactive_discussion_conflict" });
  app.get("/internal/proactive-discussion/status", async (_request, reply) => {
    if (!authenticationConfigured || !runtime) return unavailable(reply);
    try { return await runtime.getStatus(); } catch { return unavailable(reply); }
  });
  app.get<{ Params: { id: string } }>("/internal/proactive-discussion/deliveries/:id", async (request, reply) => {
    if (!authenticationConfigured || !runtime?.control) return unavailable(reply);
    if (!id(request.params.id)) return invalid(reply);
    try {
      const delivery = await runtime.control.repository.readDelivery(request.params.id);
      if (!delivery || delivery.chatId !== PD_PILOT_CHAT) return reply.code(404).send({ ok: false, error: "not_found" });
      return { ok: true, delivery };
    } catch { return unavailable(reply); }
  });
  app.put("/internal/proactive-discussion/policy", async (request, reply) => {
    if (!authenticationConfigured || !auditActor || !runtime?.control) return unavailable(reply);
    const body = unwrap(request.body);
    if (!fields(body, ["chatId", "expectedVersion", "enabled"]) || body.chatId !== PD_PILOT_CHAT
      || !version(body.expectedVersion, 0) || typeof body.enabled !== "boolean") return invalid(reply);
    try {
      const repository = runtime.control.repository;
      const result = await repository.setPolicy({ expectedVersion: body.expectedVersion,
        policy: { chatId: PD_PILOT_CHAT, version: body.expectedVersion + 1, enabled: body.enabled, operatorId: auditActor }, at: now() });
      if (result !== "applied") return conflict(reply);
      return { ok: true, ...(await repository.readState(PD_PILOT_CHAT)) };
    } catch { return unavailable(reply); }
  });
  app.post<{ Params: { id: string } }>("/internal/proactive-discussion/issues/:id/resume", async (request, reply) => {
    if (!authenticationConfigured || !auditActor || !runtime?.control) return unavailable(reply);
    const body = unwrap(request.body);
    if (!fields(body, ["chatId", "expectedVersion"]) || body.chatId !== PD_PILOT_CHAT
      || !version(body.expectedVersion, 1) || !id(request.params.id)) return invalid(reply);
    try {
      const result = await runtime.control.repository.resumeByOperator({ chatId: PD_PILOT_CHAT,
        issueId: request.params.id, expectedVersion: body.expectedVersion, operatorId: auditActor, at: now() });
      if (result !== "applied") return conflict(reply);
      return { ok: true, ...(await runtime.control.repository.readState(PD_PILOT_CHAT)) };
    } catch { return unavailable(reply); }
  });
  app.post("/internal/proactive-discussion/reconcile", async (request, reply) => {
    if (!authenticationConfigured || !auditActor || !runtime?.control) return unavailable(reply);
    const body = unwrap(request.body);
    if (!record(body) || !fields(body, body.outcome === "sent"
      ? ["deliveryId", "expectedVersion", "outcome", "replyMessageId"] : ["deliveryId", "expectedVersion", "outcome"])
      || !id(body.deliveryId) || !version(body.expectedVersion, 1)
      || (body.outcome !== "sent" && body.outcome !== "not_sent")
      || (body.outcome === "sent" && !id(body.replyMessageId))) return invalid(reply);
    try {
      const control = runtime.control;
      const delivery = await control.repository.readDelivery(body.deliveryId);
      if (!delivery || delivery.chatId !== PD_PILOT_CHAT || delivery.version !== body.expectedVersion || delivery.state !== "outcome_unknown") return conflict(reply);
      if (body.outcome === "sent" && !await control.verifySentReceipt(delivery, body.replyMessageId as string)) return conflict(reply);
      const result = await control.repository.reconcile({ deliveryId: body.deliveryId, expectedVersion: body.expectedVersion,
        operatorId: auditActor, outcome: body.outcome,
        ...(body.outcome === "sent" ? { replyMessageId: body.replyMessageId as string } : {}),
        evidence: body.outcome === "sent" ? `fresh_iris_receipt:${body.replyMessageId}` : "operator_declared_not_sent",
        at: now() });
      if (result !== "applied") return conflict(reply);
      return { ok: true, delivery: await control.repository.readDelivery(body.deliveryId) };
    } catch { return unavailable(reply); }
  });
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function unwrap(value: unknown): unknown { return record(value) && typeof value.rawBody === "string" && Object.hasOwn(value, "parsedBody") ? value.parsedBody : value; }
function fields(value: unknown, keys: string[]): value is Record<string, unknown> { return record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function id(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 505 && !/[\r\n]/u.test(value); }
function version(value: unknown, min: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value < Number.MAX_SAFE_INTEGER; }
