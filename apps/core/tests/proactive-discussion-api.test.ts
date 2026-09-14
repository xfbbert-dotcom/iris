import { afterEach, expect, test, vi } from "vitest";
import { buildApp, type BuildAppDependencies } from "../src/app.js";
import type { ProactiveDiscussionRuntime, PdControl } from "../src/runtime/proactive-discussion-runtime.js";
import { PD_PILOT_CHAT } from "../src/proactive-discussion/contracts.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const headers = { authorization: "Bearer pd-api-test" };
const policy = { chatId: PD_PILOT_CHAT, expectedVersion: 0, enabled: true };
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.unstubAllEnvs(); });
function fixture() {
  let saved: unknown = null;
  const setPolicy = vi.fn(async (input: unknown) => { saved = input; return "applied" as const; });
  const reconcile = vi.fn(async () => "applied" as const);
  const readDelivery = vi.fn(async () => ({ id: "d1", chatId: PD_PILOT_CHAT, state: "outcome_unknown", version: 2, text: "private advice" } as never));
  const control: PdControl = { repository: { setPolicy, reconcile, readDelivery,
    readState: async () => ({ policy: (saved as { policy: never } | null)?.policy ?? null, contextVersion: 1, catalogVersion: 1, issues: [] }),
    resumeByOperator: vi.fn(async () => "applied" as const) }, verifySentReceipt: vi.fn(async () => false) };
  const runtime: ProactiveDiscussionRuntime = { start: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
    registrar: { registerMessage: async () => undefined }, control,
    getStatus: async () => ({ enabled: true, running: true, ok: true, pending: 0, failed: 0, deadLetter: 0, unknown: 0, lastSuccessAt: null }) };
  return { runtime, control, setPolicy, reconcile };
}
async function createApp(runtime: ProactiveDiscussionRuntime, overrides: BuildAppDependencies = {}) {
  const app = await buildApp({ internalApiToken: "pd-api-test", internalApiAuditActor: "operations",
    createProactiveDiscussionRuntime: () => runtime, createAnswerDraftRuntime: () => undefined,
    createEventWorkerRuntime: () => undefined, createDocumentSyncRuntime: () => undefined,
    createReindexWorkerRuntime: () => undefined, ...overrides } as BuildAppDependencies);
  apps.push(app); return app;
}

test("protected status/detail and policy use shared bearer gate and server credential principal", async () => {
  const h = fixture(), app = await createApp(h.runtime);
  expect((await app.inject({ method: "PUT", url: "/internal/proactive-discussion/policy", payload: policy })).statusCode).toBe(401);
  expect((await app.inject({ url: "/internal/proactive-discussion/deliveries/d1" })).statusCode).toBe(401);
  const result = await app.inject({ method: "PUT", url: "/internal/proactive-discussion/policy", headers: { ...headers, "x-iris-operator": "forged-person" }, payload: policy });
  expect(result.statusCode).toBe(200);
  expect(h.setPolicy).toHaveBeenCalledWith({ expectedVersion: 0, at: expect.any(Date),
    policy: { chatId: PD_PILOT_CHAT, version: 1, enabled: true, operatorId: "internal-api:operations" } });
  expect(result.json().policy.operatorId).toBe("internal-api:operations");
  expect(h.runtime.start).toHaveBeenCalledOnce();
});

test.each(["operatorId", "actorOpenId", "updatedBy", "authorizationKind"])("rejects request identity spoof %s", async field => {
  const h = fixture(), app = await createApp(h.runtime);
  expect((await app.inject({ method: "PUT", url: "/internal/proactive-discussion/policy", headers, payload: { ...policy, [field]: "forged" } })).statusCode).toBe(400);
  expect(h.setPolicy).not.toHaveBeenCalled();
});

test("mutations without a configured server principal fail closed", async () => {
  const h = fixture(), app = await createApp(h.runtime, { internalApiAuditActor: "" } as BuildAppDependencies);
  expect((await app.inject({ method: "PUT", url: "/internal/proactive-discussion/policy", headers, payload: policy })).statusCode).toBe(503);
  expect(h.setPolicy).not.toHaveBeenCalled();
});

