# Iris Governed Feishu Task Action Design

**Date:** 2026-08-22

**Status:** Approved for implementation from the architecture whitepaper and current coverage gap

## Goal

Close the next missing whitepaper action loop:

```text
explicit group request or governed action-item candidate
-> versioned task draft
-> real group-member confirmation
-> exact assignee review and approval
-> one idempotent Feishu Task v2 create call
-> durable audit and bounded result card
```

The feature extends the existing approval-before-action contract. It does not let model output,
an internal operator API, or an extracted action item directly create or assign a formal task.

## Architecture classification

This is an architecture-related requirement under whitepaper section 11 because it adds a new
high-impact external write path. It does not change Iris's visibility boundary, tenant model, or
fact/semantic split.

The relevant whitepaper requirements are:

- the orchestrator can generate task drafts;
- creating or assigning a formal task requires confirmation;
- every high-impact action is proposed, confirmed, executed, audited, and reported;
- Core owns task and reminder scheduling;
- all capabilities are administratively controllable and fail closed.

## Scope

### In scope

- One formal task with one exact Feishu user assignee.
- A bounded title, description, optional due time, and optional single reminder.
- Draft creation from an explicit `@Iris` task-draft request. A later phase may offer an existing
  open `action_item` as evidence, but passive extraction never creates a remote task.
- A real Feishu group confirmation bound to the exact draft revision and content hash.
- Full-content OAuth review and approval by the exact assignee. An administrator cannot silently
  assign a task to a different person.
- Feishu Task v2 `POST /open-apis/task/v2/tasks?user_id_type=open_id` with a deterministic
  `client_token`.
- Durable execution, success, failure, outcome-unknown, and reconciliation facts.
- A bounded result card to the source group.
- Admin Console visibility and default-off runtime controls.

### Out of scope

- Updating, completing, deleting, or reassigning existing Feishu tasks.
- Multiple assignees, followers, task lists, subtasks, recurring tasks, custom fields, attachments,
  milestones, or agent-delivery fields.
- Automatic conversion of every extracted `action_item`.
- Cross-group task assignment.
- User-level scheduling preferences or a general cron service.
- Batch approval or batch task creation.

These exclusions keep the first loop reversible and reviewable; they do not weaken the required
single-task outcome.

## Feishu boundary

The official Feishu Task v2 contract supports tenant or user access tokens for task creation,
`open_id` member identities, millisecond timestamp strings, at most one reminder in the returned
task shape, and a request `client_token` for idempotency:

- https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/task-v2/task/create
- https://github.com/larksuite/oapi-sdk-go/blob/v3_main/service/task/v2/model.go
- https://github.com/larksuite/oapi-sdk-go/blob/v3_main/service/task/v2/resource.go

Iris uses its existing coalesced tenant-token provider. The external adapter accepts only the
official Feishu origin, rejects credentials/query fragments in its configured base URL, validates
the response before returning it, and never logs request bodies, access tokens, task GUIDs, open
IDs, or descriptions.

The request body contains only:

```json
{
  "summary": "bounded title",
  "description": "bounded description",
  "due": { "timestamp": "milliseconds", "is_all_day": false },
  "members": [{ "id": "assignee open id", "type": "user", "role": "assignee" }],
  "reminders": [{ "relative_fire_minute": 30 }],
  "client_token": "deterministic token"
}
```

`due` and `reminders` are omitted together when no due time is approved. The first release permits
only `0`, `30`, `60`, or `1440` reminder minutes and at most one reminder.

## Durable facts

Migration `0057` adds four focused groups of facts.

### Task draft facts

- `formal_task_drafts`: source group, status, current revision, version, creator, timestamps.
- `formal_task_draft_revisions`: title, description, assignee open ID, due time, reminder minutes,
  risk level, author, and canonical task-spec hash.
- `formal_task_draft_evidence`: exact source conversation message and optional action-item version.
- `formal_task_draft_events`: append-only create, revise, group-confirm, revision-request, reject,
  and execution-result history.
- presentation/outbox/event tables for the real Feishu confirmation card.

Draft content is never stored in queue payloads. Redis carries IDs and expected versions only.

### Target policy

`feishu_task_target_policies` binds one source group to an allowed assignee set and optional due-time
horizon. The first pilot policy requires:

- exact source-group match;
- exact assignee allowlist match;
- assignee is a current member of the source group at confirmation, approval, and execution;
- due time is absent or between now and the configured maximum horizon;
- policy is enabled and at the exact approved version.

### Shared action proposal extension

`action_proposals` gains `create_feishu_task` and `formal_task_draft`. Existing publication fields
remain intact. Task proposals bind the exact draft revision/version, task policy/version, assignee,
due time, reminder, task-spec hash, group confirmation, review target fingerprint, and approval.

