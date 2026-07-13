import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import {
  RuntimeControlInputError,
  type RuntimeControlService,
  type RuntimeControlStatus,
} from "../src/admin/runtime-control-service.js";
import {
  RuntimeController,
  type RuntimeControllerSnapshot,
} from "../src/admin/runtime-controller.js";
import { InMemoryAuditLog, type AuditEvent } from "../src/audit/audit-log.js";
import { createDefaultRuntimeConfig } from "../src/config/runtime-config.js";
import { InMemoryEventQueue } from "../src/queues/in-memory-event-queue.js";
import { isolateEnvVar } from "./test-env.js";

let restoreInternalApiToken: () => void = () => undefined;

beforeEach(() => {
  restoreInternalApiToken = isolateEnvVar("IRIS_INTERNAL_API_TOKEN");
});

afterEach(() => {
  restoreInternalApiToken();
});

describe("runtime control API", () => {
  it("returns runtime control status", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/runtime-control/status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      globalEnabled: true,
      desiredGlobalEnabled: true,
      activationRequired: false,
      disabledGroupIds: [],
      capabilities: {
        readGroupContext: true,
        replyWhenMentioned: true,
        readGroupDocuments: true,
        retrieveKnowledgeBase: true,
        proactiveSpeech: true,
        generateKnowledgeDrafts: true,
        writeKnowledgeBase: false,
        callExternalTools: false,
      },
      revision: 0,
      updatedAt: expect.any(String),
      persistence: {
        storage: "in_memory",
        ok: true,
      },
    });
  });

  it("returns degraded durable status with the live gate over HTTP 200", async () => {
    const getStatus = vi.fn(async () => runtimeControlStatus({
      globalEnabled: false,
      desiredGlobalEnabled: true,
      activationRequired: true,
      persistence: {
        storage: "postgres",
        ok: false,
        error: "runtime_control_persistence_failed",
      },
    }));
    const app = buildApp({
      runtimeControl: pairedRuntimeControl(
        createRuntimeControlServiceStub({ getStatus }),
      ),
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/runtime-control/status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      globalEnabled: false,
      desiredGlobalEnabled: true,
      activationRequired: true,
      persistence: {
        storage: "postgres",
        ok: false,
        error: "runtime_control_persistence_failed",
      },
    });
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it("keeps disabled runtime control operationally enabled and degraded on persistence failure", async () => {
    const status = runtimeControlStatus({
      globalEnabled: false,
      desiredGlobalEnabled: false,
      activationRequired: false,
      persistence: {
        storage: "postgres",
        ok: false,
        error: "runtime_control_persistence_failed",
      },
    });
    const controller = runtimeControllerFromStatus(status);
    const app = buildApp({
      runtimeControl: pairedRuntimeControl(
        createRuntimeControlServiceStub({ getStatus: vi.fn(async () => status) }),
        controller,
      ),
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const response = await app.inject({ method: "GET", url: "/internal/status" });

    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(false);
    expect(response.json().components.runtimeControl).toEqual({
      status: "degraded",
      ok: false,
      enabled: false,
      globalEnabled: false,
      desiredGlobalEnabled: false,
      activationRequired: false,
      disabledGroupIds: [],
      disabledGroupCount: 0,
      capabilities: status.capabilities,
      revision: 7,
      updatedAt: "2026-07-13T07:30:00.000Z",
      persistence: {
        storage: "postgres",
        ok: false,
        error: "runtime_control_persistence_failed",
      },
      degradedReason: "runtime_control_persistence_failed",
    });
  });

  it("uses one paired controller for Feishu and answer gates", async () => {
    const controller = new RuntimeController(createDefaultRuntimeConfig());
    controller.disableGlobal();
    const queue = new InMemoryEventQueue();
    const answerDraftOrchestrator = {
      generateDraft: vi.fn(async () => ({
        answerText: "must not run",
        promptContext: "",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
      })),
    };
    const app = buildApp({
      queue,
      answerDraftOrchestrator,
      runtimeControl: pairedRuntimeControl(
        createRuntimeControlServiceStub(),
        controller,
      ),
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const answer = await app.inject({
      method: "POST",
      url: "/internal/answer-drafts",
      payload: { question: "Should this run?", liveChatMessages: [] },
    });
    await app.inject({
      method: "POST",
      url: "/feishu/events",
      payload: feishuMessagePayload("paired-disabled", "chat-a"),
    });
    await flushDeferredEnqueue();

    expect(answer.statusCode).toBe(403);
    expect(answer.json()).toEqual({ ok: false, error: "iris_runtime_disabled" });
    expect(answerDraftOrchestrator.generateDraft).not.toHaveBeenCalled();
    expect(queue.events).toEqual([]);
  });

  it("rejects ambiguous paired and legacy controller injection", () => {
    const pairedController = new RuntimeController(createDefaultRuntimeConfig());

    expect(() => buildApp({
      runtimeControl: pairedRuntimeControl(
        createRuntimeControlServiceStub(),
        pairedController,
      ),
      runtimeController: new RuntimeController(createDefaultRuntimeConfig()),
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    })).toThrow("runtimeControl cannot be combined with runtimeController");
  });

  it("sanitizes rejected status reads into safe dedicated and aggregate degradation", async () => {
    const secret = "postgres://admin:super-secret@db.internal/iris";
    const controller = new RuntimeController(createDefaultRuntimeConfig());
    controller.disableGlobal();
    const getStatus = vi.fn(async () => {
      throw new Error(`connection failed for ${secret}`);
    });
    const app = buildApp({
      runtimeControl: pairedRuntimeControl(
        createRuntimeControlServiceStub({ getStatus }),
        controller,
      ),
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const dedicated = await app.inject({
      method: "GET",
      url: "/internal/runtime-control/status",
    });
    const aggregate = await app.inject({ method: "GET", url: "/internal/status" });

    expect(dedicated.statusCode).toBe(200);
    expect(dedicated.json()).toMatchObject({
      ok: true,
      globalEnabled: false,
      persistence: {
        storage: "postgres",
        ok: false,
        error: "runtime_control_persistence_failed",
      },
    });
    expect(aggregate.statusCode).toBe(200);
    expect(aggregate.json()).toMatchObject({
      ok: false,
      components: {
        runtimeControl: {
          status: "degraded",
          enabled: false,
          globalEnabled: false,
          degradedReason: "runtime_control_persistence_failed",
        },
      },
    });
    expect(dedicated.body).not.toContain(secret);
    expect(aggregate.body).not.toContain(secret);
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it("sanitizes status storage mismatch using the service storage authority", async () => {
    const secret = "postgres://reader:storage-secret@db.internal/iris";
    const controller = new RuntimeController(createDefaultRuntimeConfig());
    controller.disableGlobal();
    const getStatus = vi.fn(async () => runtimeControlStatus({
      persistence: {
        storage: secret as never,
        ok: true,
      },
    }));
    const app = buildApp({
      runtimeControl: pairedRuntimeControl(
        createRuntimeControlServiceStub({ getStatus }),
        controller,
      ),
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const dedicated = await app.inject({
      method: "GET",
      url: "/internal/runtime-control/status",
    });
    const aggregate = await app.inject({ method: "GET", url: "/internal/status" });

    expect(dedicated.statusCode).toBe(200);
    expect(dedicated.json()).toMatchObject({
      ok: true,
      globalEnabled: false,
      persistence: {
        storage: "postgres",
        ok: false,
        error: "runtime_control_persistence_failed",
      },
    });
    expect(aggregate.statusCode).toBe(200);
    expect(aggregate.json()).toMatchObject({
      ok: false,
      components: {
        runtimeControl: {
          status: "degraded",
          enabled: false,
          globalEnabled: false,
          persistence: {
            storage: "postgres",
            ok: false,
            error: "runtime_control_persistence_failed",
          },
        },
      },
    });
    expect(dedicated.body).not.toContain(secret);
    expect(aggregate.body).not.toContain(secret);
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it("globally disables and re-enables Feishu event ingestion", async () => {
    const queue = new InMemoryEventQueue();
    const app = buildApp({
      queue,
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const disableResponse = await app.inject({
      method: "POST",
      url: "/internal/runtime-control/global",
      payload: { enabled: false },
    });

    expect(disableResponse.statusCode).toBe(200);
    expect(disableResponse.json()).toMatchObject({
      ok: true,
      durable: true,
      globalEnabled: false,
    });

    const disabledCallback = await app.inject({
      method: "POST",
      url: "/feishu/events",
      payload: feishuMessagePayload("event-disabled", "chat-a"),
    });

    expect(disabledCallback.statusCode).toBe(200);
    expect(disabledCallback.json()).toEqual({ ok: true });
    expect(queue.events).toEqual([]);

    const enableResponse = await app.inject({
      method: "POST",
      url: "/internal/runtime-control/global",
      payload: { enabled: true },
    });

    expect(enableResponse.statusCode).toBe(200);
    expect(enableResponse.json()).toMatchObject({
      ok: true,
      durable: true,
      globalEnabled: true,
    });

    const enabledCallback = await app.inject({
      method: "POST",
      url: "/feishu/events",
      payload: feishuMessagePayload("event-enabled", "chat-a"),
    });

    expect(enabledCallback.statusCode).toBe(200);
    expect(enabledCallback.json()).toEqual({ ok: true });
    expect(queue.events).toHaveLength(0);

    await flushDeferredEnqueue();

    expect(queue.events).toHaveLength(1);
    expect(queue.events[0]?.idempotencyKey).toBe("event-enabled");
  });

  it("maps ordinary mutation conflicts to HTTP 409 without auditing success", async () => {
    const auditLog = new InMemoryAuditLog();
    const setGlobal = vi.fn(async () => ({ kind: "conflict" as const }));
    const app = buildApp({
      auditLog,
      runtimeControl: pairedRuntimeControl(
        createRuntimeControlServiceStub({ setGlobal }),
      ),
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/runtime-control/global",
      payload: { enabled: true },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      ok: false,
      error: "runtime_control_conflict",
    });
    expect(auditLog.events).toEqual([]);
  });

  it("maps ordinary persistence failure to HTTP 503 without changing live state or auditing", async () => {
    const runtimeController = new RuntimeController(createDefaultRuntimeConfig());
    const auditLog = new InMemoryAuditLog();
    const setGroup = vi.fn(async () => ({ kind: "persistence_failed" as const }));
    const app = buildApp({
      auditLog,
      runtimeControl: pairedRuntimeControl(
        createRuntimeControlServiceStub({ setGroup }),
        runtimeController,
      ),
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/runtime-control/groups/chat-a",
      payload: { enabled: false },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      ok: false,
      error: "runtime_control_persistence_failed",
    });
    expect(runtimeController.getSnapshot().disabledGroupIds).toEqual([]);
    expect(auditLog.events).toEqual([]);
  });

  it("keeps emergency disable closed and audits the actual stop when persistence fails", async () => {
    const runtimeController = new RuntimeController(createDefaultRuntimeConfig());
    const auditLog = new InMemoryAuditLog();
    const previousSnapshot = runtimeController.getSnapshot();
    const setGlobal = vi.fn(async () => {
      runtimeController.disableGlobal();
      return {
        kind: "disable_not_persisted" as const,
        previousSnapshot,
        status: runtimeControlStatus({
          globalEnabled: false,
          desiredGlobalEnabled: true,
          activationRequired: true,
          persistence: {
            storage: "postgres",
            ok: false,
            error: "runtime_control_persistence_failed",
          },
        }),
      };
    });
    const app = buildApp({
      auditLog,
      runtimeControl: pairedRuntimeControl(
        createRuntimeControlServiceStub({ setGlobal }),
        runtimeController,
      ),
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/runtime-control/global",
      payload: { enabled: false },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      ok: false,
      error: "runtime_control_disable_not_persisted",
      globalEnabled: false,
      durable: false,
    });
    expect(runtimeController.getSnapshot().globalEnabled).toBe(false);
    expect(auditLog.events).toHaveLength(1);
    expect(auditLog.events[0]).toMatchObject({
      type: "runtime_control_updated",
      runtimeControlScope: "global",
      enabled: false,
      previousEnabled: true,
    });
  });

  it("maps service input errors to invalid_request instead of a persistence outage", async () => {
    const auditLog = new InMemoryAuditLog();
    const setCapabilities = vi.fn(async () => {
      throw new RuntimeControlInputError("capabilities");
    });
    const app = buildApp({
      auditLog,
      runtimeControl: pairedRuntimeControl(
        createRuntimeControlServiceStub({ setCapabilities }),
      ),
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/internal/runtime-control/capabilities",
      payload: { proactiveSpeech: false },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
    expect(auditLog.events).toEqual([]);
  });

  it("sanitizes unexpected mutation rejection as persistence failure", async () => {
    const secret = "postgres://operator:bad-password@db.internal/iris";
    const auditLog = new InMemoryAuditLog();
    const setGroup = vi.fn(async () => {
      throw new Error(`write failed for ${secret}`);
    });
    const controller = new RuntimeController(createDefaultRuntimeConfig());
    const app = buildApp({
      auditLog,
      runtimeControl: pairedRuntimeControl(
        createRuntimeControlServiceStub({ setGroup }),
        controller,
      ),
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/runtime-control/groups/chat-a",
      payload: { enabled: false },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      ok: false,
      error: "runtime_control_persistence_failed",
    });
    expect(response.body).not.toContain(secret);
    expect(auditLog.events).toEqual([]);
  });

  it("does not expose ordinary success when status storage mismatches the service", async () => {
    const secret = "postgres://writer:storage-secret@db.internal/iris";
    const auditLog = new InMemoryAuditLog();
    const controller = new RuntimeController(createDefaultRuntimeConfig());
    const setGroup = vi.fn(async () => ({
      kind: "success" as const,
      durable: true as const,
      previousSnapshot: runtimeControllerSnapshot(),
      status: runtimeControlStatus({
        disabledGroupIds: ["chat-a"],
        persistence: {
          storage: secret as never,
          ok: true,
        },
      }),
    }));
    const app = buildApp({
      auditLog,
      runtimeControl: pairedRuntimeControl(
        createRuntimeControlServiceStub({ setGroup }),
        controller,
      ),
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/runtime-control/groups/chat-a",
      payload: { enabled: false },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      ok: false,
      error: "runtime_control_persistence_failed",
    });
    expect(response.body).not.toContain(secret);
    expect(auditLog.events).toEqual([]);
  });

  it("keeps emergency disable fail-closed when success storage mismatches", async () => {
    const secret = "postgres://writer:disable-secret@db.internal/iris";
    const auditLog = new InMemoryAuditLog();
    const controller = new RuntimeController(createDefaultRuntimeConfig());
    const previousSnapshot = controller.getSnapshot();
    const setGlobal = vi.fn(async () => {
      controller.disableGlobal();
      return {
        kind: "success" as const,
        durable: true as const,
        previousSnapshot,
        status: runtimeControlStatus({
          globalEnabled: false,
          desiredGlobalEnabled: false,
          persistence: {
            storage: secret as never,
            ok: true,
          },
        }),
      };
    });
    const app = buildApp({
      auditLog,
      runtimeControl: pairedRuntimeControl(
        createRuntimeControlServiceStub({ setGlobal }),
        controller,
      ),
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/runtime-control/global",
      payload: { enabled: false },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      ok: false,
      error: "runtime_control_disable_not_persisted",
      globalEnabled: false,
      durable: false,
    });
    expect(response.body).not.toContain(secret);
    expect(controller.getSnapshot().globalEnabled).toBe(false);
    expect(auditLog.events).toHaveLength(1);
    expect(auditLog.events[0]).toMatchObject({
      type: "runtime_control_updated",
      runtimeControlScope: "global",
      enabled: false,
      previousEnabled: true,
    });
  });

  it("uses the mutation before-state and requested value for concurrent audit data", async () => {
    const auditLog = new InMemoryAuditLog();
    const controller = new RuntimeController(createDefaultRuntimeConfig());
    const previousSnapshot = runtimeControllerSnapshot({
      globalEnabled: false,
      desiredGlobalEnabled: true,
      activationRequired: true,
      revision: 6,
    });
    const setGlobal = vi.fn(async () => ({
      kind: "success" as const,
      durable: true as const,
      previousSnapshot,
      status: runtimeControlStatus({
        globalEnabled: false,
        desiredGlobalEnabled: true,
        activationRequired: true,
        revision: 8,
      }),
    }));
    const app = buildApp({
      auditLog,
      runtimeControl: pairedRuntimeControl(
        createRuntimeControlServiceStub({ setGlobal }),
        controller,
      ),
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/runtime-control/global",
      payload: { enabled: true },
    });

    expect(response.statusCode).toBe(200);
    expect(setGlobal).toHaveBeenCalledTimes(1);
    expect(auditLog.events).toHaveLength(1);
    expect(auditLog.events[0]).toMatchObject({
      type: "runtime_control_updated",
      runtimeControlScope: "global",
      enabled: true,
      previousEnabled: false,
    });
  });

  it("does not let service status override reserved success response fields", async () => {
    const controller = new RuntimeController(createDefaultRuntimeConfig());
    const status = Object.assign(runtimeControlStatus(), {
      ok: false,
      durable: false,
    }) as RuntimeControlStatus;
    const setGlobal = vi.fn(async () => ({
      kind: "success" as const,
      durable: true as const,
      previousSnapshot: runtimeControllerSnapshot(),
      status,
    }));
    const app = buildApp({
      runtimeControl: pairedRuntimeControl(
        createRuntimeControlServiceStub({ setGlobal }),
        controller,
      ),
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/runtime-control/global",
      payload: { enabled: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      durable: true,
      revision: 7,
    });
    expect(setGlobal).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "blank", value: "   " },
    { label: "overlength", value: "x".repeat(121) },
    { label: "newline", value: "alice\nbob" },
    { label: "non-string", value: 42 },
    { label: "array", value: ["alice", "bob"] },
  ])("rejects $label operator header before service or audit", async ({ value }) => {
    const auditLog = new InMemoryAuditLog();
    const setGlobal = vi.fn(async () => ({ kind: "conflict" as const }));
    const controller = new RuntimeController(createDefaultRuntimeConfig());
    const app = buildApp({
      auditLog,
      runtimeControl: pairedRuntimeControl(
        createRuntimeControlServiceStub({ setGlobal }),
        controller,
      ),
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });
    app.addHook("preValidation", async (request) => {
      (request.headers as Record<string, unknown>)["x-iris-operator"] = value;
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/runtime-control/global",
      payload: { enabled: true },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
    expect(setGlobal).not.toHaveBeenCalled();
    expect(auditLog.events).toEqual([]);
  });

  it("trims a valid bounded operator header before calling the service", async () => {
    const controller = new RuntimeController(createDefaultRuntimeConfig());
    const setGlobal = vi.fn(async () => ({ kind: "conflict" as const }));
    const app = buildApp({
      runtimeControl: pairedRuntimeControl(
        createRuntimeControlServiceStub({ setGlobal }),
        controller,
      ),
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/runtime-control/global",
      headers: { "x-iris-operator": " alice@example.com " },
      payload: { enabled: true },
    });

    expect(response.statusCode).toBe(409);
    expect(setGlobal).toHaveBeenCalledWith({
      enabled: true,
      updatedBy: "alice@example.com",
    });
  });

  it("surfaces global runtime disablement in consolidated status", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    await app.inject({
      method: "POST",
      url: "/internal/runtime-control/global",
      payload: { enabled: false },
    });

    const status = await app.inject({
      method: "GET",
      url: "/internal/status",
    });

    expect(status.statusCode).toBe(200);
    expect(status.json().components.runtimeControl).toEqual({
      status: "disabled",
      ok: true,
      enabled: false,
      globalEnabled: false,
      desiredGlobalEnabled: false,
      activationRequired: false,
      disabledGroupIds: [],
      disabledGroupCount: 0,
      capabilities: {
        readGroupContext: true,
        replyWhenMentioned: true,
        readGroupDocuments: true,
        retrieveKnowledgeBase: true,
        proactiveSpeech: true,
        generateKnowledgeDrafts: true,
        writeKnowledgeBase: false,
        callExternalTools: false,
      },
      revision: 1,
      updatedAt: expect.any(String),
      persistence: {
        storage: "in_memory",
        ok: true,
      },
    });
    expect(status.json().summary.attentionComponents).toContainEqual({
      name: "runtimeControl",
      status: "disabled",
    });
  });

  it("disables and re-enables Feishu event ingestion for one group", async () => {
    const queue = new InMemoryEventQueue();
    const app = buildApp({
      queue,
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const disableResponse = await app.inject({
      method: "POST",
      url: "/internal/runtime-control/groups/%20chat-a%20",
      payload: { enabled: false },
    });

    expect(disableResponse.statusCode).toBe(200);
    expect(disableResponse.json()).toMatchObject({
      ok: true,
      durable: true,
      disabledGroupIds: ["chat-a"],
    });

    await app.inject({
      method: "POST",
      url: "/feishu/events",
      payload: feishuMessagePayload("event-disabled-group", "chat-a"),
    });
    await app.inject({
      method: "POST",
      url: "/feishu/events",
      payload: feishuMessagePayload("event-enabled-group", "chat-b"),
    });
    await flushDeferredEnqueue();

    expect(queue.events).toHaveLength(1);
    expect(queue.events[0]?.idempotencyKey).toBe("event-enabled-group");

    const enableResponse = await app.inject({
      method: "POST",
      url: "/internal/runtime-control/groups/chat-a",
      payload: { enabled: true },
    });

    expect(enableResponse.statusCode).toBe(200);
    expect(enableResponse.json()).toMatchObject({
      ok: true,
      durable: true,
      disabledGroupIds: [],
    });

    await app.inject({
      method: "POST",
      url: "/feishu/events",
      payload: feishuMessagePayload("event-reenabled-group", "chat-a"),
    });
    await flushDeferredEnqueue();

    expect(queue.events).toHaveLength(2);
    expect(queue.events[1]?.idempotencyKey).toBe("event-reenabled-group");
  });

  it("rejects invalid runtime control requests", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const invalidGlobal = await app.inject({
      method: "POST",
      url: "/internal/runtime-control/global",
      payload: { enabled: "false" },
    });
    const invalidGroup = await app.inject({
      method: "POST",
      url: "/internal/runtime-control/groups/%20",
      payload: { enabled: true },
    });

    expect(invalidGlobal.statusCode).toBe(400);
    expect(invalidGlobal.json()).toEqual({ ok: false, error: "invalid_request" });
    expect(invalidGroup.statusCode).toBe(400);
    expect(invalidGroup.json()).toEqual({ ok: false, error: "invalid_request" });
  });

  it("blocks answer draft generation while Iris is globally disabled", async () => {
    const answerDraftOrchestrator = {
      generateDraft: vi.fn(async () => ({
        answerText: "Draft answer.",
        promptContext: "",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
      })),
    };
    const app = buildApp({
      answerDraftOrchestrator,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    await app.inject({
      method: "POST",
      url: "/internal/runtime-control/global",
      payload: { enabled: false },
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/answer-drafts",
      payload: {
        question: "What changed?",
        liveChatMessages: [],
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ ok: false, error: "iris_runtime_disabled" });
    expect(answerDraftOrchestrator.generateDraft).not.toHaveBeenCalled();
  });

  it("blocks answer draft generation for disabled groups only", async () => {
    const answerDraftOrchestrator = {
      generateDraft: vi.fn(async () => ({
        answerText: "Draft answer.",
        promptContext: "",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
      })),
    };
    const app = buildApp({
      answerDraftOrchestrator,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    await app.inject({
      method: "POST",
      url: "/internal/runtime-control/groups/chat-a",
      payload: { enabled: false },
    });

    const disabledResponse = await app.inject({
      method: "POST",
      url: "/internal/answer-drafts",
      payload: {
        question: "What changed?",
        chatId: "chat-a",
        liveChatMessages: [],
      },
    });
    const enabledResponse = await app.inject({
      method: "POST",
      url: "/internal/answer-drafts",
      payload: {
        question: "What changed?",
        chatId: "chat-b",
        liveChatMessages: [],
      },
    });

    expect(disabledResponse.statusCode).toBe(403);
    expect(disabledResponse.json()).toEqual({ ok: false, error: "iris_runtime_disabled" });
    expect(enabledResponse.statusCode).toBe(200);
    expect(enabledResponse.json()).toMatchObject({ answerText: "Draft answer." });
    expect(answerDraftOrchestrator.generateDraft).toHaveBeenCalledTimes(1);
    expect(answerDraftOrchestrator.generateDraft).toHaveBeenCalledWith({
      question: "What changed?",
      chatId: "chat-b",
      liveChatMessages: [],
    });
  });

  it("updates runtime capabilities", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/internal/runtime-control/capabilities",
      payload: {
        proactiveSpeech: false,
        writeKnowledgeBase: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      durable: true,
      capabilities: {
        proactiveSpeech: false,
        writeKnowledgeBase: true,
      },
    });

    const status = await app.inject({
      method: "GET",
      url: "/internal/runtime-control/status",
    });

    expect(status.json()).toMatchObject({
      capabilities: {
        proactiveSpeech: false,
        writeKnowledgeBase: true,
      },
    });
  });

  it("persists capability updates once and audits only requested keys", async () => {
    const auditLog = new InMemoryAuditLog();
    const setCapabilities = vi.fn(async () => ({
      kind: "success" as const,
      durable: true as const,
      previousSnapshot: runtimeControllerSnapshot(),
      status: runtimeControlStatus({
        capabilities: {
          ...runtimeControlStatus().capabilities,
          proactiveSpeech: false,
          writeKnowledgeBase: true,
          callExternalTools: true,
        },
      }),
    }));
    const app = buildApp({
      auditLog,
      runtimeControl: pairedRuntimeControl(
        createRuntimeControlServiceStub({ setCapabilities }),
      ),
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/internal/runtime-control/capabilities",
      headers: { "x-iris-operator": "alice@example.com" },
      payload: {
        proactiveSpeech: false,
        writeKnowledgeBase: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(setCapabilities).toHaveBeenCalledTimes(1);
    expect(setCapabilities).toHaveBeenCalledWith({
      updates: {
        proactiveSpeech: false,
        writeKnowledgeBase: true,
      },
      updatedBy: "alice@example.com",
    });
    expect(auditLog.events.map((event) =>
      event.type === "runtime_control_updated" ? event.targetId : undefined,
    )).toEqual([
      "proactiveSpeech",
      "writeKnowledgeBase",
    ]);
  });

  it("degrades aggregate status after exactly one failed persistence read", async () => {
    const getStatus = vi.fn(async () => runtimeControlStatus({
      persistence: {
        storage: "postgres",
        ok: false,
        error: "runtime_control_persistence_failed",
      },
    }));
    const app = buildApp({
      runtimeControl: pairedRuntimeControl(
        createRuntimeControlServiceStub({ getStatus }),
      ),
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
      now: () => new Date("2026-07-13T08:00:00.000Z"),
    });

    const response = await app.inject({ method: "GET", url: "/internal/status" });

    expect(response.statusCode).toBe(200);
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(response.json()).toMatchObject({
      ok: false,
      status: "degraded",
      summary: {
        degradedComponents: ["runtimeControl"],
      },
      components: {
        runtimeControl: {
          status: "degraded",
          ok: false,
          enabled: true,
          globalEnabled: true,
          desiredGlobalEnabled: true,
          activationRequired: false,
          revision: 7,
          updatedAt: "2026-07-13T07:30:00.000Z",
          persistence: {
            storage: "postgres",
            ok: false,
            error: "runtime_control_persistence_failed",
          },
          degradedReason: "runtime_control_persistence_failed",
        },
      },
    });
  });

  it("records successful runtime control changes in the audit log", async () => {
    const recordedAt = new Date("2026-07-04T06:20:00.000Z");
    const auditLog = new InMemoryAuditLog({ now: () => recordedAt });
    const app = buildApp({
      auditLog,
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    await app.inject({
      method: "POST",
      url: "/internal/runtime-control/global",
      payload: { enabled: false },
    });
    await app.inject({
      method: "POST",
      url: "/internal/runtime-control/groups/chat-a",
      payload: { enabled: false },
    });
    await app.inject({
      method: "PATCH",
      url: "/internal/runtime-control/capabilities",
      payload: {
        proactiveSpeech: false,
        writeKnowledgeBase: true,
      },
    });

    const events = await app.inject({
      method: "GET",
      url: "/internal/audit/events?limit=20&type=runtime_control_updated",
    });

    expect(events.statusCode).toBe(200);
    expect(events.json().events).toEqual([
      {
        type: "runtime_control_updated",
        documentId: "runtime-control",
        fragmentIds: [],
        runtimeControlScope: "capability",
        targetId: "writeKnowledgeBase",
        enabled: true,
        previousEnabled: false,
        recordedAt: "2026-07-04T06:20:00.000Z",
      },
      {
        type: "runtime_control_updated",
        documentId: "runtime-control",
        fragmentIds: [],
        runtimeControlScope: "capability",
        targetId: "proactiveSpeech",
        enabled: false,
        previousEnabled: true,
        recordedAt: "2026-07-04T06:20:00.000Z",
      },
      {
        type: "runtime_control_updated",
        documentId: "runtime-control",
        fragmentIds: [],
        runtimeControlScope: "group",
        targetId: "chat-a",
        enabled: false,
        previousEnabled: true,
        recordedAt: "2026-07-04T06:20:00.000Z",
      },
      {
        type: "runtime_control_updated",
        documentId: "runtime-control",
        fragmentIds: [],
        runtimeControlScope: "global",
        enabled: false,
        previousEnabled: true,
        recordedAt: "2026-07-04T06:20:00.000Z",
      },
    ]);
  });

  it("keeps runtime control mutations available when audit logging fails", async () => {
    class FailingAuditLog extends InMemoryAuditLog {
      override async record(_event: AuditEvent): Promise<void> {
        throw new Error("audit sink unavailable");
      }
    }

    const app = buildApp({
      auditLog: new FailingAuditLog(),
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/runtime-control/global",
      payload: { enabled: false },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      globalEnabled: false,
    });
  });

  it("records an optional operator hint on runtime control audit events", async () => {
    const recordedAt = new Date("2026-07-04T06:25:00.000Z");
    const auditLog = new InMemoryAuditLog({ now: () => recordedAt });
    const app = buildApp({
      auditLog,
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    await app.inject({
      method: "POST",
      url: "/internal/runtime-control/global",
      headers: {
        "x-iris-operator": " alice@example.com ",
      },
      payload: { enabled: false },
    });

    const events = await app.inject({
      method: "GET",
      url: "/internal/audit/events?limit=1&type=runtime_control_updated",
    });

    expect(events.statusCode).toBe(200);
    expect(events.json().events).toEqual([
      {
        type: "runtime_control_updated",
        documentId: "runtime-control",
        fragmentIds: [],
        runtimeControlScope: "global",
        enabled: false,
        previousEnabled: true,
        operatorHint: "alice@example.com",
        recordedAt: "2026-07-04T06:25:00.000Z",
      },
    ]);
  });

  it("filters runtime control audit events by operator hint", async () => {
    const auditLog = new InMemoryAuditLog();
    const app = buildApp({
      auditLog,
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    await app.inject({
      method: "POST",
      url: "/internal/runtime-control/global",
      headers: {
        "x-iris-operator": "alice@example.com",
      },
      payload: { enabled: false },
    });
    await app.inject({
      method: "POST",
      url: "/internal/runtime-control/global",
      headers: {
        "x-iris-operator": "bob@example.com",
      },
      payload: { enabled: true },
    });

    const events = await app.inject({
      method: "GET",
      url: "/internal/audit/events?limit=20&type=runtime_control_updated&operatorHint=alice%40example.com",
    });

    expect(events.statusCode).toBe(200);
    expect(events.json().meta.filters).toEqual({
      type: "runtime_control_updated",
      operatorHint: "alice@example.com",
    });
    expect(events.json().events).toHaveLength(1);
    expect(events.json().events[0]).toMatchObject({
      type: "runtime_control_updated",
      operatorHint: "alice@example.com",
      enabled: false,
    });
  });

  it("rejects invalid runtime capability updates", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const unknownCapability = await app.inject({
      method: "PATCH",
      url: "/internal/runtime-control/capabilities",
      payload: { unknownCapability: true },
    });
    const nonBooleanCapability = await app.inject({
      method: "PATCH",
      url: "/internal/runtime-control/capabilities",
      payload: { proactiveSpeech: "false" },
    });
    const emptyUpdate = await app.inject({
      method: "PATCH",
      url: "/internal/runtime-control/capabilities",
      payload: {},
    });

    expect(unknownCapability.statusCode).toBe(400);
    expect(unknownCapability.json()).toEqual({ ok: false, error: "invalid_request" });
    expect(nonBooleanCapability.statusCode).toBe(400);
    expect(nonBooleanCapability.json()).toEqual({ ok: false, error: "invalid_request" });
    expect(emptyUpdate.statusCode).toBe(400);
    expect(emptyUpdate.json()).toEqual({ ok: false, error: "invalid_request" });
  });

  it("blocks answer draft generation when reply capability is disabled", async () => {
    const answerDraftOrchestrator = {
      generateDraft: vi.fn(async () => ({
        answerText: "Draft answer.",
        promptContext: "",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
      })),
    };
    const app = buildApp({
      answerDraftOrchestrator,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    await app.inject({
      method: "PATCH",
      url: "/internal/runtime-control/capabilities",
      payload: { replyWhenMentioned: false },
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/answer-drafts",
      payload: {
        question: "What changed?",
        chatId: "chat-a",
        liveChatMessages: [],
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ ok: false, error: "iris_runtime_disabled" });
    expect(answerDraftOrchestrator.generateDraft).not.toHaveBeenCalled();
  });
});

function feishuMessagePayload(eventId: string, chatId: string) {
  return {
    header: {
      event_id: eventId,
      event_type: "im.message.receive_v1",
    },
    event: {
      message: {
        message_id: `${eventId}-message`,
        chat_id: chatId,
        message_type: "text",
        content: "{\"text\":\"hello\"}",
      },
    },
  };
}

async function flushDeferredEnqueue(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  await Promise.resolve();
}

function createRuntimeControlServiceStub(
  overrides: Partial<RuntimeControlService> = {},
): RuntimeControlService {
  const status = runtimeControlStatus();
  const previousSnapshot = runtimeControllerSnapshot();
  return {
    persistenceStorage: "postgres" as const,
    getStatus: vi.fn(async () => status),
    setGlobal: vi.fn(async () => ({
      kind: "success" as const,
      durable: true as const,
      previousSnapshot,
      status,
    })),
    setGroup: vi.fn(async () => ({
      kind: "success" as const,
      durable: true as const,
      previousSnapshot,
      status,
    })),
    setCapabilities: vi.fn(async () => ({
      kind: "success" as const,
      durable: true as const,
      previousSnapshot,
      status,
    })),
    ...overrides,
  };
}

function runtimeControlStatus(
  overrides: Partial<RuntimeControlStatus> = {},
): RuntimeControlStatus {
  return {
    globalEnabled: true,
    desiredGlobalEnabled: true,
    activationRequired: false,
    disabledGroupIds: [],
    capabilities: {
      readGroupContext: true,
      replyWhenMentioned: true,
      readGroupDocuments: true,
      retrieveKnowledgeBase: true,
      proactiveSpeech: true,
      generateKnowledgeDrafts: true,
      writeKnowledgeBase: false,
      callExternalTools: false,
    },
    revision: 7,
    updatedAt: new Date("2026-07-13T07:30:00.000Z"),
    persistence: {
      storage: "postgres",
      ok: true,
    },
    ...overrides,
  };
}

function runtimeControllerSnapshot(
  overrides: Partial<RuntimeControllerSnapshot> = {},
): RuntimeControllerSnapshot {
  const { persistence: _persistence, ...snapshot } = runtimeControlStatus();
  return { ...snapshot, ...overrides };
}

function runtimeControllerFromStatus(status: RuntimeControlStatus): RuntimeController {
  const config = createDefaultRuntimeConfig();
  config.globalEnabled = status.globalEnabled;
  const controller = new RuntimeController(config);
  controller.replaceDurablePolicy({
    desiredGlobalEnabled: status.desiredGlobalEnabled,
    disabledGroupIds: status.disabledGroupIds,
    capabilities: status.capabilities,
    revision: status.revision,
    updatedAt: status.updatedAt,
    ...(status.updatedBy === undefined ? {} : { updatedBy: status.updatedBy }),
  });
  return controller;
}

function pairedRuntimeControl(
  service: RuntimeControlService,
  controller = new RuntimeController(createDefaultRuntimeConfig()),
) {
  return {
    controller,
    service,
  };
}
