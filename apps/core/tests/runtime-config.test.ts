import { describe, expect, it } from "vitest";

import { createDefaultRuntimeConfig } from "../src/config/runtime-config.js";
import * as envConfig from "../src/config/env.js";
import {
  readKnowledgeConflictRuntimeConfig,
  readManagedKnowledgeUpdateDeploymentConfig,
  readMemoryExtractionRuntimeConfig,
  readProactiveSignalPlannerRuntimeConfig,
} from "../src/config/env.js";

describe("createDefaultRuntimeConfig", () => {
  it("defaults formal task draft generation off independently of knowledge drafts", () => {
    const capabilities = createDefaultRuntimeConfig({}).capabilities;

    expect(capabilities.generateTaskDrafts).toBe(false);
    expect(capabilities.generateKnowledgeDrafts).toBe(true);
  });

  it("defaults managed knowledge updates off independently of knowledge-base writes", () => {
    const capabilities = createDefaultRuntimeConfig({}).capabilities;

    expect(capabilities.updateManagedKnowledge).toBe(false);
    expect(capabilities.writeKnowledgeBase).toBe(false);
  });

  it("keeps the development default enabled when startup configuration is absent", () => {
    expect(createDefaultRuntimeConfig({}).globalEnabled).toBe(true);
  });

  it("starts globally disabled when explicitly configured fail closed", () => {
    expect(
      createDefaultRuntimeConfig({ IRIS_RUNTIME_GLOBAL_ENABLED: " false " }).globalEnabled,
    ).toBe(false);
  });

  it("supports explicit startup enablement", () => {
    expect(createDefaultRuntimeConfig({ IRIS_RUNTIME_GLOBAL_ENABLED: "TRUE" }).globalEnabled).toBe(
      true,
    );
  });

  it("rejects invalid startup enablement instead of silently enabling Iris", () => {
    expect(() =>
      createDefaultRuntimeConfig({ IRIS_RUNTIME_GLOBAL_ENABLED: "sometimes" }),
    ).toThrow("IRIS_RUNTIME_GLOBAL_ENABLED must be true or false");
    expect(() => createDefaultRuntimeConfig({ IRIS_RUNTIME_GLOBAL_ENABLED: "   " })).toThrow(
      "IRIS_RUNTIME_GLOBAL_ENABLED must be true or false",
    );
  });
});

describe("managed knowledge update deployment configuration", () => {
  it("defaults off and accepts only one explicit pilot group", () => {
    expect(readManagedKnowledgeUpdateDeploymentConfig({})).toEqual({
      enabled: false,
      groupAllowlist: [],
    });
    expect(readManagedKnowledgeUpdateDeploymentConfig({
      IRIS_MANAGED_KNOWLEDGE_UPDATE_ENABLED: "true",
      IRIS_MANAGED_KNOWLEDGE_UPDATE_GROUP_ALLOWLIST: " group-a ",
    })).toEqual({
      enabled: true,
      groupAllowlist: ["group-a"],
    });
  });

  it.each([
    [
      { IRIS_MANAGED_KNOWLEDGE_UPDATE_ENABLED: "yes" },
      "IRIS_MANAGED_KNOWLEDGE_UPDATE_ENABLED must be true or false",
    ],
    [
      { IRIS_MANAGED_KNOWLEDGE_UPDATE_ENABLED: "true" },
      "IRIS_MANAGED_KNOWLEDGE_UPDATE_GROUP_ALLOWLIST must contain exactly one group",
    ],
    [
      {
        IRIS_MANAGED_KNOWLEDGE_UPDATE_ENABLED: "true",
        IRIS_MANAGED_KNOWLEDGE_UPDATE_GROUP_ALLOWLIST: "group-a,group-b",
      },
      "IRIS_MANAGED_KNOWLEDGE_UPDATE_GROUP_ALLOWLIST must contain exactly one group",
    ],
    [
      {
        IRIS_MANAGED_KNOWLEDGE_UPDATE_ENABLED: "true",
        IRIS_MANAGED_KNOWLEDGE_UPDATE_GROUP_ALLOWLIST: "group-a, ,group-b",
      },
      "IRIS_MANAGED_KNOWLEDGE_UPDATE_GROUP_ALLOWLIST must not contain blank group IDs",
    ],
    [
      {
        IRIS_MANAGED_KNOWLEDGE_UPDATE_ENABLED: "true",
        IRIS_MANAGED_KNOWLEDGE_UPDATE_GROUP_ALLOWLIST: "group-a,group-a",
      },
      "IRIS_MANAGED_KNOWLEDGE_UPDATE_GROUP_ALLOWLIST must contain unique group IDs",
    ],
  ])("fails closed for malformed deployment input %#", (env, message) => {
    expect(() => readManagedKnowledgeUpdateDeploymentConfig(env)).toThrow(message);
  });
});

