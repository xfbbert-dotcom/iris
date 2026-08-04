# Iris Durable Runtime Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist Iris runtime-control policy in a versioned Postgres singleton while preserving process-local, fail-closed global activation after every Core restart.

**Architecture:** A strict Postgres repository owns the durable desired snapshot, while the existing synchronous `RuntimeController` remains the only message-path gate. A small coordinator performs compare-and-swap writes before ordinary live mutations, applies emergency global disable in memory first, and reports persistence health without ever substituting permissive defaults. Production startup composes that repository before `buildApp`, restores only group/capability policy, and always initializes the live global gate to disabled.

**Tech Stack:** TypeScript 5.5, Node.js 24, Fastify 5, PostgreSQL 16, `pg`, Vitest, Docker Compose, Bash/PowerShell deployment tooling.

## Global Constraints

- The approved design is `docs/superpowers/specs/2026-07-13-iris-durable-runtime-control-design.md`; implementation must not broaden its scope.
- Core message processing must remain synchronous and must not perform a database call per Feishu event.
- A production Core process must start with live `globalEnabled=false`, regardless of durable `desiredGlobalEnabled`.
- Missing, malformed, or unavailable durable state must fail startup closed; no in-memory permissive fallback is allowed in production composition.
- Ordinary and authority-increasing mutations persist before changing live state.
- Emergency global disable changes live state before persistence and remains disabled when persistence fails or conflicts.
- Compare-and-swap conflicts return HTTP `409`; infrastructure failures return HTTP `503` with stable error codes.
- The singleton row contains no secret, bearer token, database URL, or model credential.
- Local unit tests may use an explicit in-memory coordinator; production composition must use Postgres.
- Public `/internal/*` routes remain inaccessible through Caddy.
- The existing Iris pilot remains online until local tests, CI, backup, deploy, and rollback gates pass.
- No deployment may merge PR #4 or change the approved production commit without explicit user authorization.

---

## File Map

- `apps/core/migrations/0016_runtime_control_state.sql`: singleton table, constraints, and conservative seed row.
- `apps/core/src/admin/runtime-control-state-repository.ts`: durable snapshot types, repository interface, capability constants, and strict decoder contract.
- `apps/core/src/admin/postgres-runtime-control-state-repository.ts`: Postgres read and optimistic compare-and-swap implementation.
- `apps/core/src/admin/runtime-controller.ts`: synchronous live gate plus atomic durable-policy replacement and durable metadata.
- `apps/core/src/admin/runtime-control-service.ts`: in-memory and durable mutation/status coordinators.
- `apps/core/src/runtime/runtime-control-runtime.ts`: production Postgres composition, startup restore, and pool cleanup.
- `apps/core/src/app.ts`: HTTP mappings, aggregate status, startup composition, and cleanup wiring.
- `apps/core/tests/runtime-control-*.test.ts`: controller, repository, coordinator, API, and startup contracts.
- `apps/core/tests/migration-runner.test.ts`: migration structure/default assertions.
- `deploy/pilot/backup.sh`, `scripts/pilot-smoke*.mjs`, and deployment docs: operator and rollback contracts.

---

### Task 1: Create The Singleton Runtime-Control Migration

**Files:**
- Create: `apps/core/migrations/0016_runtime_control_state.sql`
- Modify: `apps/core/tests/migration-runner.test.ts`

**Interfaces:**
- Consumes: the existing lexical migration runner in `apps/core/src/database/migrate.ts`.
- Produces: exactly one row keyed by `singleton_id = 1`, revision `0`, desired global disabled, no disabled groups, and the approved capability defaults.

- [ ] **Step 1: Write the failing migration contract test**

Add this test under `describe("defaultMigrationsDir")`:

```ts
it("includes the conservative singleton runtime-control state", async () => {
  const migration = await readFile(
    join(defaultMigrationsDir(), "0016_runtime_control_state.sql"),
    "utf8",
  );
  const normalized = migration.replace(/\s+/g, " ").trim().toLowerCase();

  expect(normalized).toContain("create table runtime_control_state");
  expect(normalized).toContain("primary key check (singleton_id = 1)");
  expect(normalized).toContain("revision bigint not null check (revision >= 0)");
  expect(normalized).toContain("desired_global_enabled boolean not null");
  expect(normalized).toContain("disabled_group_ids text[] not null");
  expect(normalized).toContain("capabilities jsonb not null");
  expect(normalized).toContain("values (1, 0, false, array[]::text[]");
  expect(normalized).toContain("\"writeknowledgebase\":false");
  expect(normalized).toContain("\"callexternaltools\":false");
});
```