test("reconcile treats the submitted receipt as lookup only and never trusts submitted evidence", async () => {
  const h = fixture(), app = await createApp(h.runtime);
  const payload = { deliveryId: "d1", expectedVersion: 2, outcome: "sent", replyMessageId: "receipt" };
  expect((await app.inject({ method: "POST", url: "/internal/proactive-discussion/reconcile", headers, payload })).statusCode).toBe(409);
  expect(h.reconcile).not.toHaveBeenCalled();
  h.control.verifySentReceipt = async () => true;
  expect((await app.inject({ method: "POST", url: "/internal/proactive-discussion/reconcile", headers, payload })).statusCode).toBe(200);
  expect(h.reconcile).toHaveBeenCalledWith(expect.objectContaining({ operatorId: "internal-api:operations", evidence: "fresh_iris_receipt:receipt", outcome: "sent" }));
});

test("PD startup/status failure is isolated and sanitized while ordinary health remains available", async () => {
  const h = fixture();
  h.runtime.start = async () => { throw new Error("secret-startup"); };
  h.runtime.getStatus = async () => { throw new Error("secret-status"); };
  const app = await createApp(h.runtime);
  expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
  const result = await app.inject({ url: "/internal/status", headers });
  expect(result.json().components.proactiveDiscussion).toMatchObject({ ok: false, status: "degraded" });
  expect(result.body).not.toContain("secret");
  expect(result.json().components.proactiveDiscussion).not.toHaveProperty("pending");
});

test("app forwards ordinary lineage independent of PD and owns PD cleanup on construction failure", async () => {
  const h = fixture();
  const localMessageVerifier = { verify: async () => false };
  let forwarded: unknown;
  const app = await createApp(h.runtime, {
    createAnswerDraftRuntime: () => ({ localMessageVerifier, answerDraftOrchestrator: { generateDraft: async () => ({ answerText: "answer" } as never) },
      answerSourcePermissionVerifier: { verify: async () => [] }, close: async () => undefined }),
    createEventWorkerRuntime: input => { forwarded = input?.localMessageVerifier; return undefined; },
  });
  expect(forwarded).toBe(localMessageVerifier);
  await app.ready(); await app.close();
  expect(h.runtime.close).toHaveBeenCalledOnce();
  const failed = fixture();
  let cleanup: Promise<void> | undefined;
  await expect(createApp(failed.runtime, {
    onBeforeRuntimeCloseOwnership: () => { throw new Error("late composition failure"); },
    onRuntimeStartupCleanup: promise => { cleanup = promise; },
  })).rejects.toThrow("late composition failure");
  await cleanup;
  expect(failed.runtime.close).toHaveBeenCalledOnce();
});

test("resume is exact-group/version checked and not-sent reconciliation is audited without sending", async () => {
  const h = fixture(), app = await createApp(h.runtime);
  const request = { method: "POST" as const, url: "/internal/proactive-discussion/issues/i1/resume", headers };
  expect((await app.inject({ ...request, payload: { chatId: "other", expectedVersion: 1 } })).statusCode).toBe(400);
  expect((await app.inject({ ...request, payload: { chatId: PD_PILOT_CHAT, expectedVersion: 1 } })).statusCode).toBe(200);
  expect(h.control.repository.resumeByOperator).toHaveBeenCalledWith({ chatId: PD_PILOT_CHAT, issueId: "i1", expectedVersion: 1, operatorId: "internal-api:operations", at: expect.any(Date) });
  expect((await app.inject({ method: "POST", url: "/internal/proactive-discussion/reconcile", headers,
    payload: { deliveryId: "d1", expectedVersion: 2, outcome: "not_sent" } })).statusCode).toBe(200);
  expect(h.control.verifySentReceipt).not.toHaveBeenCalled();
  expect(h.reconcile).toHaveBeenCalledWith(expect.objectContaining({ outcome: "not_sent", operatorId: "internal-api:operations", evidence: "operator_declared_not_sent" }));
});

test("unconfigured bearer does not expose protected bodies or accept policy writes", async () => {
  vi.stubEnv("IRIS_INTERNAL_API_TOKEN", "");
  const h = fixture(), app = await createApp(h.runtime, { internalApiToken: "" });
  expect((await app.inject({ url: "/internal/proactive-discussion/deliveries/d1" })).statusCode).toBe(503);
  expect((await app.inject({ method: "PUT", url: "/internal/proactive-discussion/policy", payload: policy })).statusCode).toBe(503);
  expect(h.setPolicy).not.toHaveBeenCalled();
});
