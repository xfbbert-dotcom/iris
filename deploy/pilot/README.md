# Iris Pilot Operations

Use the reviewed commit and an image whose recorded source SHA is that same commit. Keep the
internal bearer token inside Core; do not print it, the database URL, or any application secret.

## Automatic Memory Extraction

The `ai-worker` service is reachable only on the internal `backend` network and publishes no host
port. Core and AI Worker images use the same `IRIS_IMAGE_TAG`. Keep
`IRIS_MEMORY_EXTRACTION_ENABLED=false` is the maintenance and preflight default. The controlled
real-Feishu memory/thread/action gate has passed, so a reviewed daily pilot may set it to `true`
only with `IRIS_THREAD_EXTRACTION_GROUP_IDS` and `IRIS_ACTION_EXTRACTION_GROUP_IDS` equal to the
single approved pilot group. Keep both lists empty outside that pilot. The AI Worker bearer token
must match Core's token, while its extraction-model credentials come from the separate
`IRIS_MEMORY_EXTRACTION_MODEL_*` deployment variables; do not replace Core's existing answer-model
configuration.

Core waits only for `ai-worker` to start. An unhealthy extraction worker degrades extraction status
but must not prevent Feishu callback, document-sync, or mention-reply startup. Never expose the
worker on the edge network and never use live provider quota to manufacture an acceptance 429.

## Local Embedding Profile Rollout

The Gemini free tier exhausted the shared `embed_content_free_tier_requests` quota at 100 requests;
changing Gemini embedding model names did not create a separate quota. The pilot therefore uses
only the private Ollama embedding service for vectors. It does not replace the existing answer or
AI Worker extraction model provider, and neither `embedding-model` nor `embedding-model-init` has
an edge or host port.

