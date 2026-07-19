## Scope

Implements Iris Phase 5B-1: governed, version-bound Feishu cards for knowledge-draft group confirmation, revision requests, and rejection.

## Safety boundaries

- All knowledge-card runtime gates default off.
- Callback handling acknowledges first and processes through a durable queue.
- Current runtime, presentation, draft evidence, and group membership are revalidated before mutation.
- This PR does not add ActionProposal, owner/admin approval, OAuth review pages, or Feishu knowledge-base writes.

## Evidence

- Phase 5B-1 code and default-off deployment/readiness contracts are implemented and passed the local exit gate.
- The operator contract requires same-SHA deployment, zero existing/new queue and DLQ counts, one-group enablement, six real Feishu cases, database-to-card fact matching, non-pilot negative controls, and fail-closed rollback.
- Real Feishu pilot acceptance is pending. This PR does not claim deployment, card delivery, or a live pilot pass.
- Phase 5B-2 proposal/owner-admin/OAuth work and Phase 5B-3 Feishu knowledge-base writes remain explicitly excluded.

## Local Exit Gate

- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm test`: 2,034 passed, 127 skipped (2,161 total).
- `npm run test:python`: 177 passed.
- `npm run test:pilot`: 82 passed, 0 skipped (including 34 pilot-smoke checks).
- `docker compose config`, `npm run readiness -- --env-file deploy/pilot/ci.env` (14/14 checks passed), `npm run pilot:config`, and `git diff --check`: passed.

## Intended PR

- Base: `codex/iris-knowledge-draft-facts`
- Head: `codex/iris-knowledge-approval-actions`
- Draft title: `feat: add governed knowledge card confirmation`
