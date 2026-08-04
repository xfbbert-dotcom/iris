# Iris Durable Runtime Control Design

Date: 2026-07-13
Status: Approved design
Product: Iris
Decision: B1, Postgres single-row versioned snapshot

## 1. Goal

Persist Iris runtime-control policy before the pilot expands to the first 20-30 users, while
preserving the existing fail-closed rule for crashes, host restarts, container recreation, and
failed maintenance.

The durable policy covers:

- the operator's requested global state;
- disabled Feishu group IDs;
- all runtime capability switches;
- the policy revision, update time, and operator hint.

The live global activation remains a separate process-local safety state. A Core process always
starts globally disabled and requires an explicit operator activation after health checks pass.

## 2. Scope

This phase implements:

- one Postgres migration for a singleton runtime-control snapshot;
- a narrow repository interface and Postgres implementation;
- strict snapshot decoding and optimistic revision control;
- startup loading of durable group and capability policy;
- fail-closed live global startup even when requested global state is persisted as enabled;
- durable runtime-control API mutations;
- explicit degraded reporting when emergency disable cannot be persisted;
- status, tests, rollout documentation, and deployment verification.

This phase does not implement:

- the visual Admin Console;
- durable audit-event storage;
- automatic global activation after any restart;
- multi-tenant runtime policy;
- proactive behavior, knowledge publication, or external tool execution;
- more than one Core replica.

The current Feishu pilot continues running while this feature is developed. Deployment follows the
existing commit-pinned, backup-first, fail-closed rollout procedure.

## 3. Alternatives Considered

### 3.1 Selected: Single Versioned Snapshot

One singleton Postgres row stores the complete runtime policy. Every successful mutation replaces
the whole policy under an optimistic revision check.

This is selected because Iris currently serves one company from one Core process. The approach gives
atomic updates, simple recovery, and a small operational surface without blocking a future tenant
key.

### 3.2 Rejected For V1: Normalized Policy Tables

Separate global, group, and capability tables would make ad hoc querying easier, but would require
multi-table transactions and more complex snapshot reconstruction. The current company size and
single-writer deployment do not justify that cost.

### 3.3 Rejected For V1: Event-Sourced Runtime Policy

An append-only policy event stream would provide a complete durable history, but Iris already has an
audit boundary and does not need event replay to control 20-30 users. Durable audit storage can be
added independently when real compliance requirements appear.

## 4. Data Model

