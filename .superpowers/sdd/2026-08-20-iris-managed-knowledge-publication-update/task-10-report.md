# Task 10 Report: End-to-End Regression, Documentation, and Pilot Runbook

## Status

Documentation and the controlled-pilot runbook are complete.  The managed existing-page update is
implemented and locally verified, default-off, and **controlled Feishu acceptance pending**.  No
live Feishu request/mutation, deployment, push, merge, or remote enablement was performed.

An observable current-HEAD `npm run verify` completed with terminal **exit 0**. The earlier
uncaptured attempt is superseded by this final evidence; it is not used as a passing claim.

## Baseline and implementation

- Baseline before documentation: `HEAD` `9ac437f3`, branch
  `codex/iris-managed-wiki-update`, clean linked worktree.
- Added `docs/development/iris-managed-knowledge-update-pilot.md`, an operator-facing runbook with
  exact default-off, one-group, fresh-single-block, evidence, stop, recovery, and rollback limits.
- Updated README and the coverage baseline to preserve existing real publication-pilot facts while
  stating that existing-page update is locally verified/default-off/live pending.
- Updated the plan: Tasks 1–9 are checked from their ledger review-clean commits; Task 1 now carries
  canonical SHA-256 `6991ce0a6fcde71f7e4c492b1746e1f04727fe3b124691803aab99fccdb4d8c6` for
  `Line one\nLine two`. Task 10's complete-verification and live-pilot steps remain unchecked.
- Cleaned the Task 7 historic 4xx self-review prose and added an explicit non-fabrication note for
  the Task 8 Fix Round 1 focused-command totals.

## Verification

| Gate | Result |
| --- | --- |
| Focused managed action/document suite | PASS — 13 files, 195 passed, 23 configured skips |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| Pre-documentation `git diff --check` | PASS |
| `npm run verify` | PASS — captured terminal exit 0; Core 199 files passed / 3 skipped and 3,677 tests passed / 287 skipped; Python 181 passed; pilot 174 passed / 1 skipped; Compose, readiness (19/19), and pilot configuration passed |
| Post-documentation `git diff --check` | PASS (only CRLF conversion warnings) |
| Required documentation `rg` check | PASS; pending-state wording found |

Configured PostgreSQL test branches were skipped where no `IRIS_TEST_DATABASE_URL` /
`DATABASE_URL` was configured. Those skips are not a real PostgreSQL execution claim. The pilot
suite also reported one Docker-daemon-unavailable Caddy boundary-probe skip; it did not prevent the
captured exit-0 repository gate.

## Files

- `docs/development/iris-managed-knowledge-update-pilot.md`
- `README.md`
- `docs/superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md`
- `docs/superpowers/plans/2026-08-20-iris-managed-knowledge-publication-update.md`
- `.superpowers/sdd/2026-08-20-iris-managed-knowledge-publication-update/task-7-report.md`
- `.superpowers/sdd/2026-08-20-iris-managed-knowledge-publication-update/task-8-report.md`

## Self-review and concerns

- The runbook never permits adoption/inference of legacy, arbitrary, multi-block, or rich-content
  pages and contains no raw body/token/error evidence fields.
- Enabling requires migration 0055, Feishu/OAuth dependencies, document-sync/update workers,
  capabilities, exact group allowlist, readiness, and zero unresolved work. Disabling blocks new
  claims but leaves recovery/admin convergence available.
- **Live-pilot blocker:** no specifically authorized group/page/credentials were supplied; result is
  `not yet run` / controlled Feishu acceptance pending.

## Fix Round 1/5 — executable controlled-pilot documentation

### Changes

- Corrected the internal-status path to `status.components.managedKnowledgeUpdates`; approval
  interaction queue counts are checked at `status.knowledgeCards.queue`.
- Made the status helper conditional: while the deployment is safely disabled it verifies only the
  actual disabled shape and uses the durable execution-state projection; after enablement it requires
  the reconciliation object and both supported reconciliation counters at zero.
