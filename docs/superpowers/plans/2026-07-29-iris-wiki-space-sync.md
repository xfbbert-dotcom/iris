# Iris Feishu Wiki Space Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an Iris administrator register one Feishu wiki root URL and have Core durably, asynchronously, and idempotently discover and synchronize all supported pages in that space.

**Architecture:** Add a Postgres-backed wiki-space authorization and scan state machine inside the existing Core modular monolith. A bounded worker uses the existing cached Feishu tenant token, traverses same-space wiki nodes breadth-first, and sends supported pages through the existing authorized-wiki document registration and document-sync queue. The HTTP request never waits on Feishu, and the existing live permission guard remains the final authority before model context injection.

**Tech Stack:** TypeScript, Fastify, PostgreSQL, Feishu Open API, Vitest, existing Iris document-source/document-sync runtime and Admin Console.

## Global Constraints

- The current pilot remains on commit `bea8dca59bfea80b5beaea4c49c7525e9c1150b6` until a reviewed candidate receives explicit deployment approval.
- `IRIS_WIKI_SPACE_SYNC_ENABLED` defaults to `false`.
- Public ingress must continue returning `404` for `/internal/*`.
- Registration performs no Feishu network call and returns HTTP `202`.
- Traversal stays inside the resolved root space, uses breadth-first order, and is bounded to 500 nodes and depth 20.
- Only `docx` and legacy `doc` wiki nodes enter the existing document pipeline.
- A missing page in one scan is not automatically deleted or disabled.
- Automated tests must not consume Gemini or any hosted model quota.
- Production vectors remain on the approved 1536-dimensional profile; local-model work is separate.

---

## File Map

- `apps/core/migrations/0041_wiki_space_authorizations.sql`: durable authorization and scan state.
- `apps/core/src/documents/wiki-space-authorization-repository.ts`: state-machine persistence and claims.
- `apps/core/src/documents/feishu-wiki-space-client.ts`: bounded Feishu node API adapter.
- `apps/core/src/documents/wiki-space-scanner.ts`: deterministic breadth-first traversal.
- `apps/core/src/documents/wiki-space-sync-worker.ts`: one claimed authorization scan and document registration.
- `apps/core/src/documents/wiki-space-sync-worker-loop.ts`: timer lifecycle and status snapshot.
- `apps/core/src/runtime/document-sync-runtime.ts`: compose the new module with existing document sync.
- `apps/core/src/config/env.ts`: opt-in runtime configuration.
- `apps/core/src/app.ts`: internal wiki-space API.
- `apps/core/src/admin-console/admin-console-assets.ts`: operator registration and status controls.
- `deploy/pilot/docker-compose.yml`, `deploy/pilot/ci.env`, `.env.pilot.example`: explicit default-off deployment wiring.
- Focused `apps/core/tests/*.test.ts` files: test each boundary before implementation.

---

### Task 1: Durable Wiki-Space Authorization State Machine

**Files:**
- Create: `apps/core/migrations/0041_wiki_space_authorizations.sql`
- Create: `apps/core/src/documents/wiki-space-authorization-repository.ts`
- Create: `apps/core/tests/wiki-space-authorization-repository.test.ts`
- Modify: `apps/core/tests/migration-runner.test.ts`

**Interfaces:**
- Produces:

