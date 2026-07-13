# Iris Internal Rollout Runbook

This runbook is for the first 20-30 person company rollout. The goal is to keep Iris usable and
recoverable before a full admin UI exists.

## Pilot-First Rollout Gate

Do not wait for exhaustive hardening before anyone uses Iris. Roll out in two stages:

1. Start with one Feishu group and 3-5 cooperative users.
2. Expand to the full 20-30 person company only after the pilot has no unresolved P0 or P1 issue.

Only these severities may block the pilot:

- **P0:** unauthorized data exposure, callback authentication bypass, secret exposure, irreversible
  data loss, or uncontrolled external action.
- **P1:** Iris cannot reliably receive callbacks, answer an explicit mention, read a group-visible
  document, retrieve an authorized knowledge-base document, enforce the live permission guard,
  stop in an emergency, or recover queued work without repeated user-visible effects.
- **P2/P3:** operator convenience, non-critical status polish, future horizontal scale, and
  speculative hardening. Record these for post-launch work; do not delay the single-group pilot.

The pilot gate is green only when all of the following are true:

- `npm run readiness` reports `status: "ready"` or an explicitly accepted non-security warning;
- database migrations have completed and `GET /internal/status` reports all enabled workers running;
- GitHub Core and AI Worker checks pass for the deployed commit;
- one real Feishu group completes the callback, mention reply, group-document, authorized-wiki,
  live-permission-denial, global-disable, and queue-recovery smoke checks;
- an operator knows the rollback action: stop Core and disable or remove the Feishu callback/bot.

Once this gate passes, deploy the pilot. Do not start another general hardening audit unless the gate
fails, the pilot exposes a P0/P1 issue, or the same user friction repeats.

### Runtime-Control Limitation During The Pilot

The current runtime-control state is in memory. The pilot Compose configuration sets
`IRIS_RUNTIME_GLOBAL_ENABLED=false`, so a Core restart fails closed and requires an operator to
enable Iris explicitly after checking health. Per-group and capability mutations still return to
their defaults after restart. For the 3-5 person pilot, treat stopping the Core service (and, if
necessary, disabling the Feishu callback or bot) as the authoritative emergency stop. Durable
Postgres-backed runtime control is a P1 item before expanding to the full 20-30 person rollout, but
it does not delay the supervised single-group pilot.

## Security Boundary

The `/internal/*` endpoints are operator APIs, not public APIs. Until an authentication layer is
added, expose Core only inside a trusted network, VPN, or private tunnel controlled by the team.
`IRIS_INTERNAL_API_TOKEN` is required before the internal rollout readiness profile can pass; do
not invite the first group while operator APIs are missing a bearer-token guard.

When either `IRIS_INTERNAL_API_TOKEN` or `FEISHU_VERIFICATION_TOKEN` is missing or blank, the direct
Core development server listens only on `127.0.0.1`. Both v1 tokens are required before Core listens
on `0.0.0.0` for container, private-network, or callback ingress. `FEISHU_ENCRYPT_KEY` alone is not
sufficient. This is a startup safety fallback, not a replacement for the trusted network boundary.

Never expose these endpoints directly to the public internet:

- `/internal/runtime-control/*`
- `/internal/readiness`
- `/internal/document-sync/*`
- `/internal/events/*`
- `/internal/reindex/*`
- `/internal/audit/*`
- `/internal/answer-drafts`

Every `/internal/*` request must include:

```powershell
$irisHeaders=@{Authorization="Bearer $env:IRIS_INTERNAL_API_TOKEN"}
```

For runtime-control changes, operators may add an audit hint. This is not authentication; it is a
human-readable trace label recorded on runtime-control audit events:

```powershell
$irisOperatorHeaders=@{
  Authorization="Bearer $env:IRIS_INTERNAL_API_TOKEN"
  "X-Iris-Operator"="alice@example.com"
}
```

The internal `Invoke-RestMethod` examples below include `-Headers $irisHeaders`. `/health` and
`/feishu/events` do not use this token.

The bearer scheme is case-insensitive for client compatibility, but the token value must match
`IRIS_INTERNAL_API_TOKEN` exactly.