- [ ] **Step 2: Run the migration test and verify RED**

Run: `npm --workspace apps/core test -- tests/migration-runner.test.ts`

Expected: FAIL with `ENOENT` for `0016_runtime_control_state.sql`.

- [ ] **Step 3: Add the minimal migration**

Create:

```sql
create table runtime_control_state (
  singleton_id smallint primary key check (singleton_id = 1),
  revision bigint not null check (revision >= 0),
  desired_global_enabled boolean not null,
  disabled_group_ids text[] not null,
  capabilities jsonb not null,
  updated_at timestamptz not null,
  updated_by text null
);

insert into runtime_control_state (
  singleton_id,
  revision,
  desired_global_enabled,
  disabled_group_ids,
  capabilities,
  updated_at,
  updated_by
)
values (
  1,
  0,
  false,
  array[]::text[],
  '{"readGroupContext":true,"replyWhenMentioned":true,"readGroupDocuments":true,"retrieveKnowledgeBase":true,"proactiveSpeech":true,"generateKnowledgeDrafts":true,"writeKnowledgeBase":false,"callExternalTools":false}'::jsonb,
  now(),
  null
);
```

- [ ] **Step 4: Verify GREEN and migration ordering**

Run: `npm --workspace apps/core test -- tests/migration-runner.test.ts`

Expected: PASS, including the new migration contract.

- [ ] **Step 5: Commit**

```bash
git add apps/core/migrations/0016_runtime_control_state.sql apps/core/tests/migration-runner.test.ts
git commit -m "feat: add durable runtime control migration"
```

---

### Task 2: Add Strict Snapshot Decoding And Postgres Compare-And-Swap

**Files:**
- Create: `apps/core/src/admin/runtime-control-state-repository.ts`
- Create: `apps/core/src/admin/postgres-runtime-control-state-repository.ts`
- Create: `apps/core/tests/postgres-runtime-control-state-repository.test.ts`

**Interfaces:**
- Consumes: `IrisCapability` from `apps/core/src/config/runtime-config.ts` and a generic `queryable.query<T>()` dependency.
- Produces:

```ts
export type DurableRuntimeControlSnapshot = {
  revision: number;
  desiredGlobalEnabled: boolean;
  disabledGroupIds: string[];
  capabilities: IrisCapability;
  updatedAt: Date;
  updatedBy?: string;
};

export interface RuntimeControlStateRepository {
  getSnapshot(): Promise<DurableRuntimeControlSnapshot>;
  replaceSnapshot(input: {
    expectedRevision: number;
    next: Omit<DurableRuntimeControlSnapshot, "revision" | "updatedAt">;
  }): Promise<DurableRuntimeControlSnapshot | "conflict">;
}
```

- [ ] **Step 1: Write failing repository tests for valid decoding and strict rejection**

Create table-driven tests that call `createPostgresRuntimeControlStateRepository({ queryable })` and assert:

```ts
it("decodes the singleton row without sharing mutable values", async () => {
  const queryable = fakeQueryable([validRow()]);
  const repository = createPostgresRuntimeControlStateRepository({ queryable });

  const snapshot = await repository.getSnapshot();

  expect(snapshot).toEqual({
    revision: 4,
    desiredGlobalEnabled: true,
    disabledGroupIds: ["chat-a"],
    capabilities: defaultCapabilities(),
    updatedAt: new Date("2026-07-13T00:00:00.000Z"),
    updatedBy: "operator@example.com",
  });
});

it.each([
  ["unsafe revision", { revision: "9007199254740992" }],
  ["duplicate group", { disabled_group_ids: ["chat-a", "chat-a"] }],
  ["blank group", { disabled_group_ids: [" "] }],
  ["missing capability", { capabilities: { ...defaultCapabilities(), callExternalTools: undefined } }],
  ["unknown capability", { capabilities: { ...defaultCapabilities(), unknown: false } }],
  ["non-boolean capability", { capabilities: { ...defaultCapabilities(), proactiveSpeech: "false" } }],
  ["invalid timestamp", { updated_at: "not-a-date" }],
  ["blank operator", { updated_by: " " }],
])("rejects %s", async (_label, override) => {
  const repository = createPostgresRuntimeControlStateRepository({
    queryable: fakeQueryable([{ ...validRow(), ...override }]),
  });
  await expect(repository.getSnapshot()).rejects.toThrow("invalid runtime control snapshot");
});
```