describe("memory extraction rollout configuration", () => {
  it("fails closed with empty allowlists and parses trimmed unique group ids", () => {
    expect(readMemoryExtractionRuntimeConfig(enabledExtractionEnv())).toMatchObject({
      threadEnabledGroupIds: [],
      actionEnabledGroupIds: [],
      candidateConfidenceFloor: 0.65,
      applyConfidence: 0.85,
    });

    expect(readMemoryExtractionRuntimeConfig({
      ...enabledExtractionEnv(),
      IRIS_THREAD_EXTRACTION_GROUP_IDS: " group-a,group-b, group-a ",
      IRIS_ACTION_EXTRACTION_GROUP_IDS: "group-b",
      IRIS_THREAD_CANDIDATE_CONFIDENCE_FLOOR: "0.7",
      IRIS_MEMORY_EXTRACTION_MIN_CONFIDENCE: "0.9",
    })).toMatchObject({
      threadEnabledGroupIds: ["group-a", "group-b"],
      actionEnabledGroupIds: ["group-b"],
      candidateConfidenceFloor: 0.7,
      applyConfidence: 0.9,
    });
  });

  it("rejects action groups outside the thread rollout and invalid threshold ordering", () => {
    expect(() => readMemoryExtractionRuntimeConfig({
      ...enabledExtractionEnv(),
      IRIS_THREAD_EXTRACTION_GROUP_IDS: "group-a",
      IRIS_ACTION_EXTRACTION_GROUP_IDS: "group-b",
    })).toThrow("IRIS_ACTION_EXTRACTION_GROUP_IDS must be a subset of IRIS_THREAD_EXTRACTION_GROUP_IDS");

    expect(() => readMemoryExtractionRuntimeConfig({
      ...enabledExtractionEnv(),
      IRIS_THREAD_CANDIDATE_CONFIDENCE_FLOOR: "0.85",
      IRIS_MEMORY_EXTRACTION_MIN_CONFIDENCE: "0.85",
    })).toThrow("IRIS_THREAD_CANDIDATE_CONFIDENCE_FLOOR must be less than IRIS_MEMORY_EXTRACTION_MIN_CONFIDENCE");
  });
});

describe("proactive signal planner rollout configuration", () => {
  it("stays disabled by default and parses an explicit group allowlist", () => {
    expect(readProactiveSignalPlannerRuntimeConfig({})).toEqual({ enabled: false });

    expect(readProactiveSignalPlannerRuntimeConfig({
      IRIS_PROACTIVE_SIGNAL_PLANNER_ENABLED: "true",
      IRIS_PROACTIVE_SIGNAL_PLANNER_GROUP_IDS: " group-a,group-b ",
      DATABASE_URL: "postgres://example/iris",
    })).toEqual({
      enabled: true,
      databaseUrl: "postgres://example/iris",
      enabledGroupIds: ["group-a", "group-b"],
      intervalMs: 60000,
      batchLimit: 10,
      quietThreadAfterMinutes: 1440,
      overdueActionGraceMinutes: 15,
    });
  });

  it("requires at least one group and bounds scan timing while enabled", () => {
    expect(() => readProactiveSignalPlannerRuntimeConfig({
      IRIS_PROACTIVE_SIGNAL_PLANNER_ENABLED: "true",
      DATABASE_URL: "postgres://example/iris",
    })).toThrow("IRIS_PROACTIVE_SIGNAL_PLANNER_GROUP_IDS must contain at least one group");

    expect(() => readProactiveSignalPlannerRuntimeConfig({
      IRIS_PROACTIVE_SIGNAL_PLANNER_ENABLED: "true",
      IRIS_PROACTIVE_SIGNAL_PLANNER_GROUP_IDS: "group-a",
      IRIS_PROACTIVE_SIGNAL_PLANNER_QUIET_THREAD_MINUTES: "0",
      DATABASE_URL: "postgres://example/iris",
    })).toThrow("IRIS_PROACTIVE_SIGNAL_PLANNER_QUIET_THREAD_MINUTES must be a positive integer");
  });
});

