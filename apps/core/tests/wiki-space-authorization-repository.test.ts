import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createPostgresWikiSpaceAuthorizationRepository,
  type WikiSpaceAuthorization,
  type WikiSpaceAuthorizationDataSource,
  type WikiSpaceAuthorizationRepository,
} from "../src/documents/wiki-space-authorization-repository.js";
import {
  defaultMigrationsDir,
  runMigrations,
  type MigrationClient,
} from "../src/database/migrate.js";

const at = new Date("2026-07-29T08:00:00.000Z");
const later = new Date("2026-07-29T09:00:00.000Z");
const databaseUrl = process.env.IRIS_TEST_DATABASE_URL?.trim();
const runIfDatabase = databaseUrl ? describe.sequential : describe.skip;
const schema = `wiki_space_sync_${randomUUID().replaceAll("-", "")}`;

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
    expect(sql).toContain("scan_state in ('pending', 'retry_wait', 'synced')");
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

runIfDatabase("Postgres wiki space authorization state transitions", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let repository: WikiSpaceAuthorizationRepository;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: databaseUrl });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const isolatedUrl = new URL(databaseUrl!);
    isolatedUrl.searchParams.set("options", `-c search_path=${schema},public`);
    pool = new pg.Pool({ connectionString: isolatedUrl.toString() });
    await runMigrations({
      client: pool as unknown as MigrationClient,
      migrationsDir: defaultMigrationsDir(),
    });
    repository = createPostgresWikiSpaceAuthorizationRepository({
      dataSource: pool as unknown as WikiSpaceAuthorizationDataSource,
    });
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool?.end();
  });

  it("resets attempts after every success so periodic refreshes continue past the attempt cap", async () => {
    const rootSourceUri = uniqueRoot("repeated-success");
    const registered = await repository.register({
      rootSourceUri,
      rootNodeToken: "repeated-success",
      at,
    });
    let dueAt = at;

    for (let refresh = 0; refresh < 7; refresh += 1) {
      const claimed = await repository.claimNext({
        at: dueAt,
        leaseExpiresAt: plusMs(dueAt, 600_000),
        maxAttempts: 5,
      });
      expect(claimed).toMatchObject({
        id: registered.authorization.id,
        attemptCount: 1,
        scanState: "scanning",
      });
      const nextScanAt = plusMs(dueAt, 21_600_000);
      const completed = await completeClaim(repository, claimed!, dueAt, nextScanAt);
      expect(completed).toMatchObject({
        attemptCount: 0,
        scanState: "synced",
        nextScanAt,
      });
      dueAt = nextScanAt;
    }
  });

  it("starts a fresh claim series after manual rescan and disabled-to-enabled recovery", async () => {
    const manual = await createDeadLetter(repository, "manual-recovery", at);
    const manualRecoveryAt = plusMs(at, 1_000);
    const rescanned = await repository.requestScan({
      id: manual.id,
      at: manualRecoveryAt,
    });
    expect(rescanned).toMatchObject({ attemptCount: 0, scanState: "pending" });
    await expect(repository.claimNext({
      at: manualRecoveryAt,
      leaseExpiresAt: plusMs(manualRecoveryAt, 600_000),
      maxAttempts: 1,
    })).resolves.toMatchObject({ id: manual.id, attemptCount: 1 });

    const toggled = await createDeadLetter(repository, "toggle-recovery", plusMs(at, 10_000));
    const disabledAt = plusMs(at, 11_000);
    await repository.setEnabled({ id: toggled.id, enabled: false, at: disabledAt });
    const enabledAt = plusMs(at, 12_000);
    const enabled = await repository.setEnabled({ id: toggled.id, enabled: true, at: enabledAt });
    expect(enabled).toMatchObject({ attemptCount: 0, scanState: "pending", nextScanAt: enabledAt });
    await expect(repository.claimNext({
      at: enabledAt,
      leaseExpiresAt: plusMs(enabledAt, 600_000),
      maxAttempts: 1,
    })).resolves.toMatchObject({ id: toggled.id, attemptCount: 1 });
  });

  it("atomically dead-letters an expired final-attempt lease under concurrent claims", async () => {
    const registered = await repository.register({
      rootSourceUri: uniqueRoot("final-lease"),
      rootNodeToken: "final-lease",
      at,
    });
    const claimed = await repository.claimNext({
      at,
      leaseExpiresAt: plusMs(at, 1_000),
      maxAttempts: 1,
    });
    expect(claimed).toMatchObject({ id: registered.authorization.id, attemptCount: 1 });

    const recoveryAt = plusMs(at, 2_000);
    const secondRepository = createPostgresWikiSpaceAuthorizationRepository({
      dataSource: pool as unknown as WikiSpaceAuthorizationDataSource,
    });
    await expect(Promise.all([
      repository.claimNext({
        at: recoveryAt,
        leaseExpiresAt: plusMs(recoveryAt, 600_000),
        maxAttempts: 1,
      }),
      secondRepository.claimNext({
        at: recoveryAt,
        leaseExpiresAt: plusMs(recoveryAt, 600_000),
        maxAttempts: 1,
      }),
    ])).resolves.toEqual([undefined, undefined]);

    const exhausted = (await repository.list({ limit: 100 }))
      .find((authorization) => authorization.id === registered.authorization.id);
    expect(exhausted).toMatchObject({
      scanState: "dead_letter",
      attemptCount: 1,
      lastErrorClassification: "lease_expired",
      lastScanCompletedAt: recoveryAt,
    });
    expect(exhausted).not.toHaveProperty("leaseExpiresAt");
  });

  it("re-registers enabled roots as fresh scans while preserving disabled rows exactly", async () => {
    const enabled = await createDeadLetter(repository, "reregister-enabled", at);
    const repeatedAt = plusMs(at, 1_000);
    const repeated = await repository.register({
      rootSourceUri: enabled.rootSourceUri,
      rootNodeToken: enabled.rootNodeToken,
      at: repeatedAt,
    });
    expect(repeated).toMatchObject({
      created: false,
      authorization: {
        id: enabled.id,
        enabled: true,
        scanState: "pending",
        attemptCount: 0,
        nextScanAt: repeatedAt,
        revision: enabled.revision + 1,
      },
    });

    const disabledRegistered = await repository.register({
      rootSourceUri: uniqueRoot("reregister-disabled"),
      rootNodeToken: "reregister-disabled",
      at,
    });
    const disabled = await repository.setEnabled({
      id: disabledRegistered.authorization.id,
      enabled: false,
      at: plusMs(at, 2_000),
    });
    const disabledRepeated = await repository.register({
      rootSourceUri: disabled!.rootSourceUri,
      rootNodeToken: disabled!.rootNodeToken,
      at: plusMs(at, 3_000),
    });
    expect(disabledRepeated).toEqual({ authorization: disabled, created: false });
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

async function createDeadLetter(
  repository: WikiSpaceAuthorizationRepository,
  token: string,
  startedAt: Date,
): Promise<WikiSpaceAuthorization> {
  const registered = await repository.register({
    rootSourceUri: uniqueRoot(token),
    rootNodeToken: token,
    at: startedAt,
  });
  const claimed = await repository.claimNext({
    at: startedAt,
    leaseExpiresAt: plusMs(startedAt, 600_000),
    maxAttempts: 1,
  });
  expect(claimed).toMatchObject({ id: registered.authorization.id, attemptCount: 1 });
  return repository.fail({
    id: claimed!.id,
    revision: claimed!.revision,
    at: plusMs(startedAt, 500),
    classification: "forbidden",
  });
}

function completeClaim(
  repository: WikiSpaceAuthorizationRepository,
  claimed: WikiSpaceAuthorization,
  completedAt: Date,
  nextScanAt: Date,
): Promise<WikiSpaceAuthorization> {
  return repository.complete({
    id: claimed.id,
    revision: claimed.revision,
    at: completedAt,
    nextScanAt,
    spaceId: "space-1",
    discoveredNodeCount: 1,
    registeredDocumentCount: 1,
    skippedNodeCount: 0,
  });
}

function uniqueRoot(token: string): string {
  return `https://tenant.feishu.cn/wiki/${token}-${randomUUID()}`;
}

function plusMs(value: Date, milliseconds: number): Date {
  return new Date(value.getTime() + milliseconds);
}
