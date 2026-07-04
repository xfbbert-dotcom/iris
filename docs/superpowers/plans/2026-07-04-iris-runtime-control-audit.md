# Iris Runtime Control Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record successful runtime-control mutations in the internal audit log.

**Architecture:** Extend the existing in-memory `AuditEvent` union with a `runtime_control_updated`
event and write it from the runtime-control mutation routes after validation and mutation. Keep
audit writes best-effort so emergency disablement is never blocked by observability failures.

**Tech Stack:** Fastify, Vitest, TypeScript, Markdown.

---

### Task 1: Runtime-Control Audit Events

**Files:**
- Modify: `apps/core/src/audit/audit-log.ts`
- Modify: `apps/core/src/app.ts`
- Modify: `apps/core/tests/runtime-control-api.test.ts`

- [x] **Step 1: Write failing audit API coverage**

Add a runtime-control API test that performs one global update, one group update, and one capability
update, then queries:

```powershell
npm test --workspace apps/core -- runtime-control-api.test.ts
```

Expected before implementation: the query for
`/internal/audit/events?limit=20&type=runtime_control_updated` returns 400 because the event type is
not recognized yet.

- [x] **Step 2: Write audit failure isolation coverage**

Add a runtime-control API test with an `InMemoryAuditLog` subclass whose `record()` throws. Assert
`POST /internal/runtime-control/global` still returns 200 and updates `globalEnabled`.

- [x] **Step 3: Extend the audit event model**

Add a `RuntimeControlAuditEvent` union member with:

```typescript
type: "runtime_control_updated";
documentId: "runtime-control";
fragmentIds: string[];
runtimeControlScope: "global" | "group" | "capability";
enabled: boolean;
previousEnabled: boolean;
targetId?: string;
```

- [x] **Step 4: Accept the new query type**

Update `parseAuditEventType()` so `runtime_control_updated` is valid for audit event filters.

- [x] **Step 5: Record successful mutations**

For runtime-control mutation routes:

- global route records one global event;
- group route records one group event with `targetId` as the group ID;
- capability route records one event per capability update.

- [x] **Step 6: Keep audit writes best-effort**

Wrap runtime-control audit writes in `try/catch` and swallow audit failures after the mutation is
applied.

- [x] **Step 7: Run focused tests**

Run:

```powershell
npm test --workspace apps/core -- runtime-control-api.test.ts
```

Expected: the command exits 0.

### Task 2: Documentation And Verification

**Files:**
- Modify: `docs/operations/internal-rollout-runbook.md`
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`
- Create: `docs/superpowers/specs/2026-07-04-iris-runtime-control-audit-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-runtime-control-audit.md`

- [x] **Step 1: Document operator usage and architecture**

Document the runtime-control audit query in the rollout runbook and add the architecture principle
that runtime-control mutations must be auditable while emergency controls remain available when
audit logging fails.

- [x] **Step 2: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

- [ ] **Step 3: Commit, push, and verify PR checks**

Commit the runtime-control audit update, push `codex/iris-document-source-registry`, update PR #3,
and confirm GitHub Actions returns Core and AI Worker success.