describe("wiki space sync rollout configuration", () => {
  it("stays disabled by default and reads bounded enabled settings", () => {
    const readWikiSpaceSyncRuntimeConfig = getWikiSpaceSyncRuntimeConfigReader();

    expect(readWikiSpaceSyncRuntimeConfig({})).toEqual({ enabled: false });
    expect(readWikiSpaceSyncRuntimeConfig({
      IRIS_DOCUMENT_SYNC_WORKER_ENABLED: "true",
      IRIS_WIKI_SPACE_SYNC_ENABLED: "true",
    })).toEqual({
      enabled: true,
      intervalMs: 1_000,
      refreshIntervalMs: 21_600_000,
      leaseMs: 600_000,
      maxDepth: 20,
      maxAttempts: 5,
    });
  });

  it("rejects unsafe scan settings and document-sync-independent enablement", () => {
    const readWikiSpaceSyncRuntimeConfig = getWikiSpaceSyncRuntimeConfigReader();
    const enabledEnv = {
      IRIS_DOCUMENT_SYNC_WORKER_ENABLED: "true",
      IRIS_WIKI_SPACE_SYNC_ENABLED: "true",
    };

    expect(() => readWikiSpaceSyncRuntimeConfig({
      ...enabledEnv,
      IRIS_WIKI_SPACE_SYNC_INTERVAL_MS: "2147483648",
    })).toThrow("IRIS_WIKI_SPACE_SYNC_INTERVAL_MS must not exceed 2147483647");
    expect(() => readWikiSpaceSyncRuntimeConfig({
      ...enabledEnv,
      IRIS_WIKI_SPACE_SYNC_REFRESH_INTERVAL_MS: "0",
    })).toThrow("IRIS_WIKI_SPACE_SYNC_REFRESH_INTERVAL_MS must be a positive integer");
    expect(() => readWikiSpaceSyncRuntimeConfig({
      ...enabledEnv,
      IRIS_WIKI_SPACE_SYNC_LEASE_MS: "0",
    })).toThrow("IRIS_WIKI_SPACE_SYNC_LEASE_MS must be a positive integer");
    expect(() => readWikiSpaceSyncRuntimeConfig({
      ...enabledEnv,
      IRIS_WIKI_SPACE_SYNC_MAX_DEPTH: "21",
    })).toThrow("IRIS_WIKI_SPACE_SYNC_MAX_DEPTH must not exceed 20");
    expect(() => readWikiSpaceSyncRuntimeConfig({
      ...enabledEnv,
      IRIS_WIKI_SPACE_SYNC_MAX_ATTEMPTS: "1001",
    })).toThrow("IRIS_WIKI_SPACE_SYNC_MAX_ATTEMPTS must not exceed 1000");
    expect(() => readWikiSpaceSyncRuntimeConfig({
      IRIS_WIKI_SPACE_SYNC_ENABLED: "true",
    })).toThrow("wiki space sync requires the document sync worker to be enabled");
  });
});

describe("knowledge conflict rollout configuration", () => {
  it("stays disabled without reading any dependency", () => {
    expect(readKnowledgeConflictRuntimeConfig({})).toEqual({ enabled: false });
  });

  it("requires an explicit unique allowlist covered by cards and approvals", () => {
    expect(() => readKnowledgeConflictRuntimeConfig({
      ...enabledKnowledgeConflictEnv(),
      IRIS_KNOWLEDGE_CONFLICT_GROUP_ALLOWLIST: "",
    })).toThrow("IRIS_KNOWLEDGE_CONFLICT_GROUP_ALLOWLIST must contain at least one group");
    expect(() => readKnowledgeConflictRuntimeConfig({
      ...enabledKnowledgeConflictEnv(),
      IRIS_KNOWLEDGE_CONFLICT_GROUP_ALLOWLIST: "group-a,group-a",
    })).toThrow("IRIS_KNOWLEDGE_CONFLICT_GROUP_ALLOWLIST must contain unique group IDs");
    expect(() => readKnowledgeConflictRuntimeConfig({
      ...enabledKnowledgeConflictEnv(),
      IRIS_KNOWLEDGE_CONFLICT_GROUP_ALLOWLIST: "group-b",
    })).toThrow("IRIS_KNOWLEDGE_CARD_GROUP_IDS must include every knowledge-conflict group");
    expect(() => readKnowledgeConflictRuntimeConfig({
      ...enabledKnowledgeConflictEnv(),
      IRIS_APPROVAL_ACTION_GROUP_IDS: "group-b",
    })).toThrow("IRIS_APPROVAL_ACTION_GROUP_IDS must include every knowledge-conflict group");
  });

  it("requires every enabled dependency and returns bounded settings", () => {
    expect(readKnowledgeConflictRuntimeConfig(enabledKnowledgeConflictEnv())).toEqual({
      enabled: true,
      databaseUrl: "postgres://example/iris",
      redisUrl: "redis://localhost:6379",
      enabledGroupIds: ["group-a"],
      botOpenId: "ou_iris",
      scannerIntervalMs: 60_000,
      scannerBatchLimit: 10,
      scanLeaseMs: 30_000,
      scanMaxAttempts: 5,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 60_000,
      dispatcherIntervalMs: 1_000,
      dispatcherBatchLimit: 10,
      deliveryLeaseMs: 30_000,
      reconciliationDelayMs: 300_000,
    });

    for (const [name, value] of [
      ["IRIS_MODEL_PROVIDER", undefined],
      ["IRIS_EMBEDDING_PROVIDER", undefined],
      ["IRIS_EMBEDDING_DIMENSIONS", undefined],
      ["REDIS_URL", undefined],
      ["FEISHU_APP_ID", undefined],
      ["IRIS_KNOWLEDGE_CARD_ENABLED", "false"],
      ["IRIS_APPROVAL_ACTIONS_ENABLED", "false"],
    ] as const) {
      expect(() => readKnowledgeConflictRuntimeConfig({
        ...enabledKnowledgeConflictEnv(),
        [name]: value,
      })).toThrow();
    }
  });

  it("rejects unsafe timer, batch, lease, attempt, and retry settings", () => {
    for (const [name, value] of [
      ["IRIS_KNOWLEDGE_CONFLICT_SCANNER_INTERVAL_MS", "0"],
      ["IRIS_KNOWLEDGE_CONFLICT_SCANNER_BATCH_LIMIT", "51"],
      ["IRIS_KNOWLEDGE_CONFLICT_SCAN_LEASE_MS", "2147483648"],
      ["IRIS_KNOWLEDGE_CONFLICT_SCAN_MAX_ATTEMPTS", "11"],
      ["IRIS_KNOWLEDGE_CONFLICT_DISPATCHER_BATCH_LIMIT", "101"],
      ["IRIS_KNOWLEDGE_CONFLICT_RECONCILIATION_DELAY_MS", "0"],
    ] as const) {
      expect(() => readKnowledgeConflictRuntimeConfig({
        ...enabledKnowledgeConflictEnv(),
        [name]: value,
      })).toThrow();
    }
    expect(() => readKnowledgeConflictRuntimeConfig({
      ...enabledKnowledgeConflictEnv(),
      IRIS_KNOWLEDGE_CONFLICT_RETRY_BASE_DELAY_MS: "2000",
      IRIS_KNOWLEDGE_CONFLICT_RETRY_MAX_DELAY_MS: "1000",
    })).toThrow("retry max delay must be at least the base delay");
  });
});