```ts
export type WikiSpaceScanState =
  | "pending"
  | "scanning"
  | "synced"
  | "retry_wait"
  | "dead_letter"
  | "disabled";

export type WikiSpaceAuthorization = {
  id: string;
  rootSourceUri: string;
  rootNodeToken: string;
  spaceId?: string;
  title?: string;
  enabled: boolean;
  scanState: WikiSpaceScanState;
  attemptCount: number;
  nextScanAt: Date;
  leaseExpiresAt?: Date;
  lastScanStartedAt?: Date;
  lastScanCompletedAt?: Date;
  lastSuccessAt?: Date;
  lastErrorClassification?: string;
  discoveredNodeCount: number;
  registeredDocumentCount: number;
  skippedNodeCount: number;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
};

export type WikiSpaceAuthorizationRepository = {
  register(input: {
    rootSourceUri: string;
    rootNodeToken: string;
    at: Date;
  }): Promise<{ authorization: WikiSpaceAuthorization; created: boolean }>;
  list(input: { limit: number }): Promise<WikiSpaceAuthorization[]>;
  claimNext(input: {
    at: Date;
    leaseExpiresAt: Date;
    maxAttempts: number;
  }): Promise<WikiSpaceAuthorization | undefined>;
  complete(input: {
    id: string;
    revision: number;
    at: Date;
    nextScanAt: Date;
    spaceId: string;
    title?: string;
    discoveredNodeCount: number;
    registeredDocumentCount: number;
    skippedNodeCount: number;
  }): Promise<WikiSpaceAuthorization>;
  fail(input: {
    id: string;
    revision: number;
    at: Date;
    classification: string;
    retryAt?: Date;
  }): Promise<WikiSpaceAuthorization>;
  requestScan(input: { id: string; at: Date }): Promise<WikiSpaceAuthorization | undefined>;
  setEnabled(input: {
    id: string;
    enabled: boolean;
    at: Date;
  }): Promise<WikiSpaceAuthorization | undefined>;
  getStatusCounts(): Promise<Record<WikiSpaceScanState, number>>;
};
```

- [ ] **Step 1: Write migration and repository tests first**

Cover migration ordering/constraints plus repository behavior:

```ts
it("registers a root idempotently without re-enabling an admin-disabled root", async () => {
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
  expect(repeated.created).toBe(false);
  expect(repeated.authorization.enabled).toBe(false);
  expect(repeated.authorization.scanState).toBe("disabled");
});
```

Also prove `claimNext` uses `FOR UPDATE SKIP LOCKED`, reclaims expired leases,
does not claim disabled/dead-letter rows, and matches `id + revision` when
completing or failing.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
npm --workspace @iris/core test -- wiki-space-authorization-repository migration-runner
```

Expected: FAIL because migration `0041` and repository exports do not exist.

- [ ] **Step 3: Add the migration and minimal repository**

The migration must include exact state checks, non-negative counters, unique
`root_source_uri`, and due-work indexes. Implement validation with bounded
strings, finite limits, dates, and optimistic revision transitions.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same command. Expected: PASS with no warnings.

- [ ] **Step 5: Commit**

```powershell
git add apps/core/migrations/0041_wiki_space_authorizations.sql apps/core/src/documents/wiki-space-authorization-repository.ts apps/core/tests/wiki-space-authorization-repository.test.ts apps/core/tests/migration-runner.test.ts
git commit -m "feat: persist wiki space scan state"
```

### Task 2: Feishu Node Client And Bounded Traversal

**Files:**
- Create: `apps/core/src/documents/feishu-wiki-space-client.ts`
- Create: `apps/core/src/documents/wiki-space-scanner.ts`
- Create: `apps/core/tests/feishu-wiki-space-client.test.ts`
- Create: `apps/core/tests/wiki-space-scanner.test.ts`

**Interfaces:**
- Consumes: existing `FeishuTenantAccessTokenProvider`.
- Produces:

```ts
export type FeishuWikiNode = {
  nodeToken: string;
  objectToken: string;
  objectType: string;
  spaceId: string;
  title?: string;
  hasChild: boolean;
};

export type FeishuWikiSpaceClient = {
  getNode(nodeToken: string): Promise<FeishuWikiNode>;
  listChildren(input: {
    spaceId: string;
    parentNodeToken: string;
    pageToken?: string;
    pageSize: number;
  }): Promise<{ nodes: FeishuWikiNode[]; nextPageToken?: string }>;
};

