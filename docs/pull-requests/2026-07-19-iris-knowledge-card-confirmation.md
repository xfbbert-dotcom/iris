## Scope

Implements Iris Phase 5B-1: governed, version-bound Feishu cards for knowledge-draft group confirmation, revision requests, and rejection.

## Safety boundaries

- All knowledge-card runtime gates default off.
- Enabled card callbacks require bounded `FEISHU_ENCRYPT_KEY`, raw body, fresh timestamp, and a valid signature; legacy Feishu event callback compatibility remains unchanged.
- Callback handling acknowledges first and processes through a durable queue; lease expiry consumes the five-attempt budget and terminalizes to a deterministic content-free DLQ.
- Callback enqueue rejection and timeout uncertainty are distinct; uncertain users are told not to repeat the click, and no second enqueue is started automatically.
- Dispatch-time transport rejection is `outcome_unknown` and is never resent automatically; `request_not_sent` is reserved for provable pre-dispatch failures.
- Internal status exposes content-free outbox counts, and readiness blocks unresolved outcome-unknown or terminal/exhausted failures without permanently blocking ordinary in-flight retries.
- Cards visibly carry bounded Iris/status/source/draft/revision/version traceability while keeping evidence/source raw text out and using Feishu's valid 1,000-character input cap.
- Phase 5B-1 uses only migration `0031`; migration number `0032` remains reserved for Phase 5B-2.
- Current runtime, presentation, draft evidence, and group membership are revalidated before mutation.
- The worker rechecks the live global/group/capability gate after membership and immediately before mutation.
- Pilot Caddy exposes exactly `/feishu/events` and `/feishu/card-actions`; `/internal/*` and every other unmatched path remain 404.
- Final cards render action-specific committed facts for confirm, request-revision, and reject through one deterministic immediate/retry renderer, without draft or evidence text.
- Postgres interaction row locks now follow draft then presentation, matching presentation creation and preventing the opposing lock-order deadlock.
- This PR does not add ActionProposal, owner/admin approval, OAuth review pages, or Feishu knowledge-base writes.

## Evidence

- Phase 5B-1 code and default-off deployment/readiness contracts are implemented and passed the local exit gate.
- The operator contract requires same-SHA deployment, zero existing/new queue and DLQ counts, one-group enablement, six real Feishu cases, database-to-card fact matching, non-pilot negative controls, and fail-closed rollback.
- Real Feishu pilot acceptance is pending. This PR does not claim deployment, card delivery, or a live pilot pass.
- Phase 5B-2 proposal/owner-admin/OAuth work and Phase 5B-3 Feishu knowledge-base writes remain explicitly excluded.

## Local Exit Gate

- `npm run typecheck`: passed.
- `npm run build`: passed.
- Focused A-G suites with real Redis and real Postgres: 322 passed, 0 skipped.
- `npm test`: 2,050 passed, 129 skipped (2,179 total); the skipped integration paths passed in the focused real-backend run above.
- `npm run test:python`: 177 passed.
- `npm run test:pilot`: 116 passed, 0 skipped (including 38 pilot-smoke checks).
- `docker compose config`, `npm run readiness -- --env-file deploy/pilot/ci.env` (14/14 checks passed), `npm run pilot:config`, and `git diff --check`: passed.
- Second-wave worker/renderer/dispatcher/static repository suites: 73 passed, with 36 database-only cases skipped in this invocation.
- Second-wave real Postgres migration/repository suites: 67 passed, 0 skipped, including the coordinated create-versus-apply race.
- Second-wave Caddy/public-smoke assertions: 54 passed, 0 skipped; the pinned pilot image also passed `caddy validate`.

## Intended PR

- Base: `codex/iris-knowledge-draft-facts`
- Head: `codex/iris-knowledge-approval-actions`
- Draft title: `feat: add governed knowledge card confirmation`
