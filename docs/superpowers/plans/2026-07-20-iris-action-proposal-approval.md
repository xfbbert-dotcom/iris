# Iris Action Proposal And Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Phase 5B-2A as a complete, fail-closed action-proposal and human-approval loop for `publish_knowledge_draft`, converting confirmed/current knowledge drafts into version-bound proposals and collecting the exact low/medium/high risk approvals without writing to Feishu Wiki.

**Architecture:** Add an `action-approvals` module beside Phase 5B-1. PostgreSQL owns target policies, role grants, proposal/requirement/approval/event facts, approval-card presentations, and delivery outboxes. A bounded planner discovers eligible `pending_review` drafts idempotently; the existing authenticated Feishu card callback ingress and Redis interaction queue are extended with a discriminated action-approval job, while a dedicated worker rechecks runtime, draft version/evidence, target policy, and the actor's current role before committing approval facts. The full-content OAuth review page is Phase 5B-2B and Feishu Wiki writes remain Phase 5B-3.

**Tech Stack:** TypeScript 5.5, Node.js 24, Fastify 5, Zod 4, PostgreSQL 16, Redis 7, Vitest 2, Feishu OpenAPI JSON 2.0 cards.

## Execution Status (2026-07-20)

- Tasks 1-7 are implemented through code commit `02179e4d`; the implementation remains default-off and does not write Feishu Wiki.
- Task 8 documentation、fresh full-repository gates 和独立复审已完成。GitHub push/checks 与真实 Feishu pilot 仍需完成，5B-2A 在此之前不能标记为真实验收通过。
- Phase 5B-2B and 5B-3 remain separate work. This plan must not be extended with non-blocking hardening after the Task 8 exit gates pass.

## Global Constraints

- Build on exact Phase 5B-1 commit `e201ed321d7103cfb7919acefe1af5c6731b2c84`; do not change PR #11 or its deployed candidate.
- Implement only Phase 5B-2A. Do not call Feishu Wiki create/write APIs, mark drafts `published`, or enable `writeKnowledgeBase`.
- Use migration `0032_action_approval_facts.sql`; do not edit migrations `0030` or `0031`, and reserve `0033_knowledge_publications.sql` for Phase 5B-3.
- Default `IRIS_APPROVAL_ACTIONS_ENABLED=false`; an empty `IRIS_APPROVAL_ACTION_GROUP_IDS` means no group may create or act on proposals.
- Keep Phase 5B-1 callback authentication, three-second acknowledgement, Redis durability, and live Feishu group-membership contract unchanged.
- All callback jobs must be content-free. Do not put draft content, evidence content, access tokens, callback bodies, rejection/revision reasons, or raw provider errors in Redis, ordinary logs, status payloads, or DLQ summaries.
- A proposal binds exact `draft_id`, revision number, draft version, target-policy ID/version, risk level, and an immutable requirement snapshot. Any change cancels the unexecuted proposal and invalidates prior approvals.
- Low risk with a current source-group confirmation requires no extra human approval. Medium risk requires the current exact `feishu_user` reviewer. High risk requires a current `iris_admin` grant or the exact reviewer with a current `authorized_high_risk_owner` grant.
- Company-level drafts without a source group never auto-approve: low/medium require the exact `feishu_user` reviewer; high requires the same high-risk rule.
- The initial single-group production runtime does not discover company-level drafts. Their domain contract remains covered, but production activation requires a separate explicit runtime/policy gate so no company proposal can be sent and then become unapprovable.
- `text_label`, model output, display names, card labels, request parameters, and internal bearer tokens are never authorization identities.
- Internal APIs may create/update target policies and role grants and may request revision/reject for governance, but no internal API accepts an actor Open ID to fabricate human approval.
- Runtime, group allowlist, current evidence, proposal version, role grant, target policy, and approval requirement must all be re-read after callback receipt and immediately before mutation.
- Approval card update failure cannot roll back a committed approval. PostgreSQL remains the fact source.
- Public Caddy exposure remains `/health`, `/feishu/events`, and `/feishu/card-actions`; every public `/internal/*` and unmatched path remains 404.
- Exit after the agreed automated and real pilot gates pass. Cosmetic card variants, batch approval, multi-tenant policy, and the OAuth full-content review page are tracked for Phase 5B-2B instead of extending 5B-2A indefinitely.

