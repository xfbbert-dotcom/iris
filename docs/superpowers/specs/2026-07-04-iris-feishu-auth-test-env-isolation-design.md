# Iris Feishu Auth Test Env Isolation Design

## Goal

Keep Feishu gateway route tests deterministic when a developer or CI environment has
`FEISHU_VERIFICATION_TOKEN` or `FEISHU_ENCRYPT_KEY` set. Tests that do not explicitly exercise
Feishu environment auth should not accidentally inherit real shell credentials and receive 401
responses instead of the route behavior they are testing.

## Architecture

Reuse the existing `isolateEnvVar(name)` test helper in `apps/core/tests/feishu-gateway.test.ts`.
Each test snapshots and deletes:

- `IRIS_INTERNAL_API_TOKEN`
- `FEISHU_VERIFICATION_TOKEN`
- `FEISHU_ENCRYPT_KEY`

The original values are restored after each test. The production app remains unchanged:
`buildApp()` still reads Feishu auth environment configuration when no test dependency overrides the
verifier. The isolation only makes tests explicit about when they want environment-backed Feishu
auth.

## Invariants

- Feishu gateway route tests are not affected by real shell Feishu auth variables.
- The existing test that exercises Feishu auth config from the environment still sets those variables
  explicitly inside the test.
- The original environment variable values are restored after each test.
- Production Feishu verification behavior is unchanged.

## Out Of Scope

- Changing production environment loading.
- Introducing a global Vitest setup file.
- Isolating unrelated environment variables.
