# Iris Internal MVP Real-Feishu Gray Checklist

This checklist is the product-level gate for the first 20-30 person internal rollout. It does not
replace the detailed runbooks for memory, action approval, publication, or proactive delivery. It
keeps the team from treating one passed module as "complete Iris", while also preventing endless
hardening from blocking real usage.

## Exit Rule

Start real internal usage when every P1 loop below has passed once in a controlled pilot group, with
global disable and rollback already rehearsed. Do not wait for multi-tenant installation, billing,
batch admin workflows, durable admin identity, or polished analytics.

Stop or roll back only for:

- unauthorized data exposure;
- Iris replying or acting while globally/group disabled;
- permission-revoked document content entering an answer;
- repeated callback failures, stuck queues, or non-empty DLQs after retry;
- knowledge-base writes without the required review and approval facts;
- proactive delivery without explicit group allowlist and runtime permission.

Record non-blocking hardening as backlog instead of extending the gate.

## Required Pilot Loops

1. Shared group chat context
   - Two or more users talk in the same Feishu group.
   - A later `@Iris` question can use earlier group context.
   - A control group cannot read the pilot group's context.

2. Non-mention learning
   - Ordinary non-`@Iris` discussion is ingested asynchronously.
   - Thread/action/memory extraction updates state without Iris speaking.
   - Queues and DLQs return to zero.

3. Document reading
   - Group-visible document links are discovered, synced, indexed, and cited.
   - Authorized wiki/knowledge-base content is synced, indexed, and cited.
   - A user-submitted Feishu document can be registered from Admin Console and by an explicit
     in-chat `@Iris` submission command.
   - Missing/unsupported submission links and disabled document-reading state fail closed without
     invoking the model.

4. Permission revocation
   - A previously readable group or wiki document is revoked.
   - The next answer performs live permission guard checks and does not leak revoked content.
   - Guard denials are recorded as denials, not generic errors.

5. Knowledge draft to group confirmation
   - Iris creates or receives a knowledge draft from valid evidence.
   - The draft is shown to the group for confirmation or revision.
   - Revision and rejection are idempotent and visible in Admin Console.

6. Approval before high-impact action
   - Publishing to Feishu knowledge base requires the current draft revision, current review
     attestation, role/owner approval facts, and runtime permission.
   - Stale cards, stale review pages, revoked roles, and missing review facts cannot approve.

7. Knowledge-base publication
   - An approved draft publishes to the authorized Feishu wiki root exactly once.
   - Success, retryable failure, and outcome-unknown states are observable.
   - The source group receives a bounded result card.

8. Proactive candidate preview
   - Iris can scan one explicit pilot group for quiet unresolved threads or overdue actions.
   - Candidates are visible in Admin Console and can be dismissed.
   - No Feishu message is sent until explicit delivery approval and proactive runtime permission.

9. Governed proactive delivery
   - One approved candidate sends exactly one bounded Feishu card to the allowlisted group.
   - Runtime pause, group disable, global disable, and delivery env disable all prevent sending.
   - Duplicate approvals do not create duplicate cards.

10. Emergency stop
    - Global disable stops replies, extraction side effects, proactive delivery, and action
      execution.
    - Public `/health` remains available; public `/internal/*` remains `404`.
    - Queues drain or remain safely retryable after re-enable.

## Current Status - 2026-07-24

- Loops 3, 4, 5, 6, 7, and 10 have real Feishu pilot evidence for their core safety or product
  path: group/wiki document answering, permission revocation, knowledge draft confirmation,
  approval-before-action, first knowledge-base publication, and runtime fail-closed behavior.
- Loops 1 and 2 are code-complete for current-group message ingestion, semantic memory, threads,
  and actions, but their real Feishu gray gate is still pending. The current blocker is external
  Gemini availability: the latest minimal V2 JSON Schema probe returned `503 provider_unavailable`.
  Until that probe succeeds, semantic DLQ replay must not run.
- Loops 8 and 9 are code-complete and locally verified for governed proactive candidates and
  delivery gating, but real Feishu proactive card delivery remains default-off and must wait until
  the semantic thread/action loop has passed in the pilot group.
- This status means the product is not "only a chatbot", but it also is not yet a complete daily
  Iris rollout. The next release gate is provider recovery followed by ordered semantic DLQ replay
  and one controlled real Feishu semantic gray pass.

## Not Required For The First 20-30 Person MVP

- self-service multi-company installation;
- tenant isolation, billing, and tenant admin roles;
- rich batch approval workflows;
- full analytics dashboards;
- broad cross-group memory sharing;
- polished mobile admin UI;
- proactive speech in every group.

These are productization or scale work. They should not block the first internal rollout unless
pilot usage proves they are required for safety or daily operation.

## Current Deployment Dependency

Before running this checklist on `iris.quello.cn`, the operator environment must be able to SSH into
the VPS with the approved deployment account and deploy the exact PR candidate SHA. If SSH access is
unavailable, code can still be verified locally and in GitHub CI, but real Feishu production
acceptance cannot be honestly marked complete.
