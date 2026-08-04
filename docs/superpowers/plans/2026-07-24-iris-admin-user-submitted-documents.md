# Iris Admin User Submitted Documents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an internal Admin Console entry point for registering user-submitted Feishu document links and enqueueing sync.

**Architecture:** Extend the existing static `/admin` Document Sources panel to call the existing authenticated `POST /internal/document-sync/user-submitted-documents` API. The console remains metadata-only, uses the operator-provided internal token, and refreshes the source list after registration.

**Tech Stack:** Fastify, TypeScript, browser-native HTML/CSS/JavaScript, existing document-sync internal APIs.

## Global Constraints

- Do not introduce a frontend framework or new runtime dependency.
- Do not expose `/internal/*` publicly; Caddy remains exact static `/admin` assets only.
- Do not render document body text, raw snapshots, tokens, or card JSON.
- Do not bypass existing URL normalization, permission, registration, or sync queue behavior.
- Existing internal APIs remain the source of truth.

---

### Task 1: Manual Document Registration In Static Assets

**Files:**
- Modify: `apps/core/src/admin-console/admin-console-assets.ts`
- Test: `apps/core/tests/admin-console-assets.test.ts`

**Interfaces:**
- Consumes: `POST /internal/document-sync/user-submitted-documents`
- Consumes: `GET /internal/document-sync/sources?includeLatestSnapshot=true`
- Produces: internal document submission form in `/admin`

- [x] **Step 1: Write the failing test**

Add an asset test that asserts the console renders `user-document-source-uri`, `user-document-submitter`, correct document source type filters, and calls `/internal/document-sync/user-submitted-documents` without exposing raw body fields.

- [x] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/core test -- admin-console-assets.test.ts`

Expected: FAIL because the console has no user-submitted document form.

- [x] **Step 3: Implement minimal panel**

Extend Document Sources with:
- user document URL input;
- optional title input;
- submitted-by input;
- submit button.

Extend JS with:
- `userSubmittedDocumentPath`;
- `registerUserSubmittedDocument()`;
- form submit handler that posts the normalized request, clears transient inputs, records an event, and refreshes document sources.

- [x] **Step 4: Run focused test**

Run: `npm --workspace apps/core test -- admin-console-assets.test.ts`

Expected: PASS.

### Task 2: Documentation And Verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md`
- Modify: `docs/pull-requests/2026-07-23-iris-proactive-signal-preview.md`

- [x] **Step 1: Update docs**

Record that Admin Console now includes an internal user-submitted document registration entry point, while a normal Feishu user self-service submission flow remains future work.

- [x] **Step 2: Verify**

Run:
- `npm --workspace apps/core test -- admin-console-assets.test.ts admin-console-api.test.ts answer-draft-api.test.ts`
- `npm --workspace apps/core test`
- `npm --workspace apps/core run typecheck`
- `npm --workspace apps/core run build`
- `node --test scripts/pilot-compose.test.mjs`
- `git diff --check`

Expected: all pass, with only existing Windows CRLF warnings allowed.