Migration `0016_runtime_control_state.sql` creates one table:

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
```

The migration inserts row `singleton_id = 1` with revision `0` and conservative defaults:

- `desired_global_enabled = false`;
- no disabled groups;
- group context, mention replies, group-document reads, knowledge-base retrieval, proactive speech,
  and knowledge-draft generation enabled;
- knowledge-base writes and external tool calls disabled.

The repository treats the row as invalid unless:

- the revision is a non-negative safe integer;
- `disabled_group_ids` contains only unique, non-blank strings;
- `capabilities` is an object containing exactly the supported capability keys;
- every capability value is boolean;
- `updated_at` is a valid timestamp;
- `updated_by`, when present, is a non-blank bounded string.

Unknown, missing, or malformed capability data is an error. Iris never substitutes permissive
defaults for a corrupt durable snapshot.

## 5. Domain Interfaces

The persistence boundary is independent from the synchronous hot-path controller:

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

`RuntimeController` remains synchronous for message processing. It gains one replacement method for
durable group and capability policy and tracks the durable revision and desired global state for
status reporting. Loading a durable snapshot never enables the live global gate.

## 6. Startup Semantics

Startup order is:

```text
validate environment
-> connect to Postgres
-> run migrations
-> load and strictly decode singleton runtime policy
-> create RuntimeController with live globalEnabled=false
-> apply durable disabled groups and capabilities
-> compose workers and HTTP app
-> report activationRequired when desiredGlobalEnabled=true
```

The environment variable `IRIS_RUNTIME_GLOBAL_ENABLED` remains available for credential-free local
tests and development composition. The pilot profile continues to set it to `false`. A production
runtime with the Postgres repository configured always forces the live startup value to `false`.

If migration, lookup, or decoding fails, Core startup fails and Caddy cannot obtain a healthy
upstream. Iris does not start with an in-memory default that might broaden a group or capability
policy.

## 7. Mutation Semantics

### 7.1 Authority-Increasing And Ordinary Mutations

Global enable, group enable or disable, and capability changes follow:

```text
read current controller snapshot and durable revision
-> construct complete next durable snapshot
-> compare-and-swap Postgres row
-> on success replace live policy
-> record audit event
-> return new snapshot
```

The Postgres update uses `where singleton_id = 1 and revision = $expectedRevision` and increments the
revision. Zero updated rows means conflict. The API returns HTTP `409` with
`runtime_control_conflict`; it does not retry against a policy the caller did not observe.

If persistence fails, the API returns HTTP `503` with `runtime_control_persistence_failed` and the
live controller remains unchanged.

Audit recording happens after the durable and live state agree. An audit-sink failure is reported by
the existing audit diagnostics, but does not roll back a committed policy or reopen a disabled gate.

### 7.2 Emergency Global Disable

Global disable is the only memory-first mutation:

```text
set live globalEnabled=false immediately
-> attempt compare-and-swap persistence
-> record audit event
-> report actual and durable outcome
```

When persistence succeeds, the API returns HTTP `200` with `durable: true`. When persistence fails
or conflicts, Iris remains disabled and returns HTTP `503` with:

```json
{
  "ok": false,
  "error": "runtime_control_disable_not_persisted",
  "globalEnabled": false,
  "durable": false
}
```

The operator must treat that response as "stopped now, persistence requires repair." Because every
Core startup is globally disabled, the emergency state cannot become enabled merely by restarting
the process.

### 7.3 Re-Activation After Restart

When a persisted snapshot requests global enablement, startup status reports:

```json
{
  "globalEnabled": false,
  "desiredGlobalEnabled": true,
  "activationRequired": true
}
```

After readiness, worker health, pending counts, and DLQs pass, the operator calls the existing global
enable endpoint. Persisting the already-requested value still advances the revision and records the
fresh operator action before the live gate opens.

## 8. API And Status Changes

`GET /internal/runtime-control/status` and the runtime-control component of
`GET /internal/status` add:

- `desiredGlobalEnabled`;
- `activationRequired`;
- `revision`;
- `updatedAt`;
- optional `updatedBy`;
- `persistence.storage: "postgres"`;
- `persistence.ok`;
- a stable `runtime_control_persistence_failed` error when the latest read fails.

Each status request performs a lightweight singleton-row read. The dedicated runtime-control status
endpoint still returns HTTP `200` with the live state when that read fails, but sets
`persistence.ok: false`; this keeps the emergency-control surface observable. The aggregate internal
status marks the runtime-control component unhealthy and therefore reports a degraded overall
status. The last successfully validated desired state and revision remain visible but are not
presented as current durable proof.

Existing fields remain stable. Successful mutation responses add `durable: true`. Conflict and
persistence errors use the explicit responses defined above.

The internal bearer-token boundary remains unchanged. Public `/internal/*` routes remain hidden by
Caddy.

## 9. Backup And Restore

The Postgres backup now naturally includes the durable policy row. Existing planned-backup behavior
remains authoritative for live activation and Caddy:

- a successful planned backup may restore the pre-maintenance live activation;
- a failed backup keeps live activation disabled and Caddy stopped;
- restoring Postgres restores policy intent but never auto-enables the new Core process;
- rollback to an older image must use a database version that the older image supports or restore the
  paired pre-deploy backup.

No secret is stored in the runtime-control row.

## 10. Error Handling And Observability

The repository exposes typed conflict separately from infrastructure failure. API logs and audit
events must not contain the internal bearer token or database URL.

`GET /internal/status` reports runtime-control persistence as unhealthy when the repository cannot
be read. Worker health does not override that failure. The public health endpoint remains a process
liveness endpoint; deployment gates continue to use authenticated internal status and readiness.

Operator-visible errors distinguish:

- invalid request (`400`);
- revision conflict (`409`);
- persistence failure with no live change (`503`);
- emergency disable applied but not persisted (`503` with `globalEnabled: false`).

## 11. Testing Strategy

Tests must cover:

- migration presence, singleton constraints, and conservative defaults;
- strict Postgres row decoding;
- compare-and-swap success and conflict;
- startup restores groups and capabilities but never live global activation;
- corrupt or unavailable durable state fails startup closed;
- global enable persists before the live controller changes;
- ordinary mutation failure leaves live state unchanged;
- emergency disable takes effect before persistence and reports degraded durability;
- two concurrent mutations cannot overwrite each other;
- status fields and HTTP error mappings;
- planned backup and rollback contracts remain fail closed;
- full TypeScript, Python, pilot, readiness, Compose, and Postgres integration verification.

Production rollout must prove:

1. deploy while Iris and Caddy are disabled;
2. the migration creates the conservative singleton row;
3. group and capability policy survive a controlled Core restart;
4. live global activation returns disabled after restart;
5. explicit activation restores the pilot;
6. all workers are healthy and pending/DLQ counts remain zero;
7. a real Feishu mention still returns an authorized answer;
8. rollback remains available from the paired pre-deploy backup.

## 12. Architecture Alignment

This design changes the runtime-control persistence boundary and therefore amends the architecture
whitepaper before implementation. It does not change Iris's identity, document visibility,
knowledge authority, permission guard, model boundary, deployment topology, or single-company
scope.

Future multi-company work may add `tenant_id` and replace the singleton key, but it must preserve the
same separation between durable intent and live activation.
