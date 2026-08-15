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
- [ ] Rollback proves scan/outbox counts stop changing and append-only facts remain present.

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
| 3 | queue, DLQ, outbox, reconciliation counts | Pending |
| 4 | source/snapshot/message IDs, hashes, versions, timestamps | Pending |
| 5 | runtime revision, enabled group count, readiness pass/fail | Pending |
| 6 | scan/candidate/evidence IDs and counts | Pending |
| 7 | answer delivery/candidate IDs and observed pass/fail | Pending |
| 8 | candidate/delivery/message IDs and versions | Pending |
| 9 | interaction/draft/control IDs and pass/fail flags | Pending |
| 10 | draft ID/version/risk/status and drained counts | Pending |
| 11 | rollback revision and before/after counts | Pending |
| 12 | metadata artifact hash and timestamp | Pending |

## Mandatory Failure And Rollback Record

If any post-enable step fails, record the failed step number and metadata artifact hash. Stop Caddy,
restore off/empty feature defaults, durably disable all known groups/global/read-draft-proactive-write
capabilities, recreate Core, and prove counts stop changing. Preserve every append-only PostgreSQL
fact. A failed or incomplete live run leaves Release Status as Pending live acceptance.

## Explicit Non-Claims

- No live PostgreSQL, Redis, Feishu, model, or Wiki acceptance is claimed by this template.
- No automatic truth selection or conflict resolution is implemented.
- No cross-group or broad historical scan is enabled.
- No in-place Wiki mutation is implemented.