- [ ] **Step 2: Run the repository tests and verify RED**

Run: `npm --workspace apps/core test -- tests/postgres-runtime-control-state-repository.test.ts`

Expected: FAIL because both repository modules are missing.

- [ ] **Step 3: Implement capability constants and the strict decoder**

Define the exact ordered key list and decoder:

```ts
export const runtimeCapabilityNames = [
  "readGroupContext",
  "replyWhenMentioned",
  "readGroupDocuments",
  "retrieveKnowledgeBase",
  "proactiveSpeech",
  "generateKnowledgeDrafts",
  "writeKnowledgeBase",
  "callExternalTools",
] as const satisfies readonly (keyof IrisCapability)[];

export const runtimeControlUpdatedByMaxChars = 256;

export function decodeDurableRuntimeControlSnapshot(row: unknown): DurableRuntimeControlSnapshot {
  // Read an object row, parse bigint through Number, require a non-negative safe integer,
  // normalize and sort unique non-blank group IDs, require exactly runtimeCapabilityNames,
  // clone booleans, parse a valid Date, and omit updatedBy only when the DB value is null.
  // Every violation throws Error("invalid runtime control snapshot: <field>").
}
```

The implementation must reject rather than default any unknown/missing field and must never return the row's array/object references.

- [ ] **Step 4: Implement Postgres read and CAS, then test success/conflict**

Use these SQL shapes:

```ts
const readSql = `
select revision, desired_global_enabled, disabled_group_ids, capabilities, updated_at, updated_by
from runtime_control_state
where singleton_id = 1
`;

const replaceSql = `
update runtime_control_state
set revision = revision + 1,
    desired_global_enabled = $2,
    disabled_group_ids = $3,
    capabilities = $4::jsonb,
    updated_at = now(),
    updated_by = $5
where singleton_id = 1 and revision = $1
returning revision, desired_global_enabled, disabled_group_ids, capabilities, updated_at, updated_by
`;
```

Add tests proving the expected revision is parameter `$1`, the whole snapshot is supplied, one returned row is decoded, and zero rows yields exactly `"conflict"`.

- [ ] **Step 5: Verify GREEN and type safety**

Run:

```bash
npm --workspace apps/core test -- tests/postgres-runtime-control-state-repository.test.ts
npm run typecheck
```

Expected: both commands PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/core/src/admin/runtime-control-state-repository.ts apps/core/src/admin/postgres-runtime-control-state-repository.ts apps/core/tests/postgres-runtime-control-state-repository.test.ts
git commit -m "feat: add runtime control state repository"
```

---

### Task 3: Extend The Synchronous Controller With Durable Metadata

**Files:**
- Modify: `apps/core/src/admin/runtime-controller.ts`
- Modify: `apps/core/tests/runtime-controller.test.ts`

**Interfaces:**
- Consumes: `DurableRuntimeControlSnapshot` from Task 2.
- Produces:

```ts
export type RuntimeControllerSnapshot = {
  globalEnabled: boolean;
  desiredGlobalEnabled: boolean;
  activationRequired: boolean;
  disabledGroupIds: string[];
  capabilities: IrisCapability;
  revision: number;
  updatedAt: Date;
  updatedBy?: string;
};

