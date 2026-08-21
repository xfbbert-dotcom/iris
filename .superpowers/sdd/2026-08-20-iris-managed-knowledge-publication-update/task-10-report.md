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
