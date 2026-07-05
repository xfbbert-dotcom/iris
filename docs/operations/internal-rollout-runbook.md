# Iris Internal Rollout Runbook

This runbook is for the first 20-30 person company rollout. The goal is to keep Iris usable and
recoverable before a full admin UI exists.

## Security Boundary

The `/internal/*` endpoints are operator APIs, not public APIs. Until an authentication layer is
added, expose Core only inside a trusted network, VPN, or private tunnel controlled by the team.
Set `IRIS_INTERNAL_API_TOKEN` whenever Core is reachable outside a developer laptop.

Never expose these endpoints directly to the public internet:

- `/internal/runtime-control/*`
- `/internal/readiness`
- `/internal/document-sync/*`
- `/internal/events/*`
- `/internal/reindex/*`
- `/internal/audit/*`
- `/internal/answer-drafts`

When `IRIS_INTERNAL_API_TOKEN` is configured, every `/internal/*` request must include:

```powershell
$irisHeaders=@{Authorization="Bearer $env:IRIS_INTERNAL_API_TOKEN"}
```

For runtime-control changes, operators may add an audit hint. This is not authentication; it is a
human-readable trace label recorded on runtime-control audit events:

```powershell
$irisOperatorHeaders=@{
  Authorization="Bearer $env:IRIS_INTERNAL_API_TOKEN"
  "X-Iris-Operator"="alice@example.com"
}
```

The internal `Invoke-RestMethod` examples below include `-Headers $irisHeaders`. `/health` and
`/feishu/events` do not use this token.

The bearer scheme is case-insensitive for client compatibility, but the token value must match
`IRIS_INTERNAL_API_TOKEN` exactly.

`IRIS_INTERNAL_API_TOKEN` must be a single visible ASCII token without spaces, tabs, line breaks, or
commas. Generate it as one header-safe secret value, for example with letters, numbers, hyphens, and
underscores.

The token guard applies to the internal request path before any query string. For example,
`/internal/status?details=1` and `/internal?probe=1` both require the same bearer token when
`IRIS_INTERNAL_API_TOKEN` is set.

## Local Infrastructure

Start Postgres and Redis:

```powershell
docker compose up -d
```

Set the local database URL and run migrations:

```powershell
$env:DATABASE_URL="postgres://iris:iris@localhost:5432/iris"
npm --workspace apps/core run db:migrate
```

## Core Runtime Environment

Use `.env.example` as the non-secret checklist for the variables below. Keep real values in your
local shell, deployment secret store, or private runtime configuration.

Minimal shared configuration:

```powershell
$env:DATABASE_URL="postgres://iris:iris@localhost:5432/iris"
$env:REDIS_URL="redis://localhost:6379"
$env:PORT="3000"
$env:IRIS_INTERNAL_API_TOKEN="<operator-shared-secret>"
```

Feishu callback verification:

```powershell
$env:FEISHU_VERIFICATION_TOKEN="<feishu-verification-token>"
$env:FEISHU_ENCRYPT_KEY="<optional-feishu-encrypt-key>"
```

Feishu OpenAPI access for document reads and live permission checks:

```powershell
$env:FEISHU_APP_ID="<feishu-app-id>"
$env:FEISHU_APP_SECRET="<feishu-app-secret>"
$env:FEISHU_OPEN_BASE_URL="https://open.feishu.cn"
$env:IRIS_FEISHU_BOT_OPEN_ID="<iris-bot-open-id>"
$env:IRIS_FEISHU_DOCUMENT_FETCH_TIMEOUT_MS="10000"
$env:IRIS_FEISHU_DOCUMENT_MAX_CONTENT_CHARS="2000000"
```

`IRIS_FEISHU_BOT_OPEN_ID` lets Iris identify explicit @mentions from Feishu message events. When
this value, Feishu OpenAPI credentials, and internal answer drafting are configured, the event worker
can draft an answer and reply to messages that mention the Iris bot. Missing this value keeps event
ingestion and document discovery running, but disables automatic @Iris replies.
Check `GET /internal/events/status` or `GET /internal/status` for `mentionRepliesEnabled: true`
before expecting @Iris replies in Feishu. If it is false, inspect
`mentionRepliesUnavailableReason` for the missing setup step.

Mention reply readiness reasons:

| Reason | Meaning | Fix |
| --- | --- | --- |
| `missing_bot_open_id` | Iris cannot identify which Feishu mention belongs to itself. | Set `IRIS_FEISHU_BOT_OPEN_ID` to the bot open id from Feishu. |
| `missing_feishu_openapi_config` | Iris can process events but cannot call Feishu OpenAPI to reply. | Set `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, and `FEISHU_OPEN_BASE_URL`. |
| `missing_answer_draft_orchestrator` | Iris can receive mentions but cannot generate answers. | Enable internal answer drafts and configure model, embedding, and retrieval dependencies. |

Enable background workers:

```powershell
$env:IRIS_EVENT_WORKER_ENABLED="true"
$env:IRIS_DOCUMENT_SYNC_WORKER_ENABLED="true"
$env:IRIS_REINDEX_WORKER_ENABLED="true"
```

Optional worker tuning:

```powershell
$env:IRIS_EVENT_WORKER_INTERVAL_MS="1000"
$env:IRIS_EVENT_WORKER_BATCH_LIMIT="50"
$env:IRIS_DOCUMENT_SYNC_WORKER_INTERVAL_MS="1000"
$env:IRIS_DOCUMENT_SYNC_WORKER_BATCH_LIMIT="10"
$env:IRIS_REINDEX_WORKER_INTERVAL_MS="1000"
$env:IRIS_REINDEX_WORKER_BATCH_LIMIT="25"
```

Model and embedding providers:

```powershell
$env:IRIS_MODEL_PROVIDER="openai-compatible"
$env:IRIS_MODEL_BASE_URL="https://api.example.com/v1"
$env:IRIS_MODEL_API_KEY="<model-api-key>"
$env:IRIS_MODEL_NAME="<model-name>"
$env:IRIS_MODEL_TIMEOUT_MS="30000"

$env:IRIS_EMBEDDING_PROVIDER="openai-compatible"
$env:IRIS_EMBEDDING_BASE_URL="https://api.example.com/v1"
$env:IRIS_EMBEDDING_API_KEY="<embedding-api-key>"
$env:IRIS_EMBEDDING_MODEL="<embedding-model>"
$env:IRIS_EMBEDDING_DIMENSIONS="1536"
$env:IRIS_EMBEDDING_TIMEOUT_MS="30000"
```

External base URLs must be absolute `http` or `https` URLs without embedded credentials, query
strings, or fragments. Iris rejects invalid model, embedding, and Feishu OpenAPI base URLs during
configuration loading.

Enable internal answer drafting:

```powershell
$env:IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS="true"
$env:IRIS_INTERNAL_DRAFT_PERMISSION_MODE="source-policy"
```

In `source-policy` mode, Feishu docx/docs/wiki fragments require Feishu OpenAPI live permission
checks before they can enter the model prompt. If `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, or
`FEISHU_OPEN_BASE_URL` is missing, Iris fails closed for Feishu document content and answers from
live chat plus any non-Feishu sources covered by local policy.

Mention replies require both internal answer drafting and the `replyWhenMentioned` runtime
capability. If Iris is globally disabled, the group is disabled, or `replyWhenMentioned` is false,
Iris will store allowed message facts but will not answer in Feishu.

Before starting the internal rollout, run the same readiness profile locally:

```powershell
npm run readiness
```

Or validate a private env file directly:

```powershell
npm run readiness -- --env-file .env
```

The env-file parser supports full-line comments and inline operator notes after unquoted or quoted
values, for example `PORT=3000 # local dev port`. A `#` inside quoted values is preserved, so quote
secrets or URLs when the `#` is part of the value.

The command prints the readiness JSON and exits with code `1` when any blocking check fails.

Run Core:

```powershell
npm --workspace apps/core run dev
```

## Health Checks

Basic process health:

```powershell
Invoke-RestMethod http://localhost:3000/health
```

Consolidated operator status:

```powershell
Invoke-RestMethod `
  -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/status
```

Pre-rollout configuration readiness:

```powershell
Invoke-RestMethod `
  -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/readiness
```

Use readiness before inviting the first internal group. `status: "ready"` means chat ingestion,
document sync, semantic reindexing, @Iris answer drafting, Feishu OpenAPI access, and the
source-policy permission guard are configured. `status: "ready_with_warnings"` means no blocking
configuration is missing, but the listed warnings should be handled before exposing Core beyond a
trusted private network. `status: "blocked"` means Iris is not ready for the 20-30 person rollout;
check each failed item and the listed `envVars`.

Important status rules:

- Top-level `status: "healthy"` means no reported component has `ok: false`.
- Top-level `status: "degraded"` means at least one reported component has `ok: false`.
- `summary.attentionSeverity` is the compact operator-priority signal: `critical` for degraded
  components, `warning` for stopped enabled runtimes, `info` for disabled components, and `none`
  when no component needs attention.
