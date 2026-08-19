# Task 11 Report: Boundary Defaults And Acceptance Gate

## Result

- Implementation commit: `e219fd70b4bd3da302dcca4fb449a232286dc541`
- Scope: committed default-off deployment wiring, effective-env smoke rejection, private Caddy
  boundary, executable 12-step one-group acceptance/rollback runbook, metadata-only PR evidence
  template, and README pending-live-acceptance statement.
- Live pilot: not run and not claimed.

## TDD RED

- Focused smoke command:
  `node --test --test-name-pattern "knowledge-conflict|default-off knowledge-card|public callback" scripts/pilot-smoke-lib.test.mjs`
- Result before implementation: 4 tests, 0 pass, 4 fail.
- Expected failures proved the smoke output lacked conflict default/readiness facts, the public
  conflict route was not probed, and effective enabled/nonempty allowlist inputs were not rejected.
- `npm run pilot:config` exited `0` before implementation, but its Core environment omitted both
  required knowledge-conflict variables. The failing Compose contract test covered that missing
  deployment behavior; no Docker failure was fabricated.

## GREEN Verification

- Focused runbook/rollback/PR contracts: 3/3 pass.
- Extracted PowerShell controller syntax: parse pass, one executable block.
- Focused smoke contracts: 4/4 pass.
- Focused Compose defaults/boundary contracts: 2/2 pass.
- `npm run test:pilot`: 149 tests, 148 pass, 1 skip, 0 fail. The existing executable Caddy
  container probe skipped because the Docker daemon is unavailable; static Caddy and mocked public
  boundary contracts passed.
- `npm run readiness -- --env-file deploy/pilot/ci.env`: 17/17 pass; knowledge conflicts reported
  `Knowledge conflicts are safely disabled.`
- `npm --workspace apps/core test -- runtime-config.test.ts internal-rollout-readiness.test.ts`:
  45/45 pass.
- `npm run pilot:config`: exit `0`.
- Parsed Compose Core environment: `IRIS_KNOWLEDGE_CONFLICT_ENABLED=false`, allowlist length `0`.
- `git diff --check`: exit `0` before commit.

## Artifact SHA-256

- Runbook: `12a39679fbc52bd4f40c6796d47aefd8a758ebc92919e7b1a0617b96f85628a3`
- PR evidence template: `bd900c17e4522ec616daacb4e6336edaa61823fa075a7002ef0931bbd21344d9`
- Pilot CI env: `b66e15e2fd6e4f32d6261968ddb94ad39d3fea7c84688a02a9daabf9e896404f`
- Pilot Compose: `39aa3066c35fe940fed9e15d2d074051cf71bb5fea051f007b4eeb883d10500c`
- Pilot smoke controller: `a5e24544f87a6b13f18e43ad83045972ebb7b13c0d0f76fb2c5ece5a2d7117b9`

## Residual Verification Risk

- No live PostgreSQL, Redis, Feishu, model, or Wiki acceptance was executed.
- The Docker daemon was unavailable, so the pinned Caddy image runtime probe remains unexecuted in
  this environment. Public-route behavior is covered by static and smoke contracts only.
- Task 12 must run the exact-SHA one-pilot/nonpilot-control procedure with approved private
  credentials and record only the metadata allowed by the runbook. Until that succeeds, the loop
  remains pending live acceptance and creates only a governed update draft, never an in-place Wiki
  edit.

## Fix Round 1: P1 False-Positive Closure

### Result

- Implementation/tests/docs commit: `76f62728239b6e7050b0390e0392aa1855dc7a18`.
- Step 6 now validates exact evidence-row cardinality with bidirectional `EXCEPT ALL` over the
  actual `knowledge_conflict_evidence` columns. Recorded message, memory/timestamp,
  source/timestamp/version, snapshot/hash, and fragment/hash identities are exact; duplicate,
  missing, and unrelated rows fail.
- Step 8 now binds one sent delivery to the exact candidate/message and a metadata-only card hash.
  Both sides, evidence counts, material difference, proposed update, uncertainty label, a readable
  safe current link, and zero unsafe/denied links are mandatory.
- Step 9 now models all six permission/snapshot × pre-answer/pre-delivery/pre-callback cases.
  Permission denial correctly leaves the candidate version unchanged; snapshot replacement must
  produce the exact `snapshot_stale` superseding event. Every case requires an exact rejected
  operation/result code and zero answer disclosure, post-boundary delivery/send, applied
  interaction, and draft mutation. Pre-callback cases also bind one exact callback identity and
  one rejected callback result.
- Step 10 now fails closed on unresolved answer deliveries, draft presentations/outboxes, action
  proposals/requirements/presentations/outboxes/executions, reconciliation-required,
  outcome-unknown, and failed execution states using existing migration names and status values.
- Rollback now re-attests the exact current/historical group inventory, PostgreSQL-backed desired
  and live global policy, all inventoried groups disabled, document-read/retrieval/draft/proactive/
  write capabilities false, conflict/card/approval flags false, and all allowlists empty after Core
  recreation. Per-table state digests detect same-count claims/transitions; expanded append-only
  fact counts must not decrease.
- Live pilot: not run and not claimed. Task 12 remains the owner of live acceptance.

### TDD RED

- Command:
  `node --test --test-name-pattern "knowledge-conflict" scripts/pilot-operations.test.mjs`
- Initial result: 8 tests, 3 pass, 5 fail.
- Expected failures were the five missing executable gates:
  `Assert-ExactEvidenceBindingFacts`, `Assert-ApprovedCardProof`, `Assert-RevocationFacts`,
  `Assert-DrainedDurableStates`, and rollback attestation/fingerprint checks.
- A later executable exact-row fixture exposed malformed PowerShell SQL-row composition and failed
  1/1 before the expression was corrected; the same fixture then passed and continued to reject
  duplicate and unrelated rows.

### GREEN Verification

- Focused knowledge-conflict contracts: 8/8 pass, including executable PowerShell invalid fixtures
  for all five reviewer paths.
- Full pilot operations contracts: 39/39 pass.
- Fresh final `npm run test:pilot`: 154 tests, 153 pass, 1 skip, 0 fail. The sole skip accurately
  reports that the Docker daemon is unavailable for the pinned Caddy runtime boundary probe; no
  container probe result is claimed.
