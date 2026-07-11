# Iris Single-VPS Pilot Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce and verify a commit-pinned Docker Compose deployment for the 3-5 person Iris Feishu pilot on one Linux VPS.

**Architecture:** Build Core into a non-root Node 22 image, run migrations as a one-shot service, and run exactly one Core replica with private Postgres/pgvector and Redis services. Put Caddy in front with an exact public route allowlist for `/feishu/events` and `/health`; keep Core's operator API reachable only from VPS loopback or an SSH tunnel.

**Tech Stack:** Node.js 22, TypeScript, Docker multi-stage builds, Docker Compose, Caddy 2, Postgres 16 + pgvector, Redis 7, GitHub Actions.

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-11-iris-single-vps-pilot-deployment-design.md`.
- Keep exactly one active Core consumer for all Redis queue families.
- Do not publish Postgres or Redis host ports.
- Publish Core only as `127.0.0.1:3000:3000` for SSH-tunneled operator access.
- Caddy may publicly forward only exact `/feishu/events` and `/health` paths.
- Keep all real secrets out of Git; `.env.pilot` remains ignored.
- Do not add an idle Python Worker container.
- Every behavior or executable contract change follows RED, GREEN, full verification, review, commit, and push.

---

### Task 1: Production TypeScript Build

**Files:**
- Create: `apps/core/tsconfig.build.json`
- Modify: `apps/core/package.json`
- Modify: `package.json`

**Interfaces:**
- Produces: `npm run build`, `npm --workspace apps/core run start`, and compiled files `apps/core/dist/app.js` plus `apps/core/dist/database/migrate.js`.
- Consumes: the existing `apps/core/tsconfig.json` compiler contract and workspace lockfile.

- [ ] **Step 1: Verify the production build command is absent**

Run:

```powershell
npm run build
```

Expected: FAIL because the root package has no `build` script.

- [ ] **Step 2: Add a source-only build config**

Create `apps/core/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "types": ["node"],
    "noEmit": false
  },
  "include": ["src/**/*.ts"],
  "exclude": ["tests/**/*.ts"]
}
```

Add these scripts to `apps/core/package.json`:

```json
"build": "tsc --project tsconfig.build.json",
"start": "node dist/app.js",
"db:migrate:prod": "node dist/database/migrate.js"
```

Add this script to root `package.json`:

```json
"build": "npm --workspace apps/core run build"
```

- [ ] **Step 3: Verify compiled entry points**

Run:

```powershell
npm run build
Test-Path apps/core/dist/app.js
Test-Path apps/core/dist/database/migrate.js
```

Expected: build exits `0`; both path checks print `True`.

- [ ] **Step 4: Verify existing type and test contracts**

Run:

```powershell
npm run typecheck
npm test
```

Expected: both commands exit `0`.

- [ ] **Step 5: Commit**

```powershell
git add apps/core/tsconfig.build.json apps/core/package.json package.json
git commit -m "build: add production core compilation"
```

---

### Task 2: Non-Root Core Container Image

**Files:**
- Create: `deploy/pilot/Dockerfile`
- Create: `.dockerignore`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: Task 1's `npm run build` and compiled entry points.
- Produces: one `iris-core` runtime image that can run either `node apps/core/dist/app.js` or `node apps/core/dist/database/migrate.js`.

- [ ] **Step 1: Verify the image definition is absent**

Run:

```powershell
Test-Path deploy/pilot/Dockerfile
```

Expected: `False`.

- [ ] **Step 2: Add the multi-stage image**

Create `deploy/pilot/Dockerfile`:

```dockerfile
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/core/package.json apps/core/package.json
RUN npm ci

COPY apps/core/src apps/core/src
COPY apps/core/tsconfig.json apps/core/tsconfig.json
COPY apps/core/tsconfig.build.json apps/core/tsconfig.build.json
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/core/package.json apps/core/package.json
COPY --from=build --chown=node:node /app/apps/core/dist apps/core/dist

