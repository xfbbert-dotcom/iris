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