- `npm run readiness -- --env-file deploy/pilot/ci.env`: 17/17 pass, including safely disabled
  conflict/card/approval checks.
- `npm run pilot:config`: exit `0`; rendered Core environment retains conflict/card/approval flags
  false and all corresponding allowlists empty.
- Extracted PowerShell controller parse: pass, 6,221 tokens.
- `git diff --check`: exit `0` before the implementation commit (line-ending notices only).

### Fix-Round Artifact SHA-256

- Runbook: `79c007e167a05dc1720e7feee312b3f6d55aa36a9df8241d67f849212b724ca2`
- PR evidence template: `d79484594899d308cd90e60b2f9c6ad5abab4a53e64d68b72ae0e49c3e8bfee0`
- Pilot operations contracts: `ed9cf8df5754a97a918fb33b3b28e8f27a06d1e1ae952426f0cad7e7a4daea02`

### Residual Risk

- SQL text is contract-checked against repository migrations and PowerShell fixtures, but no live
  PostgreSQL query, Redis worker, Feishu callback/card, model call, Wiki read, or pilot mutation was
  executed in this fix round.
- Docker remained unavailable for the single executable pinned-Caddy boundary test. Static Caddy,
  Compose, smoke, default-off, and mocked public-boundary contracts passed.
- The loop remains pending live acceptance and produces a governed update draft, not an in-place
  Wiki edit.

## Fix Round 2: Chronology, Publication, Status, And Baseline Closure

### Result

- Implementation/tests/docs commit: `1190592621a09fe7a21d900a928a19c682b5b9a6`.
- Step 4 now validates the complete exact `pilotMessageIds` set. Every ID must resolve exactly once,
  belong to the pilot group, and have `created_at` strictly later than both the exact synchronized
  source `updated_at` and snapshot `fetched_at`. Duplicate, missing, nonpilot, pre-snapshot, and
  equal-timestamp rows fail. The metadata-only source/snapshot/message binding is pinned through
  Step 6 so the evidence file cannot substitute a different message set after chronology passes.
- The final durable drain now treats active action-approval presentations as unresolved even when
  their requirements are already satisfied. It also requires exact immutable publication bindings
  for every pilot-path published draft and succeeded proposal/execution. Deliberately
  pre-publication drafts remain valid without a publication fact; missing or mismatched facts fail.
- Disabled Core status now always emits a content-free top-level `knowledgeCards` surface with
  readable zero active counts. Baseline and rollback gates require that surface, zero enabled groups,
  zero queue/presentation/outbox safety counts, and safely disabled conflict and action-approval
  components; missing properties fail closed.
- Step 3 now attests all conflict/card/action-approval flags as false, all three allowlists as empty,
  exact PostgreSQL-backed desired/live global and group policy, disabled capabilities, and disabled
  component status before any enablement.
- Live pilot: not run and not claimed. Task 12 remains the owner of exact-SHA live acceptance.

### TDD RED

- `npm run test:pilot`: 156 tests, 151 pass, 4 fail, 1 skip. The four expected failures were the
  absent multi-message chronology and disabled-baseline functions, acceptance of active/missing-
  publication drain facts, and acceptance of a rollback status with no `knowledgeCards` object.
- `npm exec --workspace apps/core -- vitest run tests/knowledge-card-api.test.ts`: 12 tests,
  11 pass and 1 fail. The expected failure proved `/internal/status` omitted `knowledgeCards` when
  the runtime was disabled.
- The skip was the existing executable pinned-Caddy boundary probe and accurately reported that the
  Docker daemon was unavailable.

### GREEN Verification

- Focused pilot operations contracts: 41/41 pass, including executable PowerShell fixtures for a
  later C1 plus pre/equal-snapshot C2, nonpilot/missing/duplicate message IDs, an active presentation
  with no pending requirement, missing/mismatched publication, missing status properties, and each
  card/action flag/allowlist boundary.
- Fresh final `npm run test:pilot`: 156 tests, 155 pass, 0 fail, 1 Docker-daemon-unavailable skip.
- Core config/readiness/card regression set: 57/57 pass.
- Consolidated status/readiness API regressions: 24/24 pass.
- `npm run readiness -- --env-file deploy/pilot/ci.env`: 17/17 pass; conflict, card, and action
  approval checks each reported safely disabled.
- `npm run typecheck`: exit `0`.
- `npm run build`: exit `0`.
- `npm run pilot:config`: exit `0`; rendered Core has all three feature flags false and all three
  allowlists empty.
- Extracted PowerShell controller parse: pass, 6,770 tokens.
- `git diff --check`: exit `0` before the implementation commit; line-ending notices only.

### Artifact SHA-256

- Runbook: `ae20dfd9b2cf1b92e9a849cbd9867829188f662d5f8cf92f30eafe2f9c322537`.
- PR evidence template: `b3343ff83f875ff0dc6c57cb993e2ae5da787c98d0519dffc5ca1ee219320494`.
- Pilot operations contracts: `5290c9a7c23a9471f204c9db2af83802ad9dacb91491e40500f4e25d0b29925f`.
- Core status implementation: `162916d5e1cc19976c5c5aa2770d16a960bc8a0ac17b10bc7914e51fe0f71804`.
- Core status contract: `20229bcf61198b0906833c001f16dd06e4a9a9c96a54c4d4f4672d3a0f8233c0`.

### Residual Risk

- SQL was checked against migrations `0012`, `0030`-`0032`, `0035`-`0036`, and the publication
  repository's atomic version transitions, but no live PostgreSQL query was executed in this round.
- No Redis worker, Feishu callback/card, model request, Wiki read, credential, or real pilot mutation
  was used. Docker remained unavailable for the executable Caddy container probe; static Caddy,
  Compose, smoke, and mocked boundary contracts passed.
- The product loop remains pending live acceptance and produces only a governed update draft, never
  an in-place Wiki edit.

## Fix Round 3: Production Chronology And Disabled Durable-Work Attestation

### Result