USER node
CMD ["node", "apps/core/dist/app.js"]
```

Create `.dockerignore`:

```text
.git
.github
.env
.env.*
!.env.example
node_modules
apps/core/dist
workers
docs
*.log
```

Keep `.env.pilot.example` committable by adding this line to `.gitignore`:

```text
!.env.pilot.example
```

- [ ] **Step 3: Validate image syntax and build**

Run when a Docker engine is available:

```powershell
docker build --file deploy/pilot/Dockerfile --tag iris-core:pilot .
docker image inspect iris-core:pilot
```

Expected: both commands exit `0`; the final image user is `node`.

If the local engine is unavailable, record that environmental limitation and rely on Task 4's GitHub Linux build as the authoritative image execution gate.

- [ ] **Step 4: Commit**

```powershell
git add .dockerignore .gitignore deploy/pilot/Dockerfile
git commit -m "build: add pilot core image"
```

---

### Task 3: Private Compose Network And Caddy Allowlist

**Files:**
- Create: `.env.pilot.example`
- Create: `deploy/pilot/docker-compose.yml`
- Create: `deploy/pilot/Caddyfile`
- Create: `deploy/pilot/ci.env`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 2's Core image and the existing readiness environment contract.
- Produces: `npm run pilot:config`, a five-service pilot stack, public Caddy routes, and loopback-only Core operator access.

- [ ] **Step 1: Verify pilot Compose validation is absent**

Run:

```powershell
npm run pilot:config
```

Expected: FAIL because the root script and pilot Compose file do not exist.

- [ ] **Step 2: Add the exact public route allowlist**

Create `deploy/pilot/Caddyfile`:

```caddyfile
{
  email {$CADDY_EMAIL}
}

{$IRIS_PUBLIC_HOSTNAME} {
  encode zstd gzip

  @feishu path /feishu/events
  handle @feishu {
    reverse_proxy core:3000
  }

  @health path /health
  handle @health {
    reverse_proxy core:3000
  }

  handle {
    respond 404
  }
}
```

- [ ] **Step 3: Add the pilot service graph**

Create `deploy/pilot/docker-compose.yml` with:

- `postgres` using `pgvector/pgvector:pg16`, no `ports`, `pg_isready`, and `iris_postgres_data`;
- `redis` using `redis:7-alpine`, no `ports`, AOF enabled, `redis-cli ping`, and `iris_redis_data`;
- `migrate` using the Core image and `node apps/core/dist/database/migrate.js`;
- `core` using the same image, `127.0.0.1:3000:3000`, a Node-fetch healthcheck, and one replica;
- `caddy` using `caddy:2-alpine`, ports `80:80` and `443:443`, and exact config/volume mounts;
- condition-based dependencies, bounded JSON-file logging, and restart policies;
- explicit environment interpolation for every readiness variable.

The database URL must be composed exactly as:

```yaml
DATABASE_URL: postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
```

The Redis URL must be:

```yaml
REDIS_URL: redis://redis:6379
```

- [ ] **Step 4: Add non-secret environment contracts**

Create `.env.pilot.example` containing every variable from `.env.example`, plus:

```dotenv
IRIS_PUBLIC_HOSTNAME=iris.example.com
CADDY_EMAIL=ops@example.com
POSTGRES_USER=iris
POSTGRES_PASSWORD=replace-with-url-safe-postgres-password
POSTGRES_DB=iris
IRIS_IMAGE_TAG=pilot
```

Create `deploy/pilot/ci.env` with non-secret CI-only values, including:

```dotenv
IRIS_PUBLIC_HOSTNAME=http://localhost
CADDY_EMAIL=ci@example.com
POSTGRES_USER=iris
POSTGRES_PASSWORD=iris_ci_password
POSTGRES_DB=iris
IRIS_IMAGE_TAG=ci
```

Use syntactically valid non-secret values for all readiness variables so containers can start without external API calls.

- [ ] **Step 5: Add and verify Compose validation**

Add this root script:

```json
"pilot:config": "docker compose --env-file deploy/pilot/ci.env --file deploy/pilot/docker-compose.yml config"
```

Run:

```powershell
npm run pilot:config
```

Expected: exit `0`; rendered output publishes only Caddy 80/443 and Core loopback 3000; Postgres and Redis have no `ports` entries.

- [ ] **Step 6: Commit**

```powershell
git add .env.pilot.example deploy/pilot/Caddyfile deploy/pilot/docker-compose.yml deploy/pilot/ci.env package.json
git commit -m "deploy: add single-vps pilot stack"
```

---

### Task 4: Linux Container Smoke Gate In CI

**Files:**
- Create: `scripts/pilot-smoke.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 3's CI environment and Compose stack.
- Produces: `npm run pilot:smoke` plus a GitHub gate proving build, startup, public route filtering, bearer protection, and clean teardown.

- [ ] **Step 1: Write the smoke verifier before wiring CI**

