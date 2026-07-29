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

### Bound transient answer-model retries without multiplying the deadline

- **Failure:** Authorized retrieval, live Feishu permission checks, and prompt assembly all
  succeeded, but `gemini-3.5-flash` returned HTTP 503 high demand and the internal answer endpoint
  failed before producing the exact requested marker.
- **Root cause:** The selected answer model was temporarily capacity-constrained, while the
  OpenAI-compatible adapter had neither a transient retry nor a model-compatible exact-output
  prompt for the available Gemini 3.6 model.
- **Prevention rule:** Select the answer model through configuration, omit deprecated sampling
  controls, and retry at most once only for HTTP 408/500/502/503/504 or a fetch transport failure.
  Never retry quota or permanent client errors. Treat the configured timeout as one total budget
  across the initial request, backoff, and retry.
- **Guard:** Deterministic tests cover every retryable status, 429 and 401 non-retry behavior,
  malformed error bodies, final transport-error identity, remaining timer duration, timer cleanup
  before backoff, and exact-value prompt policy.
- **Exit condition:** Local and CI verification pass, the internal authorized-document request
  returns exactly the requested marker through `gemini-3.6-flash`, one bounded Feishu pilot answer
  passes, and production is restored to a verified fail-closed state after evidence is recorded.

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

### Require a postcondition for browser and OpenAPI writes

- **Failure:** Browser automation reported successful clicks on Feishu's visual `New` card, but no
  document, menu, navigation, or new tab appeared. The application-level document-create request
  was separately rejected with Feishu code `99991672`, and no document was created.
- **Root cause:** The visual card is a non-native interactive container whose automation result
  does not prove that Feishu accepted the action. The Iris application also does not currently
  hold a document-create scope, so the service API is not an equivalent fallback.
- **Prevention rule:** Treat every external write as incomplete until its domain postcondition is
  observed. Do not retry an unchanged permission denial. For an employee-submission acceptance,
  prefer a human-created, explicitly shared fixture instead of widening application permissions
  only to manufacture test data.
- **Guard:** Check for the new canonical document URL or API object before recording success,
  record only the bounded provider error code, and keep Iris fail-closed while awaiting the
  fixture.
- **Exit condition:** A genuinely new document exists, was not previously registered, and is
  explicitly shared with Iris before the bounded submission window opens.

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

### Preserve explicit intent across same-event document discovery

- **Failure:** A real `@Iris` document-submission command synced and indexed successfully, but the
  final source type was `group_visible_document` instead of `user_submitted_document`.
- **Root cause:** Mention handling registered the explicit user submission first. Generic link
  discovery then observed the same URI in the same Feishu message and applied the normal
  group-over-user source priority, treating a mechanical duplicate as independent evidence.
- **Prevention rule:** Attach group/message provenance to in-chat submissions. Keep user-submitted
  type and defaults only when every group observation is paired with an explicit submission from
  the exact same URI, group, and message. Any independent group observation resumes normal source
  precedence.
- **Guard:** Order-independent in-memory and real PostgreSQL tests, retry idempotency tests, a full
  Feishu event-chain regression, and pilot postconditions for source type, both evidence rows, and
  `canUseForKnowledgeDrafts=false`.
- **Exit condition:** One bounded real submission produces one canonical user-submitted source,
  exactly one user-submission and one same-message group evidence row, healthy sync/index state,
  and no pending or dead-letter work.

### Distinguish document commands from questions about documents

- **Failure:** A real question containing the noun phrase `用户提交文档` was treated as a new
  document-submission command and replied by asking for a link.
- **Root cause:** The Chinese intent pattern matched any occurrence of `提交文档`, without requiring
  an imperative cue or an explicit demonstrative such as `这个文档`.
- **Prevention rule:** Command routing must require command-shaped language. Ordinary questions
  that merely describe a user-submitted document stay on the answer path.
- **Guard:** A regression uses the exact failed sentence, while the existing explicit Chinese and
  English submission-command cases continue to bypass the answer model.