- Implementation/tests/docs commit: `131bcc70d248c55b9b0fb9bbfc478db856b37700`.
- Step 4 now queries `conversation_messages.sent_at`, returns the exact source, snapshot, and
  message timestamps, and independently requires every pinned pilot message `sent_at` to be
  strictly later than both synchronized source times. Database ingestion `created_at` is ignored.
- Disabled knowledge-card status no longer fabricates zero counts. A separately owned read-only
  status reader reuses the existing PostgreSQL presentation/outbox repository and Redis approval-
  interaction queue adapters. It creates no dispatcher, worker, polling loop, callback gateway, or
  card-processing path, and closes its PostgreSQL pool and Redis client on normal or failed startup.
- Live disabled readiness and rollback now fail closed when those counts are unreadable or when
  Redis pending/processing/delayed/DLQ work, active/pending-send/send-failed draft presentations,
  or unresolved/outcome-unknown/terminal-failed presentation outbox work remains.
- The direct Step 10 drain additionally treats an active `knowledge_draft_presentations` row as
  unresolved, even when every other aggregate is zero.
- Live pilot: not run and not claimed. Task 12 remains the owner of exact-SHA live acceptance.

### TDD RED

- Initial pilot operations command: `node --test scripts/pilot-operations.test.mjs`.
  Result: 41 tests, 39 pass and 2 expected fail. The failures proved the chronology SQL still used
  ingestion `created_at` and the durable drain accepted an active knowledge-draft presentation.
- Initial Core command:
  `npm exec --workspace apps/core -- vitest run tests/internal-rollout-readiness.test.ts tests/knowledge-card-api.test.ts tests/knowledge-card-status-reader.test.ts`.
  Result: 54 tests, 42 pass and 12 expected fail. Disabled API/readiness still returned synthetic
  zero, ignored injected residual counts and read errors, and had no read-only status-reader factory.
- A stronger executable chronology fixture then supplied a pre-snapshot `sentAt`, a later
  `createdAt`, and a forged positive aggregate. It produced 40 pass and 1 expected fail before the
  controller began comparing the returned production timestamps itself.

### GREEN Verification

- Final pilot operations contracts: 41/41 pass, including the stronger pre-snapshot `sentAt` /
  later-ingestion fixture and the active-draft-presentation drain fixture.
- Final focused Core status/readiness/reader set: 54/54 pass.
- Consolidated Core status, readiness, knowledge-card runtime, startup, snapshot, and resource-close
  regressions: 130/130 pass.
- Fresh full `npm run test:pilot`: 156 tests, 155 pass, 0 fail, 1 skip. The sole skip accurately
  reports that the Docker daemon is unavailable for the executable pinned-Caddy boundary probe;
  no container result is claimed.
- `npm run readiness -- --env-file deploy/pilot/ci.env`: 17/17 pass in static disabled-env mode.
- `npm run typecheck`: exit `0`.
- `npm run build`: exit `0`.
- `npm run pilot:config`: exit `0`; rendered Core retains conflict/card/action-approval flags false
  and all three allowlists empty.
- Extracted PowerShell controller parse: pass, 6,856 tokens.
- `git diff --check`: exit `0` before the implementation commit; line-ending notices only.

### Artifact SHA-256

- Runbook: `0ac1f6add359cddb1543bc22a7ba43be8a47cd823efd1fd9fdcd8554f8b92375`.
- PR evidence template: `cd3e87b9d0cfb1378b27ae290f8dc86ceefdd37703593a0cf9bc2c923819b027`.
- Pilot operations contracts: `acbd28d2b3b1c849c33846cff1f0a608eb44512fc5616dcb854c997d5ac60a83`.
- Knowledge-card status reader: `3868e44742cee55875563553b8c3f045e179e7634038280b43d50dc48f2bcf0b`.
- Core status composition: `7485d21ee973532f84da0c7a5772e254338acd2772bd68a26cb4c36fb09ea424`.
- Disabled readiness gate: `096a41cd0963e0bb8048128ad8914764a7ff8ce97b86dd39677e468d0efbf42b`.
- Status-reader contract: `5d6845cb96aa179983d6871e7eeed859ecd9afbf31d4657ec4d59f41f625f185`.

### Residual Risk

- No live PostgreSQL query, Redis queue, Feishu callback/card, model request, Wiki read, credential,
  or pilot mutation was used in this fix round.
- A disabled Core with both status stores configured now owns one read-only Redis client and one
  lazy PostgreSQL pool so it can attest durable work. Storage/count failure intentionally degrades
  live readiness and rollback; no processing loop is enabled.
- Docker remained unavailable for the executable Caddy container probe. Static Caddy, Compose,
  smoke, default-off, and mocked boundary contracts passed.
- The loop remains pending live acceptance and produces only a governed update draft, never an
  in-place Wiki edit.

## Fix Round 4: Bounded Disabled Status-Reader Cleanup

### Result

- Implementation/tests commit: `f537d731af929a04699c79ca02af27f763dde28a`.
- The disabled knowledge-card status reader now tracks Redis connection readiness independently of
  the enabled processing runtime. Pending or failed connections use the Node Redis destructive
  close primitive immediately and never await a graceful command on an unready transport.
- A ready client still receives one graceful `quit`. Rejection or a 250 ms bound triggers one
  `destroy` fallback; the timer is unreferenced and cleared when graceful close settles.
- Concurrent and sequential `close()` calls reuse one settled promise. PostgreSQL and Redis cleanup
  each run exactly once, including startup composition failure. The enabled knowledge-card runtime
  close path and its existing failure semantics were not changed.
- Live pilot: not run and not claimed. Task 12 remains the owner of exact-SHA live acceptance.

### TDD RED

- Command:
  `npm exec --workspace apps/core -- vitest run tests/knowledge-card-status-reader.test.ts`.
- Result before implementation: 7 tests, 3 pass and 4 expected fail.
- A production-faithful refused-connection fixture and a startup-composition fixture both exceeded
  the deterministic 400 ms test bound because cleanup awaited connection/`quit` forever. A ready
  client with hanging `quit` also exceeded the bound, while a ready client with rejected `quit`
  propagated that rejection instead of completing the safe fallback.
- Root cause: the shared runtime close helper always awaited the Redis connection promise and then
  always invoked `quit`; it had no connection-state branch or destructive fallback.

