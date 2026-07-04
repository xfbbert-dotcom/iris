# Iris Redis URL Config Implementation Plan

**Goal:** Fail invalid Redis connection strings during config loading for enabled
worker runtimes.

**Architecture:** Add a Redis-specific URL env reader in `env.ts`, use it for
the shared `REDIS_URL` field in event, document sync, and reindex worker runtime
configs, and keep credentials/database paths intact.

**Tech Stack:** TypeScript, Vitest.

---

## File Structure

- Modify `apps/core/src/config/env.ts`.
- Modify `apps/core/tests/env.test.ts`.
- Modify `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`.
- Create `docs/superpowers/specs/2026-07-04-iris-redis-url-config-design.md`.
- Create `docs/superpowers/plans/2026-07-04-iris-redis-url-config.md`.

### Task 1: Regression Tests

- [x] Add env tests accepting `rediss://` Redis URLs with credentials and DB
  paths.
- [x] Add env tests rejecting malformed `REDIS_URL` values and non-Redis
  protocols.
- [x] Run `npm --workspace apps/core test -- env.test.ts` and observe RED.

Observed: env tests failed because malformed `REDIS_URL` values were accepted.

### Task 2: Implementation

- [x] Add a `readRedisUrlEnv()` helper.
- [x] Use it for all enabled worker runtime configs.
- [x] Preserve default `redis://localhost:6379` behavior.
- [x] Run `npm --workspace apps/core test -- env.test.ts` and observe GREEN.

Observed: env tests passed with 51 passing tests.

### Task 3: Architecture And Verification

- [x] Update the architecture whitepaper runtime configuration safety section.
- [x] Run `npm run verify`.
- [x] Commit and push.
- [x] Watch PR #3 checks.

Observed: `npm run verify` passed. Core reported 741 passing tests and 4 skipped
tests. Python worker tests reported 7 passing tests. Docker Compose config
rendered successfully.

Observed: pushed commit `43b37ad`; GitHub Actions reported AI Worker and Core
success for PR #3.
