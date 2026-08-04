# Iris Proactive Candidate Context Design

**Status:** Approved on 2026-08-04 after the user chose to continue with the
recommended behavior.

## 1. Purpose

The Admin Console currently presents pending proactive candidates using raw
entity identifiers. It also lets an operator approve a candidate after the
referenced thread or action has changed, closed, become hidden, or lost its
required parent state. The dispatcher eventually fails those deliveries closed,
but the operator sees an unclear work item and can queue work that cannot be
sent.

This slice makes the existing human approval loop understandable and prevents a
stale candidate from entering the delivery outbox. It does not expand proactive
speech, alter rollout scope, or change the architecture whitepaper.

## 2. Product Contract

### 2.1 Pending-candidate projection

Every candidate returned by the pending-candidate API includes:

- `approvalState`: `ready` or `stale`;
- `subjectLabel` only when the exact candidate target is currently valid.

For a discussion thread, the subject is its current title. For an action item,
the subject is its current description. Resolution is bound to the candidate's
group ID, entity ID, entity type, and entity version.

A candidate is `ready` only when the same authorization predicates used by the
delivery renderer hold:

- the exact entity version still exists in the same group;
- the entity is visible;
- the entity remains open;
- an action item's parent thread remains visible and is open or resolved.

All other pending candidates are `stale`. Stale rows remain visible so operators
can understand and dismiss accumulated work; they are not silently hidden.

### 2.2 Admin Console

The candidate table renders a human subject:

- `Discussion: <title>` for a ready thread;
- `Action: <description>` for a ready action;
- `Stale (the work item changed, closed, or is no longer visible)` otherwise.

The UI never displays the raw entity ID or candidate idempotency key. Labels are
inserted with `textContent`; no evidence or message body is returned or rendered.

Ready candidates retain both **Dismiss** and **Approve delivery** actions. Stale
candidates retain **Dismiss**, while **Approve delivery** is disabled and explains
why through accessible text/title metadata.

### 2.3 Atomic approval

UI state is advisory. The repository rechecks the exact current entity state in
the approval transaction. A stale candidate cannot be inserted into the delivery
outbox even when a client calls the API directly or the entity changes after the
list was loaded.

The repository approval result adds `stale`. The HTTP API maps it to:

```text
409 { "ok": false, "error": "proactive_signal_candidate_stale" }
```

Existing `queued`, `already_queued`, and `not_found` behavior remains unchanged.
Approval, runtime, suppression, and final-send gates continue to apply.

## 3. Data Flow

1. The repository selects pending, undelivered candidates.
2. A bounded left join resolves the exact current thread or action projection.
3. The repository returns a subject label and readiness classification.
4. The Admin Console presents the human label or stale state.
5. On approval, one transactional `INSERT ... SELECT` repeats the readiness
   predicates and inserts only a currently valid candidate.
6. If no insert occurs, the repository distinguishes an existing delivery,
   a stale candidate, and a missing candidate without weakening authorization.

No schema migration is required.

## 4. Alternatives Considered

### Hide stale candidates

Rejected because stale work would disappear without explanation and could
accumulate indefinitely.

### Label stale candidates but allow approval

Rejected because it preserves misleading operator behavior and needlessly queues
delivery work that the dispatcher must later cancel.

### Chosen: show, explain, and block atomically

This gives operators visibility, keeps dismissal available, and closes the
time-of-check/time-of-use gap at the repository boundary.

## 5. Safety and Scope

- No cross-group retrieval or permission-policy change.
- No automatic candidate approval or delivery.
- No raw evidence, message content, identity, or internal identifier exposure.
- No change to proactive rollout flags, allowlists, or production defaults.
- Existing dispatcher and final authorization remain defense-in-depth gates.

## 6. Acceptance Tests

- A current thread candidate returns its title and `ready`.
- A current action candidate returns its description and `ready` only when its
  parent dependency is valid.
- Changed, closed, hidden, missing, or version-mismatched targets return `stale`
  without a subject label.
- Atomic approval of a stale candidate returns `stale` and inserts no outbox row.
- The API returns the enriched projection and maps stale approval to HTTP 409.
- The Admin Console renders human subjects, hides raw identifiers, disables stale
  approval, and keeps stale dismissal available.
- Existing candidate, suppression, approval, and delivery tests remain green.

## 7. Rollout

The change is delivered through a draft pull request and exact-SHA CI. Deployment
uses the existing bounded pilot runbook. Runtime scope and proactive enablement
must remain unchanged, queues must drain to zero, and public internal endpoints
must remain unavailable.