### GREEN Verification

- Focused status-reader close contracts: 7/7 pass, including refused/unready, rejected quit,
  hanging quit, normal graceful close, repeated close, exact resource counts, and startup cleanup.
- Consolidated reader/runtime/startup/readiness/resource-close regressions: 137/137 pass.
- Full Core `npm test`: 3,376 pass, 0 fail, 250 environment-gated skips; 186 test files passed and
  3 were skipped.
- Pilot operations contracts: 41/41 pass.
- Fresh full `npm run test:pilot`: 156 tests, 155 pass, 0 fail, 1 skip. The sole skip accurately
  reports that the Docker daemon is unavailable for the executable pinned-Caddy boundary probe;
  no container result is claimed.
- `npm run readiness -- --env-file deploy/pilot/ci.env`: 17/17 pass in static disabled-env mode.
- `npm run typecheck`: exit `0`.
- `npm run build`: exit `0`.
- `npm run pilot:config`: exit `0`; rendered default-off boundaries remain unchanged.
- Extracted PowerShell controller parse: pass, 6,856 tokens.
- `git diff --check`: exit `0` before the implementation commit; line-ending notices only.

### Artifact SHA-256

- Knowledge-card runtime/status reader: `788532b88242d0905fa889faa2b16b534515f84f96bf027bd3991b4e6bf878b3`.
- Status-reader close contracts: `92bb21568464f4d35f307ed30bb03b9315ed387709e6d5adb38d13cc2496c93c`.

### Residual Risk

- No live PostgreSQL query, Redis queue, Feishu callback/card, model request, Wiki read, credential,
  or pilot mutation was used in this fix round.
- The destructive fallback intentionally prioritizes bounded shutdown over completing content-free
  status reads on a failed or slow Redis transport. The status reader performs no writes or worker
  processing.
- Docker remained unavailable for the executable Caddy container probe. Static Caddy, Compose,
  smoke, default-off, and mocked boundary contracts passed.
- The loop remains pending live acceptance and produces only a governed update draft, never an
  in-place Wiki edit.

## Fix Round 5: Real Node Redis Destruction And Lazy Status Connection

### Result

- Implementation/tests commit: `16568d29eac1b32bfd9ecffd90a7333b0923be2b`.
- The disabled knowledge-card status reader now composes its PostgreSQL repository, Redis queue,
  and status surface synchronously before it can start a Redis connection. The first Redis-backed
  count read starts one observed connection; closing before that read permanently prevents connect.
- This separately owned read-only Redis client never sends `QUIT`. Shutdown uses one deterministic
  `destroy()` only when the client is open. `ClientClosedError` is accepted only after `isOpen`
  proves false; any other destruction failure or a client that remains open fails closed.
- A close racing a real Node Redis handshake coordinates on either the observed connect outcome or
  successful socket destruction. This is necessary because Node Redis 6.1 can leave `connect()`
  pending after `destroy()` has already closed the handshake socket. The abandoned internal outcome
  remains rejection-observed, while status callers reject and shutdown settles without a timer,
  socket, reconnect, or unhandled rejection leak.
- Concurrent and later `close()` calls reuse the same fulfilled promise. PostgreSQL `end()` and
  Redis `destroy()` each run at most once. Synchronous composition failure preserves the primary
  error, schedules no connect microtask, and still closes the acquired PostgreSQL pool.
- The enabled knowledge-card runtime and its existing Redis close helper were not changed.
- Live pilot: not run and not claimed. Task 12 remains the owner of exact-SHA live acceptance.

### TDD RED

- Command:
  `npm exec --workspace apps/core -- vitest run tests/knowledge-card-status-reader-real-redis.test.ts`.
- With the production-real TCP fixture corrected to Node Redis RESP2 startup semantics, all 5 tests
  failed against the Round 4 implementation. Refused-connect and synchronous-composition cleanup
  rejected `ClientClosedError`; close-before-read still reached the delayed connection; connected
  close used the unsafe `QUIT` path; and a pending handshake did not settle within the test bound.
- Source inspection confirmed the Node Redis 6.1 ordering: `quit()` marks the client closed before
  awaiting the protocol reply, so a timeout fallback cannot safely call `destroy()`.
- An intermediate real-adapter run reached 4/5 pass and proved that successful destruction closes
  the socket and flips `isOpen`/`isReady` false while Node Redis can leave the original handshake
  promise pending. That evidence drove the destruction-or-connect terminal coordination used here.

### GREEN Verification

- Production-real and mocked status-reader lifecycle contracts: 12/12 pass. The real suite uses the
  installed Node Redis 6.1 client plus a local TCP server and covers refused connection with
  reconnect disabled, a server that would hang `QUIT` but receives none, synchronous composition
  failure, close-before-first-read, pending-handshake close, repeated/concurrent close, exact
  resource-close counts, closed sockets, and no unhandled rejection.
- Consolidated status reader, enabled runtime, startup, readiness, API, and resource-close
  regressions: 129/129 pass.
- Full Core `npm test`: 3,381 pass, 0 fail, 250 environment-gated skips; 187 test files passed and
  3 were skipped.
- Pilot operations contracts: 41/41 pass.
- Fresh full `npm run test:pilot`: 156 tests, 155 pass, 0 fail, 1 skip. The sole skip accurately
  reports that the Docker daemon is unavailable for the executable pinned-Caddy boundary probe;
  no container result is claimed.
- `npm run readiness -- --env-file deploy/pilot/ci.env`: 17/17 pass in static disabled-env mode.
- `npm run typecheck`: exit `0`.
- `npm run build`: exit `0`.
- `npm run pilot:config`: exit `0`; rendered conflict/card/action-approval defaults remain false
  and their allowlists remain empty.
- Extracted PowerShell controller parse: pass, 6,856 tokens.
- `git diff --check`: exit `0` before the implementation commit; line-ending notices only.

### Artifact SHA-256

- Knowledge-card runtime/status reader: `b02030d7c5df04d738e836653c90599606f97f684552f243c54b6cc72a3dca49`.
- Mocked status-reader contract: `cdf32b08c8427abed8deb79ab2bcc6775c2b7cc6071c52a0e48f271840f843b0`.
- Real Node Redis lifecycle contract: `fdab3fae68b1e8bc3be9516c09d701326fa71f7b9dfc7bd1160d678abdf4f1be`.

