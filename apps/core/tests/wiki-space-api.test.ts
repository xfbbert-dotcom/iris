import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { DocumentSyncRuntime } from "../src/runtime/document-sync-runtime.js";

const operatorAuthorization = { authorization: "Bearer operator-secret" };
const registeredAt = new Date("2026-07-29T09:00:00.000Z");
const rootSourceUri = "https://tenant.feishu.cn/wiki/root_1?from=space";

describe("Wiki space internal API", () => {
  it("registers a locally validated wiki root without normalizing it before the runtime", async () => {
    const runtime = fakeDocumentSyncRuntime();
    const app = buildApp({
      internalApiToken: "operator-secret",
      now: () => registeredAt,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/document-sync/wiki-spaces",
      headers: operatorAuthorization,
      payload: { rootSourceUri },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      ok: true,
      created: true,
      authorization: { id: "wiki-space-1", rootSourceUri },
    });
    expect(runtime.wikiSpaces.register).toHaveBeenCalledWith({
      rootSourceUri,
      at: registeredAt,
    });
    await app.close();
  });

  it.each([
    ["missing root URI", {}],
    ["extra body property", { rootSourceUri, enabled: true }],
    ["non-wiki URL", { rootSourceUri: "https://tenant.feishu.cn/docx/doc_1" }],
    ["non-https URL", { rootSourceUri: "http://tenant.feishu.cn/wiki/root_1" }],
    ["unsupported host", { rootSourceUri: "https://example.com/wiki/root_1" }],
    ["non-exact path", { rootSourceUri: "https://tenant.feishu.cn/wiki/root_1/child" }],
    ["oversized root URI", { rootSourceUri: `https://tenant.feishu.cn/wiki/${"a".repeat(8_170)}` }],
  ])("rejects %s before registering", async (_name, payload) => {
    const runtime = fakeDocumentSyncRuntime();
    const app = buildApp({
      internalApiToken: "operator-secret",
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/document-sync/wiki-spaces",
      headers: operatorAuthorization,
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
    expect(runtime.wikiSpaces.register).not.toHaveBeenCalled();
    await app.close();
  });

  it("requires internal authorization before wiki space operations", async () => {
    const runtime = fakeDocumentSyncRuntime();
    const app = buildApp({
      internalApiToken: "operator-secret",
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/document-sync/wiki-spaces",
      payload: { rootSourceUri },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ ok: false, error: "internal_api_unauthorized" });
    expect(runtime.wikiSpaces.register).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns the safe unavailable error when the document sync runtime is absent", async () => {
    const app = buildApp({
      internalApiToken: "operator-secret",
      createDocumentSyncRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/wiki-spaces",
      headers: operatorAuthorization,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false, error: "document_sync_worker_unavailable" });
    await app.close();
  });

  it("lists wiki spaces with a bounded limit", async () => {
    const runtime = fakeDocumentSyncRuntime({
      wikiSpaces: {
        ...fakeWikiSpaces(),
        list: vi.fn(async () => [wikiSpaceAuthorization()]),
      },
    });
    const app = buildApp({
      internalApiToken: "operator-secret",
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/wiki-spaces?limit=999",
      headers: operatorAuthorization,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      wikiSpaces: [{ id: "wiki-space-1", rootSourceUri }],
    });
    expect(runtime.wikiSpaces.list).toHaveBeenCalledWith({ limit: 100 });
    await app.close();
  });

  it("rejects invalid wiki space list limits", async () => {
    const runtime = fakeDocumentSyncRuntime();
    const app = buildApp({
      internalApiToken: "operator-secret",
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/wiki-spaces?limit=-1",
      headers: operatorAuthorization,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
    expect(runtime.wikiSpaces.list).not.toHaveBeenCalled();
    await app.close();
  });

  it("requests a rescan for an existing wiki space", async () => {
    const runtime = fakeDocumentSyncRuntime({
      wikiSpaces: {
        ...fakeWikiSpaces(),
        requestScan: vi.fn(async () => wikiSpaceAuthorization({ scanState: "pending" })),
      },
    });
    const app = buildApp({
      internalApiToken: "operator-secret",
      now: () => registeredAt,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/document-sync/wiki-spaces/wiki-space-1/rescan",
      headers: operatorAuthorization,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      authorization: { id: "wiki-space-1", scanState: "pending" },
    });
    expect(runtime.wikiSpaces.requestScan).toHaveBeenCalledWith({
      id: "wiki-space-1",
      at: registeredAt,
    });
    await app.close();
  });

  it("returns a safe not found error for a missing wiki space rescan", async () => {
    const runtime = fakeDocumentSyncRuntime();
    const app = buildApp({
      internalApiToken: "operator-secret",
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/document-sync/wiki-spaces/missing/rescan",
      headers: operatorAuthorization,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ ok: false, error: "wiki_space_not_found" });
    await app.close();
  });

  it.each([
    [true, "pending"],
    [false, "disabled"],
  ])("sets wiki space enabled to %s", async (enabled, scanState) => {
    const runtime = fakeDocumentSyncRuntime({
      wikiSpaces: {
        ...fakeWikiSpaces(),
        setEnabled: vi.fn(async () => wikiSpaceAuthorization({ enabled, scanState })),
      },
    });
    const app = buildApp({
      internalApiToken: "operator-secret",
      now: () => registeredAt,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/internal/document-sync/wiki-spaces/wiki-space-1",
      headers: operatorAuthorization,
      payload: { enabled },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      authorization: { id: "wiki-space-1", enabled, scanState },
    });
    expect(runtime.wikiSpaces.setEnabled).toHaveBeenCalledWith({
      id: "wiki-space-1",
      enabled,
      at: registeredAt,
    });
    await app.close();
  });

  it("rejects invalid wiki space enable requests", async () => {
    const runtime = fakeDocumentSyncRuntime();
    const app = buildApp({
      internalApiToken: "operator-secret",
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/internal/document-sync/wiki-spaces/${"a".repeat(513)}`,
      headers: operatorAuthorization,
      payload: { enabled: "true" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
    expect(runtime.wikiSpaces.setEnabled).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ["POST", 514, "/rescan"],
    ["POST", 4_096, "/rescan"],
    ["PATCH", 514, ""],
    ["PATCH", 4_096, ""],
  ] as const)(
    "returns a controlled invalid request for %s wiki space IDs with %i characters",
    async (method, idLength, suffix) => {
      const runtime = fakeDocumentSyncRuntime();
      const app = buildApp({
        internalApiToken: "operator-secret",
        createDocumentSyncRuntime: () => runtime,
      });

      const response = await app.inject({
        method,
        url: `/internal/document-sync/wiki-spaces/${"a".repeat(idLength)}${suffix}`,
        headers: operatorAuthorization,
        ...(method === "PATCH" ? { payload: { enabled: true } } : {}),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
      expect(runtime.wikiSpaces.requestScan).not.toHaveBeenCalled();
      expect(runtime.wikiSpaces.setEnabled).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it.each([
    ["POST", "/internal/document-sync/wiki-spaces/wiki-space-1/not-rescan"],
    ["PATCH", "/internal/document-sync/wiki-spaces/wiki-space-1/extra"],
  ] as const)(
    "returns the default 404 for authenticated %s shape mismatches before parsing malformed JSON",
    async (method, url) => {
      const runtime = fakeDocumentSyncRuntime();
      const app = buildApp({
        internalApiToken: "operator-secret",
        createDocumentSyncRuntime: () => runtime,
      });

      const response = await app.inject({
        method,
        url,
        headers: {
          ...operatorAuthorization,
          "content-type": "application/json",
        },
        payload: "{not-json",
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        statusCode: 404,
        error: "Not Found",
      });
      expect(runtime.wikiSpaces.requestScan).not.toHaveBeenCalled();
      expect(runtime.wikiSpaces.setEnabled).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it.each([
    ["POST", 514, "/rescan"],
    ["POST", 4_096, "/rescan"],
    ["PATCH", 514, ""],
    ["PATCH", 4_096, ""],
  ] as const)(
    "rejects authenticated %s wiki space IDs with %i characters before parsing malformed JSON",
    async (method, idLength, suffix) => {
      const runtime = fakeDocumentSyncRuntime();
      const app = buildApp({
        internalApiToken: "operator-secret",
        createDocumentSyncRuntime: () => runtime,
      });

      const response = await app.inject({
        method,
        url: `/internal/document-sync/wiki-spaces/${"a".repeat(idLength)}${suffix}`,
        headers: {
          ...operatorAuthorization,
          "content-type": "application/json",
        },
        payload: "{not-json",
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
      expect(runtime.wikiSpaces.requestScan).not.toHaveBeenCalled();
      expect(runtime.wikiSpaces.setEnabled).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it.each([
    ["POST", "/rescan"],
    ["PATCH", ""],
  ] as const)(
    "authenticates exact overlong %s requests before parsing malformed JSON",
    async (method, suffix) => {
      const runtime = fakeDocumentSyncRuntime();
      const app = buildApp({
        internalApiToken: "operator-secret",
        createDocumentSyncRuntime: () => runtime,
      });

      const response = await app.inject({
        method,
        url: `/internal/document-sync/wiki-spaces/${"a".repeat(514)}${suffix}`,
        headers: { "content-type": "application/json" },
        payload: "{not-json",
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ ok: false, error: "internal_api_unauthorized" });
      expect(runtime.wikiSpaces.requestScan).not.toHaveBeenCalled();
      expect(runtime.wikiSpaces.setEnabled).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it("keeps unrelated and method-mismatched request targets on the default 404 boundary", async () => {
    const runtime = fakeDocumentSyncRuntime();
    const app = buildApp({
      internalApiToken: "operator-secret",
      createDocumentSyncRuntime: () => runtime,
    });
    const longId = "a".repeat(4_096);

    const unrelatedPublic = await app.inject({
      method: "PATCH",
      url: `/document-sync/wiki-spaces/${longId}`,
      payload: { enabled: true },
    });
    const unrelatedInternal = await app.inject({
      method: "PATCH",
      url: `/internal/not-a-route/${longId}`,
      headers: operatorAuthorization,
      payload: { enabled: true },
    });
    const wrongWikiSpaceMethod = await app.inject({
      method: "GET",
      url: `/internal/document-sync/wiki-spaces/${longId}`,
      headers: operatorAuthorization,
    });

    expect(unrelatedPublic.statusCode).toBe(404);
    expect(unrelatedInternal.statusCode).toBe(404);
    expect(wrongWikiSpaceMethod.statusCode).toBe(404);
    await app.close();
  });

  it("authenticates overlong wiki space request targets before returning validation errors", async () => {
    const runtime = fakeDocumentSyncRuntime();
    const app = buildApp({
      internalApiToken: "operator-secret",
      createDocumentSyncRuntime: () => runtime,
    });
    const longId = "a".repeat(4_096);

    const rescan = await app.inject({
      method: "POST",
      url: `/internal/document-sync/wiki-spaces/${longId}/rescan`,
    });
    const update = await app.inject({
      method: "PATCH",
      url: `/internal/document-sync/wiki-spaces/${longId}`,
      payload: { enabled: true },
    });

    expect(rescan.statusCode).toBe(401);
    expect(rescan.json()).toEqual({ ok: false, error: "internal_api_unauthorized" });
    expect(update.statusCode).toBe(401);
    expect(update.json()).toEqual({ ok: false, error: "internal_api_unauthorized" });
    await app.close();
  });

  it("maps registration and operation failures to safe errors", async () => {
    const registrationError = new Error("Feishu credential: secret-value");
    const operationError = new Error("database connection: secret-value");
    const runtime = fakeDocumentSyncRuntime({
      wikiSpaces: {
        ...fakeWikiSpaces(),
        register: vi.fn(async () => {
          throw registrationError;
        }),
        requestScan: vi.fn(async () => {
          throw operationError;
        }),
      },
    });
    const app = buildApp({
      internalApiToken: "operator-secret",
      createDocumentSyncRuntime: () => runtime,
    });

    const registration = await app.inject({
      method: "POST",
      url: "/internal/document-sync/wiki-spaces",
      headers: operatorAuthorization,
      payload: { rootSourceUri },
    });
    const operation = await app.inject({
      method: "POST",
      url: "/internal/document-sync/wiki-spaces/wiki-space-1/rescan",
      headers: operatorAuthorization,
    });

    expect(registration.statusCode).toBe(500);
    expect(registration.json()).toEqual({ ok: false, error: "wiki_space_registration_failed" });
    expect(operation.statusCode).toBe(500);
    expect(operation.json()).toEqual({ ok: false, error: "wiki_space_operation_failed" });
    expect(registration.body).not.toContain("secret-value");
    expect(operation.body).not.toContain("secret-value");
    await app.close();
  });
});

function fakeDocumentSyncRuntime(overrides: Partial<DocumentSyncRuntime> = {}): DocumentSyncRuntime {
  return {
    getStatus: vi.fn(async () => ({
      enabled: true as const,
      running: true,
      intervalMs: 1_000,
      batchLimit: 10,
      pendingJobCount: 0,
      deadLetterJobCount: 0,
    })),
    sources: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => undefined),
      updatePolicy: vi.fn(async () => undefined),
      listSnapshots: vi.fn(async () => undefined),
      getSnapshot: vi.fn(async () => undefined),
      getLatestSnapshot: vi.fn(async () => undefined),
      getLatestSnapshots: vi.fn(async () => new Map()),
    },
    enqueueSource: vi.fn(async () => ({ status: "not_found" as const, documentSourceId: "missing" })),
    registerAuthorizedWikiDocument: vi.fn(async () => ({
      source: {} as never,
      enqueue: { status: "not_found" as const, documentSourceId: "missing" },
    })),
    registerUserSubmittedDocument: vi.fn(async () => ({
      source: {} as never,
      enqueue: { status: "not_found" as const, documentSourceId: "missing" },
    })),
    deadLetters: {
      list: vi.fn(async () => []),
      replay: vi.fn(async () => "not_found" as const),
      delete: vi.fn(async () => "not_found" as const),
      replayBatch: vi.fn(async () => ({
        replayedCount: 0,
        notFoundIds: [],
        unsupportedLegacyIds: [],
      })),
    },
    wikiSpaces: fakeWikiSpaces(),
    start: vi.fn(),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function fakeWikiSpaces(): DocumentSyncRuntime["wikiSpaces"] {
  return {
    register: vi.fn(async ({ rootSourceUri: sourceUri, at }) => ({
      authorization: wikiSpaceAuthorization({ rootSourceUri: sourceUri, nextScanAt: at }),
      created: true,
    })),
    list: vi.fn(async () => []),
    requestScan: vi.fn(async () => undefined),
    setEnabled: vi.fn(async () => undefined),
  };
}

function wikiSpaceAuthorization(overrides: Record<string, unknown> = {}) {
  return {
    id: "wiki-space-1",
    rootSourceUri,
    rootNodeToken: "root_1",
    enabled: true,
    scanState: "pending" as const,
    attemptCount: 0,
    nextScanAt: registeredAt,
    discoveredNodeCount: 0,
    registeredDocumentCount: 0,
    skippedNodeCount: 0,
    revision: 1,
    createdAt: registeredAt,
    updatedAt: registeredAt,
    ...overrides,
  };
}