- Added fail-closed PowerShell helpers for placeholder validation, property existence, count checks,
  durable runtime acknowledgements, and a human authority/ticket/image-digest gate.
- Replaced prose-only activation/rollback with the actual runtime-control GET/POST/PATCH routes,
  headers, payloads, expected durable PostgreSQL readbacks, and stop conditions.
- Made fresh target/control publication, group confirmation, OAuth review, and approval explicitly
  manual Feishu actions, with adjacent read-only API/SQL evidence instead of invented write routes.
- Added explicit human-gate/action/readback/stop/rollback wording for conflict, confirmation,
  OAuth approval, and the system mutation, including a parameterized metadata-only execution/update
  projection for the post-mutation revision/hash/request evidence.
- Added per-step content-free evidence fields, exact read-only SQL projections with explicit columns,
  and a clear prohibition on raw Feishu tokens/block IDs/bodies/errors.

### Documentation checks

- `git diff --check` — passed (only line-ending warnings).
- Required managed-update acceptance/status/privacy `rg` check — passed; it found the corrected
  component path, real runtime routes, read-only evidence projections, pending live status, and the
  raw-token prohibition.
- PowerShell parser check over every fenced PowerShell block — passed with zero parse errors; blocks
  were parsed only, never executed.

### Scope and remaining gate

This fix changes Markdown/report evidence only. It performs no live Feishu call, deployment,
runtime enablement, database mutation, push, or merge. The live pilot remains `not yet run` /
controlled Feishu acceptance pending.

## Fix Round 2/5 — executable-safety contract

### Changes

- Added fail-closed private-value validation for sentinel/placeholder values, control characters,
  whitespace, ID/operator/ticket/token syntax and length; no failure reports the supplied value.
- Bound all bearer use to one separately supplied ticket-approved internal origin, requiring HTTPS
  except loopback HTTP explicitly approved with `IRIS_PILOT_ALLOW_LOOPBACK_HTTP=true`, rejecting
  userinfo/path/query/fragment and blocking an origin mismatch.
- Added a fresh PostgreSQL/current-desired/group/capability state assertion before each capability,
  group, and global runtime mutation, plus the existing human ticket-entry gate immediately before
  dispatch.
- Initialized and validated managed-page, draft, proposal, and recovery-execution IDs from private
  environment/verified readback; internal routes URL-encode them and the SQL remains psql-variable
  parameterized. Removed literal draft/proposal route placeholders.
- Corrected approval evidence to current migrations: Task 5's managed-update
  `action_target_fingerprint` plus attestation `reviewed_at`, and the approval to requirement join
  with subject/revision, authorization summary, requirement kind/role/state, and satisfied-source
  metadata; no callback, operation-key, body, or token columns are selected.
- Completed rollback readback with PostgreSQL persistence, both capabilities, current/desired global,
  pilot group, and the reusable content-free drain helper. Disable continues recovery/admin until all
  queues, DLQs, and unresolved states are zero.

### Documentation checks

- Parsed all three fenced PowerShell blocks with `System.Management.Automation.Language.Parser`:
  zero parse errors; Markdown fence count was 12.
- Static contract assertions: 17 required fragments passed (approved-origin binding, placeholder
  rejection, pre-write gates, ID encoding, corrected SQL join, final rollback/drain); four forbidden
  fragments were absent (literal draft/proposal placeholders and obsolete approval columns).
- Write-safety assertion: exactly six guarded runtime writes, each with one fresh pre-write state
  assertion; no direct write exists outside `Invoke-InternalWrite`.
- `git diff --check` passed (line-ending warnings only); focused `rg` found all expected safety and
  schema fragments.

### Scope and remaining gate

This fix changes Markdown/report evidence only. It does not execute a documented network, database,
or runtime command; it performs no live Feishu call, deployment, enablement, push, or merge. The live
pilot remains `not yet run` / controlled Feishu acceptance pending.