### Residual Risk

- No live PostgreSQL query, Redis service/queue, Feishu callback/card, model request, Wiki read,
  credential, or pilot mutation was used in this fix round. The real adapter regression used only
  an ephemeral local TCP server and metadata-free Redis protocol responses.
- Docker remained unavailable for the executable Caddy container probe. Static Caddy, Compose,
  smoke, default-off, and mocked public-boundary contracts passed.
- The loop remains pending live acceptance and produces only a governed update draft, never an
  in-place Wiki edit.

## Exception Fix Round 6: Default-Reconnect Status-Reader Shutdown

### Result

- Implementation/tests commit: `14652cb2c6b3ac80d826994fd2ad62719cb0e769`.
- The disabled knowledge-card status reader now distinguishes a pending transport attempt from the
  bounded retry backoff used by the installed Node Redis 6.1 client. A refused transport marks the
  still-open reconnecting client safe for immediate `destroy()`; a `reconnecting` event marks the
  next dial pending; and the existing `connect` terminal preserves safe pending-handshake cleanup.
- Destruction during retry backoff now waits only for the connect outcome made finite by that
  destruction. Consequently `close()` does not fulfill before Node Redis emits its final
  bookkeeping `reconnecting` event and exits the loop. No late reconnect, open/ready client,
  repeated destruction, socket, or unhandled rejection remains after close.
- Pending handshakes retain destruction-or-connect coordination, including the Node Redis state in
  which a server has accepted the TCP socket before the library assigns that socket internally.
  This avoids both the original infinite default-reconnect wait and an accepted-socket leak.
- Lazy connection, no-`QUIT` read-only shutdown, synchronous composition cleanup, repeated and
  concurrent `close()` identity, and exact PostgreSQL/Redis close counts are preserved. The enabled
  knowledge-card runtime and its graceful close semantics were not changed.
- Live pilot: not run and not claimed. Task 12 remains the owner of exact-SHA live acceptance.

### TDD RED

- Initial production-real command:
  `npm exec --workspace apps/core -- vitest run tests/knowledge-card-status-reader-real-redis.test.ts`.
- Initial result: 6 tests, 5 pass and 1 expected fail. The new client used
  `redis://127.0.0.1:1`, `connectTimeout: 50`, and the installed default reconnect strategy. After
  starting `getStatus()`, waiting 20 ms, and calling `close()`, the 750 ms bound failed with
  `operation did not settle within test bound`; `pool.end()` was therefore never reached.
- Root cause inspection of installed `redis@6.1.0` showed that `RedisSocket.connect()` sets
  `isOpen` before dialing and its default reconnect loop keeps the returned promise pending across
  refused connections. The Round 5 close branch skipped destruction while connecting before a TCP
  `connect` event, then raced two signals that could both remain pending forever.
- A deliberately minimal unconditional-destroy hypothesis made the default-reconnect test pass but
  failed the existing real pending-handshake contract 5/6: a TCP server can accept just before Node
  Redis assigns its private socket, so an early public destroy can flip `isOpen` false without
  reaching that not-yet-assigned socket. That hypothesis was discarded in favor of explicit
  attempt-terminal tracking.
- A second production-real RED strengthened the same test to count reconnect signals after close.
  Result: 6 tests, 5 pass and 1 expected fail, `expected 1 to be 0`. Immediate destruction stopped
  the next dial but `close()` still fulfilled before the current retry delay emitted its final
  bookkeeping signal. The final implementation waits for that now-finite outcome only in the
  error/backoff terminal path; it never substitutes the potentially unbounded pending-handshake
  outcome for the destruction terminal.

### GREEN Verification

- Production-real Node Redis lifecycle suite: 6/6 pass. It covers the default-reconnect refused
  port, reconnect-disabled refusal, connected no-`QUIT` close, synchronous composition failure,
  close-before-first-read, and a real pending handshake. The default-reconnect case proves a shared
  fulfilled close promise within 750 ms, rejected status, one destroy, one PostgreSQL end, and then
  observes 300 ms with zero late reconnects, `isOpen=false`, `isReady=false`, and no unhandled
  rejection.
- Production-real plus mocked status-reader lifecycle suites: 13/13 pass.
- Consolidated status reader, enabled runtime, startup, readiness, API, and resource-close set:
  134/134 pass across 9 files.
- Full Core `npm --workspace apps/core test`: 3,382 pass, 0 fail, 250 environment-gated skips;
  187 test files passed and 3 were skipped.
- Pilot operations `node --test scripts/pilot-operations.test.mjs`: 41/41 pass.
- Fresh full `npm run test:pilot`: 156 tests, 155 pass, 0 fail, 1 skip in 402,974 ms. The sole
  skip accurately reports the unavailable Docker daemon for the executable pinned-Caddy boundary
  probe; static Compose, Caddy, smoke, and rollback contracts passed.
- `npm run readiness -- --env-file deploy/pilot/ci.env`: 17/17 pass in static disabled-env mode.
- `npm run typecheck`: exit `0`.
- `npm run build`: exit `0`.
- `npm run pilot:config`: exit `0`; parsed Core configuration has conflict/card/action-approval
  flags `false` and all three corresponding allowlist lengths `0`.
- Full executable PowerShell controller parse: pass, 7,006 tokens.
- `git diff --check`: exit `0` before the implementation commit; line-ending notices only.
- Direct `docker info` exited `1` because the Docker Desktop Linux daemon pipe does not exist. No
  container execution or live-service result is claimed.

### Artifact SHA-256

- Knowledge-card runtime/status reader: `26e4b54901a0b00fd9494019d84d436fd65c6c8f649c592d9bbfc27526319514`.
- Production-real Node Redis lifecycle contract:
  `a9d3b8ec4f2e93f1076f61950fe7cb66e276997b3bfab36772e791630622a639`.

### Residual Risk

- No live PostgreSQL query, Redis service/queue, Feishu callback/card, model request, Wiki read,
  credential, or pilot mutation was used. The real Redis tests use only port 1 refusal and an
  ephemeral local TCP server with metadata-free RESP2 fixtures.
