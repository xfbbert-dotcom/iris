# Iris Planned Backup Runtime State Design

## Status

Approved for implementation on 2026-07-13 as a maintenance refinement to the existing pilot
fail-closed startup policy.

## Goal

Keep an intentionally enabled Iris available after a successful scheduled backup without weakening
the rule that crashes, host restarts, container recreation, and failed maintenance leave Iris
globally disabled.

## Decision

The backup script treats the current global runtime state and Caddy running state as temporary
maintenance context, not durable application state. Before stopping services it reads
`GET /internal/runtime-control/status` from inside the Core container and records whether Caddy is
running. It never writes either value to the backup bundle, database, environment file, or disk.

The ordered success path is:

1. Read and validate the current global runtime state while Core is healthy.
2. Record whether Caddy is currently running.
3. Stop Caddy and Core, then capture the paired Postgres and Redis snapshot.
4. Restart Core alone and verify that fail-closed startup reports `globalEnabled: false`.
5. Encrypt and atomically publish the backup file.
6. Restore `globalEnabled: true` only when it was true before the backup, and verify the mutation.
7. Restart Caddy only when it was running before the backup.

The failure path never restores an enabled runtime and never opens Caddy. Cleanup first attempts an
explicit API disable while Core may still be reachable, retries and verifies the Caddy stop, then
restarts Core by itself so operators retain an internal recovery surface. Core must report its
configured fail-closed startup value before cleanup is considered verified. If Docker prevents the
final state from being proven, the script emits a `FAIL-CLOSED RECOVERY INCOMPLETE` incident message
instead of silently treating cleanup as successful.

## Security Boundaries

- Runtime-control requests execute inside the Core container and read the existing internal token
  from that process environment. The token is never printed or parsed from `.env.pilot` by Bash.
- The script accepts only literal `true` or `false` from the status endpoint.
- A backup is successful only after the encrypted artifact has passed its non-empty check and has
  been atomically renamed to its final path.
- Re-enabling Iris and reopening Caddy occur after publication, never from the `EXIT` trap.
- If status capture, snapshot creation, Core restart, encryption, publication, state restoration, or
  verification fails, the command exits non-zero with Caddy stopped and Iris disabled.

## Testing

Repository operation tests assert the ordering and fail-closed cleanup contract. Executable behavior
tests run the production Bash script against fake Compose, age, Postgres, and Redis boundaries and
inject failures into state capture, snapshotting, Core restart, encryption, publication, runtime
restoration, Caddy startup, and cleanup. Production rollout uses two controlled drills: first with
Iris disabled and Caddy stopped, then with Iris enabled but Caddy still stopped. The second drill
verifies state restoration without exposing a public callback; the operator disables Iris again
after the assertion while the Gemini quota gate remains pending.

## Out Of Scope

- Persisting runtime-control state across unplanned restarts.
- Persisting group or capability overrides.
- Re-enabling Caddy after a failed backup.
- Changing backup contents, encryption, retention, or restore semantics.
