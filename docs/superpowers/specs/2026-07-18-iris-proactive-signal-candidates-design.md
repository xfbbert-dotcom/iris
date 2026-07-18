# Iris Proactive Signal Candidates Design

> Design date: 2026-07-18
> Constitutional basis: `2026-06-30-iris-architecture-whitepaper.md`
> Requirement baseline: IRIS-CORE-005 and IRIS-CORE-006 in `2026-07-14-iris-core-requirement-coverage-baseline.md`

## 1. Goal

Implement Phase 4A of the approved roadmap: Iris detects quiet unresolved discussions and open actions, ranks them, and persists explainable proactive candidates without sending any Feishu message.

This is the safety and quality gate before Phase 4B. It lets the team inspect candidate quality with real pilot data while keeping `proactiveSpeech` disabled and creating no external side effect.

## 2. Selected Approach

Use a deterministic TypeScript scanner over the authoritative `discussion_threads` and `action_items` fact layer.

Alternatives considered:

1. Ask the model to discover proactive signals directly from raw chat. This could find softer signals, but it consumes model quota, is harder to explain, and can bypass the semantic state already approved as authoritative.
2. Build knowledge drafting first. That is independently valuable but is Phase 5 in the approved roadmap and requires a larger approval and Feishu write path.
3. Build the Admin Console first. It improves operations but does not add the missing agent behavior.

The deterministic scanner is selected because it follows the roadmap, is testable without Gemini, and creates the smallest complete quality loop: fact state -> candidate -> explanation -> operator inspection -> dismissal/expiry.

## 3. Constitutional Boundaries

- Phase 4A never calls a model and never sends a Feishu message.
- Only `open`, retrieval-visible, current-group threads and actions are eligible.
- `candidate`, `resolved`, `merged`, `completed`, `cancelled`, or invalidated semantic entities are never eligible.
- Runtime policy is checked before scanning a group and immediately before persisting a candidate.
- Global disable, group disable, or `proactiveSpeech=false` stops candidate generation fail closed.
- An empty proactive group allowlist means no group is scanned.
- Candidate state is independent of model output and independent of future delivery state.
- Candidate evidence remains indirect but exact: every source entity is already bound to persisted current-group message evidence.
- No candidate can trigger an external write or action.

## 4. Candidate Model

`proactive_signal_candidates` stores:

- identity: `id`, `group_id`;
- source: `source_type` (`thread` or `action`), `source_id`, `source_version`;
- reason: `quiet_unresolved_thread`, `quiet_open_action`, or `overdue_action`;
- ranking: `score` in `[0,1]`, stable `policy_version`, structured `score_factors`;
- explanation: bounded operator-facing text generated from deterministic templates;
- lifecycle: `pending`, `dismissed`, or `expired`, with compare-and-swap `version`;
- timestamps: source activity, eligibility, observation, dismissal, expiry, creation, update;
- optional bounded dismissal reason and actor.

The unique idempotency key is `(group_id, source_type, source_id, source_version, reason, policy_version)`. Scanner retries therefore return the existing candidate instead of duplicating it.

At most one pending candidate may exist for the same `(group_id, source_type, source_id, reason)`. When the authoritative entity version changes, the previous pending candidate is expired before a replacement can be inserted. A dismissed candidate is not recreated for the same source version and policy version.

## 5. Eligibility And Precedence

Default pilot policy:

- minimum semantic confidence: `0.70`;
- quiet thread threshold: 24 hours;
- quiet action threshold: 24 hours;
- overdue action grace: 30 minutes;
- maximum candidates created per scan: 50;
- scanner interval: 5 minutes;
- policy version: `phase4a-v1`.

Action signals take precedence over their parent thread. A quiet open thread with at least one eligible open action produces action candidates only; this avoids telling the group twice that the same work is unresolved.

For an action, `overdue_action` takes precedence over `quiet_open_action`.

## 6. Deterministic Scoring

The evaluator receives a bounded source snapshot and the policy. It returns either no candidate or one candidate.

Score composition:

- base: `0.55` quiet thread, `0.60` quiet action, `0.75` overdue action;
- confidence contribution: up to `0.15`;
- age contribution: up to `0.15` after the relevant threshold;
- overdue severity contribution: up to `0.10` for overdue actions;
- final score is clamped to `0.99`.

`score_factors` records every component and relevant duration. The explanation is a bounded deterministic sentence such as: "Open action has been quiet for 31 hours and is 7 hours overdue; semantic confidence is 0.91."

No title, description, owner label, or message content is copied into the explanation. Internal list APIs may join source summaries only after exact group scoping.

## 7. Scanner And Persistence Flow

```text
timer/manual internal scan
-> read runtime snapshot
-> require global enabled + proactiveSpeech + non-disabled allowlisted group
-> load bounded eligible source snapshots from Postgres
-> deterministically evaluate and rank
-> re-check runtime gate for each candidate
-> transactionally expire superseded pending candidate and insert/idempotently observe replacement
-> persist scan-run counts and outcome
-> expose candidate and run state through authenticated internal APIs
```

The scanner does not need Redis: source facts already live in Postgres, scans are bounded and repeatable, and uniqueness plus transactions provide retry safety. A future multi-replica deployment can add a database advisory lease without changing the domain contract.

## 8. Runtime Configuration

New environment configuration:

- `IRIS_PROACTIVE_CANDIDATE_SCANNING_ENABLED=false` by default;
- `IRIS_PROACTIVE_CANDIDATE_GROUP_IDS=` empty by default;
- bounded positive integers for scan interval, batch limit, quiet thresholds, and overdue grace;
- bounded confidence in `[0,1]`;
- fixed application-owned policy version `phase4a-v1`.

Enabling scanning with an empty group allowlist fails closed by producing an enabled-but-idle status with an explicit reason. It does not scan every group.

## 9. Internal API And Operations

Authenticated internal endpoints:

- `GET /internal/proactive/candidates?groupId=...&status=...&limit=...`;
- `GET /internal/proactive/candidates/:id`;
- `POST /internal/proactive/candidates/:id/dismiss`;
- `POST /internal/proactive/scans` for one bounded operator-triggered scan;
- `GET /internal/proactive/status`.

The aggregate `/internal/status` includes runtime enabled/running state, allowlisted group count, candidate counts by status, latest scan, and degraded reason. Phase 4A contains no approve/send endpoint.

Dismissal is version checked and idempotent. An unknown, wrong-group, already-expired, or stale candidate fails closed with a non-success result.

## 10. Quality Gates And Exit Condition

Phase 4A code is complete when:

- pure evaluator tests cover every reason, precedence, threshold, and score bound;
- repository tests with real Postgres cover group isolation, idempotency, supersession, dismissal, and concurrency;
- runtime tests prove every global/group/capability/allowlist gate;
- app tests prove internal authentication and absence of any Feishu send path;
- migration, typecheck, Core tests, and root verification pass;
- a pilot runbook can inspect candidates while `proactiveSpeech=false` in production by leaving scanning disabled until the explicit Phase 4A gray window.

Real candidate-quality acceptance waits for PR #8 semantic state gray acceptance. That dependency does not block code completion and must not be simulated with production writes.

## 11. Explicitly Out Of Scope

- proactive Feishu delivery, feedback buttons, or send audit (Phase 4B);
- model-authored suggestions;
- knowledge drafts and knowledge-base publishing (Phase 5);
- cross-group notification;
- formal task creation or assignment;
- Admin Console UI;
- multi-tenant scheduling.
