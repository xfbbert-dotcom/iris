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