- Destruction during the installed default reconnect backoff waits for only that current bounded
  Node Redis delay so no reconnect signal occurs after close. Pending-handshake cleanup still uses
  the destruction terminal because the library's handshake outcome is not a safe shutdown bound.
- Docker remained unavailable for the executable Caddy container probe. Static Caddy, Compose,
  smoke, default-off, and mocked public-boundary contracts passed.
- The product loop remains pending live acceptance and produces only a governed update draft,
  never an in-place Wiki edit.

## Exception Fix Round 7: Accepted Pending-Handshake Reconnect Closure

### Result

- Implementation/tests commit: `d945ef09afd8072a546931d3637d161699b50a82`.
- The disabled knowledge-card status reader now coordinates destruction with three terminal signals
  when shutdown starts during an accepted but not yet internally assigned Redis handshake: connect
  outcome settlement, the final reconnect bookkeeping event, or a 300 ms bounded timer. The timer
  exceeds the installed Node Redis 6.1 default first retry maximum of 249 ms and is both unreferenced
  and cleared after an earlier terminal signal.
- This closes the race in which the destruction signal won before the later Redis error handler
  classified the connect outcome. `close()` can no longer fulfill before Node Redis emits its final
  `reconnecting` bookkeeping event, and it never substitutes an unbounded reconnect outcome for a
  shutdown bound.
- Default-refused connection, reconnect-disabled pending handshake/private socket assignment,
  synchronous composition failure, close-before-first-read, lazy connection, no-`QUIT` shutdown,
  exact-once Redis/PostgreSQL cleanup, and shared concurrent/repeated close promise contracts remain
  intact. The enabled knowledge-card runtime and its graceful close semantics were not changed.
- Live pilot: not run and not claimed. Task 12 was not started.

### TDD RED

- Command:
  `npm exec --workspace apps/core -- vitest run tests/knowledge-card-status-reader-real-redis.test.ts -t "accepted pending handshake"`.
- Initial result: 1 failed and 6 skipped. The production-real test used installed `redis@6.1.0`,
  omitted `reconnectStrategy` to retain the production default, and connected to an ephemeral local
  TCP server that accepted the socket but sent no RESP. It began `getStatus()`, waited only for the
  server-side accept, and immediately called `close()`.
- `close()` fulfilled and all resource cleanup assertions passed, but after a 350 ms observation
  window the test saw one late `reconnecting` event (`expected 1 to be 0`). That window exceeds the
  default first retry delay of 50 ms plus up to 199 ms jitter.
- Root cause: the prior destruction promise could win the close race before the handshake rejection
  reached the Redis error handler. At that instant `awaitConnectSettlementAfterDestroy` was still
  false, so close returned; the later handler then classified the outcome and Node Redis emitted its
  delayed final reconnect event after close settlement.
- A one-turn settlement hypothesis remained RED. Moving the wait classification into the connect
  listener made the new case pass but regressed the reconnect-disabled pending-handshake contract
  by waiting on an outcome that can remain pending, so that hypothesis was reverted.

### GREEN Verification

- Exact accepted pending-handshake default-reconnect test: pass; 10 independent process repetitions
  passed 10/10 with zero reconnect events after close settlement.
- Production-real Node Redis lifecycle suite: 7/7 pass. It covers default-reconnect refusal, the
  accepted pending handshake with default reconnect, reconnect-disabled refusal and pending
  handshake, connected no-`QUIT` close, synchronous composition failure, and close-before-first-read.
- Production-real plus mocked status-reader lifecycle suites: 14/14 pass.
- Consolidated status reader, enabled runtime, startup, readiness, API, and resource-close set:
  135/135 pass across 9 files.
- Full Core `npm --workspace apps/core test`: 3,383 pass, 0 fail, 250 environment-gated skips;
  187 test files passed and 3 were skipped.
- Pilot operations `node --test scripts/pilot-operations.test.mjs`: 41/41 pass.
- Fresh full `npm run test:pilot`: 156 tests, 155 pass, 0 fail, 1 skip in 388,382 ms. The sole skip
  accurately reports the unavailable Docker daemon for the executable pinned-Caddy boundary probe;
  static Compose, Caddy, smoke, and rollback contracts passed.
- `npm run readiness -- --env-file deploy/pilot/ci.env`: 17/17 pass in static disabled-env mode.
- `npm run typecheck`: exit `0`.
- `npm run build`: exit `0`.
- `npm run pilot:config`: exit `0`; parsed Core configuration has conflict/card/action-approval
  flags `false` and all three corresponding allowlist lengths `0`.
- Full executable PowerShell controller parse: pass, 7,006 tokens and 0 parse errors.
- `git diff --check`: exit `0` before the implementation commit; line-ending notices only.
- Direct `docker info --format '{{.ServerVersion}}'` exited `1` because the Docker Desktop Linux
  daemon pipe does not exist. No container execution or live-service result is claimed.

### Artifact SHA-256

- Knowledge-card runtime/status reader: `0c07792b9641b7f5d7b090f55c6aa1efbf35dce5355e71018dd58046a90d2cc4`.
- Production-real Node Redis lifecycle contract:
  `d393974bb2b180d3eac48ef4ab1c420511bba16d93ba51e9db48df1f41c045f2`.

### Residual Risk

- No live PostgreSQL query, Redis service/queue, Feishu callback/card, model request, Wiki read,
  credential, or pilot mutation was used. The real Redis tests use only port 1 refusal and an
  ephemeral local TCP server that accepts a metadata-free connection without a protocol reply.
- The 300 ms terminal bound is deliberately coupled to the installed Node Redis 6.1 default first
  retry upper bound of 249 ms. A dependency reconnect-policy change must update this contract; the
  bound prevents an infinite shutdown wait even if no terminal bookkeeping signal arrives.
- Docker remained unavailable for the executable Caddy container probe. Static Caddy, Compose,
  smoke, default-off, and mocked public-boundary contracts passed.
- The product loop remains pending live acceptance and produces only a governed update draft,
  never an in-place Wiki edit.

## Exception Fix Round 8: Request-Driven Redis Connection Generations

### Result