replaceDurablePolicy(snapshot: DurableRuntimeControlSnapshot): void;
```

- [ ] **Step 1: Write failing tests for startup restore and defensive copies**

```ts
it("restores durable policy without opening the live global gate", () => {
  const controller = new RuntimeController({
    ...createDefaultRuntimeConfig(),
    globalEnabled: false,
  });

  controller.replaceDurablePolicy(durableSnapshot({ desiredGlobalEnabled: true }));

  expect(controller.getSnapshot()).toMatchObject({
    globalEnabled: false,
    desiredGlobalEnabled: true,
    activationRequired: true,
    disabledGroupIds: ["chat-a"],
    revision: 7,
  });
  expect(controller.canProcessGroupMessage("chat-b")).toBe(false);
});
```

Add a second test mutating the input arrays/capability object and returned snapshot; neither mutation may change controller state.

- [ ] **Step 2: Run the controller tests and verify RED**

Run: `npm --workspace apps/core test -- tests/runtime-controller.test.ts`

Expected: FAIL because `replaceDurablePolicy` and metadata fields do not exist.

- [ ] **Step 3: Implement atomic durable-policy replacement**

The constructor initializes local-development metadata at revision `0` and `updatedAt` once. `replaceDurablePolicy` must replace disabled groups, capabilities, desired state, revision, timestamp, and operator as one synchronous operation. It never alters live `globalEnabled`; after a durable global-enable write succeeds, the coordinator opens that separate live gate explicitly.

Use:

```ts
replaceDurablePolicy(snapshot: DurableRuntimeControlSnapshot): void {
  this.config.disabledGroupIds = new Set(snapshot.disabledGroupIds);
  this.config.capabilities = { ...snapshot.capabilities };
  this.desiredGlobalEnabled = snapshot.desiredGlobalEnabled;
  this.revision = snapshot.revision;
  this.updatedAt = new Date(snapshot.updatedAt);
  this.updatedBy = snapshot.updatedBy;
}
```

`getSnapshot()` computes `activationRequired` as `desiredGlobalEnabled && !globalEnabled` and returns fresh arrays, objects, and `Date` values.

- [ ] **Step 4: Keep existing hot-path behavior green**

Run:

```bash
npm --workspace apps/core test -- tests/runtime-controller.test.ts tests/answer-draft-api.test.ts tests/event-worker-runtime.test.ts
```

Expected: PASS after updating only exact snapshot assertions that intentionally include new metadata.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/admin/runtime-controller.ts apps/core/tests/runtime-controller.test.ts apps/core/tests/answer-draft-api.test.ts
git commit -m "feat: track durable runtime policy metadata"
```

---

### Task 4: Implement Durable Mutation Coordination

**Files:**
- Create: `apps/core/src/admin/runtime-control-service.ts`
- Create: `apps/core/tests/runtime-control-service.test.ts`

**Interfaces:**
- Consumes: `RuntimeController`, `RuntimeControlStateRepository`, `RuntimeCapabilityName`.
- Produces:

```ts
export type RuntimeControlPersistence = {
  storage: "postgres" | "in_memory";
  ok: boolean;
  error?: "runtime_control_persistence_failed";
};

export type RuntimeControlStatus = RuntimeControllerSnapshot & {
  persistence: RuntimeControlPersistence;
};

export type RuntimeControlMutationResult =
  | { kind: "success"; durable: true; status: RuntimeControlStatus }
  | { kind: "conflict" }
  | { kind: "persistence_failed" }
  | { kind: "disable_not_persisted"; status: RuntimeControlStatus };

export interface RuntimeControlService {
  getStatus(): Promise<RuntimeControlStatus>;
  setGlobal(input: { enabled: boolean; updatedBy?: string }): Promise<RuntimeControlMutationResult>;
  setGroup(input: { groupId: string; enabled: boolean; updatedBy?: string }): Promise<RuntimeControlMutationResult>;
  setCapabilities(input: { updates: Partial<IrisCapability>; updatedBy?: string }): Promise<RuntimeControlMutationResult>;
}
```

- [ ] **Step 1: Write failing tests for persist-first ordinary mutations**

Test global enable, group enable/disable, and capability changes with a deferred repository promise. Before resolving persistence, assert the live controller is unchanged. After success, assert the exact returned durable snapshot is installed.

```ts
it("persists global enable before opening the live gate", async () => {
  const pending = deferred<DurableRuntimeControlSnapshot | "conflict">();
  const { controller, service, repository } = fixture({ replaceResult: pending.promise });

  const mutation = service.setGlobal({ enabled: true, updatedBy: "alice" });
  expect(controller.getSnapshot().globalEnabled).toBe(false);
  expect(repository.replaceSnapshot).toHaveBeenCalledWith(expect.objectContaining({
    expectedRevision: 3,
    next: expect.objectContaining({ desiredGlobalEnabled: true, updatedBy: "alice" }),
  }));

  pending.resolve(durableSnapshot({ revision: 4, desiredGlobalEnabled: true }));
  await expect(mutation).resolves.toMatchObject({ kind: "success", durable: true });
  expect(controller.getSnapshot().globalEnabled).toBe(true);
});
```

