# Task 7 Report: Version-Bound Knowledge Conflict Card Delivery

## Status

DONE_WITH_CONCERNS

Task 7 is implemented and its automated gates pass. The remaining concern is environmental: the
conditional PostgreSQL repository cases were skipped because `IRIS_TEST_DATABASE_URL` was not
configured. No live Feishu pilot was attempted or claimed in this task.

## Commit

- `57ac5827` — `feat(core): deliver knowledge conflict cards`
- This report is committed separately after the implementation verification.

## Delivered Behavior

- Renders one deterministic Feishu JSON 2.0 card for an exact
  `approved_for_delivery` candidate version and exact current target-source identity.
- Shows the uncertainty/no-winner warning, current synchronized knowledge, newer group conclusion,
  material difference, proposed update, target/version label, and bounded evidence labels.
- Binds both callbacks to candidate ID, delivered candidate version (`approved version + 1`), group
  ID, action, and a deterministic delivery nonce. It includes no actor identity or hidden evidence
  bodies in the callback value.
- Treats card text as untrusted: normalizes and truncates visible fields, escapes Feishu Markdown,
  strips control characters from visible text, rejects control characters in callback identifiers,
  and emits a link only for bounded credential-free HTTPS source URIs.
- Enforces a 24 KiB card JSON limit and a 12-component limit. Maximal multibyte input remains below
  both boundaries.
- Claims only repository-approved outbox work. It verifies exact claim/candidate/source binding,
  checks all five delivery gates and current bot membership, then repeats both just before the final
  current-state validation.
- Uses the Task 6 current validator for the final live source-permission reattestation and exact
  repository evidence validation. `beginDeliveryAttempt` is the last awaited state transition before
  the external Feishu send.
- Uses stable per-delivery Feishu UUIDs and callback nonces, so a proven request-not-sent retry keeps
  the same delivery identity and cannot create a new logical card.
- Completes the repository's atomic `external_attempting -> sent` transition after Feishu returns a
  message ID. The candidate is therefore advanced to the callback-bound delivered version only by
  the existing Task 2 transaction.
- Classifies request-not-sent and retryable remote failures as bounded retries, remote rejection and
  disabled/stale policy as permanent failures, and timeouts, untyped post-boundary failures, or a
  failed sent completion as `outcome_unknown`.
- Supplies a reconciliation due time for every outcome-unknown result. Those rows remain excluded
  from normal claims by the Task 2 repository and are never blindly resent.
- Computes capped deterministic exponential backoff from durable attempt count and converts every
  retryable preparation/send result to a permanent `max_attempts_exhausted` result at attempt five.
- Adds a serialized polling loop with idempotent start/stop, no overlapping batches, cloned snapshots,
  observer isolation, and content-free counters/error categories only.

## TDD Evidence

### RED

- The initial Task 7 focused run failed all three suites because the renderer, dispatcher, and loop
  modules did not exist.
- A preparation-retry regression failed with `retrying/validation_unavailable` at attempt five until
  retry exhaustion was centralized across both preparation and external failures.
- Candidate-ID and callback-nonce control-character regressions failed because the renderer initially
  accepted both values; the identifier boundary now rejects them.

### GREEN

Focused Task 7 command:

```text
npm --workspace apps/core exec vitest run -- tests/knowledge-conflict-card-renderer.test.ts tests/knowledge-conflict-dispatcher.test.ts tests/knowledge-conflict-dispatcher-loop.test.ts
```

Result: exit 0; 3 files passed; 34 tests passed.

Relevant conflict/repository/Feishu/card command:

```text
npm --workspace apps/core exec vitest run -- tests/knowledge-conflict.test.ts tests/postgres-knowledge-conflict-repository.test.ts tests/knowledge-conflict-current-validator.test.ts tests/knowledge-conflict-card-renderer.test.ts tests/knowledge-conflict-dispatcher.test.ts tests/knowledge-conflict-dispatcher-loop.test.ts tests/feishu-interactive-card-client.test.ts tests/knowledge-card-dispatcher.test.ts tests/knowledge-card-dispatcher-loop.test.ts
```

Result: exit 0; 9 files passed; 152 tests passed and 12 conditional PostgreSQL tests skipped.

Full Core command:

```text
npm --workspace apps/core test
```

Result: exit 0; 181 files passed and 3 files skipped; 3,157 tests passed and 248 tests skipped.

Typecheck and build:

```text
npm --workspace apps/core run typecheck
npm --workspace apps/core run build
```

Result: both exit 0 (`tsc --noEmit`; `tsc --project tsconfig.build.json`).

Diff validation:

- `git diff --check`: exit 0 before staging.
- `git diff --cached --check`: exit 0 before the implementation commit.
- Git emitted only the repository's Windows line-ending conversion warnings.

## Scope Review

- No Task 8 callback parser, gateway, interaction worker, or draft creation was added.
- No Task 9 answer-provider behavior or Task 10 runtime composition was added.
- The plan, design, progress ledger, Task 7 brief, and applied migrations were not modified.
- The implementation reuses the existing Feishu interactive-card client and Task 2 delivery/current
  validation state machine rather than adding a second transport or outbox.

## Concerns And Follow-Up

- Run the conditional repository suite against an isolated PostgreSQL database in CI or an
  environment with `IRIS_TEST_DATABASE_URL` configured.
- End-to-end Feishu card delivery, timeout reconciliation, and the ten-step live pilot remain later
  integration/acceptance work; this report does not treat them as completed.