- Implementation/tests commit: `91faec289f16ab8cfb52c60219a77d65d7edab51`.
- The disabled, read-only knowledge-card status reader now constructs its production Redis clients
  with `reconnectStrategy: false`. It owns no background reconnect loop and no retry timer.
- A refused connection or a disconnected ready connection fails the current status request closed.
  The next `getStatus()` creates a fresh client generation and explicitly reconnects; concurrent
  reads share the same connecting or ready generation. This preserves transient recovery without
  allowing work to outlive a request generation.
- Close first enters a terminal reader state, so no later request can create a generation. It then
  closes every still-open owned generation, waits only for a no-retry dial to fail or expose its
  assigned transport, destroys the assigned transport, detaches reader-owned listeners, and closes
  PostgreSQL once. Concurrent and repeated close calls retain the same settled promise.
- Failed and disconnected closed generations remove their reader listeners and leave the owned set;
  already-closed clients do not receive a fabricated `destroy()`. Every client still open at close
  is destroyed exactly once.
- The one-shot `reconnectObserved` signal and fixed 300 ms Node Redis backoff bound were removed.
  The enabled knowledge-card runtime and its graceful Redis close semantics were not changed.
- Live pilot: not run and not claimed. Task 12 was not started.

### Design Decision

- A single no-reconnect client was rejected because the previous memoized `redisConnection` kept
  its first rejection forever and would make all later readiness/status calls permanently fail.
- Reusing that same client after a ready disconnect was also rejected because it retains stale queue
  and listener state. Fresh request-driven generations give failure isolation and a clear owner.
- A custom abortable Node Redis socket factory was rejected as disproportionate and dependent on
  private library behavior. The selected protocol uses only public `connect`, `destroy`, lifecycle
  events, and `isOpen`/`isReady` state.

### TDD RED

- Production-real A/B command:
  `npm exec --workspace apps/core -- vitest run tests/knowledge-card-status-reader-real-redis.test.ts -t "recovers a (refused|disconnected)"`.
- Initial result: 2 failed and 7 skipped. Both tests timed out at `condition did not settle within
  test bound` while waiting for the replacement TCP connection. The prior one-shot connection
  promise prevented the next request from creating a generation after either refusal or disconnect.
- Scenario A uses a refused first request, starts a server on the same ephemeral endpoint, issues
  two concurrent recovery reads, waits for their one shared replacement connection to be accepted,
  and closes before the client transport event completes.
- Scenario B completes an initial real status read, destroys the server-side ready socket, waits for
  the client to become closed/not-ready, starts the next read, waits for its replacement connection
  to be accepted, and immediately closes before the second handshake completes.
- Each scenario runs 10 iterations and, after close settles, observes another 350 ms while requiring
  zero late `connect`, `ready`, or `reconnecting` events, zero server sockets, no open/ready clients,
  no unhandled rejection, one aggregate Redis destroy, one PostgreSQL end, restored listener counts,
  and the same concurrent/repeated close promise.
- Production factory command:
  `npm exec --workspace apps/core -- vitest run tests/knowledge-card-status-reader.test.ts -t "without background reconnect"`.
- Initial result: 1 failed and 7 skipped. The factory received only `{ url }`, while the new contract
  expected a socket configuration with `reconnectStrategy: false`.

### GREEN Verification

- Both production-real generation races: 2/2 pass across 10 iterations each. Scenario A's two
  concurrent recovery reads create only one replacement generation, and both scenarios retain only
  two total clients after the post-close observation window.
- Production-real Node Redis lifecycle suite: 7/7 pass. The previous injected default-background-
  reconnect tests were replaced by the approved production no-reconnect recovery generations.
- Production-real plus mocked status-reader suites: 15/15 pass. The mocked suite includes the
  production factory option and reader-listener cleanup contracts.
- Consolidated status reader, enabled runtime, startup, readiness, API, and resource-close set:
  136/136 pass across 9 files.
- Full Core `npm --workspace apps/core test`: 3,384 pass, 0 fail, 250 environment-gated skips;
  187 test files passed and 3 were skipped.
- Pilot operations `node --test scripts/pilot-operations.test.mjs`: 41/41 pass in 52,061 ms.
- Fresh full `npm run test:pilot`: 156 tests, 155 pass, 0 fail, 1 skip in 412,217 ms. The sole skip
  accurately reports the unavailable Docker daemon for the executable pinned-Caddy boundary probe;
  static Compose, Caddy, smoke, backup, restore, and rollback contracts passed.
- `npm run readiness -- --env-file deploy/pilot/ci.env`: 17/17 pass in static disabled-env mode.
- `npm run typecheck`: exit `0`.
- `npm run build`: exit `0`.
- `npm run pilot:config`: exit `0`; parsed Core configuration has conflict/card/action-approval
  flags `false` and all three corresponding allowlist lengths `0`.
- Full executable PowerShell controller parse: pass, 7,006 tokens and 0 parse errors.
- `git diff --check`: exit `0` before the implementation commit; line-ending notices only.
- Direct `docker info --format '{{.ServerVersion}}'` exited `1` because the Docker Desktop Linux
  daemon pipe does not exist. No container execution or live-service result is claimed.

### Artifact SHA-256

- Knowledge-card runtime/status reader: `366ba75ec8eab4ef20ac3de548a19c65217e35edf36a9e9ee4fcd4beaed4c3b8`.
- Production-real Node Redis lifecycle contract:
  `cf7cb770ed3571897650e28e3afdb238d199f71d4b9531ff6e446b545a1e459e`.
- Mocked status-reader lifecycle contract:
  `5e8e74902849e6df1a4fcf385779da3acb844ac430b25176fbebff36fbb137fe`.

### Residual Risk

- No live PostgreSQL query, Redis service/queue, Feishu callback/card, model request, Wiki read,
  credential, or pilot mutation was used. The real Redis tests use only local ephemeral TCP servers
  and metadata-free RESP2 fixtures.
- Before a transport is assigned, public Node Redis cannot cancel its private in-progress socket.
  Close therefore waits for the configured finite connection timeout or transport exposure; it no
  longer waits for an unbounded reconnect loop or a guessed backoff interval.
- Docker remained unavailable for the executable Caddy container probe. Static Caddy, Compose,
  smoke, default-off, and mocked public-boundary contracts passed.
