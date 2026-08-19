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

## Formal Review Fix Round 1

### Commit

- `6cb4066b` — `fix(core): close conflict delivery race boundaries`
- This report update is committed separately after the fix verification.

### Resolved Findings

- The dispatcher now repeats all delivery gates and live bot membership after current validation, then
  performs one final synchronous gate read immediately before the durable external-attempt boundary.
- `beginDeliveryAttempt` now binds the exact candidate ID, `approved_for_delivery` status, approved
  version, delivery ID, worker lease, and durable attempt count in one candidate-before-delivery locked
  transaction. The Feishu transport call follows that awaited transaction without another await.
- Candidate dismissal and governance transitions away from approval are rejected while delivery is
  `external_attempting` or `outcome_unknown`; outcome-unknown reconciliation can therefore still move
  the bound candidate and delivery to their terminal sent state.
- Every non-current validator result now settles the claimed delivery. In particular, a superseded
  result caused by a disappeared source permanently fails the delivery unless another transaction has
  already placed it in a compatible terminal or quarantined state.
- The dispatcher loop observer receives only a stable `worker_failed` error object, never the raw
  worker exception, and its snapshots remain content-free.
- Visible and callback text now rejects or replaces both C0 and C1 controls. Source URIs containing
  raw controls/whitespace, malformed percent escapes, or percent-encoded controls are suppressed
  before URL construction rather than canonicalized into a link.
- The polling loop uses explicit lifecycle state plus a generation token. `start()` during an in-flight
  `stop()` is consistently ignored, and the previous generation cannot schedule another timer.
- No schema change or migration was required; the fix strengthens existing repository transactions.

### TDD Evidence

RED regressions were added first. The initial focused run reported 15 failures covering gate disablement
during validation, dismissal before and after begin, exact candidate/version/attempt binding, missing-
source settlement, observer secret leakage, C1/URI handling, and stop/start timer overlap.

Final focused review command:

```text
npm --workspace apps/core exec vitest run -- tests/knowledge-conflict-dispatcher.test.ts tests/knowledge-conflict-dispatcher-loop.test.ts tests/knowledge-conflict-card-renderer.test.ts tests/postgres-knowledge-conflict-repository.test.ts
```

Result: exit 0; 4 files passed; 85 tests passed and 13 conditional PostgreSQL tests skipped.

Relevant conflict/repository/Feishu/card command:

```text
npm --workspace apps/core exec vitest run -- tests/knowledge-conflict.test.ts tests/postgres-knowledge-conflict-repository.test.ts tests/knowledge-conflict-current-validator.test.ts tests/knowledge-conflict-card-renderer.test.ts tests/knowledge-conflict-dispatcher.test.ts tests/knowledge-conflict-dispatcher-loop.test.ts tests/feishu-interactive-card-client.test.ts tests/knowledge-card-dispatcher.test.ts tests/knowledge-card-dispatcher-loop.test.ts
```

Result: exit 0; 9 files passed; 166 tests passed and 13 conditional PostgreSQL tests skipped.

Full Core command:

```text
npm --workspace apps/core test
```

Result: exit 0; 181 files passed and 3 files skipped; 3,171 tests passed and 249 tests skipped.

Typecheck, build, and diff validation:

```text
npm --workspace apps/core run typecheck
npm --workspace apps/core run build
git diff --check
git diff --cached --check
```

Result: all exited 0. The only diagnostics were the repository's Windows line-ending conversion
warnings. A typecheck-only test-fixture narrowing found after the full run was corrected and followed
by a passing focused dispatcher run, typecheck, and build.

### Remaining Concern

- The new real-PostgreSQL begin-versus-dismiss serialization regression is present but was skipped
  with the other conditional repository cases because `IRIS_TEST_DATABASE_URL` is not configured in
  this environment. The deterministic repository transaction tests and all non-database race tests
  passed; CI should run the conditional case against an isolated PostgreSQL database.

## Formal Review Fix Round 2

### Commit

- `a283f683` — `fix(core): enforce exact conflict card boundaries`
- This report update is committed separately after the fix verification.

### Resolved Findings

- Callback identifiers are now validated without trimming or normalization repair. C0/C1 controls,
  leading or trailing Unicode whitespace, and any NFC-changing value are rejected, so candidate ID,
  group ID, nonce, and delivery-derived nonce inputs retain exact binding or fail closed.
- Visible card text retains its bounded replacement/normalization behavior; only callback identity
  fields use the exact-value rule.
- Source links now require literal lowercase `https://` followed by a non-empty authority before URL
  parsing. The renderer rejects backslashes, raw C0/C1 or Unicode whitespace, malformed percent
  escapes, and percent-encoded data that decodes to controls or Unicode whitespace.