Create `scripts/pilot-smoke.mjs` to:

1. poll `http://127.0.0.1/health` with a bounded 60-second deadline;
2. require public health status `200`;
3. require public `http://127.0.0.1/internal/status` status `404`;
4. require direct Core `http://127.0.0.1:3000/internal/status` status `401` without auth;
5. require direct Core status `200` with `Authorization: Bearer ci-internal-token`;
6. print a bounded success summary and exit non-zero on any mismatch.

Use Node's built-in `fetch`; do not add a dependency.

- [ ] **Step 2: Verify RED without the stack**

Run:

```powershell
node scripts/pilot-smoke.mjs
```

Expected: FAIL after the bounded deadline because no pilot stack is listening.

- [ ] **Step 3: Wire CI build and smoke lifecycle**

Add root script:

```json
"pilot:smoke": "node scripts/pilot-smoke.mjs"
```

In the Core GitHub Actions job, after ordinary tests:

```yaml
- name: Build Core production artifacts
  run: npm run build

- name: Validate pilot Compose
  run: npm run pilot:config

- name: Start pilot stack
  run: docker compose --env-file deploy/pilot/ci.env --file deploy/pilot/docker-compose.yml up --build --detach

- name: Smoke pilot boundaries
  run: npm run pilot:smoke

- name: Show pilot logs on failure
  if: failure()
  run: docker compose --env-file deploy/pilot/ci.env --file deploy/pilot/docker-compose.yml logs --no-color

- name: Stop pilot stack
  if: always()
  run: docker compose --env-file deploy/pilot/ci.env --file deploy/pilot/docker-compose.yml down --volumes --remove-orphans
```

- [ ] **Step 4: Run the Linux-authoritative gate**

Push the task branch and watch the Core GitHub check to completion.

Expected: Core and AI Worker both succeed; pilot image builds; all four HTTP boundary assertions pass; Compose tears down.

- [ ] **Step 5: Commit**

```powershell
git add scripts/pilot-smoke.mjs .github/workflows/ci.yml package.json
git commit -m "ci: verify pilot container boundaries"
```

---

### Task 5: Operator Deployment And Backup Runbook

**Files:**
- Modify: `docs/operations/internal-rollout-runbook.md`

**Interfaces:**
- Consumes: Tasks 1-4 commands and file paths.
- Produces: one exact VPS provisioning, deployment, verification, backup, restore, SSH tunnel, and rollback procedure.

- [ ] **Step 1: Add exact pilot deployment commands**

Document:

```bash
cp .env.pilot.example .env.pilot
chmod 600 .env.pilot
npm run readiness -- --env-file .env.pilot
docker compose --env-file .env.pilot --file deploy/pilot/docker-compose.yml config
docker compose --env-file .env.pilot --file deploy/pilot/docker-compose.yml up --build --detach
docker compose --env-file .env.pilot --file deploy/pilot/docker-compose.yml ps
```

Include Ubuntu firewall rules for SSH, HTTP, and HTTPS; DNS requirements; Feishu callback URL; and the SSH tunnel command.

- [ ] **Step 2: Add exact backup and restore commands**

Document an encrypted backup flow using `docker compose exec -T postgres pg_dump`, host-side encryption, owner-only permissions, and seven-day retention. Document restore into a stopped Core stack and require a readiness/status recheck after restore.

- [ ] **Step 3: Add exact rollback commands**

Document disabling the Feishu callback first, stopping `caddy` and `core`, preserving volumes/logs, and returning to the prior commit-pinned image.

- [ ] **Step 4: Verify documentation and repository contracts**

Run:

```powershell
git diff --check
npm run build
npm run pilot:config
npm run verify
```

Expected: all commands exit `0` except a local Docker image execution step when the documented host engine limitation is present; GitHub CI remains the authoritative Linux container gate.

- [ ] **Step 5: Request independent code review**

Review the complete range against the design, with special attention to:

- no public `/internal/*` route;
- no Postgres/Redis host ports;
- no committed secrets;
- migration ordering;
- non-root image runtime;
- bounded health polling and cleanup on CI failure;
- single-consumer deployment.

- [ ] **Step 6: Commit and push**

```powershell
git add docs/operations/internal-rollout-runbook.md
git commit -m "docs: add pilot VPS operations"
git push origin codex/iris-document-source-registry
```

After push, require PR #3 to report `mergeStateStatus: CLEAN`, Core success, and AI Worker success.
