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

## Fix Round 3/5 — post-confirm runtime and durable-drain gates

### Changes

- Strengthened placeholder rejection to fail on any case-insensitive occurrence of `pending`,
  `change_me`/`change-me`, `dummy`, `example`, or either angle bracket, so values such as
  `pending-draft-1` cannot pass; validation messages never include the supplied value.
- Refactored `Invoke-InternalWrite` to accept a stage precondition scriptblock and enforce the exact
  order: ticket `Read-Host` confirmation, immediate internal runtime-status GET, stage assertion,
  then dispatch. The three enable stages bind their prescribed PG/global/group/capability predicates
  after confirmation; durable response/readback remains authoritative despite the unavoidable GET-to-route race.
- Made rollback idempotent for coherent partial enablement: global, group, and capability disables
  each take a post-confirm fresh state read, allow an already-disabled state, and verify their own
  successive durable disable readback; persistence/current-desired divergence stops escalation.
- Added `Assert-ManagedDatabaseDrain`, which executes and parses the named content-free unresolved
  execution-state projection through private PostgreSQL environment configuration without printing a
  connection string or raw error. The disabled status branch calls it instead of treating SQL as a
  display-only check.
- Final closeout now reads `/internal/action-approvals/status` and requires the managed recovery/admin
  loop to be running, requires the managed-update disabled status shape, then proves final
  PostgreSQL/global/group/capability state and runs queue/DLQ plus durable-SQL drain to zero.

### Documentation checks

- Parsed all three fenced PowerShell blocks with `System.Management.Automation.Language.Parser`:
  zero parse errors; Markdown fence count was 12.
- Static contract assertions: 14 required safety fragments passed (substring sentinel rejection,
  post-confirm ordering, enable/rollback stages, PostgreSQL drain, recovery-status read); five stale
  fragments were absent. Exactly six guarded runtime writes were found.
- `git diff --check` passed (line-ending warnings only); focused `rg` found the required helpers,
  routes, post-confirm predicates, recovery status, and pending live wording.

### Scope and remaining gate

This fix changes Markdown/report evidence only. It does not execute a documented network, database,
or runtime command, and no live Feishu action, deployment, enablement, push, or merge occurred. The
live pilot remains `not yet run` / controlled Feishu acceptance pending.

## Fix Round 4: Fail-Closed PostgreSQL Client Invocation

Review found that `Assert-ManagedDatabaseDrain` could accept an empty result when `psql` was absent:
PowerShell command-not-found left a previously successful native `$LASTEXITCODE` at zero, and the
helper checked no independent invocation-success signal. A safe local RED reproduction used a
guaranteed-nonexistent command after `cmd.exe /d /c exit 0`; it exited 0 and printed:

```text
RED_REPRO current_pattern_accepted_missing_command last_exit=0 rows=0 success=True
```

The runbook now resolves `psql` only as an Application and replaces resolution failures with a
content-free error. Immediately before invocation it clears `$global:LASTEXITCODE`; immediately
after invocation it captures both `$?` and `$global:LASTEXITCODE`, then requires actual invocation
success, an `Int32` native exit code, and exit zero. Empty output remains a legitimate zero-unresolved
result only after those proofs. The count-only `BEGIN READ ONLY` query is unchanged, and neither the
client path nor database connection details are printed.

The isolated GREEN probe did not execute real `psql` or contact a database. It rejected a missing
command despite a stale zero and accepted `cmd.exe` as a real Application stand-in that produced no
rows and exited zero:

```text
GREEN_MISSING_COMMAND failed_closed=true stale_exit_was_zero=true
GREEN_ISOLATED_SUCCESS passed=true rows=0 exit_type_proven=Int32
```

Every PowerShell fence in the managed-update runbook was parsed with the PowerShell AST parser:

```text
POWERSHELL_PARSE blocks=3 errors=0
```

Scoped static assertions exited 0 with:

```text
STATIC_application_resolution=true
STATIC_reset_then_invoke=true
STATIC_immediate_status_capture=true
STATIC_typed_zero_gate=true
STATIC_read_only_count_query=true
STATIC_no_bare_psql_invocation=true
```

