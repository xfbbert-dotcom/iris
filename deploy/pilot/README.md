# Iris Pilot Operations

Use the reviewed commit and an image whose recorded source SHA is that same commit. Keep the
internal bearer token inside Core; do not print it, the database URL, or any application secret.

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
   `desiredGlobalEnabled=true` is durable intent and never permission to auto-enable the live gate.
7. Start Caddy only after authenticated internal gates pass, including healthy workers and zero
   queue and DLQ counts. Confirm public `/health` succeeds and public `/internal/*` remains `404`.
8. Explicitly POST global true with the operator header. Require HTTP `200`, `globalEnabled=true`,
   and `durable=true`; a response without durable proof is a failed activation.
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

## Rollback

Keep Caddy stopped and Iris disabled throughout rollback. Restore the paired Postgres and Redis
backup with `restore-from-stdin.sh --confirm-replace-database`, and restore the matching reviewed
Core image when the older image cannot read the migrated database. Restoring the Postgres snapshot
restores durable intent but never live activation. A restored or restarted Core must report live
`globalEnabled=false`, even when `desiredGlobalEnabled=true` and `activationRequired=true`.

Repeat the full authenticated health, persistence, worker, queue, and DLQ gates before starting
Caddy. Explicit reactivation still requires a fresh POST global true response with HTTP `200` and
`durable=true`, followed by real Feishu acceptance and another zero-count check.