- [ ] **Step 2: Run coordinator tests and verify RED**

Run: `npm --workspace apps/core test -- tests/runtime-control-service.test.ts`

Expected: FAIL because `runtime-control-service.ts` does not exist.

- [ ] **Step 3: Implement snapshot construction and persist-first mutations**

For each ordinary mutation:

1. Clone the current controller snapshot.
2. Build a complete `next` durable snapshot with the requested update and bounded `updatedBy`.
3. Call `replaceSnapshot({ expectedRevision: current.revision, next })` exactly once.
4. Return `kind: "conflict"` for the typed conflict without touching live state.
5. Return `kind: "persistence_failed"` for thrown repository errors without touching live state.
6. On success call `replaceDurablePolicy`, then set the requested live global value only for `setGlobal`.

- [ ] **Step 4: Write failing emergency-disable and concurrency tests**

```ts
it("keeps emergency disable live when persistence fails", async () => {
  const { controller, service } = fixture({
    liveEnabled: true,
    replaceError: new Error("postgres unavailable"),
  });

  await expect(service.setGlobal({ enabled: false })).resolves.toMatchObject({
    kind: "disable_not_persisted",
    status: { globalEnabled: false, persistence: { storage: "postgres", ok: false } },
  });
  expect(controller.getSnapshot().globalEnabled).toBe(false);
});

it("allows only one mutation to win a shared revision", async () => {
  const first = service.setGroup({ groupId: "chat-a", enabled: false });
  const second = service.setGroup({ groupId: "chat-b", enabled: false });
  await expect(Promise.all([first, second])).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "success" }),
      expect.objectContaining({ kind: "conflict" }),
    ]),
  );
});
```

- [ ] **Step 5: Implement emergency disable and status read degradation**

Emergency disable calls `controller.disableGlobal()` before repository access. A persistence conflict or thrown error maps to `disable_not_persisted`; the live gate stays false. `getStatus()` reads the singleton once and, on success, exposes current durable proof without enabling the live gate. On failure it returns the last validated controller metadata with:

```ts
{
  storage: "postgres",
  ok: false,
  error: "runtime_control_persistence_failed",
}
```

Add `createInMemoryRuntimeControlService(controller, now)` for unit/local app composition. It must preserve the same API shape, use revision increments in memory, and report `storage: "in_memory"`.

- [ ] **Step 6: Verify GREEN**

Run: `npm --workspace apps/core test -- tests/runtime-control-service.test.ts`

Expected: PASS for persist-first ordering, emergency disable, conflict, infrastructure failure, concurrent mutation, and degraded status.

- [ ] **Step 7: Commit**

```bash
git add apps/core/src/admin/runtime-control-service.ts apps/core/tests/runtime-control-service.test.ts
git commit -m "feat: coordinate durable runtime mutations"
```

---

### Task 5: Map Durable Semantics Into The Internal API And Aggregate Status

**Files:**
- Modify: `apps/core/src/app.ts`
- Modify: `apps/core/tests/runtime-control-api.test.ts`
- Modify: `apps/core/tests/internal-status-snapshot.test.ts`
- Modify: `apps/core/tests/answer-draft-api.test.ts`

**Interfaces:**
- Consumes: `RuntimeControlService` from Task 4, optionally injected as `runtimeControlService?: RuntimeControlService` in `BuildAppDependencies`.
- Produces: stable HTTP `200/409/503` mappings and a degraded aggregate runtime-control component when persistence is unavailable.

- [ ] **Step 1: Write failing HTTP mapping tests**

Add focused tests for:

```ts
expect(conflictResponse.statusCode).toBe(409);
expect(conflictResponse.json()).toEqual({ ok: false, error: "runtime_control_conflict" });

expect(failedResponse.statusCode).toBe(503);
expect(failedResponse.json()).toEqual({
  ok: false,
  error: "runtime_control_persistence_failed",
});

expect(disableResponse.statusCode).toBe(503);
expect(disableResponse.json()).toMatchObject({
  ok: false,
  error: "runtime_control_disable_not_persisted",
  globalEnabled: false,
  durable: false,
});
```

