# Iris Internal Token Test Env Isolation Design

## Goal

Keep Core API tests deterministic when a developer or CI environment has
`IRIS_INTERNAL_API_TOKEN` set. Tests that do not explicitly exercise the internal token guard should
not accidentally inherit a real shell token and receive 401 responses instead of the route behavior
they are testing.

## Architecture

Add a small test helper that snapshots an environment variable, deletes it for the duration of a
test, and restores the original value afterward. API test files that instantiate `buildApp()` isolate
`IRIS_INTERNAL_API_TOKEN` in `beforeEach`/`afterEach`.

The production app remains unchanged: `buildApp()` still reads `IRIS_INTERNAL_API_TOKEN` when no
test dependency overrides it. The isolation only makes tests explicit about when they want ambient
environment configuration.

## Invariants

- API tests are not affected by a real shell `IRIS_INTERNAL_API_TOKEN`.
- Tests that need token-protected behavior continue to inject `internalApiToken` directly.
- The original environment variable value is restored after each test.
- Feishu auth environment tests keep their existing per-test environment setup.

## Out Of Scope

- Changing production environment loading.
- Centralizing all test setup in a global Vitest setup file.
- Isolating unrelated environment variables.
