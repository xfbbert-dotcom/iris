import { randomUUID } from "node:crypto";

import type {
  AgentExecutionLedgerRepository,
  RecordAgentExecutionLedgerEventInput,
} from "./agent-execution-ledger-repository.js";

export type AgentExecutionObservation = Omit<
  RecordAgentExecutionLedgerEventInput,
  "id" | "tenantKey" | "at"
> & {
  id?: string;
  tenantKey?: string;
  at?: Date;
};

export interface AgentExecutionObserver {
  observe(input: AgentExecutionObservation): Promise<void>;
}

export type AgentExecutionObserverWriteFailure = {
  error: unknown;
  at: Date;
};

export function createAgentExecutionObserver({
  repository,
  tenantKey = "default",
  now = () => new Date(),
  createId = randomUUID,
  onWriteFailure,
}: {
  repository: Pick<AgentExecutionLedgerRepository, "recordEvent">;
  tenantKey?: string;
  now?: () => Date;
  createId?: () => string;
  onWriteFailure?: (failure: AgentExecutionObserverWriteFailure) => void;
}): AgentExecutionObserver {
  return {
    async observe(input) {
      const {
        id = createId(),
        tenantKey: eventTenantKey = tenantKey,
        at = now(),
        ...event
      } = input;
      try {
        await repository.recordEvent({
          id,
          tenantKey: eventTenantKey,
          at,
          ...event,
        });
      } catch (error) {
        try {
          onWriteFailure?.({ error, at: new Date(now()) });
        } catch {
          // Observability must not replace the business result with its own failure.
        }
      }
    },
  };
}
