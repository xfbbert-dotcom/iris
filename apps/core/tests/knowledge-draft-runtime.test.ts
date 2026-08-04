import { describe, expect, it, vi } from "vitest";

import { RuntimeController } from "../src/admin/runtime-controller.js";
import { createDefaultRuntimeConfig } from "../src/config/runtime-config.js";
import { createKnowledgeDraftRuntime } from "../src/runtime/knowledge-draft-runtime.js";

describe("createKnowledgeDraftRuntime", () => {
  it("is unavailable without a database URL", () => {
    expect(createKnowledgeDraftRuntime({ env: {} })).toBeUndefined();
  });

  it("requires the matching runtime controller when configured", () => {
    expect(() => createKnowledgeDraftRuntime({
      env: { DATABASE_URL: "postgresql://example/iris" },
    })).toThrow("runtimeController");
  });

  it("creates one repository, reports status, applies group gates, and closes once", async () => {
    const end = vi.fn(async () => undefined);
    const pool = { query: vi.fn(), connect: vi.fn(), end };
    const repository = {
      createDraft: vi.fn(),
      reviseDraft: vi.fn(),
      requestRevision: vi.fn(),
      rejectDraft: vi.fn(),
      getDraft: vi.fn(),
      listDrafts: vi.fn(),
      listEvents: vi.fn(),
      getStatusCounts: vi.fn(async () => ({
        pending_confirmation: 2,
        pending_review: 1,
        needs_revision: 0,
        rejected: 1,
        published: 0,
      })),
    };
    const controller = new RuntimeController(createDefaultRuntimeConfig());
    controller.disableGroup("group-disabled");
    const runtime = createKnowledgeDraftRuntime({
      env: { DATABASE_URL: "postgresql://example/iris" },
      runtimeController: controller,
      dependencies: {
        createPostgresPool: vi.fn(() => pool as never),
        createRepository: vi.fn(() => repository),
      },
    });

    expect(runtime?.repository).toBe(repository);
    expect(runtime?.canCreateDraft({ sourceGroupId: "group-active" })).toBe(true);
    expect(runtime?.canCreateDraft({ sourceGroupId: "group-disabled" })).toBe(false);
    await expect(runtime?.getStatus()).resolves.toEqual({
      enabled: true,
      companyCreationEnabled: true,
      counts: {
        pending_confirmation: 2,
        pending_review: 1,
        needs_revision: 0,
        rejected: 1,
        published: 0,
      },
    });
    await Promise.all([runtime?.close(), runtime?.close()]);
    expect(end).toHaveBeenCalledOnce();
  });
});