No live/network/database/`psql` command, full suite, deployment, real Feishu action, push, or PR was
performed. The live pilot remains **not yet run / controlled Feishu acceptance pending**.

## Final Whole-Branch Fix

### Review-finding closure

- **Production managed-page registration:** the action-approval runtime now constructs one shared
  PostgreSQL managed-page repository before either executor and passes it to publication execution
  even while managed mutations are default-off. Composition and publication-lifecycle tests prove
  the exact dependency and persisted page/source/document/block/revision identity.
- **Durable reindex and answer snapshot binding:** migration 0056 adds an append-only successful
  reindex-completion fact keyed by exact snapshot and embedding profile, plus the page's current
  reconciled snapshot pointer. The reindex worker records completion only after successful indexing
  or a proven already-indexed result, including a successful zero-fragment snapshot. Resync readiness
  and completion require the exact active profile fact, all prior bindings, no newer unresolved work,
  and a readable/synced source. Search eligibility, permission verification, and the atomic send
  transaction all require citations to the still-current reconciled snapshot, so a prepared answer
  from an older snapshot cannot pass after later reactivation.
- **Coherent managed observation:** Feishu raw fetches now carry the remote revision as
  `sourceVersion`. A managed observation is recorded only when that revision equals the managed
  block revision and the canonical full-body snapshot equals the managed block body. Missing,
  changing, or mismatched revision/body facts fail closed for managed observation while preserving
  ordinary snapshot sync.
- **Permission revalidation:** durable claim and reactivation gates require `readable`, never
  `unknown`. Both the update executor and uncertainty reconciler perform a live, group-scoped
  Feishu permission preflight immediately before every remote mutation. Denied or unavailable live
  proof blocks mutation; the existing write-policy, capability, authorization-group, and approval
  bindings remain exact.

Migration 0056 is append-only and backward-compatible with existing 0052-0055 history. Existing
managed rows remain safely unavailable until they acquire an exact reconciled snapshot and reindex
completion. The migration runner and startup/readiness checks require 0056.

### RED to GREEN evidence

- The initial focused RED run reported 16 failed, 243 passed, and 1 skipped across the eight selected
  files. Additional isolated RED cases covered live permission enforcement and completion
  idempotence before their implementations were added.
- The broader focused regression run completed with 450 passed and 83 skipped. The final
  configured-PostgreSQL-focused subset completed with 189 passed and 83 skipped across eight files,
  covering queue-pending, failed/wrong-profile reindex, zero-fragment success, permission states,
  real transaction races, and delayed prepared-answer invalidation.
- Those 83 configured-PostgreSQL tests were skipped because neither `IRIS_TEST_DATABASE_URL` nor
  `DATABASE_URL` was present. They were written but were not executed against PostgreSQL; this is an
  explicit environment caveat, not a passing PostgreSQL claim.
- TypeScript typecheck passed during focused stabilization. The first repository verification
  attempt found one stale runtime fixture expectation after the intentional dependency addition;
  its single focused test file then passed 5/5. No other broad gate was rerun before the final gate.

### Final verification

The single final `npm run verify` completed with terminal exit 0:

| Gate | Result |
| --- | --- |
| TypeScript typecheck | PASS |
| Build | PASS |
| Core Vitest | PASS — 200 files passed / 3 skipped; 3,699 tests passed / 288 skipped |
| Python pytest | PASS — 181 passed |
| Pilot/static Node tests | PASS — 174 passed / 1 skipped |
| Compose and pilot configuration | PASS |
| Readiness | PASS — 19/19 checks |
| Final `git diff --check` after report | PASS (line-ending warnings only) |

The one pilot/static skip was the executable Caddy boundary probe because the Docker daemon was
unavailable. Docker Compose configuration validation still passed. No live pilot, network request,
Feishu mutation, deployment, push, or merge was performed; controlled Feishu acceptance remains
pending.

During the final gate, the backup test briefly exposed an untracked
`.tmp-iris-backup-test-L1FPGz` directory. At gate completion, a literal-path check found it already
absent, an exact top-level scan found zero `.tmp-iris-backup-test-*` entries, and `git status` did not
list it. No temporary backup artifact is included in the commit.