---

## File Structure

Create focused units under `apps/core/src/action-approvals/`:

- `action-proposal.ts`: proposal, requirement, role-grant, and policy value contracts.
- `action-proposal-repository.ts`: storage interfaces, status snapshots, and stable conflict types.
- `postgres-action-proposal-repository.ts`: policy/grant/proposal/approval transactions and append-only events.
- `action-proposal-planner.ts`: bounded discovery and idempotent proposal/requirement creation.
- `action-proposal-planner-loop.ts`: lifecycle and content-free status.
- `action-approval-card-renderer.ts`: deterministic, version-bound approval cards.
- `action-approval-dispatcher.ts`: approval-card outbox delivery and safe retry classification.
- `action-approval-dispatcher-loop.ts`: delivery polling lifecycle.
- `action-approval-worker.ts`: live authorization and atomic approval/revision/rejection.
- `action-proposal-api.ts`: internal list/detail/event/policy/grant and controlled governance routes.

Create `apps/core/src/runtime/action-approval-runtime.ts` for PostgreSQL composition, planning, delivery, action handling, status, and close order. Extend the existing card-action parser, gateway job, Redis queue, and worker dispatcher rather than introducing a second public callback URL.

---

### Task 1: Freeze Migration And Domain Contracts

**Files:**
- Create: `apps/core/migrations/0032_action_approval_facts.sql`
- Create: `apps/core/src/action-approvals/action-proposal.ts`
- Create: `apps/core/src/action-approvals/action-proposal-repository.ts`
- Create: `apps/core/tests/action-proposal.test.ts`
- Create: `apps/core/tests/postgres-action-proposal-repository.test.ts`
- Modify: `apps/core/src/knowledge-governance/knowledge-draft.ts`
- Modify: `apps/core/migrations/0032_action_approval_facts.sql`

**Interfaces:**
- Produces: `ActionProposal`, `ActionApprovalRequirement`, `ActionApproval`, `PublicationTargetPolicy`, `ActionRoleGrant`, and `ActionProposalRepository`.
- Produces statuses `pending_approval`, `approved`, `executing`, `succeeded`, `failed`, `cancelled`, `expired`, and `reconciliation_required`.
- Adds knowledge-draft event types `review_approved` and `approval_invalidated`; publication events remain reserved for migration `0033`.

- [ ] **Step 1: Write failing domain tests**

```ts
it("builds the exact medium-risk requirement snapshot", () => {
  const snapshot = buildApprovalRequirementSnapshot({
    sourceGroupId: "oc_group",
    riskLevel: "medium",
    reviewer: { type: "feishu_user", ref: "ou_owner" },
    groupConfirmation: { actorOpenId: "ou_member", presentationId: "presentation-1" },
    targetPolicy: { id: "policy-1", version: 4 },
  });
  expect(snapshot.map((item) => item.kind)).toEqual(["group_confirmation", "designated_owner"]);
});

it("does not auto-approve a company-level low-risk draft", () => {
  expect(buildApprovalRequirementSnapshot({
    riskLevel: "low",
    reviewer: { type: "feishu_user", ref: "ou_owner" },
    targetPolicy: { id: "policy-1", version: 1 },
  }).map((item) => item.kind)).toEqual(["designated_owner"]);
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```powershell
npm --workspace apps/core test -- action-proposal.test.ts postgres-action-proposal-repository.test.ts
```

Expected: FAIL because migration `0032` and action-approval modules do not exist.

- [ ] **Step 3: Implement bounded domain values**

```ts
export const ACTION_PROPOSAL_STATUSES = [
  "pending_approval", "approved", "executing", "succeeded", "failed",
  "cancelled", "expired", "reconciliation_required",
] as const;
export const ACTION_APPROVAL_REQUIREMENT_KINDS = [
  "group_confirmation", "designated_owner", "iris_admin_or_authorized_owner",
] as const;
export const ACTION_ROLE_GRANT_TYPES = ["iris_admin", "authorized_high_risk_owner"] as const;
export const ACTION_PROPOSAL_ACTION_TYPE = "publish_knowledge_draft" as const;

