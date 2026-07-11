# Iris Single-VPS Pilot Deployment Design

## Goal

Deploy the current Iris PR stack to one Linux VPS for a supervised 3-5 person Feishu group pilot.
The deployment must make the working callback, mention reply, document sync, retrieval, and
permission paths available without exposing operator APIs, Postgres, or Redis to the public
internet.

This is the first real-use environment, not a horizontally scalable production platform.

## Selected Approach

Use one Ubuntu 24.04 LTS VPS with Docker Compose and five containers:

1. `caddy`: public TLS termination and strict route allowlist.
2. `migrate`: one-shot Core image command that applies Postgres migrations.
3. `core`: one TypeScript Core process and one consumer for each Redis queue family.
4. `postgres`: Postgres 16 with pgvector and a persistent volume.
5. `redis`: Redis 7 with append-only persistence and a persistent volume.

The Python AI Worker package remains tested but does not run as an idle pilot container because it
does not yet have a long-running queue-consumer entry point. The implemented pilot answer,
document-sync, embedding, and retrieval paths currently run through Core. This is a deployment-stage
deviation, not removal of the architectural Python worker boundary; Python jobs enter the deployment
when they own executable queue work.

## Network And Security Boundary

The VPS firewall exposes only:

- TCP `22` from operator IPs for SSH;
- TCP `80` and `443` publicly for Caddy and Feishu callbacks.

Caddy publicly forwards only exact paths:

- `/feishu/events` to Core;
- `/health` to Core.

Every other public path returns `404`, including all `/internal/*` paths. Core is additionally bound
to host loopback as `127.0.0.1:3000`, allowing operators to use an SSH tunnel without making the
operator API public:

```bash
ssh -L 3000:127.0.0.1:3000 operator@$IRIS_PUBLIC_HOSTNAME
```

Postgres and Redis have no published host ports. They are reachable only on the private Compose
network. Core still enforces `IRIS_INTERNAL_API_TOKEN` on `/internal/*`, so the SSH boundary and
application bearer token remain defense in depth.

## Image And Startup Flow

The Core image uses a multi-stage Node 22 build:

1. install the locked workspace dependencies with `npm ci`;
2. compile only `apps/core/src` to JavaScript;
3. prune development dependencies;
4. copy the compiled app and production dependencies into a non-root runtime image;
5. run with the existing direct executable entry point.

Compose startup order is condition-based:

```text
Postgres healthy -> migrate exits successfully --\
                                               +-> Core healthy -> Caddy public
Redis healthy --------------------------------/
```

A migration failure prevents Core startup. A listener or runtime startup failure exits the Core
container, whose restart policy retries after the failure is visible in container logs. The
deployment keeps exactly one Core replica because the current Redis processing recovery contract is
single-consumer.

The migration job intentionally depends only on Postgres and receives only `DATABASE_URL`; it does
not need Redis, Feishu, model, embedding, or operator credentials. Third-party images are pinned by
digest, while the locally built Core image is tagged with the approved source commit.

## Configuration And Secrets

Commit only a non-secret `.env.pilot.example`. The real `.env.pilot` remains ignored by Git and is
stored on the VPS with owner-only permissions.

The pilot environment must provide:

- public hostname and Caddy email;
- Postgres database name, user, and URL-safe password;
- all variables already required by `npm run readiness`;
- Feishu verification token, app credentials, and Iris bot open ID;
- model and embedding provider credentials;
- one generated internal API bearer token.

The deployment must run readiness against the real env file before starting Compose. Placeholder
values are never accepted as a successful launch gate.

## Persistence And Recovery

Postgres and Redis use named Docker volumes. Redis enables append-only persistence so queued work is
not intentionally memory-only across a clean restart.

Before inviting pilot users:

- create and verify one encrypted `pg_dump` backup;
- schedule daily encrypted Postgres backups with seven-day retention;
- record the restore command in the private operator notes;
- confirm the document/event/reindex DLQs are empty.

Runtime-control switches are still in memory. During the single-group pilot, the authoritative
emergency stop is to stop `core` and, if required, disable the Feishu callback or bot. Durable
Postgres-backed runtime control remains required before expansion to 20-30 users.

## Public And Private Verification

Automated deployment verification must prove:

- the Core TypeScript production build succeeds;
- the Core Docker image builds;
- the pilot Compose file resolves with placeholder non-secret configuration;
- Core container health reaches healthy;
- public `/health` returns `200`;
- public `/internal/status` returns `404` at Caddy;
- loopback `/internal/status` returns `401` without a bearer token and `200` with it.

The real Feishu pilot smoke test then proves:

1. URL verification and a normal callback receive `200` within the Feishu timeout.
2. A non-mentioned message is stored but does not trigger a reply.
3. An explicit @Iris mention produces one reply.
4. A document shared in the pilot group is fetched, indexed, and used with source evidence.
5. An authorized wiki document can be retrieved.
6. A permission-denied document is excluded from answer context.
7. Global disable stops processing/replies for the running process.
8. A controlled failed job becomes visible, can be replayed, and clears from DLQ.

Only failures in this gate trigger more pre-pilot hardening.

## Deployment And Rollback

Initial deployment is manual and commit-pinned:

1. provision the VPS, firewall, DNS, and Docker Engine;
2. clone the repository and check out the approved commit;
3. install the private `.env.pilot`;
4. run readiness, image build, and Compose validation;
5. start the stack and verify public/private boundaries;
6. configure Feishu to use `https://${IRIS_PUBLIC_HOSTNAME}/feishu/events`;
7. invite one pilot group.

Rollback is operationally simple:

1. disable the Feishu callback or bot;
2. stop Caddy and Core;
3. preserve Postgres/Redis volumes and logs;
4. restore the previous commit-pinned image or database backup if needed.

## Out Of Scope

- multiple Core replicas or queue consumers;
- Kubernetes or service splitting;
- public Admin Console access;
- automatic cloud provisioning;
- multi-tenant isolation;
- deploying an idle Python worker without executable queue ownership;
- durable runtime-control implementation in the 3-5 person pilot.
