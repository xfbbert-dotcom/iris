# Iris Admin Publication Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add publication/action proposal governance to the Admin Console so internal operators can see pending publication work and safely request revision or reject proposals without exposing draft body content.

**Architecture:** Extend the static `/admin` console to reuse existing authenticated `/internal/action-proposals` and `/internal/action-proposals/:id/*` endpoints. The console stays metadata-only, does not create a direct approval route, and does not perform Feishu writes.

**Tech Stack:** Fastify, TypeScript, browser-native HTML/CSS/JavaScript, existing action-proposal internal APIs.

## Global Constraints

- Do not introduce a frontend framework or new runtime dependency.
- Do not expose `/internal/*` publicly; Caddy remains exact static `/admin` assets only.
- Do not render draft body text, prompt text, tokens, card JSON, or document body text.
- Do not add a direct approval button or `/approve` route for publication proposals; approval remains Feishu/OAuth governed.
- Existing internal APIs remain the source of truth.

---

### Task 1: Publication Queue Governance In Static Assets

**Files:**
- Modify: `apps/core/src/admin-console/admin-console-assets.ts`
- Test: `apps/core/tests/admin-console-assets.test.ts`

**Interfaces:**
- Consumes: `GET /internal/action-proposals?status=pending_approval,approved,executing,failed,reconciliation_required&limit=20`
- Consumes: `POST /internal/action-proposals/:id/request-revision`
- Consumes: `POST /internal/action-proposals/:id/reject`
- Produces: publication queue governance panel in `/admin`

- [x] **Step 1: Write the failing test**

Add an asset test that asserts the console renders `Publication Queue`, `publication-queue-table`, calls `/internal/action-proposals`, includes request-revision and reject governance paths, and does not include publication approval or draft content disclosure.

- [x] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/core test -- admin-console-assets.test.ts`

Expected: FAIL before implementation or before the assertion is correctly scoped.

- [x] **Step 3: Implement minimal panel**

Extend HTML with:
- status select;
- draft/proposal subject filter;
- limit input;
- refresh button;
- `table#publication-queue-table`;
- `tbody#publication-queue-rows`.

Extend JS with:
- `publicationQueuePath()`;
- `renderPublicationQueue(proposals)`;
- `refreshPublicationQueue()`;
- `transitionPublicationProposal(proposal, action)`;
- event handlers for refresh and filters.

Render:
- proposal id;
- action type;
- draft subject and revision;
- status;
- risk level;
- target policy;
- proposal/draft versions;
- updated timestamp;
- actions: request revision, reject.

- [x] **Step 4: Run focused test**

Run: `npm --workspace apps/core test -- admin-console-assets.test.ts`

Expected: PASS.

### Task 2: Documentation And Verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md`
- Modify: `docs/pull-requests/2026-07-23-iris-proactive-signal-preview.md`

- [x] **Step 1: Update docs**

Record that Admin Console now includes publication/action proposal queue governance, while batch governance, durable audit storage, and formal admin identity remain future work.

- [x] **Step 2: Verify**

Run:
- `npm --workspace apps/core test -- admin-console-assets.test.ts admin-console-api.test.ts action-proposal-api.test.ts`
- `npm --workspace apps/core test`
- `npm --workspace apps/core run typecheck`
- `npm --workspace apps/core run build`
- `node --test scripts/pilot-compose.test.mjs`
- `git diff --check`

Expected: all pass, with only existing Windows CRLF warnings allowed.
