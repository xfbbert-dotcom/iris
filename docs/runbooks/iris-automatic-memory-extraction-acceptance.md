# Iris Automatic Memory Extraction Acceptance

Run this procedure on the isolated pilot only. Do not deploy to production or enable a real Feishu
group until every internal gate passes. Record the approved commit, image tag, fixture IDs, UTC
timestamps, status responses, SQL result counts, and fake-provider call count in the acceptance
record. Do not record bearer tokens, model keys, message text, or model payloads.

## Preconditions

1. Set `APPROVED_SHA` to the reviewed commit and set `IRIS_IMAGE_TAG` to that exact value. Require
   the rendered images to include both `iris-core:$APPROVED_SHA` and
   `iris-ai-worker:$APPROVED_SHA`; stop if their tags differ or either image has unreviewed source.
2. Keep `IRIS_MEMORY_EXTRACTION_ENABLED=false`, set a fresh shared `IRIS_AI_WORKER_TOKEN`, and load
   extraction-model credentials only through `IRIS_MEMORY_EXTRACTION_MODEL_*`. Leave Core's
   existing `IRIS_MODEL_*` answer configuration unchanged.
3. Reserve two non-production fixture groups, A and B, one deterministic ordinary-message fixture,
   one fixed candidate response with exactly one candidate grounded in A's message, and a second
   response that incorrectly cites B's message for an A candidate. Use unique fixture IDs and a UTC
   `RUN_STARTED_AT` so every database assertion is scoped to this run.
4. Use an approved internal acceptance harness that can submit the fixed persisted-message/event
   fixtures, replay the same provider message ID, hold execution immediately before candidate
   apply, and count calls to a backend-only fake model provider. The harness must not call Feishu or
   any live model during internal gates.

Render the reviewed configuration before startup:

```bash
docker compose --env-file deploy/pilot/.env --file deploy/pilot/docker-compose.yml config --images
```

Stop if the AI Worker has a published port, joins `edge`, runs as root, lacks bounded logging or a
bounded healthcheck, or if Core does not depend on it with `condition: service_started`.

## Private Startup Gates

1. Before migration or startup checks, durably POST `{ "enabled": false }` to
   `/internal/runtime-control/global` with the internal bearer token and operator header. Require
   HTTP 200, `globalEnabled=false`, and `durable=true`. Stop Caddy and prove it is stopped.
2. Start migration, Postgres, Redis, AI Worker, and Core while Caddy remains stopped. Require Docker
   health to report Postgres, Redis, AI Worker, and Core healthy. Require AI Worker `/health` to
   return exactly `{"ok":true,"service":"iris-ai-worker","schemaVersion":1}` from the backend
   network; do not publish a temporary port.
3. GET authenticated `/internal/status` and `/internal/memory-extraction/status`. Require Postgres
   persistence healthy and all enabled Core workers healthy. Before enabling extraction, require
   the direct extraction status to be exactly the disabled shape
   `{"ok":true,"enabled":false,"running":false}`.
4. Enable extraction only in the pilot configuration, recreate Core, and keep global Iris and both
   fixture groups disabled. Require extraction `enabled=true`, `running=true`, and
   `workerHealthy=true` before continuing.
5. Establish a zero baseline. Raw-event pending/processing/DLQ, document-sync
   pending/processing/delayed/DLQ, reindex pending/processing/delayed/DLQ, and memory-extraction
   `pendingJobCount`, `processingJobCount`, `delayedJobCount`, and `deadLetterJobCount` must all be
   zero. If a component does not expose one of those states, verify its authoritative Redis key or
   database state and record that evidence. Do not continue from a nonzero baseline.

## Deterministic Internal Acceptance

Run each gate from a fresh zero queue baseline. Caddy must remain stopped for this entire section.
A failure ends acceptance, durably disables global Iris, and triggers rollback.

1. Prove Caddy is stopped, durably enable global Iris, then enable only fixture group A through
   `/internal/runtime-control/groups/:groupId`. Real ingress remains closed because Caddy is stopped.
   Submit the fixed non-mention event through the internal harness and wait boundedly for extraction
   queues to return to zero.
