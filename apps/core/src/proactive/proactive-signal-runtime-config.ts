import type { ProactiveSignalPolicy } from "./proactive-signal-evaluator.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_BATCH_LIMIT = 500;
const MAX_GROUPS = 100;
const MAX_IDENTIFIER_CHARS = 512;
const POLICY_VERSION = "phase4a-v1";

export type ProactiveSignalRuntimeConfig =
  | { enabled: false }
  | {
      enabled: true;
      groupIds: string[];
      intervalMs: number;
      batchLimit: number;
      policy: ProactiveSignalPolicy;
    };

export type ProactiveSignalEnv = Record<string, string | undefined>;

export function readProactiveSignalRuntimeConfig(
  env: ProactiveSignalEnv = process.env,
): ProactiveSignalRuntimeConfig {
  const enabled = readBoolean(
    "IRIS_PROACTIVE_CANDIDATE_SCANNING_ENABLED",
    env.IRIS_PROACTIVE_CANDIDATE_SCANNING_ENABLED,
    false,
  );
  if (!enabled) return { enabled: false };

  return {
    enabled: true,
    groupIds: readGroupIds(env.IRIS_PROACTIVE_CANDIDATE_GROUP_IDS),
    intervalMs: readBoundedPositiveInteger(
      "IRIS_PROACTIVE_CANDIDATE_INTERVAL_MS",
      env.IRIS_PROACTIVE_CANDIDATE_INTERVAL_MS,
      300_000,
      MAX_TIMER_DELAY_MS,
    ),
    batchLimit: readBoundedPositiveInteger(
      "IRIS_PROACTIVE_CANDIDATE_BATCH_LIMIT",
      env.IRIS_PROACTIVE_CANDIDATE_BATCH_LIMIT,
      50,
      MAX_BATCH_LIMIT,
    ),
    policy: {
      policyVersion: POLICY_VERSION,
      minConfidence: readConfidence(
        "IRIS_PROACTIVE_CANDIDATE_MIN_CONFIDENCE",
        env.IRIS_PROACTIVE_CANDIDATE_MIN_CONFIDENCE,
        0.7,
      ),
      quietThreadMs: readBoundedPositiveInteger(
        "IRIS_PROACTIVE_CANDIDATE_QUIET_THREAD_MS",
        env.IRIS_PROACTIVE_CANDIDATE_QUIET_THREAD_MS,
        86_400_000,
        MAX_TIMER_DELAY_MS,
      ),
      quietActionMs: readBoundedPositiveInteger(
        "IRIS_PROACTIVE_CANDIDATE_QUIET_ACTION_MS",
        env.IRIS_PROACTIVE_CANDIDATE_QUIET_ACTION_MS,
        86_400_000,
        MAX_TIMER_DELAY_MS,
      ),
      overdueGraceMs: readBoundedPositiveInteger(
        "IRIS_PROACTIVE_CANDIDATE_OVERDUE_GRACE_MS",
        env.IRIS_PROACTIVE_CANDIDATE_OVERDUE_GRACE_MS,
        1_800_000,
        MAX_TIMER_DELAY_MS,
      ),
    },
  };
}

function readBoolean(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function readGroupIds(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim().length === 0) return [];
  const groupIds = raw.split(",").map((value) => value.trim());
  if (
    groupIds.length > MAX_GROUPS ||
    groupIds.some((value) => value.length < 1 || value.length > MAX_IDENTIFIER_CHARS) ||
    new Set(groupIds).size !== groupIds.length
  ) {
    throw new Error("IRIS_PROACTIVE_CANDIDATE_GROUP_IDS is invalid");
  }
  return [...groupIds].sort();
}

function readBoundedPositiveInteger(
  name: string,
  raw: string | undefined,
  fallback: number,
  maximum: number,
): number {
  const normalized = raw?.trim();
  if (normalized === undefined || normalized.length === 0) return fallback;
  if (!/^[1-9]\d*$/u.test(normalized)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`${name} must not exceed ${maximum}`);
  }
  return parsed;
}

function readConfidence(name: string, raw: string | undefined, fallback: number): number {
  const normalized = raw?.trim();
  if (normalized === undefined || normalized.length === 0) return fallback;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed >= 1) {
    throw new Error(`${name} must be greater than or equal to 0 and less than 1`);
  }
  return parsed;
}
