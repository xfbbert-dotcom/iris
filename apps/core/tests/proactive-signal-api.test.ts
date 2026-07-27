import { describe, expect, it, vi } from "vitest";

import { RuntimeController } from "../src/admin/runtime-controller.js";
import { buildApp } from "../src/app.js";
import { createDefaultRuntimeConfig } from "../src/config/runtime-config.js";
import type { ConversationStateInspectionStore } from "../src/conversation-state/conversation-state-api.js";
import type { ProactiveSignalRepository } from "../src/proactive-signals/proactive-signal-repository.js";

const authorization = { authorization: "Bearer operator-secret" };

describe("proactive signal API", () => {
  it("fails closed when proactive speech is paused for the group", async () => {
    const controller = new RuntimeController(createDefaultRuntimeConfig({}));
    controller.pauseProactiveBehavior();
    const store = createStore();
    const app = createApp({ store, controller });

    const response = await app.inject({
      method: "POST",
      url: "/internal/proactive-signals/groups/group-a/preview",
      headers: authorization,
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ ok: false, error: "proactive_speech_disabled" });
    expect(store.listThreads).not.toHaveBeenCalled();
    expect(store.listActions).not.toHaveBeenCalled();
    await app.close();
  });

  it("previews bounded current-group proactive candidates without sending messages", async () => {
    const store = createStore();
    store.listThreads.mockResolvedValue([
      {
        id: "thread-quiet",
        groupId: "group-a",
        title: "Launch decision",
        summary: "Waiting for a final launch call.",
        status: "open",
        confidence: 0.9,
        version: 2,
        firstEvidenceAt: new Date("2026-07-23T06:00:00.000Z"),
        lastActivityAt: new Date("2026-07-23T07:00:00.000Z"),
        createdAt: new Date("2026-07-23T06:00:00.000Z"),
        updatedAt: new Date("2026-07-23T07:00:00.000Z"),
        evidenceMessageIds: ["message-thread"],
      },
    ]);
    store.listActions.mockResolvedValue([
      {
        id: "action-overdue",
        groupId: "group-a",
        description: "Bob sends the risk note.",
        ownerRefType: "text_label",
        ownerRef: "Bob",
        dueAt: new Date("2026-07-23T08:00:00.000Z"),
        status: "open",
        confidence: 0.9,
        version: 1,
        createdAt: new Date("2026-07-23T06:00:00.000Z"),
        updatedAt: new Date("2026-07-23T07:00:00.000Z"),
        evidenceMessageIds: ["message-action"],
      },
    ]);
    const app = createApp({ store, now: () => new Date("2026-07-23T10:00:00.000Z") });

    const response = await app.inject({
      method: "POST",
      url: "/internal/proactive-signals/groups/group-a/preview",
      headers: authorization,
      payload: { quietThreadAfterMinutes: 60, overdueActionGraceMinutes: 5, limit: 5 },
    });

    expect(response.statusCode).toBe(200);
    expect(store.listThreads).toHaveBeenCalledWith({ groupId: "group-a", limit: 20 });
    expect(store.listActions).toHaveBeenCalledWith({ groupId: "group-a", limit: 20 });
    expect(response.json()).toEqual({
      ok: true,
      groupId: "group-a",
      generatedAt: "2026-07-23T10:00:00.000Z",
      signals: [
        expect.objectContaining({
          kind: "overdue_action",
          entityId: "action-overdue",
          suggestedMode: "ask_for_status",
        }),
        expect.objectContaining({
          kind: "quiet_open_thread",
          entityId: "thread-quiet",
          suggestedMode: "ask_for_thread_update",
        }),
      ],
    });
    expect(response.body).not.toContain("raw message text");
    await app.close();
  });

  it("records previewed candidates through the scan route without sending messages", async () => {
    const store = createStore();
    const repository = {
      recordCandidates: vi.fn<ProactiveSignalRepository["recordCandidates"]>().mockResolvedValue({
        recordedCount: 1,
        existingCount: 0,
        suppressedCount: 0,
        recordedKeys: ["quiet_open_thread:thread-quiet:2"],
      }),
      listPendingCandidates: vi.fn<ProactiveSignalRepository["listPendingCandidates"]>().mockResolvedValue([]),
      dismissCandidate: vi.fn<ProactiveSignalRepository["dismissCandidate"]>().mockResolvedValue({
        status: "not_found",
      }),
      approveCandidateForDelivery: vi.fn<ProactiveSignalRepository["approveCandidateForDelivery"]>().mockResolvedValue({
        status: "not_found",
      }),
    } as unknown as ProactiveSignalRepository;
    store.listThreads.mockResolvedValue([
      {
        id: "thread-quiet",
        groupId: "group-a",
        title: "Launch decision",
        summary: "Waiting for a final launch call.",
        status: "open",
        confidence: 0.9,
        version: 2,
        firstEvidenceAt: new Date("2026-07-23T06:00:00.000Z"),
        lastActivityAt: new Date("2026-07-23T07:00:00.000Z"),
        createdAt: new Date("2026-07-23T06:00:00.000Z"),
        updatedAt: new Date("2026-07-23T07:00:00.000Z"),
        evidenceMessageIds: ["message-thread"],
      },
    ]);
    const app = createApp({ store, proactiveSignalRepository: repository });

    const response = await app.inject({
      method: "POST",
      url: "/internal/proactive-signals/groups/group-a/scan",
      headers: authorization,
      payload: { quietThreadAfterMinutes: 60 },
    });

    expect(response.statusCode).toBe(200);
    expect(repository.recordCandidates).toHaveBeenCalledWith({
      signals: [expect.objectContaining({
        idempotencyKey: "quiet_open_thread:thread-quiet:2",
        kind: "quiet_open_thread",
      })],
      now: new Date("2026-07-23T10:00:00.000Z"),
    });
    expect(response.json()).toEqual({
      ok: true,
      groupId: "group-a",
      generatedAt: "2026-07-23T10:00:00.000Z",
      recordedCount: 1,
      existingCount: 0,
      suppressedCount: 0,
      recordedKeys: ["quiet_open_thread:thread-quiet:2"],
      signals: [expect.objectContaining({ entityId: "thread-quiet" })],
    });
    await app.close();
  });

  it("lists and dismisses pending candidates through authenticated operator routes", async () => {
    const store = createStore();
    const repository = {
      recordCandidates: vi.fn<ProactiveSignalRepository["recordCandidates"]>(),
      listPendingCandidates: vi.fn<ProactiveSignalRepository["listPendingCandidates"]>().mockResolvedValue([
        {
          idempotencyKey: "quiet_open_thread:thread-a:1",
          groupId: "group-a",
          kind: "quiet_open_thread",
          priority: "medium",
          entityType: "thread",
          entityId: "thread-a",
          entityVersion: 1,
          reasonCode: "thread_quiet_threshold_elapsed",
          suggestedMode: "ask_for_thread_update",
          status: "pending",
          lastRelevantAt: new Date("2026-07-23T08:00:00.000Z"),
          createdAt: new Date("2026-07-23T10:00:00.000Z"),
          updatedAt: new Date("2026-07-23T10:00:00.000Z"),
          evidenceMessageIds: ["message-a"],
        },
      ]),
      dismissCandidate: vi.fn<ProactiveSignalRepository["dismissCandidate"]>().mockResolvedValue({
        status: "dismissed",
      }),
      approveCandidateForDelivery: vi.fn<ProactiveSignalRepository["approveCandidateForDelivery"]>().mockResolvedValue({
        status: "queued",
        deliveryId: "delivery-a",
      }),
    } as unknown as ProactiveSignalRepository;
    const app = createApp({ store, proactiveSignalRepository: repository });

    const list = await app.inject({
      method: "GET",
      url: "/internal/proactive-signals/groups/group-a/candidates?limit=5",
      headers: authorization,
    });
    const dismiss = await app.inject({
      method: "POST",
      url: "/internal/proactive-signals/groups/group-a/candidates/quiet_open_thread%3Athread-a%3A1/dismiss",
      headers: { ...authorization, "x-iris-operator": "operator-a" },
      payload: {},
    });

    expect(list.statusCode).toBe(200);
    expect(repository.listPendingCandidates).toHaveBeenCalledWith({ groupId: "group-a", limit: 5 });
    expect(list.json()).toEqual({
      ok: true,
      groupId: "group-a",
      candidates: [expect.objectContaining({
        idempotencyKey: "quiet_open_thread:thread-a:1",
        lastRelevantAt: "2026-07-23T08:00:00.000Z",
      })],
    });
    expect(dismiss.statusCode).toBe(200);
    expect(repository.dismissCandidate).toHaveBeenCalledWith({
      idempotencyKey: "quiet_open_thread:thread-a:1",
      groupId: "group-a",
      operatorHint: "operator-a",
      now: new Date("2026-07-23T10:00:00.000Z"),
    });
    expect(dismiss.json()).toEqual({ ok: true, status: "dismissed" });
    await app.close();
  });

  it("queues an approved proactive candidate for a future Feishu card without sending it", async () => {
    const store = createStore();
    const repository = {
      recordCandidates: vi.fn<ProactiveSignalRepository["recordCandidates"]>(),
      listPendingCandidates: vi.fn<ProactiveSignalRepository["listPendingCandidates"]>().mockResolvedValue([]),
      dismissCandidate: vi.fn<ProactiveSignalRepository["dismissCandidate"]>().mockResolvedValue({
        status: "not_found",
      }),
      approveCandidateForDelivery: vi.fn<ProactiveSignalRepository["approveCandidateForDelivery"]>().mockResolvedValue({
        status: "queued",
        deliveryId: "delivery-a",
      }),
    } as unknown as ProactiveSignalRepository;
    const app = createApp({ store, proactiveSignalRepository: repository });

    const response = await app.inject({
      method: "POST",
      url: "/internal/proactive-signals/groups/group-a/candidates/quiet_open_thread%3Athread-a%3A1/approve-delivery",
      headers: { ...authorization, "x-iris-operator": "operator-a" },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(repository.approveCandidateForDelivery).toHaveBeenCalledWith({
      idempotencyKey: "quiet_open_thread:thread-a:1",
      groupId: "group-a",
      operatorHint: "operator-a",
      now: new Date("2026-07-23T10:00:00.000Z"),
    });
    expect(response.json()).toEqual({ ok: true, status: "queued", deliveryId: "delivery-a" });
    await app.close();
  });
});

function createApp({
  store,
  controller = new RuntimeController(createDefaultRuntimeConfig({})),
  now = () => new Date("2026-07-23T10:00:00.000Z"),
  proactiveSignalRepository,
}: {
  store: ConversationStateInspectionStore;
  controller?: RuntimeController;
  now?: () => Date;
  proactiveSignalRepository?: ProactiveSignalRepository;
}) {
  return buildApp({
    internalApiToken: "operator-secret",
    runtimeController: controller,
    conversationStateInspectionStore: store,
    proactiveSignalRepository,
    now,
    createAnswerDraftRuntime: () => undefined,
    createMemoryExtractionRuntime: () => undefined,
    createEventWorkerRuntime: () => undefined,
    createDocumentSyncRuntime: () => undefined,
    createReindexWorkerRuntime: () => undefined,
  });
}

function createStore() {
  return {
    getStatus: vi.fn<ConversationStateInspectionStore["getStatus"]>().mockResolvedValue({
      threads: { candidate: 0, open: 0, resolved: 0, merged: 0 },
      actions: { open: 0, completed: 0, cancelled: 0 },
      projectionRepairs: { pending: 0, processing: 0, completed: 0, failed: 0 },
    }),
    listThreads: vi.fn<ConversationStateInspectionStore["listThreads"]>().mockResolvedValue([]),
    listActions: vi.fn<ConversationStateInspectionStore["listActions"]>().mockResolvedValue([]),
    listThreadEvents: vi.fn<ConversationStateInspectionStore["listThreadEvents"]>().mockResolvedValue([]),
    listActionEvents: vi.fn<ConversationStateInspectionStore["listActionEvents"]>().mockResolvedValue([]),
    deleteMessageEvidence: vi.fn().mockResolvedValue({ status: "not_found" }),
  };
}