export type WikiSpaceScanResult = {
  spaceId: string;
  rootTitle?: string;
  documents: Array<{ nodeToken: string; title?: string }>;
  discoveredNodeCount: number;
  skippedNodeCount: number;
};
```

- [ ] **Step 1: Write failing client tests**

Assert exact Feishu URLs, bearer token usage, pagination mapping, response-size
limit, timeout, and safe classifications for `401/403/404/429/5xx`.

- [ ] **Step 2: Verify client tests are RED**

```powershell
npm --workspace @iris/core test -- feishu-wiki-space-client
```

Expected: FAIL because the client does not exist.

- [ ] **Step 3: Implement the minimal Feishu client**

Use the existing token provider. Never include response bodies or credentials
in thrown messages. Export a typed `WikiSpaceSyncError` carrying only
`classification` and `retriable`.

- [ ] **Step 4: Write failing scanner tests**

Use a deterministic fake client to prove:

```ts
expect(result.documents.map((item) => item.nodeToken)).toEqual([
  "root",
  "child-a",
  "child-b",
  "grandchild",
]);
```

Add tests for multi-page children, duplicate tokens, unsupported types,
cross-space nodes, `maxNodes=500`, and `maxDepth=20`.

- [ ] **Step 5: Verify scanner tests are RED**

```powershell
npm --workspace @iris/core test -- wiki-space-scanner
```

Expected: FAIL because traversal is absent.

- [ ] **Step 6: Implement breadth-first traversal and verify GREEN**

Use a queue of `{ node, depth }`, a `Set<string>` for visited node tokens, and
only emit `docx`/`doc` nodes. Do not perform document registration here.

- [ ] **Step 7: Commit**

```powershell
git add apps/core/src/documents/feishu-wiki-space-client.ts apps/core/src/documents/wiki-space-scanner.ts apps/core/tests/feishu-wiki-space-client.test.ts apps/core/tests/wiki-space-scanner.test.ts
git commit -m "feat: traverse authorized Feishu wiki spaces"
```

### Task 3: Scan Worker, Retry Policy, And Loop

**Files:**
- Create: `apps/core/src/documents/wiki-space-sync-worker.ts`
- Create: `apps/core/src/documents/wiki-space-sync-worker-loop.ts`
- Create: `apps/core/tests/wiki-space-sync-worker.test.ts`
- Create: `apps/core/tests/wiki-space-sync-worker-loop.test.ts`

**Interfaces:**
- Consumes: repository from Task 1 and scanner from Task 2.
- Produces:

```ts
export type AuthorizedWikiDocumentRegistrar = {
  register(input: {
    sourceUri: string;
    title?: string;
    authorizedSpaceId: string;
    observedAt: Date;
  }): Promise<{ sourceId: string; enqueueStatus: "enqueued" | "already_pending" }>;
};

export type WikiSpaceSyncWorkerResult =
  | { status: "idle" }
  | {
      status: "synced";
      authorizationId: string;
      registeredDocumentCount: number;
      skippedNodeCount: number;
    }
  | {
      status: "retrying" | "dead_lettered";
      authorizationId: string;
      classification: string;
    };
```

- [ ] **Step 1: Write worker RED tests**

Cover one successful claim, canonical child URLs using the root URL origin,
three registrations in traversal order, retry backoff, terminal failure,
exhausted attempts, and stale revision rejection.

- [ ] **Step 2: Run and observe RED**

```powershell
npm --workspace @iris/core test -- wiki-space-sync-worker
```

- [ ] **Step 3: Implement the smallest worker**

One `processNext()` call claims at most one authorization. Retry delay is
`min(30 minutes, 30 seconds * 2^(attemptCount-1))`. Completion schedules the
next scan at `now + refreshIntervalMs`.

- [ ] **Step 4: Write loop RED tests**

Prove start idempotency, stop behavior, no overlapping ticks, latest batch
snapshot, and that loop errors are reduced to safe classifications.

- [ ] **Step 5: Implement loop and verify GREEN**

```powershell
npm --workspace @iris/core test -- wiki-space-sync-worker wiki-space-sync-worker-loop
```

- [ ] **Step 6: Commit**

```powershell
git add apps/core/src/documents/wiki-space-sync-worker.ts apps/core/src/documents/wiki-space-sync-worker-loop.ts apps/core/tests/wiki-space-sync-worker.test.ts apps/core/tests/wiki-space-sync-worker-loop.test.ts
git commit -m "feat: process wiki space scans asynchronously"
```

### Task 4: Runtime And Configuration Wiring

**Files:**
- Modify: `apps/core/src/config/env.ts`
- Modify: `apps/core/src/runtime/document-sync-runtime.ts`
- Modify: `apps/core/tests/runtime-config.test.ts`
- Modify: `apps/core/tests/document-sync-runtime.test.ts`

**Interfaces:**
- Produces:

```ts
export type WikiSpaceSyncRuntimeConfig =
  | { enabled: false }
  | {
      enabled: true;
      intervalMs: number;
      refreshIntervalMs: number;
      leaseMs: number;
      maxDepth: number;
      maxAttempts: number;
    };