- Non-empty raw event, document sync, or reindex DLQs degrade the matching component.
- Disabled components are expected when the corresponding runtime is intentionally off.
- `components.runtimeControl` mirrors the current global runtime gate. If its status is
  `"disabled"`, Iris is globally off even if worker processes are still reachable.

## Runtime Control

Disable Iris globally:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/runtime-control/global `
  -ContentType "application/json" `
  -Body '{"enabled":false}'
```

Enable Iris globally:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/runtime-control/global `
  -ContentType "application/json" `
  -Body '{"enabled":true}'
```

Disable Iris for one Feishu group:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/runtime-control/groups/oc_group_id `
  -ContentType "application/json" `
  -Body '{"enabled":false}'
```

Update capabilities:

```powershell
Invoke-RestMethod `
  -Method Patch `
  -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/runtime-control/capabilities `
  -ContentType "application/json" `
  -Body '{"replyWhenMentioned":true,"readGroupDocuments":true,"retrieveKnowledgeBase":true}'
```

Read current runtime control state:

```powershell
Invoke-RestMethod `
  -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/runtime-control/status
```

The same state is also summarized inside `GET /internal/status` as `components.runtimeControl`,
including the current capability flags, so the consolidated operator snapshot can be used as the
first health check during rollout.

Inspect recent runtime-control changes:

```powershell
Invoke-RestMethod `
  -Headers $irisHeaders `
  -Uri "http://localhost:3000/internal/audit/events?limit=20&type=runtime_control_updated"
```

When a runtime-control mutation is sent with `X-Iris-Operator`, the audit event includes
`operatorHint`.

Filter runtime-control changes by operator hint:

```powershell
Invoke-RestMethod `
  -Headers $irisHeaders `
  -Uri "http://localhost:3000/internal/audit/events?limit=20&type=runtime_control_updated&operatorHint=alice%40example.com"
```

## Document Operations

List known document sources:

```powershell
Invoke-RestMethod `
  -Headers $irisHeaders `
  -Uri "http://localhost:3000/internal/document-sync/sources?limit=20&includeLatestSnapshot=true"
```

Register an authorized wiki document:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/document-sync/authorized-wiki-documents `
  -ContentType "application/json" `
  -Body '{"sourceUri":"https://example.feishu.cn/wiki/wiki_token","title":"Company Handbook","authorizedSpaceId":"space_1"}'
```

Register a user-submitted document:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/document-sync/user-submitted-documents `
  -ContentType "application/json" `
  -Body '{"sourceUri":"https://example.feishu.cn/docx/doc_token","title":"User Guide","submittedByUserId":"ou_1"}'
```

Manually enqueue a known source for sync:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/document-sync/sources/source_id/enqueue
```

Disable a source for answer retrieval:

```powershell
Invoke-RestMethod `
  -Method Patch `
  -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/document-sync/sources/source_id/policy `
  -ContentType "application/json" `
  -Body '{"canUseForAnswering":false}'
```

## DLQ Recovery

Raw Feishu event DLQ:

```powershell
Invoke-RestMethod `
  -Headers $irisHeaders `
  -Uri "http://localhost:3000/internal/events/dead-letters?limit=20"
```

Document sync DLQ:

```powershell
Invoke-RestMethod `
  -Headers $irisHeaders `
  -Uri "http://localhost:3000/internal/document-sync/dead-letters?limit=20"
```

Reindex DLQ:

```powershell
Invoke-RestMethod `
  -Headers $irisHeaders `
  -Uri "http://localhost:3000/internal/reindex/dead-letters?limit=20"
```

Replay one DLQ item:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/document-sync/dead-letters/dlq_id/replay
```

Replay a selected batch:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/document-sync/dead-letters/replay `
  -ContentType "application/json" `
  -Body '{"ids":["dlq_1","dlq_2"]}'
```

Delete an obsolete DLQ item:

```powershell
Invoke-RestMethod `
  -Method Delete `
  -Headers $irisHeaders `
  -Uri http://localhost:3000/internal/document-sync/dead-letters/dlq_id
```

Recovery rule:

- Fix the underlying cause first, such as missing Feishu credentials, provider outage, permission
  denial, or bad source URL.
- Use list endpoints to inspect failures.
- Replay selected items only after the cause is fixed.
- Delete obsolete or legacy diagnostic entries when replay is not possible.
- Re-check `/internal/status` after recovery; DLQ backlog should clear and the component should no
  longer be degraded for dead-letter reasons.

## Verification Before Internal Use

Run the local verification suite before changing rollout configuration:

```powershell
npm run verify
```

For PR verification, GitHub Actions must show:

- Core: success
- AI Worker: success
- PR merge state: clean
