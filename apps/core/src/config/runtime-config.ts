import { PD_PILOT_CHAT } from "../proactive-discussion/contracts.js";
import { parsePdOpinionMode } from "../proactive-discussion/opinion-mode.js";

export function readProactiveDiscussionConfig(env: Record<string, string | undefined>) {
  const enabled = readOptionalBoolean("IRIS_PROACTIVE_DISCUSSION_ENABLED", env.IRIS_PROACTIVE_DISCUSSION_ENABLED, false);
  const raw = env.IRIS_PROACTIVE_DISCUSSION_GROUP_IDS?.trim() ?? "";
  const groupIds = raw === "" ? [] : raw.split(",").map(value => value.trim());
  if (enabled && (groupIds.length !== 1 || groupIds[0] !== PD_PILOT_CHAT)) {
    throw new Error("IRIS_PROACTIVE_DISCUSSION_GROUP_IDS must contain only the exact pilot group");
  }
  const positive = (key: string, fallback: number, max: number) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${key} must be a bounded positive integer`);
    return value;
  };
  return { enabled, groupIds, opinionMode: parsePdOpinionMode(env.IRIS_PROACTIVE_DISCUSSION_OPINION_MODE),
    pollIntervalMs: positive("IRIS_PROACTIVE_DISCUSSION_POLL_INTERVAL_MS", 1000, 2147483647),
    batchLimit: positive("IRIS_PROACTIVE_DISCUSSION_BATCH_LIMIT", 10, 100) };
}

export type IrisCapability = {
  readGroupContext: boolean;
  replyWhenMentioned: boolean;
  readGroupDocuments: boolean;
  retrieveKnowledgeBase: boolean;
  proactiveSpeech: boolean;
  generateKnowledgeDrafts: boolean;
  generateTaskDrafts: boolean;
  createFeishuTasks: boolean;
  writeKnowledgeBase: boolean;
  updateManagedKnowledge: boolean;
  callExternalTools: boolean;
};

export type RuntimeConfig = {
  globalEnabled: boolean;
  disabledGroupIds: Set<string>;
  answerAllowedGroupIds?: Set<string>;
  capabilities: IrisCapability;
};

type RuntimeConfigEnv = Record<string, string | undefined>;

export function createDefaultRuntimeConfig(env: RuntimeConfigEnv = process.env): RuntimeConfig {
  const answerAllowedGroupIds = readAnswerAllowedGroupIds(env.IRIS_ANSWER_ALLOWED_GROUP_IDS);
  return {
    globalEnabled: readOptionalBoolean(
      "IRIS_RUNTIME_GLOBAL_ENABLED",
      env.IRIS_RUNTIME_GLOBAL_ENABLED,
      true,
    ),
    disabledGroupIds: new Set<string>(),
    ...(answerAllowedGroupIds === undefined ? {} : { answerAllowedGroupIds }),
    capabilities: {
      readGroupContext: true,
      replyWhenMentioned: true,
      readGroupDocuments: true,
      retrieveKnowledgeBase: true,
      proactiveSpeech: true,
      generateKnowledgeDrafts: true,
      generateTaskDrafts: false,
      createFeishuTasks: false,
      writeKnowledgeBase: false,
      updateManagedKnowledge: false,
      callExternalTools: false
    }
  };
}

function readAnswerAllowedGroupIds(value: string | undefined): Set<string> | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const groupIds = value.split(",").map((groupId) => groupId.trim());
  if (groupIds.some((groupId) => groupId === "")) {
    throw new Error("IRIS_ANSWER_ALLOWED_GROUP_IDS must not contain blank group IDs");
  }
  return new Set(groupIds);
}

function readOptionalBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }

  throw new Error(`${name} must be true or false`);
}
