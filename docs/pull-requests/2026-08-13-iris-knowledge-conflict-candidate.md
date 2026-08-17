# Iris Knowledge-Conflict Candidate And Update Draft

## Release Status

Live acceptance passed on 2026-08-18 for exact commit
`dd7461459e476aa6843c5c34ea775855832c8a27` and image digest
`sha256:403366a17bd8baded6a561c38d35b873ae646709d6705af3e16173ec8424499b`.
The attached controller completed all twelve gates with `result=pass`, `failedStep=null`, and
`rollbackPass=true`. The capability remains default-off after acceptance and is not approved for a
broad rollout.

This change creates a governed update draft and does not edit the existing Wiki page in place.
Publication remains subject to the existing confirmation, review, approval, and execution path.

## Scope

- Discovers eligible current group conclusions from a durable PostgreSQL scan inbox.
- Retrieves only current authorized Wiki evidence eligible for knowledge drafts.
- Persists strict, version-bound conflict candidates and exact evidence identities.
- Requires operator approval before one bounded group card can be delivered.
- Lets a current group member create one medium-risk `knowledge_conflict` draft.
- Exposes an exact current conflict in ordinary answers without selecting a winner.
- Keeps committed pilot deployment defaults off with an empty group allowlist.

## Default-Off Boundary

- [x] `IRIS_KNOWLEDGE_CONFLICT_ENABLED=false` is committed.
- [x] `IRIS_KNOWLEDGE_CONFLICT_GROUP_ALLOWLIST=` is committed.
- [x] Compose passes both exact values to Core.
- [x] Pilot smoke rejects effective enablement or a nonempty allowlist.
- [x] Public Caddy returns `404` for `/internal/knowledge-conflicts/*`.
- [x] Rollback re-attests exact group/global/capability/flag/allowlist state, proves per-table state
  fingerprints stop changing, and preserves append-only facts.

## Automated Evidence

Record fresh command results. Use counts and exit status only.

| Gate | Result | Counts / note |
| --- | --- | --- |
| Focused Core knowledge-conflict tests | Pass | 323 passed, 18 environment-gated skips, 0 failed |
| Full Core test suite | Pass | 3,417 passed, 258 environment-gated skips, 0 failed |
| Typecheck | Pass | exit 0 |
| Build | Pass | exit 0 |
| Python suite | Pass | 181 passed, 0 failed |
| Pilot contracts | Pass | 159 passed, 1 accurate local-Docker skip, 0 failed |
| Disabled-env readiness | Pass | 17 passed, 0 failed |
| Compose render | Pass | three flags false; three allowlists empty |
| Diff check | Pass | exit 0 |

## Exact Build Identity

- exact commit SHA: `dd7461459e476aa6843c5c34ea775855832c8a27`
- image digest: `sha256:403366a17bd8baded6a561c38d35b873ae646709d6705af3e16173ec8424499b`
- verification timestamp: `2026-08-17T17:22:55.6594565Z`
- reviewer identity/role ID: independent model review plus `knowledge-conflict-pilot` controller

## Live Acceptance Evidence

Use [the acceptance runbook](../runbooks/iris-knowledge-conflict-acceptance.md). Evidence is limited
to IDs, versions, hashes, counts, timestamps, image digest, and observed pass/fail facts. Do not add
source text, prompts, rendered card text, callback payloads, authorization material, or secrets.

| Step | Evidence allowed | Result |
| --- | --- | --- |
| 1 | exact commit SHA, image digest, timestamp | Pass; checkout, tag, running container, and recorded digest matched |
| 2 | pilot/control/known group IDs and counts | Pass; one pilot, nonpilot controls, and 14 durably disabled known groups |
| 3 | all three off flags/empty allowlists, disabled runtime status, real PostgreSQL presentation/outbox and Redis queue/DLQ zero counts | Pass; flags false, allowlists empty, all residual counts zero |
| 4 | exact source/snapshot IDs, hashes, versions/timestamps and every pilot message ID with production `sent_at` strictly later | Pass; exact private metadata set and strict chronology verified |
| 5 | runtime revision, enabled group count, readiness pass/fail | Pass; one allowlisted group during the bounded window, nonpilot groups disabled |
| 6 | exact scan/candidate plus every evidence row ID/timestamp/hash and bidirectional diff counts | Pass; exact evidence set and zero bidirectional difference |
| 7 | answer delivery/candidate IDs and observed pass/fail | Pass; receipt-bound answer showed both sides and selected no winner |
| 8 | exact candidate/delivery/message/card hash plus field/link pass/fail/count facts | Pass; one delivery, required fields present, one safe link, zero unsafe links |
| 9 | six stage/cause-labelled revocation candidate/operation/draft/callback IDs plus exact zero counts | Pass; six revocations, controls, member path, and duplicate no-effect checks |
| 10 | draft ID/version/risk/status, active presentation zero, exact publication-binding and drain counts | Pass; one medium-risk governed draft rejected, active/unresolved counts zero |
| 11 | exact group inventory, durable/live policy, empty allowlists, state hashes/counts/timestamps | Pass; default-off rollback, stable fingerprints, preserved append-only facts |
| 12 | metadata artifact hash and timestamp | Pass; artifact SHA-256 `3fd5f17401c49f50de25b6be76fbc28e46553d0f2f221daa1505e50632c9402d` |

## Mandatory Failure And Rollback Record

If any post-enable step fails, record the failed step number and metadata artifact hash. Stop Caddy,
restore off/empty feature defaults, durably disable all known groups/global/read-draft-proactive-write
capabilities, recreate Core, re-attest the exact inventory and policies, and prove every mutable
state fingerprint stops changing even when row counts are unchanged. Preserve every append-only
PostgreSQL fact. A failed or incomplete live run leaves Release Status as Pending live acceptance.

## Explicit Non-Claims

- Acceptance covers only the bounded one-group pilot and its nonpilot controls; it does not
  authorize a broad rollout.
- No automatic truth selection or conflict resolution is implemented.
- No cross-group or broad historical scan is enabled.
- No in-place Wiki mutation is implemented.