Also assert successful mutations add `durable: true`, and a degraded status read remains HTTP `200` with the live gate plus `persistence.ok=false`.

- [ ] **Step 2: Run API tests and verify RED**

Run: `npm --workspace apps/core test -- tests/runtime-control-api.test.ts`

Expected: FAIL because routes still mutate the controller directly.

- [ ] **Step 3: Replace direct route mutation with the service**

Compose an in-memory service only when no service is injected:

```ts
const runtimeControlService =
  dependencies.runtimeControlService ?? createInMemoryRuntimeControlService(runtimeController, now);
```

For each route, await the service result and map it through one helper:

```ts
function sendRuntimeControlMutationResult(reply: FastifyReply, result: RuntimeControlMutationResult) {
  if (result.kind === "success") {
    return reply.send({ ok: true, durable: true, ...result.status });
  }
  if (result.kind === "conflict") {
    return reply.code(409).send({ ok: false, error: "runtime_control_conflict" });
  }
  if (result.kind === "persistence_failed") {
    return reply.code(503).send({ ok: false, error: "runtime_control_persistence_failed" });
  }
  return reply.code(503).send({
    ok: false,
    error: "runtime_control_disable_not_persisted",
    globalEnabled: false,
    durable: false,
  });
}
```

Keep audit recording after service success or emergency-disable application. Do not record a successful policy change for an ordinary conflict/failure.

- [ ] **Step 4: Degrade aggregate status on persistence failure**

`GET /internal/status` awaits `runtimeControlService.getStatus()` once. Set the component's `ok` to `status.persistence.ok`, keep all existing fields, add durable metadata, and include `degradedReason: "runtime_control_persistence_failed"` only when the read fails.

- [ ] **Step 5: Verify GREEN and unchanged public boundaries**

Run:

```bash
npm --workspace apps/core test -- tests/runtime-control-api.test.ts tests/internal-status-snapshot.test.ts tests/answer-draft-api.test.ts
npm run typecheck
```

Expected: PASS. Existing runtime gate tests still prove disabled Iris does not answer.

- [ ] **Step 6: Commit**

```bash
git add apps/core/src/app.ts apps/core/tests/runtime-control-api.test.ts apps/core/tests/internal-status-snapshot.test.ts apps/core/tests/answer-draft-api.test.ts
git commit -m "feat: expose durable runtime control status"
```

---

### Task 6: Compose Fail-Closed Postgres Runtime Control At Server Startup

**Files:**
- Create: `apps/core/src/runtime/runtime-control-runtime.ts`
- Create: `apps/core/tests/runtime-control-runtime.test.ts`
- Modify: `apps/core/src/app.ts`
- Modify: `apps/core/tests/server-startup.test.ts`

**Interfaces:**
- Consumes: `readDatabaseConfig`, `createPostgresPool`, Postgres repository, controller, and durable service.
- Produces:

```ts
export type RuntimeControlRuntime = {
  runtimeController: RuntimeController;
  runtimeControlService: RuntimeControlService;
  close(): Promise<void>;
};

export async function createRuntimeControlRuntime(input?: {
  env?: NodeJS.ProcessEnv;
  createPool?: typeof createPostgresPool;
}): Promise<RuntimeControlRuntime>;
```

- [ ] **Step 1: Write failing runtime composition tests**

Cover:

```ts
it("restores groups and capabilities while forcing live global disabled", async () => {
  const runtime = await createRuntimeControlRuntime(fixtureWithSnapshot({
    desiredGlobalEnabled: true,
    disabledGroupIds: ["chat-a"],
    capabilities: { ...defaultCapabilities(), proactiveSpeech: false },
  }));

  expect(runtime.runtimeController.getSnapshot()).toMatchObject({
    globalEnabled: false,
    desiredGlobalEnabled: true,
    activationRequired: true,
    disabledGroupIds: ["chat-a"],
    capabilities: expect.objectContaining({ proactiveSpeech: false }),
  });
});

it.each([new Error("postgres unavailable"), new Error("invalid runtime control snapshot")])(
  "fails startup closed when durable state cannot be loaded",
  async (error) => {
    await expect(createRuntimeControlRuntime(fixtureThatThrows(error))).rejects.toBe(error);
    expect(closePool).toHaveBeenCalledOnce();
  },
);
```