- **Exit condition:** The focused responder suite, full Core suite, typecheck, build, exact-SHA CI,
  and one real Feishu question all pass; the real answer is the target document marker.

### Verify automatic-close timers as runnable safety controls

- **Failure:** Invoking the automatic-close script directly depended on its executable bit, so a
  timer could be scheduled without a runnable command.
- **Root cause:** The deployment treated a checked-in shell script as an executable program rather
  than explicitly selecting its interpreter.
- **Prevention rule:** Schedule the script through `/bin/bash`, verify the timer is active before
  opening ingress, and independently restore fail-closed state immediately after the test.
- **Guard:** The bounded window records the transient unit, checks its active state, and verifies
  global, group, capability, Caddy, and queue state after manual cleanup.
- **Exit condition:** The timer command is runnable, cleanup succeeds before expiry, no timer
  remains, and every fail-closed invariant is rechecked.

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

### Separate retrieval authorization from answer generation failures

- **Failure:** A real user-submitted document synced and indexed correctly, but a later internal
  answer-draft request returned only the generic `answer_draft_failed` response.
- **Root cause:** The public error envelope intentionally hides whether context retrieval,
  permission checking, or the model provider failed, so the response alone cannot identify the
  failed boundary.
- **Prevention rule:** Validate the durable source, evidence, snapshot, fragment, and deployed live
  permission checker independently before classifying the failure. Do not retry the model merely
  to discover which earlier boundary passed.
- **Guard:** Content-free boundary diagnostics, a single live permission-check invocation, empty
  queue/DLQ checks, and an explicit residual entry for the unanswered provider/runtime failure.
- **Exit condition:** The document gate is accepted only for the boundaries proven by evidence;
  answer/citation remains open until a later bounded request succeeds and is independently
  observed.

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

### Do not confuse a Wiki page anchor with the whole knowledge space

- **Failure:** Iris reported that an authorized Feishu knowledge space was available, but only the
  page whose URL was registered and its two descendants were indexed. Sibling top-level trees,
  including the material needed for a real question, were invisible.
- **Root cause:** The registered page token was used both to resolve the authoritative `space_id`
  and as the traversal boundary. A Feishu knowledge-space overview can show several sibling
  top-level trees, so one visible page is not necessarily the space root.
- **Prevention rule:** Treat a submitted Wiki page only as an authorization anchor. Resolve its
  `space_id`, enumerate every top-level node, then traverse all same-space trees. If the anchor is
  readable but whole-space enumeration is denied or empty, fail closed instead of reporting a
  successful partial scan.
- **Guard:** Client request-shape coverage for parentless top-level listing, scanner regressions
  with an anchor plus sibling tree, safe classification for Feishu error `131006`, and an empty
  top-level result regression.
- **Exit condition:** A real scan registers all supported pages visible in the authorized space,
  includes siblings of the anchor, remains idempotent on rescan, and returns every document/reindex
  queue and DLQ to zero.

### Do not treat Feishu-native recommendations as Iris retrieval evidence

- **Failure:** A `相关知识` link rendered below an Iris reply was interpreted as proof that Iris had
  retrieved the linked Feishu knowledge page.
- **Root cause:** Feishu's chat client can add its own knowledge recommendation independently of
  Iris. The decoration is visually adjacent to the bot reply but is not part of Iris's answer,
  source trace, or citation pipeline.
- **Prevention rule:** Validate Iris retrieval from durable source, snapshot, fragment, live
  permission-guard, and bounded unique-marker evidence. Never use Feishu-native recommendations,
  previews, or search decorations as Iris acceptance evidence.
- **Guard:** The wiki-space runbook labels client-native UI separately and states that the current
  release has neither durable per-answer source traces nor Iris-owned citation rendering.
- **Exit condition:** A bounded unique-marker test can prove the retrieval loop while durable
  source-level trace and citation acceptance remain explicitly open. Client-native `相关知识` is
  ignored.

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