- The product loop remains pending live acceptance and produces only a governed update draft,
  never an in-place Wiki edit.

## Exception Fix Round 9: Release Completed Redis Generation Ownership

### Result

- Implementation/tests commit: `60301f8690d568f1bdd6397ebea34f235bf7c4cb`.
- The disabled, read-only knowledge-card status reader no longer races every connection generation
  against one reader-scoped pending close promise. Each connect attempt now owns an idempotent
  terminal signal that is released after its outer connection race settles normally or
  exceptionally, and is also released on generation replacement or reader close.
- Releasing a terminal signal clears the generation's release callback before settling the signal.
  Consequently, a successful old connection does not retain its client through a pending
  reader-lifetime promise, and repeated terminal paths remain harmless.
- A pending status request still fails closed immediately when close begins. The close path retains
  the Round 8 finite no-reconnect transport protocol, exact-once cleanup, terminal no-new-generation
  state, shared concurrent/repeated close promise, and no-`QUIT` behavior.
- No timer or Redis backoff assumption was introduced. Production status clients remain
  `reconnectStrategy: false` and recover on the next request with a fresh generation. The enabled
  knowledge-card runtime and its graceful Redis close semantics were not changed.
- Live pilot: not run and not claimed. Task 12 was not started.

### TDD RED

- Command:
  `npm exec --workspace apps/core -- vitest run tests/knowledge-card-status-reader-ownership.test.ts`.
- Initial product result: 1 failed, exit `1`. The ordinary Vitest test launched a dedicated
  `node --expose-gc --import tsx` child fixture so the ownership assertion does not depend on the
  main Vitest worker exposing garbage collection.
- The fixture completed 50 ready -> unexpected disconnect -> next-request recovery cycles. Before
  garbage collection it deterministically observed 51 created clients, exactly one open client,
  and exactly two reader listeners on the current client. Its bounded forced-GC check then failed
  with `completed Redis generations remained strongly owned before reader close: 51/51 alive`.
- Root cause: every `Promise.race([connectOutcome, closedConnection])` installed a reaction on the
  same reader-scoped `closedConnection` promise. Because that promise stayed pending until reader
  close, its reaction retained the already-settled race and successful generation/client. Listener
  detachment and removal from the owned generation set could not release that independent promise
  ownership chain.
- A first child-runner attempt was discarded before the product RED because Node's `--expose-gc`
  flag reached the Vitest coordinator but not its worker. The final regression executes the
  TypeScript fixture directly in the forced-GC child and remains part of ordinary Core test runs.

### GREEN Verification

- Isolated forced-GC ownership regression: 1/1 pass. Fifty completed old generations are released
  before reader close, with at most the current generation alive; close then leaves zero open
  clients, zero reader listeners, no new generation, no unhandled rejection, one current-client
  destroy, one PostgreSQL end, and the same concurrent/repeated close promise.
- Production-real plus mocked plus ownership status-reader suites: 16/16 pass across 3 files. The
  production-real A/B tests each passed all 10 iterations and continued to prove zero post-close
  `connect`, `ready`, or `reconnecting` signals, zero sockets, no unhandled rejection, exact cleanup,
  and shared close settlement.
- Consolidated ownership, status reader, enabled runtime, startup, readiness, API, and
  resource-close set: 137/137 pass across 10 files.
- Full Core `npm test --workspace apps/core`: 3,385 pass, 0 fail, 250 environment-gated skips;
  188 test files passed and 3 were skipped.
- Pilot operations `node --test scripts/pilot-operations.test.mjs`: 41/41 pass in 48,486 ms.
- Fresh full `npm run test:pilot`: 156 tests, 155 pass, 0 fail, 1 skip in 309,719 ms. The sole skip
  accurately reports the unavailable Docker daemon for the executable pinned-Caddy boundary probe;
  static Compose, Caddy, smoke, backup, restore, and rollback contracts passed.
- `npm run readiness -- --env-file deploy/pilot/ci.env`: 17/17 pass in static disabled-env mode.
- `npm run typecheck`: exit `0`.
- `npm run build`: exit `0`.
- `npm run pilot:config`: exit `0`; parsed Core configuration has conflict/card/action-approval
  flags `false` and all three corresponding allowlist lengths `0`.
- Full executable PowerShell controller parse: pass, 7,006 tokens and 0 parse errors.
- `git diff --check`: exit `0` before the implementation commit; line-ending notices only.
- Direct `docker info --format '{{.ServerVersion}}'` exited `1` because the Docker Desktop Linux
  daemon pipe does not exist. No container execution or live-service result is claimed.

### Artifact SHA-256

- Knowledge-card runtime/status reader: `936dd49fbd2affa19f90e57ab696eb862255e0b2f9efcceba26c712bf7d61c15`.
- Ownership Vitest wrapper: `a00c36c05f3df78d11c07196c5463ba1c32ec0847cf3e561ee30d3372bd920a2`.
- Forced-GC ownership fixture: `413c4d384a0f97f603b9ca61ffc1caf0d292ce459e119b0595f37c11cbdd5456`.
- Production-real Node Redis lifecycle contract:
  `cf7cb770ed3571897650e28e3afdb238d199f71d4b9531ff6e446b545a1e459e`.
- Mocked status-reader lifecycle contract:
  `5e8e74902849e6df1a4fcf385779da3acb844ac430b25176fbebff36fbb137fe`.

### Residual Risk

- JavaScript garbage collection is inherently nondeterministic. The regression isolates the test in
  a forced-GC process, removes loop-frame ownership before measuring, bounds collection attempts,
  and first proves deterministic client/open/listener counts. It permits only the current generation
  to remain alive rather than relying on an exact incidental collection turn.
- No live PostgreSQL query, Redis service/queue, Feishu callback/card, model request, Wiki read,
  credential, or pilot mutation was used. The real Redis tests use only local ephemeral TCP servers
  and metadata-free RESP2 fixtures.
- Docker remained unavailable for the executable Caddy container probe. Static Caddy, Compose,
  smoke, default-off, and mocked public-boundary contracts passed.
- The product loop remains pending live acceptance and produces only a governed update draft,
  never an in-place Wiki edit.
