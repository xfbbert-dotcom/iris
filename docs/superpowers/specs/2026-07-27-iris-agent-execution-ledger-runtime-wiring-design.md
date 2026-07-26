# Iris Agent Execution Ledger Runtime Wiring Design

Date: 2026-07-27

Status: Approved direction for the internal 20-30 person MVP

## Goal

Connect the append-only Agent Execution Ledger to Iris's real runtime so operators can
inspect what Iris attempted, which permission decisions were made, which model or tool
boundary failed, and whether an approved action completed, without storing prompts,
answers, document bodies, or other sensitive content in the ledger.

This is an observability and accountability layer. It is not a second business state
machine and must never become the authority for permissions, approvals, actions, or
knowledge publication.

## Architectural Fit

The architecture whitepaper requires:

- Feishu Gateway to acknowledge first and avoid agent work on the callback path;
- TypeScript Core to own product behavior, permissions, approvals, and actions;
- important claims and actions to remain traceable to fact-layer evidence;
- proactive and high-impact behavior to be explainable, auditable, and pausable;
- Feishu to remain a UI adapter rather than the owner of business state.

The ledger is therefore wired only into asynchronous Core runtime boundaries. No
ledger write is added to the Feishu callback acknowledgement path.

## Considered Approaches

### A. Typed optional observer at domain boundaries

Existing answer, permission, approval, execution, and proactive components receive an
optional observer. They emit bounded structured events while preserving their current
return values and state transitions.

Advantages:

- captures internal phases such as permission decisions and external execution;
- keeps each event close to the fact that produced it;
- remains testable without Postgres by injecting an in-memory observer;
- does not require a new distributed subsystem.

Trade-off:

- a small amount of explicit instrumentation is added to several components.

### B. Runtime decorators only

Wrap whole runtimes and record only start, completion, and failure.

Advantages:

- fewer changed files;
- easy to remove.

Trade-offs:

- cannot distinguish context assembly, permission denial, provider failure, approval,
  and external execution;
- produces an operator timeline that is too coarse to explain real failures.

### C. Generic internal event bus

Publish every runtime event to a new event bus and add the ledger as a subscriber.

Advantages:

- broad future extensibility;
- many consumers can subscribe.

Trade-offs:

- adds lifecycle, ordering, retry, and delivery semantics before Iris needs them;
- risks creating a second queue architecture inside the modular monolith;
- delays the internal MVP.

## Decision

Use approach A.

Introduce a small `AgentExecutionObserver` interface owned by `agent-runtime`. Business
components emit typed observations. A Postgres-backed implementation maps observations
to the append-only repository, while tests can use a recording observer.

The observer is optional. When absent, behavior is exactly the current behavior.

## Event Semantics

The first runtime slice records:

1. Answer turns:
   - `turn_started`;
   - `provider_request_started`;
   - `provider_request_completed` or `provider_request_failed`;
   - `turn_completed` or `turn_failed`.
2. Answer-time document permission decisions:
   - one `permission_allowed`, `permission_denied`, or `permission_error` event per
     unique document source considered for the turn.
3. Approval and action lifecycle:
   - `action_proposed`;
   - `action_approved` or `action_rejected`;
   - `action_execution_started`;
   - `action_execution_completed`, `action_execution_failed`, or
     `action_execution_reconciliation_required`.
4. Proactive delivery:
   - a tool-call lifecycle for the attempt to deliver one already-planned signal.

Each event includes stable identifiers already owned by the source state machine:
Feishu message ID for mention turns, proposal ID and version for approvals, execution
ID for publication, signal ID for proactive delivery, and document source ID for
permission decisions.

## Idempotency

`operation_key` identifies one semantic lifecycle event. Exact retries must return the
original row even if the caller generated a new row ID or observed the retry at a
different timestamp.

The operation fingerprint therefore covers semantic event fields but excludes:

- ledger row `id`;
- observation timestamp `at`.

Metadata is canonicalized recursively before hashing so object key order does not turn
an exact retry into a conflict. A changed event type, subject, outcome, reason, tool,
provider, content fingerprint, duration, or metadata remains a conflict.

## Failure Policy

The observer is best-effort and fail-open only for observability:

- repository errors are caught by the observer;
- the original answer, permission denial, approval transition, action execution, or
  proactive delivery keeps its existing result;
- permission checks themselves remain fail-closed;
- action and approval state machines remain authoritative;
- an optional bounded error callback exposes ledger degradation to runtime status or
  tests without leaking content.

This policy prevents an observability outage from changing customer-visible business
outcomes. Existing authoritative audit and action tables remain intact.

## Content And Privacy Boundary

The ledger may store:

- IDs, versions, phase, outcome, provider/model ID, duration, counts, and bounded reason
  codes;
- SHA-256 content fingerprints when correlation is required.

The ledger must not store:

- raw prompts or answers;
- message text;
- document or wiki body text;
- document titles;
- model response bodies;
- credentials, tokens, or authorization headers.

## Runtime Composition

Create one optional Agent Execution Ledger runtime in `app.ts`. It owns one Postgres
pool and exposes:

- the observer used by answer, action, and proactive runtimes;
- the repository used by the internal inspection API;
- `close()` for normal shutdown.

The feature is controlled by `IRIS_AGENT_EXECUTION_LEDGER_ENABLED`. It defaults to
disabled so a deployment without migration/configuration does not change behavior.
When enabled, the migration is mandatory and startup fails if the repository cannot be
created. Individual event-write failures after startup do not fail business work.

## Inspection API

Add an internal bearer-protected read-only endpoint:

`GET /internal/agent-executions`

Supported bounded filters:

- `groupId`;
- `subjectType` plus `subjectId`;
- `toolCallId`;
- `limit` from 1 to 100.

The response returns only the content-free ledger event shape. The endpoint is not
exposed through Caddy's public boundary.

## Testing

Tests must prove:

- exact semantic replay with a different row ID/timestamp is idempotent;
- metadata key order does not create a conflict;
- changed semantic intent still conflicts;
- answer success and provider failure produce the expected ordered events;
- permission allow/deny/error produces one event per document and remains fail-closed;
- observer storage failure does not alter business results;
- approval/execution/proactive events use existing stable IDs and do not duplicate;
- the inspection API enforces filter pairs, limits, and content-free responses;
- startup and shutdown close the optional runtime exactly once;
- all existing focused and Core tests remain green.

## Out Of Scope

- a generic event bus;
- a new TUI or separate web timeline UI;
- storing chain-of-thought, prompts, answers, or document content;
- changing approval risk rules;
- changing proactive-signal selection or rate limits;
- horizontal multi-replica delivery guarantees.

The internal API is sufficient for the first slice. A richer Admin Console timeline can
consume it in a later product-facing task.
