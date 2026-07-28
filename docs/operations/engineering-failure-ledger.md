# Iris Engineering Failure Ledger

This ledger records failures that changed how Iris should be designed, tested, or released. It is
not an incident timeline. Add an entry only when it produces a reusable prevention rule or an
automated guard.

The architecture whitepaper remains authoritative. This ledger explains how to avoid repeating
delivery mistakes while implementing it.

## Product Delivery

### Do not confuse hardening with product completion

- **Failure:** Work continued through increasingly narrow robustness checks while whitepaper core
  capabilities were still missing, making a partially implemented product look nearly complete.
- **Root cause:** Quality gates had no explicit exit condition and there was no coverage baseline
  mapping shipped behavior to the whitepaper.
- **Prevention rule:** Fix P0/P1 blockers, then move to the next missing core capability. Put P2/P3
  hardening in the backlog.
- **Guard:** Keep the core-requirement coverage baseline current and require each feature plan to
  name its acceptance gate and next product capability.
- **Exit condition:** The agreed tests and one bounded real pilot workflow pass with no unresolved
  P0/P1 finding.

## External Providers

### Treat model capacity and latency as runtime state, not a code hypothesis

- **Failure:** Gemini checks returned rate limits, provider timeouts, and invalid responses across
  different windows. Repeated probes could consume quota without creating new evidence.
- **Root cause:** Provider availability was initially mixed with application correctness.
- **Prevention rule:** Perform at most one bounded probe in an approved window. Classify the real
  upstream status without storing response bodies, then stop on any non-success.
- **Guard:** Shared cooldowns, bounded timeouts, redacted provider status logs, and fake-provider
  tests for 429/5xx/timeout behavior.
- **Exit condition:** A single probe succeeds; application acceptance then runs separately and does
  not infer correctness from provider availability alone.

### Make timeout tests deterministic

- **Failure:** A streaming timeout test intermittently observed zero or one chunks on Windows even
  though production's wall-clock timeout wrapped the complete request.
- **Root cause:** The test expected scheduler-dependent progress inside an unrealistically small
  total time budget.
- **Prevention rule:** A timeout fixture must synchronously yield one known chunk and then wait
  forever; the assertion should prove the deadline interrupts the active stream.
- **Guard:** Repeat the focused timeout test enough times to expose scheduling flakes before the
  full suite.
- **Exit condition:** The focused test is repeatable and the full AI suite passes without relaxing
  the production deadline.

## Feishu Boundaries

### Acknowledge callbacks before doing expensive work

- **Failure:** Any filtering, model work, or slow dependency on the callback path risks crossing
  Feishu's retry deadline and creating duplicate events.
- **Root cause:** Ingress acknowledgement and asynchronous processing were not treated as separate
  reliability boundaries.
- **Prevention rule:** Authenticate, validate a bounded envelope, enqueue idempotently, and return
  HTTP 200. Perform signal extraction and external work in workers.
- **Guard:** Queue idempotency keys include the Feishu event/message identity, and callback tests
  cover retries.
- **Exit condition:** Duplicate delivery produces one durable job and no duplicate user-visible
  effect.

### Bind card actions to the exact sent delivery

- **Failure:** A stale or replayed card action could otherwise mutate a newer candidate or reveal
  whether an unrelated user is a group member.
- **Root cause:** Actor membership alone does not prove that the action belongs to the displayed
  delivery and entity version.
- **Prevention rule:** After the runtime and bot checks, validate delivery, candidate, group,
  message, and entity version before any membership network call or mutation.
- **Guard:** Repository binding checks, double runtime gates, current-membership checks, and
  idempotent feedback events.
- **Exit condition:** Stale bindings fail closed without membership I/O or state mutation.

### Expect transient and stale approval cards

- **Failure:** Feishu card operations returned transient or stale-card errors such as `200080` and
  `200341`; retrying an old card was not equivalent to acting on the current proposal.
- **Root cause:** Interactive cards are versioned external state and can outlive their current
  server-side review session.
- **Prevention rule:** Reissue a fresh card after stale-state failures, preserve idempotency, and
  revalidate proposal/session context on every action.
- **Guard:** Exact proposal-version binding, replay-safe callbacks, bounded retries, and
  user-visible replacement cards.
- **Exit condition:** Only the current card can change the current proposal, and repeated actions
  do not duplicate the effect.

### Diagnose card interaction errors from server evidence

- **Failure:** A real proactive-feedback click showed Feishu client code `200080` and created no
  feedback event.
