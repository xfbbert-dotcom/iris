# Iris

Iris is the company's Feishu-native AI assistant and collaboration agent.

The architecture constitution lives at:

`docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`

The internal rollout runbook lives at:

`docs/operations/internal-rollout-runbook.md`

Reusable engineering failures and prevention rules live at:

`docs/operations/engineering-failure-ledger.md`

The internal MVP acceptance checklist lives at:

`docs/runbooks/iris-internal-mvp-gray-checklist.md`

## Current Product State

All ten required P1 product loops have passed a bounded real-Feishu acceptance run. Production is
now in a controlled 3-5 person, single-group daily pilot. This does not authorize expansion to all
20-30 employees; expansion follows only after ordinary pilot use contains no unresolved P0 or P1
issue.

The implemented internal-MVP loop includes:

- ack-first Feishu event ingestion and shared group context;
- mention replies grounded in recent chat, long-term memory, group documents, employee-submitted
  documents, and authorized Feishu Wiki spaces;
- real-time source permission rechecks and permission-safe citations;
- semantic discussion-thread and action memory;
- governed knowledge drafting, group confirmation, OAuth full-text review, approval, and Feishu Wiki
  publication;
- operator-reviewed proactive reminders with group-member feedback and suppression;
- durable runtime controls, fail-closed recovery, private local embeddings, and a lightweight Admin
  Console.

The knowledge-conflict candidate loop is implemented behind production-default-off controls but is
still pending its exact-SHA live acceptance. It can compare a newer group conclusion with current
authorized Wiki evidence, require operator approval for a bounded conflict card, and create a
governed update draft. It does not edit the existing Wiki page in place; the draft enters the
existing confirmation, review, approval, and publication path. Until the dedicated one-group pilot
and nonpilot-control runbook passes, this loop is not part of the accepted daily-pilot capability
set.

Managed existing-page knowledge updates are implemented and locally verified, but remain
default-off (`IRIS_MANAGED_KNOWLEDGE_UPDATE_ENABLED=false` with an empty allowlist). They are
restricted to fresh Iris-created, single managed plain-text blocks and require exact identity,
confirmation, OAuth review, approval, one-block mutation, and exact resync. Controlled Feishu
acceptance is pending; it is not delivered or deployed until the content-free evidence in
`docs/development/iris-managed-knowledge-update-pilot.md` records a real allowlisted pilot with an
immutable image/tag/SHA, timestamps, and operators. This does not alter the already accepted
publication pilot facts above.

Governed Feishu task creation is also implemented as a default-off candidate. One explicit chat
request can produce a versioned formal-task draft, but Task v2 is called only after the same exact
task-spec hash passes group confirmation, assignee OAuth review, designated-owner approval, final
membership and runtime checks. The first rollout is restricted to one allowlisted group through
`IRIS_FEISHU_TASK_CREATION_ENABLED=false` and an empty allowlist by default. No real task-creation
acceptance is claimed until `docs/runbooks/iris-governed-feishu-task-acceptance.md` records one fresh
task, exact readback, one result card, drained recovery counts, and the safe-off rollback for an
immutable image/tag/SHA.

High-impact capabilities remain bounded: proactive deliveries require human review, knowledge-base
writes open only for an intentional governed session, and every known non-pilot group remains
disabled.

## Local Development

Install TypeScript dependencies:

```powershell
npm install
```

Run TypeScript tests:

```powershell
npm test
```

Run Python worker tests:

```powershell
npm run test:python
```

Run the full local verification suite:

```powershell
npm run verify
```

Check the internal rollout configuration profile:

```powershell
npm run readiness
```

To validate a private env file directly:

```powershell
npm run readiness -- --env-file .env
```

Use `.env.example` as the non-secret variable checklist for local or private rollout setup.

## Local Database

Start local infrastructure:

```powershell
docker compose up -d
```

If this fails before containers start, first verify host Docker/WSL readiness:

```powershell
docker compose config
docker version
docker desktop status
wsl --status
```

`docker compose config` only validates repo configuration. `docker compose up -d` also needs Docker
Desktop's engine and WSL integration to be running on the host.

Run database migrations:

```powershell
$env:DATABASE_URL="postgres://iris:iris@localhost:5432/iris"
npm --workspace apps/core run db:migrate
```

Run optional Postgres integration tests:

```powershell
$env:DATABASE_URL="postgres://iris:iris@localhost:5432/iris"
npm --workspace apps/core test -- postgres-document-source-registry.test.ts
npm --workspace apps/core test -- document-snapshot-repository.test.ts
npm --workspace apps/core test -- document-fragment-repository.test.ts
```
