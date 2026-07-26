import { describe, expect, it } from "vitest";

import {
  createAgentExecutionObserver,
} from "../src/agent-runtime/agent-execution-observer.js";
import type {
  AgentExecutionLedgerEvent,
  AgentExecutionLedgerRepository,
  RecordAgentExecutionLedgerEventInput,
} from "../src/agent-runtime/agent-execution-ledger-repository.js";

const observedAt = new Date("2026-07-27T11:00:00.000Z");

describe("AgentExecutionObserver", () => {
  it("fills stable envelope fields and records content-free metadata", async () => {
    const recorded: RecordAgentExecutionLedgerEventInput[] = [];
    const observer = createAgentExecutionObserver({
      repository: recordingRepository(recorded),
      tenantKey: "quello",
      now: () => observedAt,
      createId: () => "ledger-event-1",
    });

    await observer.observe({
      groupId: "oc_pilot",
      actorOpenId: "ou_actor",
      subjectType: "turn",
      subjectId: "om_123",
      eventType: "turn_started",
      phase: "context_assembly",
      operationKey: "turn:om_123:started",
      metadata: { route: "mention", liveChatCount: 3 },
    });

    expect(recorded).toEqual([{
      id: "ledger-event-1",
      tenantKey: "quello",
      groupId: "oc_pilot",
      actorOpenId: "ou_actor",
      subjectType: "turn",
      subjectId: "om_123",
      eventType: "turn_started",
      phase: "context_assembly",
      operationKey: "turn:om_123:started",
      metadata: { route: "mention", liveChatCount: 3 },
      at: observedAt,
    }]);
    expect(JSON.stringify(recorded)).not.toMatch(
      /promptContext|answerText|rawContent|documentBody|authorization/iu,
    );
  });

  it("uses explicit envelope fields when a caller already has stable values", async () => {
    const recorded: RecordAgentExecutionLedgerEventInput[] = [];
    const observer = createAgentExecutionObserver({
      repository: recordingRepository(recorded),
      tenantKey: "default",
      now: () => observedAt,
      createId: () => "generated-id",
    });
    const explicitAt = new Date("2026-07-27T11:01:00.000Z");

    await observer.observe({
      id: "explicit-id",
      tenantKey: "tenant-explicit",
      subjectType: "provider_request",
      subjectId: "om_123",
      eventType: "provider_request_completed",
      operationKey: "turn:om_123:provider:completed",
      metadata: {},
      at: explicitAt,
    });

    expect(recorded[0]).toMatchObject({
      id: "explicit-id",
      tenantKey: "tenant-explicit",
      at: explicitAt,
    });
  });

  it("reports repository failures without rejecting the observed business path", async () => {
    const failures: Array<{ error: unknown; at: Date }> = [];
    const storageError = new Error("database unavailable");
    const observer = createAgentExecutionObserver({
      repository: {
        async recordEvent() {
          throw storageError;
        },
      },
      now: () => observedAt,
      createId: () => "ledger-event-2",
      onWriteFailure: (failure) => {
        failures.push(failure);
      },
    });

    await expect(observer.observe({
      subjectType: "turn",
      subjectId: "om_failed",
      eventType: "turn_failed",
      outcome: "error",
      operationKey: "turn:om_failed:failed",
      metadata: { reason: "provider_unavailable" },
    })).resolves.toBeUndefined();
    expect(failures).toEqual([{ error: storageError, at: observedAt }]);
  });
});

function recordingRepository(
  recorded: RecordAgentExecutionLedgerEventInput[],
): AgentExecutionLedgerRepository {
  return {
    async recordEvent(input) {
      recorded.push(input);
      return {
        outcome: "applied",
        event: toEvent(input),
      };
    },
    async listEvents() {
      return [];
    },
  };
}

function toEvent(input: RecordAgentExecutionLedgerEventInput): AgentExecutionLedgerEvent {
  const { at, ...event } = input;
  return {
    ...event,
    createdAt: new Date(at),
  };
}