- [ ] **Step 2: Run runtime tests and verify RED**

Run: `npm --workspace apps/core test -- tests/runtime-control-runtime.test.ts`

Expected: FAIL because the runtime module is missing.

- [ ] **Step 3: Implement production composition and cleanup**

The factory must:

1. Read and validate `DATABASE_URL`.
2. Create one Postgres pool.
3. Create the repository and await `getSnapshot()`.
4. Construct `RuntimeController` from `createDefaultRuntimeConfig({ IRIS_RUNTIME_GLOBAL_ENABLED: "false" })`.
5. Apply the durable snapshot without opening the live global gate.
6. Create the durable service.
7. Close the pool if any startup step throws.
8. Return an idempotent `close()` that ends the pool once.

Migration execution stays in the existing Compose `migrate` service; Core must fail closed if migration `0016` did not run.

- [ ] **Step 4: Inject the runtime into `startServer` after preflight validation**

Extend `StartServerOptions` with:

```ts
createRuntimeControlRuntime?: () => Promise<RuntimeControlRuntime>;
```

After host/port/auth preflight succeeds, await the factory, then call:

```ts
const runtimeControlRuntime = await runtimeControlRuntimeFactory();
const app = buildApp({
  ...appDependencies,
  internalApiToken,
  runtimeController: runtimeControlRuntime.runtimeController,
  runtimeControlService: runtimeControlRuntime.runtimeControlService,
  closeRuntimeControl: () => runtimeControlRuntime.close(),
});
```

Add `closeRuntimeControl?: () => Promise<void>` to `BuildAppDependencies` and the existing `onClose` cleanup list. If `buildApp` throws before returning, close the runtime directly and preserve both errors with `AggregateError`.

- [ ] **Step 5: Write startup ordering and cleanup tests**

Update `server-startup.test.ts` to prove:

- invalid port does not call `createRuntimeControlRuntime`;
- durable state failure prevents HTTP listen and worker composition;
- listener bind failure closes runtime-control resources once;
- normal `app.close()` closes runtime-control resources once;
- simultaneous listen and cleanup failures remain an `AggregateError` in causal order.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
npm --workspace apps/core test -- tests/runtime-control-runtime.test.ts tests/server-startup.test.ts tests/runtime-startup-promise.test.ts
npm run typecheck
npm run build
```

Expected: all commands PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/core/src/runtime/runtime-control-runtime.ts apps/core/tests/runtime-control-runtime.test.ts apps/core/src/app.ts apps/core/tests/server-startup.test.ts
git commit -m "feat: restore runtime policy fail closed"
```

---

### Task 7: Harden Pilot Operations, Verify, Publish, And Roll Out

**Files:**
- Modify: `deploy/pilot/backup.sh`
- Modify: `scripts/pilot-smoke-lib.test.mjs`
- Modify: `scripts/pilot-smoke.mjs`
- Modify: `scripts/pilot-operations.test.mjs`
- Modify: `deploy/pilot/README.md`
- Modify: `docs/deployment/iris-pilot-deployment-log.md`
- Modify: `docs/superpowers/specs/2026-07-13-iris-durable-runtime-control-design.md` only if implementation reveals a genuine architecture amendment.

**Interfaces:**
- Consumes: the durable API/status contract and existing backup-first deployment scripts.
- Produces: fail-closed backup/restart/rollback checks, operator reactivation instructions, CI evidence, and a commit-pinned pilot rollout.

- [ ] **Step 1: Write failing pilot script contract tests**

Add assertions that planned backup/runtime restoration:

- records both live `globalEnabled` and durable `revision` before maintenance;
- never treats `desiredGlobalEnabled=true` as permission to auto-enable after restart;
- requires `persistence.storage === "postgres"` and `persistence.ok === true` before explicit enable;
- keeps Caddy stopped and Iris disabled after backup, migration, or status failure;
- accepts the new successful mutation field `durable: true`.

Run: `npm run test:pilot`

Expected: FAIL until scripts understand the durable fields.

- [ ] **Step 2: Update backup, smoke, and operator documentation**

Document the exact restart sequence:

```text
1. POST global false and require live globalEnabled=false.
2. Stop Caddy.
3. Verify workers, queues, and DLQs.
4. Create paired Postgres backup and record approved app/image SHA.
5. Deploy migration and Core while Caddy remains stopped.
6. Verify persistence.ok=true, globalEnabled=false, and activationRequired matches desired intent.
7. Start Caddy only after authenticated internal gates pass.
8. Explicitly POST global true; require HTTP 200 and durable=true.
9. Run real Feishu acceptance and recheck queues/DLQs.
```

The rollback section must state that restoring the Postgres snapshot restores durable intent but never live activation.

- [ ] **Step 3: Run focused and full local verification**

Run, in order:

```bash
git diff --check
npm run typecheck
npm run build
npm test
npm run test:python
npm run test:pilot
docker compose config
npm run readiness -- --env-file deploy/pilot/ci.env
npm run pilot:config
```

Expected: every command exits `0`; TypeScript reports no errors; Vitest, pytest, and Node tests report zero failures; Compose renders a valid configuration.

- [ ] **Step 4: Commit operations changes**

```bash
git add deploy/pilot/backup.sh scripts/pilot-smoke-lib.test.mjs scripts/pilot-smoke.mjs scripts/pilot-operations.test.mjs deploy/pilot/README.md
git commit -m "ops: gate durable runtime control rollout"
```

- [ ] **Step 5: Request code review and address only verified findings**

Use `superpowers:requesting-code-review`. Review against the approved design, especially startup fail-closed behavior, emergency disable ordering, CAS conflicts, secret exposure, cleanup, and rollback. For every accepted finding, first add a failing regression test, then implement the minimal fix and rerun the focused suite.

- [ ] **Step 6: Push the branch and update the existing draft PR**

```bash
git push -u origin codex/iris-durable-runtime-control
gh pr create --draft --base codex/iris-task-evidence-prompt --head codex/iris-durable-runtime-control --title "feat: persist Iris runtime control" --body "Persists Iris runtime-control intent in a versioned Postgres singleton while preserving fail-closed live activation after restart. Implements strict decoding, CAS mutations, status degradation, startup restore, and pilot rollback gates."
$prNumber = gh pr view codex/iris-durable-runtime-control --json number --jq .number
gh pr checks --watch $prNumber
```

Expected: Core and AI Worker checks are `success`. Do not merge PR #4 or the new PR without explicit authorization.

- [ ] **Step 7: Perform backup-first fail-closed pilot rollout**

Before any remote change, verify the currently approved deployment remains healthy and queues/DLQs are zero. Then:

1. Disable Iris through the internal endpoint and verify no Feishu reply.
2. Stop Caddy.
3. Create the paired backup and record its path.
4. Deploy the exact reviewed commit and same-SHA Core image.
5. Run migration `0016` and inspect the singleton row without printing secrets.
6. Start Core/Postgres/Redis with Caddy still stopped.
7. Verify `globalEnabled=false`, `persistence.ok=true`, all services healthy, and all pending/DLQ counts zero.
8. Restart Core once and prove groups/capabilities survive while live global remains false.
9. Start Caddy; verify public `/health` and public `/internal/*` remains `404`.
10. Explicitly enable Iris and require `durable=true`.
11. Obtain one real Feishu mention and verify an authorized exact answer, permission guard behavior, and zero queues/DLQs.
12. Record app SHA, image SHA, migration revision, backup path, CI links, and acceptance results in the deployment log.

If any gate fails, keep Iris disabled and Caddy stopped, restore the paired backup/image if needed, and report the exact failing gate. Never infer a pass from a stale response.

- [ ] **Step 8: Final verification before completion**

Use `superpowers:verification-before-completion`. Re-read live evidence immediately before reporting:

- app SHA equals the reviewed commit;
- Core image label/digest resolves to that same SHA;
- Core/Postgres/Redis healthy and Caddy running only after enable;
- `globalEnabled=true`, `persistence.storage="postgres"`, `persistence.ok=true`;
- event/document/reindex pending and every DLQ equal `0`;
- real Feishu acceptance result is recorded;
- rollback artifact exists;
- no uncommitted code or deployment-log changes remain.

Commit the final deployment log separately:

```bash
git add docs/deployment/iris-pilot-deployment-log.md
git commit -m "docs: record durable runtime control rollout"
git push
```
