import { describe, expect, it, vi } from "vitest";

import { RuntimeController } from "../src/admin/runtime-controller.js";
import { createDefaultRuntimeConfig } from "../src/config/runtime-config.js";
import { createFormalTaskRuntime } from "../src/runtime/formal-task-runtime.js";

describe("createFormalTaskRuntime", () => {
  it("is unavailable without a database URL", () => {
    expect(createFormalTaskRuntime({ env: {} })).toBeUndefined();
  });

  it("creates one repository, stays default-off, applies group gates, and closes once", async () => {
    const end = vi.fn(async () => undefined);
    const pool = { query: vi.fn(), connect: vi.fn(), end };
    const repository = {
      getStatusCounts: vi.fn(async () => ({
        pending_confirmation: 2,
        pending_review: 1,
        needs_revision: 0,
        rejected: 0,
        created: 0,
      })),
    };
    const cardRepository = {};
    const executionRepository = {};
    const controller = new RuntimeController(createDefaultRuntimeConfig());
    const runtime = createFormalTaskRuntime({
      env: {
        DATABASE_URL: "postgresql://example/iris",
        IRIS_FEISHU_TASK_CREATION_ENABLED: "true",
        IRIS_FEISHU_TASK_CREATION_GROUP_ALLOWLIST: "group-active",
      },
      runtimeController: controller,
      dependencies: {
        createPostgresPool: vi.fn(() => pool as never),
        createRepository: vi.fn(() => repository as never),
        createCardRepository: vi.fn(() => cardRepository as never),
        createExecutionRepository: vi.fn(() => executionRepository as never),
      },
    });

    expect(runtime?.repository).toBe(repository);
    expect(runtime?.cardRepository).toBe(cardRepository);
    expect(runtime?.executionRepository).toBe(executionRepository);
    expect(runtime?.canCreateDraft({ sourceGroupId: "group-active" })).toBe(false);
    controller.setCapability("generateTaskDrafts", true);
    expect(runtime?.canCreateDraft({ sourceGroupId: "group-active" })).toBe(true);
    expect(controller.canCreateFeishuTasks({ sourceGroupId: "group-active" })).toBe(false);
    controller.setCapability("createFeishuTasks", true);
    controller.setCapability("callExternalTools", true);
    expect(runtime?.canUseFormalTaskCards("group-active")).toBe(true);
    expect(runtime?.canUseFormalTaskCards("group-other")).toBe(false);
    controller.disableGroup("group-active");
    expect(runtime?.canCreateDraft({ sourceGroupId: "group-active" })).toBe(false);
    expect(runtime?.canUseFormalTaskCards("group-active")).toBe(false);
    await expect(runtime?.getStatus()).resolves.toEqual({
      enabled: true,
      companyCreationEnabled: true,
      counts: {
        pending_confirmation: 2,
        pending_review: 1,
        needs_revision: 0,
        rejected: 0,
        created: 0,
      },
    });
    await Promise.all([runtime?.close(), runtime?.close()]);
    expect(end).toHaveBeenCalledOnce();
  });
});