- WHATWG-repairable forms such as `https:example.com`, `https:/example.com`, backslash separators,
  uppercase schemes, and boundary whitespace are suppressed instead of emitted as live links.
- Credential-bearing sources remain suppressed, while valid credential-free HTTPS paths, queries,
  and ordinary percent-encoded data remain linkable. No callback or later-task behavior was changed.

### TDD Evidence

The new exact-binding and URI cases were written before the renderer change. The RED focused run exited
1 with 16 expected failures: ten exact identifier/nonce mutations were silently accepted and six
malformed or encoded-whitespace URI forms were canonicalized into links.

Focused renderer command:

```text
npm --workspace apps/core exec vitest run -- tests/knowledge-conflict-card-renderer.test.ts
```

Final result: exit 0; 1 file passed; 37 tests passed.

Relevant conflict/repository/Feishu/card command:

```text
npm --workspace apps/core exec vitest run -- tests/knowledge-conflict.test.ts tests/postgres-knowledge-conflict-repository.test.ts tests/knowledge-conflict-current-validator.test.ts tests/knowledge-conflict-card-renderer.test.ts tests/knowledge-conflict-dispatcher.test.ts tests/knowledge-conflict-dispatcher-loop.test.ts tests/feishu-interactive-card-client.test.ts tests/knowledge-card-dispatcher.test.ts tests/knowledge-card-dispatcher-loop.test.ts
```

Result: exit 0; 9 files passed; 189 tests passed and 13 conditional PostgreSQL tests skipped.

Full Core command:

```text
npm --workspace apps/core test
```

Result: exit 0; 181 files passed and 3 files skipped; 3,194 tests passed and 249 tests skipped.

Typecheck, build, and diff validation:

```text
npm --workspace apps/core run typecheck
npm --workspace apps/core run build
git diff --check
git diff --cached --check
```

Result: all exited 0. Git emitted only the repository's Windows line-ending conversion warnings.

### Scope Review

- The production change is confined to the Task 7 conflict-card renderer; the only other code artifact
  is its focused test suite. No Task 8 behavior, migration, plan, spec, ledger, or brief was changed.
- The existing PostgreSQL-test environment concern from Fix Round 1 remains unchanged.

## Formal Review Fix Round 3

### Commit

- `2271e476` — `fix(core): reject byte-order-mark conflict links`
- This report update is committed separately after the fix verification.

### Resolved Finding

- Source-URI validation now applies both ECMAScript whitespace (`\s`) and Unicode
  `White_Space` checks to the raw normalized URI and its percent-decoded form. Raw U+FEFF and
  percent-encoded `%EF%BB%BF` are therefore suppressed instead of becoming live card links.
- Targeted boundary coverage now verifies callback-identifier rejection at C0 lower/upper, DEL, and
  C1 lower/upper endpoints. The URI table verifies the same raw endpoints plus their percent-encoded
  forms, in addition to the two U+FEFF regressions.
- The endpoint cases were already rejected by the existing explicit C0/C1 ranges; only U+FEFF needed
  a production change. No Task 8 behavior or unrelated code was changed.

### TDD Evidence

The raw and encoded U+FEFF regressions and boundary matrix were added before the renderer change. The
RED focused run exited 1 with exactly 2 failures for the U+FEFF cases; 52 other tests passed, including
all newly added C0/C1 endpoint cases.

Focused renderer command:

```text
npm --workspace apps/core exec vitest run -- tests/knowledge-conflict-card-renderer.test.ts
```

Final result: exit 0; 1 file passed; 54 tests passed.

Relevant Task 7 command:

```text
npm --workspace apps/core exec vitest run -- tests/knowledge-conflict.test.ts tests/postgres-knowledge-conflict-repository.test.ts tests/knowledge-conflict-current-validator.test.ts tests/knowledge-conflict-card-renderer.test.ts tests/knowledge-conflict-dispatcher.test.ts tests/knowledge-conflict-dispatcher-loop.test.ts tests/feishu-interactive-card-client.test.ts tests/knowledge-card-dispatcher.test.ts tests/knowledge-card-dispatcher-loop.test.ts
```

Result: exit 0; 9 files passed; 206 tests passed and 13 conditional PostgreSQL tests skipped.

Full Core command:

```text
npm --workspace apps/core test
```

Result: exit 0; 181 files passed and 3 files skipped; 3,211 tests passed and 249 tests skipped.

Typecheck, build, and diff validation:

```text
npm --workspace apps/core run typecheck
npm --workspace apps/core run build
git diff --check
git diff --cached --check
```

Result: all exited 0. Git emitted only the repository's Windows line-ending conversion warnings.

### Remaining Concern

- No new concern was introduced. The conditional real-PostgreSQL concurrency case remains skipped in
  this environment because `IRIS_TEST_DATABASE_URL` is not configured, as recorded in Fix Round 1.
