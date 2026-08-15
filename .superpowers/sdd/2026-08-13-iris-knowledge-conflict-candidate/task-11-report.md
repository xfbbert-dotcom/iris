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
