# Iris Knowledge-Conflict Candidate And Update Draft

## Release Status

Pending live acceptance. Automated implementation gates do not close this product loop. The exact
reviewed build must complete the one-pilot-group and nonpilot-control runbook before the feature may
be described as accepted.

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

- [ ] `IRIS_KNOWLEDGE_CONFLICT_ENABLED=false` is committed.
- [ ] `IRIS_KNOWLEDGE_CONFLICT_GROUP_ALLOWLIST=` is committed.
- [ ] Compose passes both exact values to Core.
- [ ] Pilot smoke rejects effective enablement or a nonempty allowlist.
- [ ] Public Caddy returns `404` for `/internal/knowledge-conflicts/*`.
- [ ] Rollback re-attests exact group/global/capability/flag/allowlist state, proves per-table state
  fingerprints stop changing, and preserves append-only facts.

## Automated Evidence

Record fresh command results. Use counts and exit status only.

| Gate | Result | Counts / note |
| --- | --- | --- |
| Focused Core knowledge-conflict tests | Pending | pass/fail and test count |
| Full Core test suite | Pending | pass/fail and test count |
| Typecheck | Pending | pass/fail |
| Build | Pending | pass/fail |
| Python suite | Pending | pass/fail and test count |
| Pilot contracts | Pending | pass/fail and test count |
| Disabled-env readiness | Pending | pass/fail |
| Compose render | Pending | pass/fail; false/empty values |
| Diff check | Pending | pass/fail |

## Exact Build Identity

Fill only after review:

- exact commit SHA: Pending
- image digest: Pending
- verification timestamp: Pending
- reviewer identity/role ID: Pending

## Live Acceptance Evidence

Use [the acceptance runbook](../runbooks/iris-knowledge-conflict-acceptance.md). Evidence is limited
to IDs, versions, hashes, counts, timestamps, image digest, and observed pass/fail facts. Do not add
source text, prompts, rendered card text, callback payloads, authorization material, or secrets.

| Step | Evidence allowed | Result |
| --- | --- | --- |
| 1 | exact commit SHA, image digest, timestamp | Pending |
| 2 | pilot/control/known group IDs and counts | Pending |
| 3 | all three off flags/empty allowlists, disabled runtime status, real PostgreSQL presentation/outbox and Redis queue/DLQ zero counts | Pending |
| 4 | exact source/snapshot IDs, hashes, versions/timestamps and every pilot message ID with production `sent_at` strictly later | Pending |
| 5 | runtime revision, enabled group count, readiness pass/fail | Pending |
| 6 | exact scan/candidate plus every evidence row ID/timestamp/hash and bidirectional diff counts | Pending |
| 7 | answer delivery/candidate IDs and observed pass/fail | Pending |
| 8 | exact candidate/delivery/message/card hash plus field/link pass/fail/count facts | Pending |
| 9 | six stage/cause-labelled revocation candidate/operation/draft/callback IDs plus exact zero counts | Pending |
| 10 | draft ID/version/risk/status, active presentation zero, exact publication-binding and drain counts | Pending |
| 11 | exact group inventory, durable/live policy, empty allowlists, state hashes/counts/timestamps | Pending |
| 12 | metadata artifact hash and timestamp | Pending |

## Mandatory Failure And Rollback Record

If any post-enable step fails, record the failed step number and metadata artifact hash. Stop Caddy,
restore off/empty feature defaults, durably disable all known groups/global/read-draft-proactive-write
capabilities, recreate Core, re-attest the exact inventory and policies, and prove every mutable
state fingerprint stops changing even when row counts are unchanged. Preserve every append-only
PostgreSQL fact. A failed or incomplete live run leaves Release Status as Pending live acceptance.

## Explicit Non-Claims

- No live PostgreSQL, Redis, Feishu, model, or Wiki acceptance is claimed by this template.
- No automatic truth selection or conflict resolution is implemented.
- No cross-group or broad historical scan is enabled.
- No in-place Wiki mutation is implemented.