`IRIS_INTERNAL_API_TOKEN` must be a single visible ASCII token without spaces, tabs, line breaks, or
commas. Generate it as one header-safe secret value, for example with letters, numbers, hyphens, and
underscores.

The token guard applies to the internal request path before any query string. For example,
`/internal/status?details=1` and `/internal?probe=1` both require the same bearer token when
`IRIS_INTERNAL_API_TOKEN` is set. Encoded internal paths such as `/%69nternal/status` and
`/internal%2Fstatus` are treated as internal paths too, matching the router's decoded route view.

## Single-VPS Pilot Deployment

The approved pilot target is one Ubuntu 24.04 LTS VPS. Install Docker Engine and the Compose plugin
from Docker's official Ubuntu repository, then verify `docker version` and `docker compose version`.
Do not use the convenience install script for this persistent host.

Docker-published ports can bypass UFW rules. Use the cloud provider's network firewall or security
group as the primary ingress boundary:

- allow TCP `22` only from operator IP addresses;
- allow public TCP `80` and `443` for Caddy and Feishu;
- deny every other inbound port;
- never add public rules for `3000`, `5432`, or `6379`.

The pilot Compose file additionally publishes Core only on `127.0.0.1:3000` and publishes no
Postgres or Redis ports. Do not disable Docker's own firewall management; doing so breaks normal
bridge isolation. See the official [Docker Ubuntu installation](https://docs.docker.com/engine/install/ubuntu/)
and [Docker firewall guidance](https://docs.docker.com/engine/network/packet-filtering-firewalls/).

Create a dedicated operator account and either prefix every Docker command with `sudo`, or grant
that account Docker socket access before continuing:

```bash
sudo usermod --append --groups docker "$USER"
newgrp docker
docker info
```

Membership in the `docker` group is effectively root access. Grant it only to the dedicated Iris
operator, require SSH keys, and do not share that account.

Redis emits a reliability warning when Linux memory overcommit is disabled. Configure it once on the
VPS:

```bash
echo 'vm.overcommit_memory = 1' | sudo tee /etc/sysctl.d/99-iris-redis.conf
sudo sysctl --system
```

### DNS And Checkout

Create an `A` record for the pilot hostname pointing to the VPS public IPv4 address. If IPv6 is not
configured and reachable, do not publish an `AAAA` record. Wait until the record resolves to the VPS
before starting Caddy.

Deploy an explicit commit instead of a moving branch:

```bash
sudo install -d -o "$USER" -g "$USER" /opt/iris
git clone https://github.com/xfbbert-dotcom/iris.git /opt/iris/repository
cd /opt/iris/repository
git fetch origin
git checkout --detach APPROVED_COMMIT_SHA
```

Record `APPROVED_COMMIT_SHA` in the private deployment log. Do not deploy an unreviewed worktree or
an uncommitted local directory.

### Private Environment

Create the private environment file and make it readable only by the operator account:

```bash
cd /opt/iris/repository
cp .env.pilot.example .env.pilot
chmod 600 .env.pilot
```

Replace every `replace-with-*` value. Generate distinct URL-safe passwords for the Postgres admin,
`iris_migrator`, and `iris_app` roles, then keep `DATABASE_MIGRATION_URL` and `DATABASE_URL` aligned
with their respective credentials. Core receives only the app URL; the one-shot migration job
receives only the migrator URL; the admin credential remains inside the Postgres container. Set
`IRIS_IMAGE_TAG` to the checked-out `APPROVED_COMMIT_SHA`; never reuse a moving tag such as `pilot`
or `latest`. `IRIS_PUBLIC_HOSTNAME` is the DNS name only, without a path. Generate two distinct
header-safe tokens: the operator bearer for all internal APIs and the health-only bearer Caddy uses
only for ingress readiness:

```bash
openssl rand -hex 32
openssl rand -hex 32
```

Keep Feishu, model, embedding, database, and internal API secrets only in `.env.pilot` or a private
secret store. Never paste the resulting file into an issue, PR, chat, or shell history.

### Preflight And Startup

Validate Compose before contacting any service:

```bash
docker compose \
  --env-file .env.pilot \
  --file deploy/pilot/docker-compose.yml \
  config --quiet
```

Build the image and run readiness inside the same production image that will start Core. Readiness
does not make external network calls:

```bash
docker compose \
  --env-file .env.pilot \
  --file deploy/pilot/docker-compose.yml \
  build core

docker compose \
  --env-file .env.pilot \
  --file deploy/pilot/docker-compose.yml \
  run --rm --no-deps core \
  node apps/core/dist/admin/internal-rollout-readiness-cli.js
```

Do not continue unless readiness prints `"status":"ready"` with zero failed checks. Start the
single-consumer data services and Core while keeping public Caddy stopped:

```bash
docker compose \
  --env-file .env.pilot \
  --file deploy/pilot/docker-compose.yml \
  up --detach --wait --wait-timeout 120 postgres redis migrate core

docker compose \
  --env-file .env.pilot \
  --file deploy/pilot/docker-compose.yml \
  exec --no-TTY core node --input-type=module --eval '
    const response = await fetch("http://127.0.0.1:3000/internal/runtime-control/status", {
      headers: { authorization: `Bearer ${process.env.IRIS_INTERNAL_API_TOKEN}` },
    });
    const body = await response.json();
    if (!response.ok || body.globalEnabled !== false) process.exit(1);
  '

docker compose \
  --env-file .env.pilot \
  --file deploy/pilot/docker-compose.yml \
  up --detach caddy

docker compose \
  --env-file .env.pilot \
  --file deploy/pilot/docker-compose.yml \
  ps
```

The runtime-control probe must exit `0` before Caddy starts. Required state after Caddy starts:

- `postgres` and `redis` are healthy;
- `migrate` exited with code `0`;
- `core` is healthy;
- `caddy` is running;
- only ports `80`, `443`, and loopback `127.0.0.1:3000` are published.

Do not use `docker compose up --scale core=...` and do not run a second Core process. The pilot queue
recovery contract is single-consumer; exactly one `core` container is an explicit launch invariant.

If startup fails, inspect bounded logs before retrying:

```bash
docker compose \
  --env-file .env.pilot \
  --file deploy/pilot/docker-compose.yml \
  logs --no-color --tail 300
```

### Public And Private Boundary Checks

From a machine outside the VPS, verify the public surface:

```bash
curl --fail --silent --show-error https://iris.example.com/health
curl --silent --output /dev/null --write-out '%{http_code}\n' \
  https://iris.example.com/internal/status
```

Replace `iris.example.com` with `IRIS_PUBLIC_HOSTNAME`. Health must return `200`; the public internal
status request must return `404` from Caddy.

Open the private operator tunnel from the operator machine:

```bash
ssh -N -L 3000:127.0.0.1:3000 operator@iris.example.com
```

In another local terminal, verify both application authentication outcomes:

```bash
curl --silent --output /dev/null --write-out '%{http_code}\n' \
  http://127.0.0.1:3000/internal/status

curl --fail --silent --show-error \
  --header "Authorization: Bearer $IRIS_INTERNAL_API_TOKEN" \
  http://127.0.0.1:3000/internal/status

curl --fail --silent --show-error \
  --header "Authorization: Bearer $IRIS_INTERNAL_API_TOKEN" \
  http://127.0.0.1:3000/internal/ingress-readiness
```

The first request must return `401`; the authorized request must return `200` and show all enabled
workers running with empty DLQs. Ingress readiness must separately return `status: "ready"`; DLQ or
historical batch state remains an operator signal and does not control Caddy availability. Configure
the Feishu event callback only after these checks pass:

```text
https://iris.example.com/feishu/events
```

Caddy rechecks ingress readiness every two seconds. During a Redis outage it returns `503` on the
callback path so Feishu retries. After Redis is healthy, restart the single Core container; Caddy
keeps returning `503` until Core ingress readiness passes, then resumes forwarding automatically:

```bash
docker compose \
  --env-file .env.pilot \
  --file deploy/pilot/docker-compose.yml \
  restart core
```

A healthy callback still follows the fast ack-first path.

### Encrypted Backup

Install `age`, create an offline identity on an operator-controlled machine, and store only its public
recipient on the VPS. Never place the private age identity on the VPS. Install the reviewed backup
script and recipient with root-only permissions:

```bash
sudo apt-get update && sudo apt-get install -y age
sudo install -d -m 700 /etc/iris
printf '%s\n' 'AGE_PUBLIC_RECIPIENT' | sudo tee /etc/iris/backup-recipient > /dev/null
sudo chmod 644 /etc/iris/backup-recipient
sudo install -o "$USER" -g "$USER" -m 700 \
  deploy/pilot/backup.sh /usr/local/sbin/iris-backup
```

Replace `AGE_PUBLIC_RECIPIENT` with the single `age1...` recipient. Create a manual backup before
inviting pilot users:

```bash
/usr/local/sbin/iris-backup
```

The script uses `set -Eeuo pipefail`, refuses concurrent runs with `flock`, and briefly stops Caddy
and Core after graceful ingress drain. Before the stop it captures the in-memory global runtime
state through the authenticated container-local API and records whether Caddy is running. It
captures PostgreSQL and Redis while both are quiescent, starts Core alone in its configured
fail-closed state, then encrypts the paired snapshot as one bundle. It writes to a unique owner-only
temporary file and publishes it only after snapshot and encryption succeed. Only after atomic
publication does a successful planned backup restore a previously enabled global state and restart
Caddy when Caddy was running before maintenance. Files older than seven 24-hour periods are removed.

If any maintenance step fails, cleanup keeps Caddy stopped and restarts only a verified disabled
Core; it never re-enables Iris from the `EXIT` trap. Cleanup first attempts an explicit runtime API
disable, retries Caddy shutdown, uses a forced container stop if needed, and independently verifies
both final states. Treat `FAIL-CLOSED RECOVERY INCOMPLETE` as a page-level incident and immediately
verify the runtime and Caddy from the VPS. Host restarts, crashes, and container recreation also
remain fail-closed and still require an explicit operator enable. This planned-backup behavior does
not make runtime-control state durable, and group or capability overrides are not restored.

Copy the encrypted file off the VPS, decrypt it on the operator-controlled machine, inspect the
bundle, and validate both payloads. A bundle whose Postgres archive and Redis RDB have not both been
validated is not a verified backup.

```bash
VERIFY_DIR="$(mktemp -d)"
age --decrypt \
  --identity ~/.config/age/iris-backup-key.txt \
  iris-20260711T120000Z.bundle.tar.age \
  | tar --extract --directory "$VERIFY_DIR"
pg_restore --list "$VERIFY_DIR/postgres.dump" > /dev/null
docker run --rm \
  --volume "$VERIFY_DIR:/verify:ro" \
  redis:7-alpine@sha256:6ab0b6e7381779332f97b8ca76193e45b0756f38d4c0dcda72dbb3c32061ab99 \
  redis-check-rdb /verify/redis.rdb
rm -rf "$VERIFY_DIR"
```

After the first manual verification and off-host copy are working, schedule the installed script
from the dedicated operator account's crontab. Backup and restore share the same `flock` lock and
the same operator-owned backup directory:

```cron
15 2 * * * /usr/local/sbin/iris-backup >> /opt/iris/backup.log 2>&1
```

The scheduled command creates an encrypted local backup; a separate operator-controlled copy job
must move it off the VPS. Alert if either the backup or off-host copy fails.

### Restore Drill

Disable the Feishu callback before starting a restore so the platform does not accumulate callback
retries while Caddy is intentionally stopped.

Decrypt the selected paired bundle on the operator-controlled machine and stream it over SSH to the
reviewed restore script on the VPS. The required confirmation flag is deliberately
explicit. The script first restores the complete archive into a new staging database with
`--exit-on-error --single-transaction` and runs all migrations there while the current database
remains online. Only after those steps succeed does it stop Caddy and Core, rename the current
database to a timestamped `iris_previous_*` name, promote the staging database, replace Redis with
the paired RDB, and restart Iris. The old database and pre-swap Redis RDB are retained for explicit
post-restore acceptance and rollback; the script never deletes them automatically.

Run from the operator-controlled machine:

```bash
age --decrypt \
  --identity ~/.config/age/iris-backup-key.txt \
  iris-20260711T120000Z.bundle.tar.age \
  | ssh operator@iris.example.com \
    "cd /opt/iris/repository && \
      ./deploy/pilot/restore-from-stdin.sh --confirm-replace-database"
```

If staging restore or migration fails, the script removes only the staging database and leaves live
traffic untouched. If swap, readiness, or startup fails, it exits non-zero with Caddy and Core
stopped and preserves the previous database plus Redis RDB. Investigate before any manual restart.
After success, repeat private status, DLQ, database, and Feishu smoke checks; delete the retained
pair only after the acceptance window closes.

Do not practice restore against the only live database. Perform the first restore drill on a fresh
temporary Postgres volume or a separate VPS before inviting the full 20-30 person company.

### Emergency Stop And Rollback

The authoritative pilot stop is operational, not the in-memory runtime switch:

```bash
docker compose \
  --env-file .env.pilot \
  --file deploy/pilot/docker-compose.yml \
  stop caddy core
```

Disable the Feishu callback or bot before restarting an unsafe build. Preserve logs and volumes:

```bash
docker compose \
  --env-file .env.pilot \
  --file deploy/pilot/docker-compose.yml \
  logs --no-color > "iris-rollback-$(date -u +%Y%m%dT%H%M%SZ).log"
```

Checkout the previous approved commit, set `IRIS_IMAGE_TAG` to that commit SHA, validate Compose,
build that exact Core image, run readiness through the `core` service, and start the stack. Never
retag a failed image as the rollback release. If the failed release applied a migration that is not
backward compatible, restore the verified pre-release database backup before starting the previous
image.

## Local Infrastructure

Start Postgres and Redis:

```powershell
docker compose up -d
```

If Docker fails before containers start, separate repository configuration from host runtime setup:

```powershell
docker compose config
docker version
docker desktop status
wsl --status
```

- `docker compose config` validates the Compose file without requiring a running daemon.
- If `docker` is not recognized, install Docker Desktop and reopen the terminal so the CLI is on
  `PATH`.
- If Docker Desktop reports `stopped`, start Docker Desktop from Windows and wait for the engine to
  become ready before retrying `docker compose up -d`.
- If Docker Desktop is running but `docker version` cannot reach
  `npipe:////./pipe/docker_engine`, check that the Docker Desktop backend and WSL integration are
  healthy.
- If `wsl --status` reports WSL is not installed or unavailable, enable/install WSL and restart
  Docker Desktop. This is host setup, not an Iris repository failure.

Set the local database URL and run migrations:

```powershell
$env:DATABASE_URL="postgres://iris:iris@localhost:5432/iris"
npm --workspace apps/core run db:migrate
```

After the local database is running, run the optional Postgres-backed integration tests before
changing database migrations or repository behavior:

```powershell
$env:DATABASE_URL="postgres://iris:iris@localhost:5432/iris"
npm --workspace apps/core test -- postgres-document-source-registry.test.ts
npm --workspace apps/core test -- document-snapshot-repository.test.ts
npm --workspace apps/core test -- document-fragment-repository.test.ts
```

## Core Runtime Environment

Use `.env.example` as the non-secret checklist for the variables below. Keep real values in your
local shell, deployment secret store, or private runtime configuration.

Minimal shared configuration:

```powershell
$env:DATABASE_URL="postgres://iris:iris@localhost:5432/iris"
$env:REDIS_URL="redis://localhost:6379"
$env:PORT="3000"
$env:IRIS_INTERNAL_API_TOKEN="<operator-shared-secret>"
```

Feishu callback verification:

```powershell
$env:FEISHU_VERIFICATION_TOKEN="<feishu-verification-token>"
$env:FEISHU_ENCRYPT_KEY="<optional-feishu-encrypt-key>"
```

For the v1 internal rollout, `FEISHU_VERIFICATION_TOKEN` is required because Iris must read Feishu's
URL verification `challenge` from the callback body. `FEISHU_ENCRYPT_KEY` can add request signature
verification, but v1 does not decrypt encrypted Feishu callback payloads. If `FEISHU_ENCRYPT_KEY` is
set, callbacks must pass both the verification-token check and Feishu signature check.

Feishu OpenAPI access for document reads and live permission checks:

```powershell
$env:FEISHU_APP_ID="<feishu-app-id>"
$env:FEISHU_APP_SECRET="<feishu-app-secret>"
$env:FEISHU_OPEN_BASE_URL="https://open.feishu.cn"
$env:IRIS_FEISHU_BOT_OPEN_ID="<iris-bot-open-id>"
$env:IRIS_FEISHU_DOCUMENT_FETCH_TIMEOUT_MS="10000"
$env:IRIS_FEISHU_DOCUMENT_MAX_CONTENT_CHARS="2000000"
```

`IRIS_FEISHU_BOT_OPEN_ID` lets Iris identify explicit @mentions from Feishu message events. When
this value, Feishu OpenAPI credentials, and internal answer drafting are configured, the event worker
can draft an answer and reply to messages that mention the Iris bot. Missing this value keeps event
ingestion and document discovery running, but disables automatic @Iris replies.
Check `GET /internal/events/status` or `GET /internal/status` for `mentionRepliesEnabled: true`
before expecting @Iris replies in Feishu. If it is false, inspect
`mentionRepliesUnavailableReason` for the missing setup step.
In the consolidated `/internal/status` response, missing mention-reply wiring marks the
`eventWorker` component as degraded with `degradedReason: "mention_replies_unavailable"` so the
operator dashboard does not look healthy while @Iris is unable to answer.

Mention reply readiness reasons:

| Reason | Meaning | Fix |
| --- | --- | --- |
| `missing_bot_open_id` | Iris cannot identify which Feishu mention belongs to itself. | Set `IRIS_FEISHU_BOT_OPEN_ID` to the bot open id from Feishu. |
| `missing_feishu_openapi_config` | Iris can process events but cannot call Feishu OpenAPI to reply. | Set `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, and `FEISHU_OPEN_BASE_URL`. |
| `missing_answer_draft_orchestrator` | Iris can receive mentions but cannot generate answers. | Enable internal answer drafts and configure model, embedding, and retrieval dependencies. |

Enable background workers:

```powershell
$env:IRIS_EVENT_WORKER_ENABLED="true"
$env:IRIS_DOCUMENT_SYNC_WORKER_ENABLED="true"
$env:IRIS_REINDEX_WORKER_ENABLED="true"
```

For the 20-30 person v1 rollout, run only one active Core worker consumer for each Redis queue
family: raw events, document sync, and document reindex. The current Redis queue adapter recovers a
shared `processing` list before polling, which protects a single crashed worker from losing work but
is not safe for horizontal worker replicas. Do not scale Core or standalone worker processes beyond
one active consumer per queue until Iris has a leased queue adapter with per-consumer ownership and
expired-lease recovery.

Optional worker tuning:

```powershell
$env:IRIS_EVENT_WORKER_INTERVAL_MS="1000"
$env:IRIS_EVENT_WORKER_BATCH_LIMIT="50"
$env:IRIS_DOCUMENT_SYNC_WORKER_INTERVAL_MS="1000"
$env:IRIS_DOCUMENT_SYNC_WORKER_BATCH_LIMIT="10"
$env:IRIS_REINDEX_WORKER_INTERVAL_MS="1000"
$env:IRIS_REINDEX_WORKER_BATCH_LIMIT="25"
```

Model and embedding providers:

```powershell
$env:IRIS_MODEL_PROVIDER="openai-compatible"
$env:IRIS_MODEL_BASE_URL="https://api.example.com/v1"
$env:IRIS_MODEL_API_KEY="<model-api-key>"
$env:IRIS_MODEL_NAME="<model-name>"
$env:IRIS_MODEL_TIMEOUT_MS="30000"

$env:IRIS_EMBEDDING_PROVIDER="openai-compatible"
$env:IRIS_EMBEDDING_BASE_URL="https://api.example.com/v1"
$env:IRIS_EMBEDDING_API_KEY="<embedding-api-key>"
$env:IRIS_EMBEDDING_MODEL="<embedding-model>"
$env:IRIS_EMBEDDING_DIMENSIONS="1536"
$env:IRIS_EMBEDDING_TIMEOUT_MS="30000"
```

External base URLs must be absolute `http` or `https` URLs without embedded credentials, query
strings, or fragments. Iris rejects invalid model, embedding, and Feishu OpenAPI base URLs during
configuration loading.

Enable internal answer drafting:

```powershell
$env:IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS="true"
$env:IRIS_INTERNAL_DRAFT_PERMISSION_MODE="source-policy"
```

In `source-policy` mode, Feishu docx/docs/wiki fragments require Feishu OpenAPI live permission
checks before they can enter the model prompt. If `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, or
`FEISHU_OPEN_BASE_URL` is missing, Iris fails closed for Feishu document content and answers from
live chat plus any non-Feishu sources covered by local policy.

Mention replies require both internal answer drafting and the `replyWhenMentioned` runtime
capability. If Iris is globally disabled, the group is disabled, or `replyWhenMentioned` is false,
Iris will store allowed message facts but will not answer in Feishu.
When Feishu retries the same mentioned message, Iris skips duplicate `messageId` deliveries while a
reply is in flight, after a successful reply, or after runtime control suppressed that message.
Failed reply attempts remain retryable. This protects model budget and reply API calls in the v1
single-Core deployment, and prevents old mentions from being answered after replies are re-enabled;
a future multi-replica deployment should move this short-lived dedupe state into Redis.
At the gateway layer, valid Feishu event IDs deduplicate raw callbacks first. If a message callback
lacks a usable event ID, Iris falls back to `messageId` before using the canonical body hash, so
retry wrappers that add metadata do not create duplicate message events.

Before starting the internal rollout, run the same readiness profile locally:

```powershell
npm run readiness
```

Or validate a private env file directly:

```powershell
npm run readiness -- --env-file .env
```

The env-file parser supports full-line comments and inline operator notes after unquoted or quoted
values, for example `PORT=3000 # local dev port`. A `#` inside quoted values is preserved, so quote
secrets or URLs when the `#` is part of the value.

The command prints the readiness JSON and exits with code `1` when any blocking check fails.

Run Core:

```powershell
npm --workspace apps/core run dev
```

## Health Checks

Basic process health:

```powershell
Invoke-RestMethod http://localhost:3000/health
```

Consolidated operator status:

```powershell
Invoke-RestMethod `
  -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/status
```

Pre-rollout configuration readiness:

```powershell
Invoke-RestMethod `
  -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/readiness
```

Use readiness before inviting the first internal group. `status: "ready"` means chat ingestion,
document sync, semantic reindexing, @Iris answer drafting, Feishu OpenAPI access, the source-policy
permission guard, and the internal operator API token are configured.
`status: "ready_with_warnings"` means no blocking configuration is missing, but the listed warnings
should be handled before exposing Core beyond a trusted private network. `status: "blocked"` means
Iris is not ready for the 20-30 person rollout; check each failed item and the listed `envVars`.

Important status rules:

- Top-level `status: "healthy"` means no reported component has `ok: false` and no enabled
  runtime component is stopped.
- Top-level `status: "degraded"` means at least one reported component has `ok: false`, or an
  enabled runtime component reports `running: false`.
- `summary.attentionSeverity` is the compact operator-priority signal: `critical` for degraded
  components, `warning` for stopped enabled runtimes, `info` for disabled components, and `none`
  when no component needs attention.
- Non-empty raw event, document sync, or reindex DLQs degrade the matching component.
- Stopped enabled runtimes are warning-level failures because Iris is configured to do the work but
  the worker is not running.
- Disabled components are expected when the corresponding runtime is intentionally off.
- `components.runtimeControl` mirrors the current global runtime gate. If its status is
  `"disabled"`, Iris is globally off even if worker processes are still reachable.

## Runtime Control

Disable Iris globally:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/runtime-control/global `
  -ContentType "application/json" `
  -Body '{"enabled":false}'
```

Enable Iris globally:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/runtime-control/global `
  -ContentType "application/json" `
  -Body '{"enabled":true}'
```

Disable Iris for one Feishu group:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/runtime-control/groups/oc_group_id `
  -ContentType "application/json" `
  -Body '{"enabled":false}'
```

Update capabilities:

```powershell
Invoke-RestMethod `
  -Method Patch `
  -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/runtime-control/capabilities `
  -ContentType "application/json" `
  -Body '{"replyWhenMentioned":true,"readGroupDocuments":true,"retrieveKnowledgeBase":true}'
```

For emergency context isolation, set `readGroupContext` to `false`. Iris will stop writing new group
message facts and will not automatically load stored live chat history into answer prompts. Direct
mention replies can still use the current explicit request when `replyWhenMentioned` remains enabled.

Read current runtime control state:

```powershell
Invoke-RestMethod `
  -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/runtime-control/status
```

The same state is also summarized inside `GET /internal/status` as `components.runtimeControl`,
including the current capability flags, so the consolidated operator snapshot can be used as the
first health check during rollout.

Inspect recent runtime-control changes:

```powershell
Invoke-RestMethod `
  -Headers $irisHeaders `
  -Uri "http://localhost:3000/internal/audit/events?limit=20&type=runtime_control_updated"
```

When a runtime-control mutation is sent with `X-Iris-Operator`, the audit event includes
`operatorHint`.

Filter runtime-control changes by operator hint:

```powershell
Invoke-RestMethod `
  -Headers $irisHeaders `
  -Uri "http://localhost:3000/internal/audit/events?limit=20&type=runtime_control_updated&operatorHint=alice%40example.com"
```

## Document Operations

List known document sources:

```powershell
Invoke-RestMethod `
  -Headers $irisHeaders `
  -Uri "http://localhost:3000/internal/document-sync/sources?limit=20&includeLatestSnapshot=true"
```

Register an authorized wiki document:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/document-sync/authorized-wiki-documents `
  -ContentType "application/json" `
  -Body '{"sourceUri":"https://example.feishu.cn/wiki/wiki_token","title":"Company Handbook","authorizedSpaceId":"space_1"}'
```

Register a user-submitted document:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/document-sync/user-submitted-documents `
  -ContentType "application/json" `
  -Body '{"sourceUri":"https://example.feishu.cn/docx/doc_token","title":"User Guide","submittedByUserId":"ou_1"}'
```

Use the clean Feishu document URL for manual registration. Iris strips query strings and fragments,
but rejects obvious pasted-text contamination such as `https://example.feishu.cn/docx/doc_token,please`
before it can enter the registry or sync queue.

Manually enqueue a known source for sync:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/document-sync/sources/source_id/enqueue
```

If this endpoint returns `document_sync_enqueue_failed`, Iris preserves the source's previous
`syncState` when possible. Treat the failure as "no manual sync job was created", check Redis/Core
health, and retry after the queue is healthy.

Disable a source for answer retrieval:

```powershell
Invoke-RestMethod `
  -Method Patch `
  -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/document-sync/sources/source_id/policy `
  -ContentType "application/json" `
  -Body '{"canUseForAnswering":false}'
```

## DLQ Recovery

Raw Feishu event DLQ:

```powershell
Invoke-RestMethod `
  -Headers $irisHeaders `
  -Uri "http://localhost:3000/internal/events/dead-letters?limit=20"
```

Document sync DLQ:

```powershell
Invoke-RestMethod `
  -Headers $irisHeaders `
  -Uri "http://localhost:3000/internal/document-sync/dead-letters?limit=20"
```

Reindex DLQ:

```powershell
Invoke-RestMethod `
  -Headers $irisHeaders `
  -Uri "http://localhost:3000/internal/reindex/dead-letters?limit=20"
```

Replay one DLQ item:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/document-sync/dead-letters/dlq_id/replay
```

Replay a selected batch:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/document-sync/dead-letters/replay `
  -ContentType "application/json" `
  -Body '{"ids":["dlq_1","dlq_2"]}'
```

Delete an obsolete DLQ item:

```powershell
Invoke-RestMethod `
  -Method Delete `
  -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/document-sync/dead-letters/dlq_id
```

Recovery rule:

- Fix the underlying cause first, such as missing Feishu credentials, provider outage, permission
  denial, or bad source URL.
- Use list endpoints to inspect failures.
- Replay selected items only after the cause is fixed.
- Delete obsolete or legacy diagnostic entries when replay is not possible.
- Re-check `/internal/status` after recovery; DLQ backlog should clear and the component should no
  longer be degraded for dead-letter reasons.
- If a component is listed with `status: "stopped"`, treat it as an enabled worker that is not
  running. It appears in `degradedComponents` until the worker is started or intentionally disabled.

## Verification Before Internal Use

Run the local verification suite before changing rollout configuration:

```powershell
npm run verify
```

For PR verification, GitHub Actions must show:

- Core: success
- AI Worker: success
- PR merge state: clean
