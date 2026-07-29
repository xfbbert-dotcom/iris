import { describe, expect, it, vi } from "vitest";

import {
  createPostgresWikiSpaceAuthorizationRepository,
  type WikiSpaceAuthorizationDataSource,
} from "../src/documents/wiki-space-authorization-repository.js";

const at = new Date("2026-07-29T08:00:00.000Z");
const later = new Date("2026-07-29T09:00:00.000Z");

describe("createPostgresWikiSpaceAuthorizationRepository", () => {
  it("registers a root idempotently without re-enabling an admin-disabled root", async () => {
    const dataSource = createDataSource([
      { rows: [row()] },
      { rows: [row({ enabled: false, scan_state: "disabled", revision: "2", updated_at: at })] },
      { rows: [] },
      { rows: [row({ enabled: false, scan_state: "disabled", revision: "2", updated_at: at })] },
    ]);
    const repository = createPostgresWikiSpaceAuthorizationRepository({ dataSource });

    const first = await repository.register({
      rootSourceUri: "https://tenant.feishu.cn/wiki/root_1",
      rootNodeToken: "root_1",
      at,
    });
    await repository.setEnabled({ id: first.authorization.id, enabled: false, at });
    const repeated = await repository.register({
      rootSourceUri: "https://tenant.feishu.cn/wiki/root_1",
      rootNodeToken: "root_1",
      at: later,
    });

    expect(first.created).toBe(true);
    expect(repeated.created).toBe(false);
    expect(repeated.authorization.enabled).toBe(false);
    expect(repeated.authorization.scanState).toBe("disabled");
  });

  it("claims due or expired work with a skip-locked lease while excluding disabled and dead-letter roots", async () => {
    const dataSource = createDataSource([
      { rows: [row({ scan_state: "scanning", attempt_count: "2", revision: "4", lease_expires_at: later })] },
    ]);
    const repository = createPostgresWikiSpaceAuthorizationRepository({ dataSource });

    await expect(repository.claimNext({
      at,
      leaseExpiresAt: later,
      maxAttempts: 3,
    })).resolves.toMatchObject({
      scanState: "scanning",
      attemptCount: 2,
      revision: 4,
      leaseExpiresAt: later,
    });

    const sql = String(dataSource.query.mock.calls[0]?.[0]).toLowerCase();
    expect(sql).toContain("for update skip locked");
    expect(sql).toContain("scan_state in ('pending', 'retry_wait')");
    expect(sql).toContain("scan_state = 'scanning'");
    expect(sql).toContain("lease_expires_at <= $1");
    expect(sql).toContain("enabled = true");
    expect(sql).toContain("scan_state not in ('disabled', 'dead_letter')");
    expect(sql).toContain("attempt_count < $3");
  });

  it("requires the matching optimistic revision to complete or fail a claimed root", async () => {
    const dataSource = createDataSource([{ rows: [] }, { rows: [] }]);
    const repository = createPostgresWikiSpaceAuthorizationRepository({ dataSource });

    await expect(repository.complete({
      id: "authorization-1",
      revision: 4,
      at,
      nextScanAt: later,
      spaceId: "space-1",
      discoveredNodeCount: 3,
      registeredDocumentCount: 2,
      skippedNodeCount: 1,
    })).rejects.toThrow("stale wiki space authorization");
    await expect(repository.fail({
      id: "authorization-1",
      revision: 4,
      at,
      classification: "retryable_remote_failure",
      retryAt: later,
    })).rejects.toThrow("stale wiki space authorization");

    const sql = dataSource.query.mock.calls.map(([statement]) => String(statement).toLowerCase()).join("\n");
    expect(sql).toContain("where id = $1");
    expect(sql).toContain("revision = $2");
    expect(sql).toContain("scan_state = 'scanning'");
    expect(sql).toContain("scan_state = 'synced'");
    expect(dataSource.query.mock.calls[1]?.[1]).toEqual([
      "authorization-1",
      4,
      at,
      "retry_wait",
      later,
      "retryable_remote_failure",
    ]);
  });

  it("returns zero-filled status counts for every durable scan state", async () => {
    const dataSource = createDataSource([
      { rows: [{ scan_state: "pending", count: "2" }, { scan_state: "synced", count: "1" }] },
    ]);
    const repository = createPostgresWikiSpaceAuthorizationRepository({ dataSource });

    await expect(repository.getStatusCounts()).resolves.toEqual({
      pending: 2,
      scanning: 0,
      synced: 1,
      retry_wait: 0,
      dead_letter: 0,
      disabled: 0,
    });
  });

  it("rejects invalid limits and timestamps before querying Postgres", async () => {
    const dataSource = createDataSource([]);
    const repository = createPostgresWikiSpaceAuthorizationRepository({ dataSource });

    await expect(repository.list({ limit: Number.NaN })).rejects.toThrow("limit must be a finite integer");
    await expect(repository.claimNext({
      at: new Date("invalid"),
      leaseExpiresAt: later,
      maxAttempts: 1,
    })).rejects.toThrow("at must be a valid date");
    expect(dataSource.query).not.toHaveBeenCalled();
  });
});

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "authorization-1",
    root_source_uri: "https://tenant.feishu.cn/wiki/root_1",
    root_node_token: "root_1",
    space_id: null,
    title: null,
    enabled: true,
    scan_state: "pending",
    attempt_count: "0",
    next_scan_at: at,
    lease_expires_at: null,
    last_scan_started_at: null,
    last_scan_completed_at: null,
    last_success_at: null,
    last_error_classification: null,
    discovered_node_count: "0",
    registered_document_count: "0",
    skipped_node_count: "0",
    revision: "1",
    created_at: at,
    updated_at: at,
    ...overrides,
  };
}

function createDataSource(results: Array<{ rows: Array<Record<string, unknown>> }>): WikiSpaceAuthorizationDataSource & {
  query: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const query = vi.fn(async (_statement: string, _values?: unknown[]) => results[index++] ?? { rows: [] });
  return { query } as unknown as WikiSpaceAuthorizationDataSource & { query: ReturnType<typeof vi.fn> };
}