```

`DocumentSyncRuntime` gains:

```ts
wikiSpaces: {
  register(input: { rootSourceUri: string; at: Date }): Promise<{
    authorization: WikiSpaceAuthorization;
    created: boolean;
  }>;
  list(input: { limit: number }): Promise<WikiSpaceAuthorization[]>;
  requestScan(input: { id: string; at: Date }): Promise<WikiSpaceAuthorization | undefined>;
  setEnabled(input: {
    id: string;
    enabled: boolean;
    at: Date;
  }): Promise<WikiSpaceAuthorization | undefined>;
};
```

- [ ] **Step 1: Add failing config/runtime tests**

Prove default off, safe numeric bounds, rejection when wiki sync is enabled
while document sync is disabled, runtime composition, nested status counts,
start, and graceful close.

- [ ] **Step 2: Verify RED**

```powershell
npm --workspace @iris/core test -- runtime-config document-sync-runtime
```

- [ ] **Step 3: Wire the repository, client, scanner, worker, and loop**

Reuse the runtime's existing Postgres pool, tenant token provider, document
registry, and manual sync planner. The registrar adapter must call
`registerAuthorizedWikiDocument` then `enqueueSource`.

- [ ] **Step 4: Verify GREEN and run Core typecheck**

```powershell
npm --workspace @iris/core test -- runtime-config document-sync-runtime
npm --workspace @iris/core run typecheck
```

- [ ] **Step 5: Commit**

```powershell
git add apps/core/src/config/env.ts apps/core/src/runtime/document-sync-runtime.ts apps/core/tests/runtime-config.test.ts apps/core/tests/document-sync-runtime.test.ts
git commit -m "feat: wire wiki space sync runtime"
```

### Task 5: Internal API

**Files:**
- Modify: `apps/core/src/app.ts`
- Create: `apps/core/tests/wiki-space-api.test.ts`

**Interfaces:**
- Consumes: `DocumentSyncRuntime["wikiSpaces"]`.
- Produces the four endpoints in the approved design.

- [ ] **Step 1: Write API RED tests**

Prove:

```ts
const response = await app.inject({
  method: "POST",
  url: "/internal/document-sync/wiki-spaces",
  payload: { rootSourceUri: "https://tenant.feishu.cn/wiki/root_1?from=space" },
});
expect(response.statusCode).toBe(202);
expect(runtime.wikiSpaces.register).toHaveBeenCalledWith({
  rootSourceUri: "https://tenant.feishu.cn/wiki/root_1?from=space",
  at: expect.any(Date),
});
```

Also cover malformed body, non-wiki URL, missing runtime, list limit, missing
authorization, rescan, enable, and disable.

- [ ] **Step 2: Verify RED**

```powershell
npm --workspace @iris/core test -- wiki-space-api
```

- [ ] **Step 3: Implement strict parsing and routes**

Return only safe errors:
`invalid_request`, `document_sync_worker_unavailable`,
`wiki_space_not_found`, `wiki_space_registration_failed`,
`wiki_space_operation_failed`.

- [ ] **Step 4: Verify GREEN and existing internal-route protection**

```powershell
npm --workspace @iris/core test -- wiki-space-api admin-console-api
```

- [ ] **Step 5: Commit**

```powershell
git add apps/core/src/app.ts apps/core/tests/wiki-space-api.test.ts
git commit -m "feat: expose internal wiki space controls"
```

### Task 6: Admin Console Operator Loop

**Files:**
- Modify: `apps/core/src/admin-console/admin-console-assets.ts`
- Modify: `apps/core/tests/admin-console-assets.test.ts`

**Interfaces:**
- Consumes the Task 5 endpoints.
- Produces root registration, state table, rescan button, and enabled checkbox.

- [ ] **Step 1: Write asset RED tests**

Assert stable element IDs, endpoint strings, escaped rendering, loading/error
states, and icon/title labels for rescan and enable controls.

- [ ] **Step 2: Verify RED**

```powershell
npm --workspace @iris/core test -- admin-console-assets
```

- [ ] **Step 3: Add the compact Wiki Spaces section**

Keep it adjacent to Document Sources. Do not nest cards. Use a URL input,
refresh/rescan icons with tooltips, and a checkbox for enabled state.

- [ ] **Step 4: Verify GREEN**

```powershell
npm --workspace @iris/core test -- admin-console-assets admin-console-api
```

- [ ] **Step 5: Commit**

```powershell
git add apps/core/src/admin-console/admin-console-assets.ts apps/core/tests/admin-console-assets.test.ts
git commit -m "feat: manage wiki spaces in admin console"
```

### Task 7: Deployment Wiring And Automated Exit Gate

**Files:**
- Modify: `.env.pilot.example`
- Modify: `deploy/pilot/ci.env`
- Modify: `deploy/pilot/docker-compose.yml`
- Modify: `scripts/pilot-compose.test.mjs`
- Modify: `deploy/pilot/README.md`
- Create: `docs/runbooks/iris-wiki-space-sync.md`

**Interfaces:**
- Produces explicit default-off deployment variables and an operator runbook.

- [ ] **Step 1: Write compose RED assertions**

Require these values to survive interpolation:

```text
IRIS_WIKI_SPACE_SYNC_ENABLED
IRIS_WIKI_SPACE_SYNC_INTERVAL_MS
IRIS_WIKI_SPACE_SYNC_REFRESH_INTERVAL_MS
IRIS_WIKI_SPACE_SYNC_LEASE_MS
IRIS_WIKI_SPACE_SYNC_MAX_DEPTH
IRIS_WIKI_SPACE_SYNC_MAX_ATTEMPTS
```

- [ ] **Step 2: Verify RED**

```powershell
node --test scripts/pilot-compose.test.mjs
```

- [ ] **Step 3: Add default-off wiring and runbook**

The runbook must include register, inspect, rescan, disable, dead-letter
diagnosis, permission-revocation check, queue checks, and rollback to
`IRIS_WIKI_SPACE_SYNC_ENABLED=false`.

- [ ] **Step 4: Run complete automated verification**

```powershell
node --test scripts/pilot-compose.test.mjs
npm --workspace @iris/core test
npm --workspace @iris/core run typecheck
npm --workspace @iris/core run build
npm run test:pilot
npm run pilot:config
git diff --check
```

Expected: all commands pass and no test calls a hosted model.

- [ ] **Step 5: Commit**

```powershell
git add .env.pilot.example deploy/pilot/ci.env deploy/pilot/docker-compose.yml scripts/pilot-compose.test.mjs deploy/pilot/README.md docs/runbooks/iris-wiki-space-sync.md
git commit -m "ops: add wiki space sync rollout gate"
```

### Task 8: GitHub Review And Real Small-Space Acceptance

**Files:**
- Modify: `docs/runbooks/deployment-log.md`

**Interfaces:**
- Consumes the reviewed branch and the pilot root
  `https://tcnmvzw006k7.feishu.cn/wiki/Pxkiwgn3qirkzGk8Pqbc1RuunMe`.