export type ActionProposal = {
  id: string;
  actionType: typeof ACTION_PROPOSAL_ACTION_TYPE;
  subjectType: "knowledge_draft";
  subjectId: string;
  subjectRevision: number;
  subjectVersion: number;
  targetPolicyId: string;
  targetPolicyVersion: number;
  riskLevel: "low" | "medium" | "high";
  status: ActionProposalStatus;
  operationKey: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};
```

All normalizers reject unknown fields, trim references, enforce 1-512 character identifiers, use safe positive integers, clone `Date` and array values, and sort allowlists deterministically.

- [ ] **Step 4: Add migration `0032_action_approval_facts.sql`**

Create:

- `knowledge_publication_target_policies` with versioned `space_id`, optional `parent_node_token`, allowed groups/risks, enabled flag, operation key/fingerprint, and operator audit fields;
- `action_role_grants` with `(role_type, actor_open_id)` identity, enabled/version fields, operation key/fingerprint, and operator audit fields;
- `action_proposals` with exact subject/policy versions, status/version, operation key/fingerprint, and a partial unique index preventing multiple live proposals for one draft revision;
- `action_approval_requirements` with immutable role/policy snapshots and a unique `(proposal_id, requirement_kind, role_ref)` identity;
- append-only `action_approvals` and `action_events`;
- `action_approval_presentations`, append-only presentation events, and `action_approval_presentation_outbox` containing IDs only;
- reserved `action_executions` and append-only execution events, with no worker or external execution in this phase.

Use checks equivalent to:

```sql
CREATE UNIQUE INDEX action_proposals_one_live_subject_idx
  ON action_proposals (subject_id, subject_revision)
  WHERE status IN ('pending_approval', 'approved', 'executing', 'reconciliation_required');

CREATE UNIQUE INDEX action_approvals_one_requirement_actor_idx
  ON action_approvals (proposal_id, requirement_id, actor_open_id);

CREATE UNIQUE INDEX action_approval_presentations_one_active_recipient_idx
  ON action_approval_presentations (proposal_id, requirement_id, recipient_open_id)
  WHERE state = 'active';