Run the full procedure in the [internal rollout runbook](../../docs/operations/internal-rollout-runbook.md#local-embedding-profile-migration)
with Caddy stopped and global runtime disabled. `embedding-model-init` verifies the full stored
model-manifest SHA256 for `qwen3-embedding:0.6b`; `embedding-model` repeats that check in its
health check. Both checks must pass before Core can start. Do not treat `ollama list`, a model name,
or a partial digest as approval.

The active profile is exactly `openai-compatible:qwen3-embedding:0.6b:1024`. Record old-profile
DLQ evidence before deleting any old-profile DLQ entry, then use the bounded repeated
`/internal/reindex/document-profile` procedure until it reports no more work. Preserve the
prior-profile fragments for rollback; they are not candidates for the new profile's retrieval.

Keep Caddy stopped until the runbook has recorded zero queue and DLQ counts, a passing live Feishu
permission guard, and the internal Life Engine retrieval gate. Feishu-native related-knowledge UI
is not Iris evidence.

## Wiki Space Sync

`IRIS_WIKI_SPACE_SYNC_ENABLED=false` is the deployment default. The feature remains off unless the
operator explicitly enables it and restarts Core with the document-sync worker enabled. Keep the
following values explicit in `.env.pilot`: `IRIS_WIKI_SPACE_SYNC_INTERVAL_MS=1000`,
`IRIS_WIKI_SPACE_SYNC_REFRESH_INTERVAL_MS=21600000`, `IRIS_WIKI_SPACE_SYNC_LEASE_MS=600000`,
`IRIS_WIKI_SPACE_SYNC_MAX_DEPTH=20`, and `IRIS_WIKI_SPACE_SYNC_MAX_ATTEMPTS=5`.

Use the [wiki space sync runbook](../../docs/runbooks/iris-wiki-space-sync.md) for registration,
controlled enablement, status interpretation, dead-letter recovery, permission-revocation checks,
and fail-closed rollback. Do not enable it while document-sync, reindex, or raw-event queues are
degraded or non-empty.

## Planned Restart And Reactivation

Run the sequence in this exact order:

1. POST global false through the authenticated internal endpoint and require live
   `globalEnabled=false` with `durable=true`.
2. Stop Caddy and verify the `caddy` service is not running.
3. Verify workers, queues, and DLQs: event, document-sync, and reindex workers must be healthy and
   running; every pending and dead-letter count must equal `0`.
4. Create the paired Postgres backup with `deploy/pilot/backup.sh`, then record its path and the
   approved app and image SHA. The encrypted manifest records the pre-maintenance live global state,
   desired state, revision, and healthy Postgres persistence proof without recording secrets.
5. Deploy migration and Core while Caddy remains stopped. A migration or Core startup failure ends
   the operation here.
6. After Core starts, require `persistence.storage=postgres`, `persistence.ok=true, globalEnabled=false`,
   a non-negative durable revision, and `activationRequired` equal to `desiredGlobalEnabled`.
   Recheck that all workers are healthy and running and every queue and DLQ count is `0`.
   `desiredGlobalEnabled=true` is durable intent and never permission to auto-enable the live gate.
7. Explicitly POST global true with the operator header while Caddy remains stopped. Require HTTP
   `200`, `globalEnabled=true`, and `durable=true`; a timeout, transport failure, malformed response,
   or response without durable proof is a failed activation and requires a verified compensating
   disable.
8. Start Caddy only after authenticated internal gates pass and the explicit durable enable is
   verified. Confirm public `/health` succeeds and public `/internal/*` remains `404`.
9. Run real Feishu acceptance, including the permission guard, then recheck workers and require all
   event, document-sync, and reindex pending and DLQ counts to equal `0`.

The planned backup script may restore the pre-maintenance live state only after backup publication,
the restarted live gate is proven false, Postgres persistence is healthy, and worker queues are
empty. It restores from the captured live `globalEnabled` value only. It never treats the captured
`desiredGlobalEnabled` value as activation authority.

## Failure Handling

Any failed backup, migration, or status gate leaves Iris disabled and Caddy stopped. Do not continue
from a stale response. POST global false when Core is reachable, stop Caddy, verify both states, and
report the exact failed gate. Do not start Caddy or retry global enablement until the failed gate has
been repaired and every authenticated check has been rerun.

`IRIS_BACKUP_COMMAND_TIMEOUT_SECONDS` defaults to `30` and accepts decimal integers from `1` through
`300`. `IRIS_BACKUP_CLEANUP_RETRY_DELAY_SECONDS` defaults to `2` and accepts decimal integers from
`0` through `10`; cleanup makes exactly three Caddy stop attempts before a bounded kill and final
stopped-state check. The inner HTTP deadline remains independently bounded by
`IRIS_BACKUP_HTTP_TIMEOUT_MS`.

Pilot smoke makes exactly three bounded durable-disable attempts. If none returns durable proof,
it independently stops Caddy with bounded process-tree commands and verifies the service is no
longer running. In `--post-restore` mode, any failure after activation also stops and verifies
Caddy even when the compensating disable succeeds.

## Rollback

Keep Caddy stopped and Iris disabled throughout rollback. Restore the paired Postgres and Redis
backup by setting the operator-held age identity path and piping the decrypted archive directly to
the restore helper:

```bash
: "${IRIS_BACKUP_IDENTITY_FILE:?set this to the operator-held age identity file}"
: "${backup_file:?set this to the encrypted paired backup path}"
age --decrypt --identity "$IRIS_BACKUP_IDENTITY_FILE" "$backup_file" \
  | ./deploy/pilot/restore-from-stdin.sh --confirm-replace-database
```

The helper reads only the decrypted tar bundle from stdin; it does not read or store the age
identity or encrypted backup. It starts Core but never Caddy. Restore the matching reviewed Core
image when the older image cannot read the migrated database.

`IRIS_RESTORE_COMMAND_TIMEOUT_SECONDS` defaults to `120` and accepts decimal integers from `1`
through `1800`. It bounds every Docker Compose operation, including `pg_restore`, migration,
database swap, Redis replacement, copy, and service restart, with a process-tree deadline.
`IRIS_RESTORE_CLEANUP_RETRY_DELAY_SECONDS` defaults to `2` and accepts decimal integers from `0`
through `10`. Restore and fail-closed cleanup make exactly three Caddy stop attempts, then issue a
bounded kill and verify stopped state. A failed validated restore keeps Caddy stopped; failure to
prove that state is reported as incomplete cleanup.

Restoring the Postgres snapshot restores durable intent but never live activation.
Restoring durable intent never opens the live gate. A restored or restarted Core must report live
`globalEnabled=false`, even when `desiredGlobalEnabled=true` and `activationRequired=true`.

Repeat the full authenticated localhost gates for health, persistence, workers, queues, and DLQs.
Explicitly POST global true only after those gates pass, and require a fresh HTTP `200` response
with `globalEnabled=true` and `durable=true`. Start Caddy last, then run real Feishu acceptance and
another zero-count check.

CI performs those phases in one fail-closed process after the restore helper exits:

```bash
npm run pilot:smoke -- --post-restore
```

That mode first proves Caddy is stopped and runs authenticated localhost gates, durably enables the
runtime, starts and verifies Caddy, runs public boundary and callback acceptance, and finally
requires a durably proven disable. It leaves Caddy running only after the successful drill; any
failure after enable closes and verifies ingress.