function getWikiSpaceSyncRuntimeConfigReader(): (env: Record<string, string | undefined>) => unknown {
  const candidate = (envConfig as Record<string, unknown>).readWikiSpaceSyncRuntimeConfig;
  expect(candidate).toBeTypeOf("function");
  if (typeof candidate !== "function") {
    throw new Error("readWikiSpaceSyncRuntimeConfig is unavailable");
  }
  return candidate as (env: Record<string, string | undefined>) => unknown;
}

function enabledExtractionEnv() {
  return {
    IRIS_MEMORY_EXTRACTION_ENABLED: "true",
    DATABASE_URL: "postgres://example/iris",
    REDIS_URL: "redis://localhost:6379",
    IRIS_AI_WORKER_BASE_URL: "http://ai-worker:8000",
    IRIS_AI_WORKER_TOKEN: "worker-token",
    IRIS_FEISHU_BOT_OPEN_ID: "ou_iris",
  };
}

function enabledKnowledgeConflictEnv() {
  return {
    IRIS_KNOWLEDGE_CONFLICT_ENABLED: "true",
    IRIS_KNOWLEDGE_CONFLICT_GROUP_ALLOWLIST: "group-a",
    DATABASE_URL: "postgres://example/iris",
    REDIS_URL: "redis://localhost:6379",
    IRIS_MODEL_PROVIDER: "openai-compatible",
    IRIS_MODEL_BASE_URL: "https://model.example.com/v1",
    IRIS_MODEL_API_KEY: "model-key",
    IRIS_MODEL_NAME: "model-name",
    IRIS_EMBEDDING_PROVIDER: "openai-compatible",
    IRIS_EMBEDDING_BASE_URL: "https://embedding.example.com/v1",
    IRIS_EMBEDDING_API_KEY: "embedding-key",
    IRIS_EMBEDDING_MODEL: "embedding-model",
    IRIS_EMBEDDING_DIMENSIONS: "1536",
    FEISHU_APP_ID: "app-id",
    FEISHU_APP_SECRET: "app-secret",
    FEISHU_VERIFICATION_TOKEN: "verification-token",
    FEISHU_ENCRYPT_KEY: "encrypt-key",
    IRIS_FEISHU_BOT_OPEN_ID: "ou_iris",
    IRIS_KNOWLEDGE_CARD_ENABLED: "true",
    IRIS_KNOWLEDGE_CARD_GROUP_IDS: "group-a",
    IRIS_APPROVAL_ACTIONS_ENABLED: "true",
    IRIS_APPROVAL_ACTION_GROUP_IDS: "group-a",
  };
}