```

Apply the existing append-only guard to approvals, events, presentation events, and execution events. Extend `knowledge_draft_events_event_type_check` without removing existing values.

- [ ] **Step 5: Add migration contract and real-Postgres tests**

Assert every table, check, unique index, foreign key, append-only trigger, exact enum, and forward-only migration behavior. Verify rollback means application rollback while facts remain readable; do not add destructive down migrations.

- [ ] **Step 6: Run tests and commit the contract**

```powershell
npm --workspace apps/core test -- action-proposal.test.ts postgres-action-proposal-repository.test.ts
git add apps/core/migrations/0032_action_approval_facts.sql apps/core/src/action-approvals/action-proposal.ts apps/core/src/action-approvals/action-proposal-repository.ts apps/core/src/knowledge-governance/knowledge-draft.ts apps/core/tests/action-proposal.test.ts apps/core/tests/postgres-action-proposal-repository.test.ts
git commit -m "feat(core): define action approval facts"
```

---

### Task 2: Implement Policies, Grants, And Atomic Proposal Persistence

**Files:**
- Create: `apps/core/src/action-approvals/postgres-action-proposal-repository.ts`
- Modify: `apps/core/src/action-approvals/action-proposal-repository.ts`
- Modify: `apps/core/tests/postgres-action-proposal-repository.test.ts`

**Interfaces:**
- Produces policy methods `upsertTargetPolicy`, `getTargetPolicy`, and `listTargetPolicies`.
- Produces grant methods `upsertRoleGrant`, `listRoleGrants`, and `actorHasCurrentRole`.
- Produces proposal methods `createProposal`, `getProposalContext`, `listProposals`, `listEvents`, `cancelStaleProposals`, and `applyApprovalAction`.

- [ ] **Step 1: Add failing policy and grant tests**

Cover exact operation-key replay, conflicting payload rejection, sorted allowlists, version increments, disabled policies/grants, and stale expected-version conflicts.

- [ ] **Step 2: Implement policy and grant transactions**

Every mutation advisory-locks the operation key, applies compare-and-swap to the expected version, and stores only normalized Open IDs and policy facts. `actorHasCurrentRole` reads enabled rows at action time; no role result is cached in Redis.

- [ ] **Step 3: Add failing proposal creation tests**

Cover:

- low risk plus source-group confirmation creates an `approved` proposal with one satisfied requirement;
- medium risk creates `pending_approval` with group satisfied and designated-owner pending;
- high risk creates group satisfied and admin/authorized-owner pending;
- company-level low/medium requires designated owner;
- missing current target policy or unsupported group/risk returns a stable ineligible result without a proposal;
- missing verifiable reviewer leaves a pending requirement without a recipient and never downgrades risk;
- duplicate planner runs return the same proposal;
- a new draft revision cancels the old live proposal and inserts `approval_invalidated`.

- [ ] **Step 4: Implement atomic proposal and requirement creation**

`createProposal` locks the operation key and draft, verifies `pending_review`, exact current revision/version/evidence, current target policy, current group confirmation when required, and inserts proposal/requirements/events in one transaction. It stores no draft title or content.

```ts
createProposal(input: {
  proposalId: string;
  draftId: string;
  expectedRevision: number;
  expectedDraftVersion: number;
  targetPolicyId: string;
  expectedTargetPolicyVersion: number;
  requirements: readonly NewActionApprovalRequirement[];
  operationKey: string;
  at: Date;
}): Promise<{ outcome: "applied" | "already_applied"; proposal: ActionProposal }>;
```

- [ ] **Step 5: Implement atomic approval/revision/rejection**

`applyApprovalAction` locks operation, proposal, draft, requirement, and approval rows in deterministic order; rechecks subject/policy versions and current evidence; inserts one append-only approval/event; and moves the proposal to `approved` only when all current requirements are satisfied. Revision/rejection use the Phase 5A draft state machine, cancel the proposal, and never fabricate an approval.

- [ ] **Step 6: Run tests and commit persistence**

```powershell
npm --workspace apps/core test -- postgres-action-proposal-repository.test.ts
git add apps/core/src/action-approvals/postgres-action-proposal-repository.ts apps/core/src/action-approvals/action-proposal-repository.ts apps/core/tests/postgres-action-proposal-repository.test.ts
git commit -m "feat(core): persist action proposals and approvals"
```

---

### Task 3: Add The Bounded Proposal Planner

**Files:**
- Create: `apps/core/src/action-approvals/action-proposal-planner.ts`
- Create: `apps/core/src/action-approvals/action-proposal-planner-loop.ts`
- Create: `apps/core/tests/action-proposal-planner.test.ts`
- Create: `apps/core/tests/action-proposal-planner-loop.test.ts`
- Modify: `apps/core/src/action-approvals/action-proposal-repository.ts`

**Interfaces:**
- Consumes `listEligibleDrafts({ groupIds, limit })` and current policy/grant facts.
- Produces `planBatch({ limit, at })` and a loop snapshot with planned, already-planned, ineligible, failed, and cancelled-stale counts only.

- [ ] **Step 1: Write failing planner tests**

Use fixed draft/policy facts and assert deterministic policy matching by exact `spaceId` plus optional `parentNodeToken`, exact group/risk allowlists, proposal operation key `publish-knowledge:{draftId}:{revision}:{policyVersion}`, and bounded batch order by draft update time then ID.

- [ ] **Step 2: Implement planner policy matching**

Reject no match, disabled policy, multiple matches, unsupported group, unsupported risk, invalid evidence, and missing current group confirmation. Never dynamically create a target from `suggestedPublication`.

- [ ] **Step 3: Implement planner loop**

The loop runs only when global, group, `generateKnowledgeDrafts`, and `IRIS_APPROVAL_ACTIONS_ENABLED` gates all permit it. Each draft failure is isolated and classified; the loop does not stop the service or leak content.

- [ ] **Step 4: Run tests and commit planner**

```powershell
npm --workspace apps/core test -- action-proposal-planner.test.ts action-proposal-planner-loop.test.ts
git add apps/core/src/action-approvals/action-proposal-planner.ts apps/core/src/action-approvals/action-proposal-planner-loop.ts apps/core/src/action-approvals/action-proposal-repository.ts apps/core/tests/action-proposal-planner.test.ts apps/core/tests/action-proposal-planner-loop.test.ts
git commit -m "feat(core): plan publish knowledge proposals"
```

---

### Task 4: Extend The Shared Feishu Callback Queue Safely

**Files:**
- Modify: `apps/core/src/knowledge-cards/knowledge-card.ts`
- Modify: `apps/core/src/feishu/feishu-card-action.ts`
- Modify: `apps/core/src/feishu/feishu-card-action-gateway.ts`
- Modify: `apps/core/src/knowledge-cards/approval-interaction-queue.ts`
- Modify: `apps/core/src/knowledge-cards/redis-approval-interaction-queue.ts`
- Modify: `apps/core/tests/knowledge-card.test.ts`
- Modify: `apps/core/tests/feishu-card-action.test.ts`
- Modify: `apps/core/tests/feishu-card-action-gateway.test.ts`
- Modify: `apps/core/tests/approval-interaction-queue.test.ts`
- Modify: `apps/core/tests/redis-approval-interaction-queue.test.ts`

**Interfaces:**
- Extends `ApprovalInteractionJob` to a discriminated union with `kind: "knowledge_draft_confirmation" | "action_proposal_approval"`.
- Produces action-proposal actions `approve`, `request_revision`, and `reject` with exact proposal/requirement/version binding.

- [ ] **Step 1: Add failing union and parser tests**

```ts
expect(parseFeishuCardAction(validApprovalPayload)).toMatchObject({
  kind: "action_proposal_approval",
  proposalId: "proposal-1",
  requirementId: "requirement-1",
  proposalVersion: 1,
  action: "approve",
});
```

Reject mixed knowledge/proposal fields, missing `kind`, unknown keys, noncanonical positive decimal strings, approval with a reason, revision/rejection without a reason, and rejection without native confirmation.

- [ ] **Step 2: Add `kind` to Phase 5B-1 renderer and tests**

All newly generated Phase 5B-1 cards include `kind=knowledge_draft_confirmation`. Existing persisted callbacks are not rewritten; old active acceptance cards fail closed after deployment and are not production facts.

- [ ] **Step 3: Extend the content-free Redis schema**

Store only IDs, action, reason for revision/rejection, receipt time, and attempt count. Preserve duplicate, lease recovery, retry, DLQ, replay, and corrupted-payload behavior for both union members.

- [ ] **Step 4: Run focused tests and commit ingress changes**

```powershell
npm --workspace apps/core test -- knowledge-card.test.ts feishu-card-action.test.ts feishu-card-action-gateway.test.ts approval-interaction-queue.test.ts redis-approval-interaction-queue.test.ts
git add apps/core/src/knowledge-cards apps/core/src/feishu/feishu-card-action.ts apps/core/src/feishu/feishu-card-action-gateway.ts apps/core/tests
git commit -m "feat(core): route proposal approval callbacks"
```

---

### Task 5: Deliver Version-Bound Approval Cards

**Files:**
- Create: `apps/core/src/action-approvals/action-approval-card-renderer.ts`
- Create: `apps/core/src/action-approvals/action-approval-dispatcher.ts`
- Create: `apps/core/src/action-approvals/action-approval-dispatcher-loop.ts`
- Create: `apps/core/tests/action-approval-card-renderer.test.ts`
- Create: `apps/core/tests/action-approval-dispatcher.test.ts`
- Create: `apps/core/tests/action-approval-dispatcher-loop.test.ts`
- Modify: `apps/core/src/feishu/feishu-interactive-card-client.ts`
- Modify: `apps/core/tests/feishu-interactive-card-client.test.ts`

**Interfaces:**
- Produces a card bound to proposal ID/version, requirement ID, subject revision/version, recipient Open ID, and target-policy version.
- Extends the Feishu client with `sendCardToUser({ recipientOpenId, cardJson })` using `receive_id_type=open_id`.

- [ ] **Step 1: Write failing renderer tests**

Assert the card shows bounded title, risk, target policy display name, exact revision, satisfied/pending requirement summary, and buttons `Approve`, `Request revision`, and `Reject`. The card must not include the full draft body; it links to the Phase 5B-2B review route only when the configured authenticated review origin is present.

- [ ] **Step 2: Implement deterministic card rendering**

Use Feishu JSON 2.0 `behaviors[0].value`, canonical decimal strings, a 1,000-character reason textarea, and native rejection confirmation. Keep JSON under 24 KiB and components under 100.

- [ ] **Step 3: Add failing delivery tests**

Cover exact recipient Open ID, no-recipient pending requirement, one active presentation per recipient, preparation failure, `external_attempting`, success, explicit retryable/permanent failure, outcome unknown, and card-send replay.

- [ ] **Step 4: Implement outbox delivery**

Claim a Postgres outbox row, render from a fresh proposal context, mark `external_attempting` before calling Feishu, then atomically record message ID and active presentation. Never put rendered card JSON in the database or Redis.

- [ ] **Step 5: Run tests and commit delivery**

```powershell
npm --workspace apps/core test -- action-approval-card-renderer.test.ts action-approval-dispatcher.test.ts action-approval-dispatcher-loop.test.ts feishu-interactive-card-client.test.ts
git add apps/core/src/action-approvals apps/core/src/feishu/feishu-interactive-card-client.ts apps/core/tests
git commit -m "feat(core): deliver proposal approval cards"
```

---

### Task 6: Process Live Human Approval Actions

**Files:**
- Create: `apps/core/src/action-approvals/action-approval-worker.ts`
- Create: `apps/core/tests/action-approval-worker.test.ts`
- Modify: `apps/core/src/knowledge-cards/approval-interaction-worker.ts`
- Modify: `apps/core/tests/approval-interaction-worker.test.ts`
- Modify: `apps/core/src/knowledge-cards/knowledge-card-renderer.ts`

**Interfaces:**
- Produces `processActionApproval(job)` with applied, already-applied, denied, retryable, and dead-letter outcomes.
- The existing Redis worker dispatches by `job.kind` and preserves one shared queue/DLQ status surface.

- [ ] **Step 1: Write failing authorization tests**

Cover:

- medium approval succeeds only for the current exact reviewer;
- high approval succeeds for a current admin or exact reviewer with current high-risk grant;
- revoked grant, changed reviewer, changed policy version, changed draft version, invalid evidence, disabled runtime/group, unknown requirement, stale presentation, and wrong recipient all deny before mutation;
- low source-group proposal is already approved and creates no approval card;
- duplicate exact callback is idempotent and conflicting callback content is rejected;
- revision/rejection transitions the draft and cancels the proposal;
- card update failure leaves the committed approval fact intact.

- [ ] **Step 2: Implement the live authorization sequence**

For each job:

1. read global/group/capability/action gates;
2. load exact presentation/proposal/requirement/draft/policy context;
3. validate current draft evidence and document permissions;
4. validate current group membership when the draft has a source group;
5. validate current reviewer and role grants;
6. re-read all runtime gates;
7. call one atomic repository mutation;
8. update all proposal cards with a bounded committed result.

- [ ] **Step 3: Extend the shared worker dispatcher**

Keep Phase 5B-1 behavior byte-for-byte equivalent for `kind=knowledge_draft_confirmation`. Route `kind=action_proposal_approval` to the new worker and aggregate only bounded outcome counts.

- [ ] **Step 4: Run tests and commit worker behavior**

```powershell
npm --workspace apps/core test -- action-approval-worker.test.ts approval-interaction-worker.test.ts
git add apps/core/src/action-approvals/action-approval-worker.ts apps/core/src/knowledge-cards/approval-interaction-worker.ts apps/core/src/knowledge-cards/knowledge-card-renderer.ts apps/core/tests/action-approval-worker.test.ts apps/core/tests/approval-interaction-worker.test.ts
git commit -m "feat(core): authorize proposal approval actions"
```

---

### Task 7: Compose Runtime, Internal APIs, And Readiness

**Files:**
- Create: `apps/core/src/runtime/action-approval-runtime.ts`
- Create: `apps/core/src/action-approvals/action-proposal-api.ts`
- Create: `apps/core/tests/action-approval-runtime.test.ts`
- Create: `apps/core/tests/action-proposal-api.test.ts`
- Modify: `apps/core/src/config/env.ts`
- Modify: `apps/core/src/app.ts`
- Modify: `apps/core/src/admin/internal-rollout-readiness.ts`
- Modify: `apps/core/tests/env.test.ts`
- Modify: `apps/core/tests/app.test.ts`
- Modify: `apps/core/tests/internal-rollout-readiness.test.ts`
- Modify: `deploy/pilot/docker-compose.yml`
- Modify: `deploy/pilot/ci.env`
- Modify: `deploy/pilot/.env.example`
- Modify: `scripts/pilot-compose.test.mjs`
- Modify: `scripts/pilot-smoke-lib.test.mjs`

**Interfaces:**
- Adds `IRIS_APPROVAL_ACTIONS_ENABLED`, `IRIS_APPROVAL_ACTION_GROUP_IDS`, planner/dispatcher interval and batch limits, and optional `IRIS_REVIEW_PUBLIC_ORIGIN`.
- Adds internal policy/grant/proposal list/detail/event/governance routes protected by the existing bearer token.

- [ ] **Step 1: Write failing env/runtime/readiness tests**

Assert disabled-by-default behavior, empty allowlist, malformed/oversized IDs rejected, missing database/Redis/Feishu configuration fails startup only when enabled, close-order cleanup, and readiness degradation for unreadable facts, stopped loops, terminal delivery failures, or outcome-unknown rows.

- [ ] **Step 2: Implement runtime composition**

Create one Postgres pool for action facts, planner and dispatcher loops, and action worker dependencies. Pass the action worker into the existing shared callback queue processor. Start no loop and allocate no external client when the phase is disabled.

- [ ] **Step 3: Write failing API tests**

Cover bearer-before-body validation, 404 cross-subject ambiguity, bounded pagination, stable conflicts, content-free status, no actor-ID approval API, exact expected-version policy/grant mutations, request-revision/reject governance operations, and public Caddy 404 for every `/internal/*` route.

- [ ] **Step 4: Implement APIs and status**

Required routes:

```text
GET  /internal/action-proposals
GET  /internal/action-proposals/:id
GET  /internal/action-proposals/:id/events
POST /internal/action-proposals/:id/request-revision
POST /internal/action-proposals/:id/reject
GET  /internal/action-policies
PUT  /internal/action-policies/:id
GET  /internal/action-role-grants
PUT  /internal/action-role-grants/:role/:actorOpenId
GET  /internal/action-approvals/status
```

No route accepts a human approval fact. Policy/grant writes require `x-iris-operator`, exact expected version, and an operation key.

- [ ] **Step 5: Wire pilot configuration and readiness**

Keep all new flags false/empty in `ci.env` and `.env.example`. Status exposes counts only. Caddy does not gain a route. Compose and smoke tests prove the callback path remains exact and internal routes remain private.

- [ ] **Step 6: Run focused tests and commit composition**

```powershell
npm --workspace apps/core test -- action-approval-runtime.test.ts action-proposal-api.test.ts env.test.ts app.test.ts internal-rollout-readiness.test.ts
npm run test:pilot
git add apps/core/src apps/core/tests deploy/pilot scripts
git commit -m "feat(core): compose action approval runtime"
```

---

### Task 8: Verification, Documentation, GitHub, And Real Pilot Gate

**Files:**
- Create: `docs/runbooks/iris-action-proposal-approval-acceptance.md`
- Create: `docs/pull-requests/2026-07-20-iris-action-proposal-approval.md`
- Modify: `docs/superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md`
- Modify: `docs/superpowers/specs/2026-07-19-iris-knowledge-approval-publication-design.md`

**Interfaces:**
- Produces one fail-closed rollout runbook and a PR evidence record.
- Does not merge PR #11 or the new stacked PR without explicit authorization.

- [ ] **Step 1: Run the complete local gates**

```powershell
git diff --check
npm run typecheck
npm run build
npm test
npm run test:python
npm run test:pilot
npm run pilot:config
npm run readiness -- --env-file deploy/pilot/ci.env
```

Expected: all commands pass; both new runtime flags remain disabled in readiness output.

- [ ] **Step 2: Write the acceptance runbook**

Define exact exit gates:

- low source-group proposal auto-approved without an extra approval card;
- medium exact reviewer approve, revision, and rejection;
- high admin and authorized-owner success plus revoked-role denial;
- stale draft/policy/proposal/card denial;
- duplicate callback idempotency;
- non-pilot group has no proposal/card;
- runtime-disabled callback is denied with no mutation;
- proposal/card queues, outboxes, and DLQs all return to zero;
- no Feishu Wiki node/document is created;
- global/group/action gates return disabled and Caddy stops after acceptance.

- [ ] **Step 3: Commit documentation**

```powershell
git add docs/runbooks/iris-action-proposal-approval-acceptance.md docs/pull-requests/2026-07-20-iris-action-proposal-approval.md docs/superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md docs/superpowers/specs/2026-07-19-iris-knowledge-approval-publication-design.md docs/superpowers/plans/2026-07-20-iris-action-proposal-approval.md
git commit -m "docs: add action approval rollout gates"
```

- [ ] **Step 4: Push a stacked draft PR**

Push `codex/iris-approval-action-layer` and open a draft PR with base `codex/iris-knowledge-approval-actions`. Wait for Core and AI Worker checks at the exact head SHA before any deployment.

- [ ] **Step 5: Deploy fail closed and perform the real pilot**

Back up Postgres, verify migration `0032`, deploy Core and AI Worker images at the exact approved candidate, and keep `IRIS_APPROVAL_ACTIONS_ENABLED=false`, all groups disabled, and Caddy stopped. After read-only gates pass, enable only the pilot group for one bounded acceptance window and execute the runbook with real Feishu users. Any identity, permission, duplicate, data-loss, state-machine, or core-crash failure closes the gate immediately.

- [ ] **Step 6: Record evidence and stop this subphase**

Update the private VPS deployment log and the stacked PR with exact SHA, CI links, real pilot results, queue/DLQ counts, and final fail-closed state. Once all exit gates pass, proceed to Phase 5B-2B; do not continue cosmetic or batch hardening in 5B-2A.
