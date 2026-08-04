# Iris

Iris is the company's Feishu-native AI assistant and collaboration agent.

The architecture constitution lives at:

`docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`

The internal rollout runbook lives at:

`docs/operations/internal-rollout-runbook.md`

Reusable engineering failures and prevention rules live at:

`docs/operations/engineering-failure-ledger.md`

The Phase 5B-1 knowledge-card confirmation acceptance contract lives at:

`docs/runbooks/iris-knowledge-card-confirmation-acceptance.md`

Phase 5B-1 is implemented with runtime gates defaulting off and has passed local verification. Real
Feishu pilot acceptance is still pending. Phase 5B-2 proposal/owner-admin/OAuth workflows and Phase
5B-3 Feishu knowledge-base writes are not included.

The first implementation slice builds:

- TypeScript Core App
- Feishu ack-first event ingestion
- runtime capability controls
- real-time permission guard
- context assembly with live chat anchoring
- Python AI worker job contracts

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
