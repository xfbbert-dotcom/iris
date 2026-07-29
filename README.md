# Iris

Iris is the company's Feishu-native AI assistant and collaboration agent.

The architecture constitution lives at:

`docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`

The internal rollout runbook lives at:

`docs/operations/internal-rollout-runbook.md`

The first implementation slice builds:

- TypeScript Core App
- Feishu ack-first event ingestion
- runtime capability controls
- real-time permission guard
- context assembly with live chat anchoring
- experimental Python AI worker job contracts (not connected to the Pilot runtime)

## Local Development

Runtime prerequisites:

- Node.js 22
- Docker Desktop with the WSL 2 backend

Python 3.12 or newer is optional and currently needed only to run the experimental AI worker
contract tests. The Pilot Compose stack does not start a Python worker; document parsing,
embeddings, retrieval, and answer drafting currently run inside the TypeScript Core.

Install TypeScript dependencies:

```powershell
npm ci
```

Start the Core App in development mode after loading the variables from `.env.example` into the
current shell:

```powershell
npm --workspace apps/core run dev
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

When the disposable Pilot stack is already running, verify that runtime controls survive a Core
restart and are restored to their defaults afterward:

```powershell
npm run pilot:persistence-smoke
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

Run real Redis Lua queue integration tests:

```powershell
$env:REDIS_URL="redis://localhost:6379"
npm --workspace apps/core test -- redis-queue-integration.test.ts
```