- **Root cause:** The operator clicked after the bounded gray window had expired. The fail-closed
  timer had already stopped Caddy and disabled Iris, so the callback could not reach Core. The
  client code alone did not distinguish that transport closure from a stale card or application
  rejection.
- **Prevention rule:** Before changing callback code or reissuing a card, correlate the click with
  the gray-window deadline, Caddy state, callback diagnostics, queue state, and durable event
  count. Reopen a new bounded window only after proving the previous window closed cleanly.
- **Guard:** Every real card acceptance records its open and automatic-close deadlines, keeps the
  planner disabled, and verifies the public boundary plus empty queues before asking for the
  human click.
- **Exit condition:** The exact callback is durably recorded, its queue and DLQ drain to zero, and
  the same bounded cleanup restores global, group, capability, environment, and ingress state.

### Recheck mutable safety state immediately before an external side effect

- **Failure:** An active suppression could be created after a proactive delivery was claimed but
  before its Feishu card was sent, allowing one reminder the group had just marked irrelevant.
- **Root cause:** Suppression was checked during candidate creation and queue claim, but those
  checks did not authorize a later network side effect.
- **Prevention rule:** Make the final database authorization the last database operation before
  external send. Follow it only with one synchronous runtime gate, then invoke the external
  client immediately. The authorization must atomically cancel the claimed delivery when
  suppression now applies.
- **Guard:** Three-state authorization (`authorized`, `suppressed`, `stale`), a real PostgreSQL
  claim-to-feedback race regression required by CI, and dispatcher tests proving suppression or
  a runtime disable during authorization never calls Feishu.
- **Exit condition:** Feedback committed before final authorization changes the delivery to
  `cancelled`, clears its lease, and makes every later authorization stale.

### Serialize leases and suppression at the final delivery boundary

- **Failure:** A worker with an expired lease could still authorize a reminder, while a concurrent
  irrelevant-feedback transaction and candidate insert could both commit without observing the
  other's suppression state.
- **Root cause:** Final authorization checked worker ownership but not lease expiry under a row
  lock, and suppression writes shared no transaction lock with candidate registration.
- **Prevention rule:** Revalidate ownership and unexpired lease while locking the claimed delivery.
  Serialize suppression and candidate insertion with sorted, group-scoped transaction advisory
  locks.
- **Guard:** Real PostgreSQL tests force lease expiry and interleave the two transactions; SQL
  contract tests require the lease predicate and delivery row lock.
- **Exit condition:** Expired workers receive `stale`, suppression committed first prevents a
  pending candidate, and all focused tests pass against PostgreSQL.

## Data And Memory

### Recheck permissions at answer time

- **Failure:** A document may remain indexed after access is revoked indirectly through a parent
  folder or group membership change.
- **Root cause:** Webhook and local fact-layer state can lag behind Feishu's effective permission.
- **Prevention rule:** Revalidate every retrieved document with the live permission guard before
  fragments reach the model. Denial is a normal security outcome, not a retriable model error.
- **Guard:** Source-policy retrieval, content-free permission audit records, and revoked-access
  regression tests.
- **Exit condition:** Revoked content is absent from the prompt and cannot be reconstructed from a
  different source.

### Isolate semantic replay evidence

- **Failure:** Reusing partially processed markers or replaying several semantic events together
  polluted inspection and could make later operations reference entities that were never created.
- **Root cause:** Append-only history and batch extraction made acceptance state ambiguous.
- **Prevention rule:** Use a fresh isolated group/marker and replay one event at a time in original
  order, waiting for each queue state to settle before the next.
- **Guard:** Inspector checks for lifecycle, owner, evidence, version, uniqueness, control-group
  isolation, and empty queues/DLQs.
- **Exit condition:** The complete lifecycle is reproduced once with no duplicates or unrelated
  data.

## Test Architecture

### Keep test doubles aligned with fail-closed interfaces

- **Failure:** A runtime assembly test returned `repository_unavailable` after the feedback worker
  added an exact-binding repository method, while the test double still implemented only the write.
- **Root cause:** An unsafe cast allowed the mock to drift from the production dependency contract.
- **Prevention rule:** Shared test factories and mocks must implement every method in the narrowed
  `Pick` interface; assembly tests should assert security-sensitive call arguments.
- **Guard:** Full repository typecheck, runtime assembly tests, and the root `npm run verify` gate.
- **Exit condition:** Focused assembly tests and the complete verification pipeline pass on the
  same working tree.