- Produces CI evidence and a deployment decision; it does not merge.

- [ ] **Step 1: Rebase only if required, push, and create a draft PR**

Use the existing base/stack intentionally and report it in the PR body. Do not
merge.

- [ ] **Step 2: Verify Core and AI Worker checks**

Both checks must be `success` for the exact candidate SHA.

- [ ] **Step 3: Obtain explicit deployment approval**

This is the only mandatory human decision after code review. Without approval,
leave the current pilot unchanged.

- [ ] **Step 4: Deploy fail-closed and run one real traversal**

Enable only the wiki-space worker, register the root once, and verify exactly
the root plus its two current children are discovered. Do not repeatedly replay
Gemini embedding failures; discovery acceptance is independent from provider
capacity.

- [ ] **Step 5: Verify idempotency and permission guard**

Request one rescan and confirm source/evidence counts do not duplicate. Use an
already-authorized page for retrieval, then remove that page permission and
confirm the existing live permission guard rejects it before model context
injection.

- [ ] **Step 6: Record the exact outcome**

Update `docs/runbooks/deployment-log.md` and the PR acceptance comment with:
candidate SHA, image SHA, scan counts, source/evidence counts, queue/DLQ
counts, permission-guard result, and whether provider capacity blocked only
downstream indexing.

- [ ] **Step 7: Restore the approved pilot posture**

Keep the worker enabled only if every gate passes. Otherwise set
`IRIS_WIKI_SPACE_SYNC_ENABLED=false`, rebuild Core, and verify the original
pilot remains healthy.