The migration uses explicit nullable typed policy columns plus action-specific checks. It does not
reuse a Wiki policy ID for a task or weaken existing publication foreign keys.

The approval requirement is `designated_owner` with the exact assignee as `feishu_user`. There is
no admin fallback for assigning the first-version task to somebody else. Request-revision and reject
remain available and cannot create an approval fact.

### Task execution facts

- `feishu_task_creation_executions`: claim/dispatch/outcome state, request fingerprint, deterministic
  client token hash, attempt count, policy/draft/proposal versions, response classification, and
  optional remote identity.
- `feishu_task_creations`: one immutable success fact containing the exact proposal, approval,
  execution, draft, policy, remote task identity, returned task URL, spec hash, and completion time.
- append-only execution events for each state transition.
- result-presentation/outbox facts for the source-group card.

No database transaction or row lock remains open during a Feishu network request.

## Canonical task specification

The reviewed and executed content hash is computed from a strict canonical JSON object with sorted
keys and normalized strings:

```text
title, description, assigneeOpenId, dueAtUtc|null, reminderMinutes|null,
sourceGroupId, targetPolicyId, targetPolicyVersion
```

Title is 1-256 Unicode scalar values. Description is 1-3000. All outer whitespace is removed,
CRLF is normalized to LF, control characters are rejected, due time has millisecond precision, and
the assignee must be a nonblank Feishu open ID. Unknown fields are rejected.

## Runtime gates

The feature requires all of the following at each side-effect boundary:

- durable global runtime enabled;
- source group enabled;
- `generateTaskDrafts=true` to create a draft;
- `createFeishuTasks=true` to present approval or execute;
- `externalToolCalls=true` because Task v2 is an external high-impact write;
- `IRIS_FEISHU_TASK_CREATION_ENABLED=true`;
- exactly one allowlisted pilot group in `IRIS_FEISHU_TASK_CREATION_GROUP_ALLOWLIST` for the first
  controlled acceptance;
- current enabled task policy and current assignee membership.

All new capabilities and deployment flags default to false. An unplanned Core restart restores
durable intent but starts with live global activation false, consistent with the existing runtime
contract.

## Lifecycle and authority

1. A real group member explicitly asks Iris for a task draft.
2. Iris generates a draft only from the current request and allowed same-group context, persists
   evidence, and shows the exact draft in the source group.
3. A current group member confirms the exact revision. Bot actors, stale cards, disabled state, and
   nonmembers are denied without mutation.
4. The planner creates one `create_feishu_task` proposal. The exact assignee receives the approval
   card.
5. The assignee opens the OAuth review page. The attestation binds proposal version, draft
   revision/version, task-spec hash, and target fingerprint.
6. The same assignee approves. Membership, policy, runtime, proposal, review, and draft bindings are
   rechecked inside the approval transaction.
7. The executor claims once, rechecks every gate, commits, and calls Feishu with the deterministic
   `client_token`.
8. A validated success creates one immutable `feishu_task_creations` fact and a bounded source-group
   result card. The local draft becomes `created`.

Internal APIs can create or revise draft facts and perform safe governance dispositions, but they
cannot synthesize a group confirmation, OAuth attestation, or approval.

## Failure and reconciliation

- Validation, permission, policy, and capability failures occur before the external call.
- Feishu authentication and permanent validation errors fail the execution without a blind retry.
- Rate limits and explicitly retryable server failures use bounded backoff with the same
  `client_token`.
- A timeout or connection loss after dispatch becomes `outcome_unknown`. Reconciliation never uses
  a new token; it repeats the idempotent create request with the same exact payload/token and accepts
  only an identical returned task identity and task-spec projection.
- A mismatched readback or duplicate remote identity becomes `reconciliation_required` and stops
  automation.
- Global/group/capability disable stops new claims and presentations; already-recorded facts remain.

## Observability and acceptance

Status surfaces expose only counts, states, versions, timestamps, bounded classifications, and
whether loops are enabled/running. They do not expose task descriptions, open IDs, Feishu access
tokens, callback bodies, task GUIDs, or URLs.

Completion requires:

1. migration and repository integration tests against real PostgreSQL;
2. focused adapter, approval, executor, reconciliation, and result-card tests;
3. full Core/AI/Compose verification with default-off configuration;
4. one controlled real Feishu pilot with a fresh assignee-approved task;
5. proof of exactly one remote task, exact assignee/due/title projection, one local success fact,
   bounded result card, zero queues/DLQs/unresolved outcomes, and final fail-closed rollback.
