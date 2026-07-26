import type { ConversationStateInspectionStore } from "../conversation-state/conversation-state-api.js";
import {
  planProactiveSignals,
  type ProactiveSignalCandidate,
} from "./proactive-signal-planner.js";
import type { ProactiveSignalRepository } from "./proactive-signal-repository.js";

const ENTITY_LIMIT = 20;

export type ProactiveSignalScanResult =
  | {
      groupId: string;
      status: "recorded";
      signalCount: number;
      recordedCount: number;
      existingCount: number;
      recordedKeys: string[];
    }
  | {
      groupId: string;
      status: "skipped";
      reason: "runtime_disabled";
      recordedCount: 0;
      existingCount: 0;
    };

export type ProactiveSignalScanner = {
  scanOnce(input: { groupId: string; limit: number }): Promise<ProactiveSignalScanResult>;
};

export type ProactiveSignalScannerDependencies = {
  store: Pick<ConversationStateInspectionStore, "listThreads" | "listActions">;
  repository: Pick<ProactiveSignalRepository, "recordCandidates">;
  canPlanProactiveSignals(groupId: string): boolean;
  now?: () => Date;
  quietThreadAfterMinutes: number;
  overdueActionGraceMinutes: number;
};

export function createProactiveSignalScanner({
  store,
  repository,
  canPlanProactiveSignals,
  now = () => new Date(),
  quietThreadAfterMinutes,
  overdueActionGraceMinutes,
}: ProactiveSignalScannerDependencies): ProactiveSignalScanner {
  const quietThreadAfterMs = requirePositiveMinutes(
    "quietThreadAfterMinutes",
    quietThreadAfterMinutes,
  ) * 60 * 1000;
  const overdueActionGraceMs = requirePositiveMinutes(
    "overdueActionGraceMinutes",
    overdueActionGraceMinutes,
  ) * 60 * 1000;

  return {
    async scanOnce({ groupId, limit }) {
      const safeGroupId = requireIdentifier("groupId", groupId);
      const safeLimit = requireLimit(limit);
      if (!readRuntimeGate(canPlanProactiveSignals, safeGroupId)) {
        return {
          groupId: safeGroupId,
          status: "skipped",
          reason: "runtime_disabled",
          recordedCount: 0,
          existingCount: 0,
        };
      }

      const generatedAt = requireDate(now());
      const [threads, actions] = await Promise.all([
        store.listThreads({ groupId: safeGroupId, limit: ENTITY_LIMIT }),
        store.listActions({ groupId: safeGroupId, limit: ENTITY_LIMIT }),
      ]);
      const signals: ProactiveSignalCandidate[] = planProactiveSignals({
        groupId: safeGroupId,
        now: generatedAt,
        threads,
        actions,
        quietThreadAfterMs,
        overdueActionGraceMs,
        limit: safeLimit,
      });
      const recorded = await repository.recordCandidates({ signals, now: generatedAt });
      return {
        groupId: safeGroupId,
        status: "recorded",
        signalCount: signals.length,
        ...recorded,
      };
    },
  };
}

function readRuntimeGate(canPlanProactiveSignals: (groupId: string) => boolean, groupId: string): boolean {
  try {
    return canPlanProactiveSignals(groupId);
  } catch {
    return false;
  }
}

function requireIdentifier(name: string, value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 512) throw new Error(`${name} is invalid`);
  return normalized;
}

function requireLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error("limit is invalid");
  }
  return value;
}

function requirePositiveMinutes(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 60 * 24 * 30) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("proactive signal scan time must be valid");
  }
  return new Date(value);
}