2. Query `group_memories`, `group_memory_message_evidence`, and `conversation_messages`, scoped to
   group A, `created_by='memory-extraction-worker'`, and `created_at >= RUN_STARTED_AT`. Require
   exactly one new active memory, at least one evidence row, every evidence message in group A, and
   the fixed source message among those rows. Record only IDs and counts.
3. Replay the exact same provider message ID and payload. After queues return to zero, require the
   same memory ID, total new-memory count still exactly one, and no additional evidence binding.
4. Submit the cross-group candidate that cites B's message for a memory in A. Require no new or
   changed memory and a deterministic rejection diagnostic; all queues must return to zero.
5. Use the harness barrier to pause one A run after claim and before apply. Durably disable group A,
   release the barrier, and require the run to be skipped as `runtime_disabled_before_apply` with no
   memory created or changed. Re-enable A, wait through one worker interval, and prove that skipped
   candidate still was not applied.
6. Point only the AI Worker's extraction-model variables at a backend-only fake provider configured
   to return one HTTP 429 with a valid `Retry-After`. Submit one job and require exactly one fake
   provider call, exactly one delayed extraction job, a bounded shared `providerCooldownUntil`, no
   DLQ item, and no memory. Submit another eligible job during cooldown and require the call count
   to remain one. Never exhaust or probe live Gemini quota to manufacture this gate.
7. Reset the fake provider to the fixed successful response, expire the harness-controlled cooldown,
   and drain both jobs. Require extraction pending, processing, delayed, and DLQ counts all zero.
8. POST an authenticated `/internal/answer-drafts` request with `chatId` equal to group A and a fixed
   question that requires the accepted decision. Require the result's permitted memory context to
   contain the accepted memory ID/content and to contain no group B evidence or unauthorized
   document. This proves a later same-group answer receives the memory without calling Feishu.
9. Durably disable group A and global Iris, require `globalEnabled=false` and `durable=true`, and
   recheck every queue/DLQ count is zero before leaving the internal phase.

## One-Group Feishu Pilot

Only after all internal gates pass, durably enable global Iris and exactly one approved real Feishu
pilot group. Keep every other group disabled.

1. Send one ordinary, non-mention decision message in the approved group and record its Feishu
   message ID and time. Do not include secrets or sensitive personal data.
2. Wait boundedly for all raw, document, reindex, and extraction queues/DLQs to return to zero.
   Require exactly one evidence-bound memory for that message and no memory in another group.
3. Send a later `@Iris` question whose answer requires the decision. Require the answer to use the
   decision accurately and cite no document, message, or memory outside the approved group and
   current permission policy.
4. Re-run health and zero-count gates. Acceptance passes only if existing callback acknowledgement,
   ordinary chat persistence, document sync, and mention replies remain healthy.

## Rollback

1. First durably disable global Iris and the pilot group. Require `globalEnabled=false` and
   `durable=true`, stop Caddy, and leave Core plus AI Worker running so already queued extraction
   jobs can observe the disabled policy.
2. Wait boundedly for pending, processing, and delayed extraction work to drain or be explicitly
   skipped. Require extraction DLQ and all other queue/DLQ counts to be zero. Do not delete Redis
   keys or database rows to force a green result; preserve failed evidence for diagnosis.
3. Set `IRIS_MEMORY_EXTRACTION_ENABLED=false` and recreate Core. Require the direct extraction
   status to return `enabled=false` and `running=false`, then stop the AI Worker. Core must remain
   healthy even though the worker is absent.
4. Verify existing chat persistence, document sync, internal answer draft, callback acknowledgement,
   and mention-reply paths still work. Restore Caddy and any prior global/group runtime state only
   after those checks pass and only under the existing Pilot Operations reactivation procedure.
5. Preserve accepted memories unless the incident requires a reviewed corrective or hard-delete
   operation. Record the failed gate, affected fixture IDs, queue counts, and rollback timestamps;
   never record secrets or raw provider payloads.
