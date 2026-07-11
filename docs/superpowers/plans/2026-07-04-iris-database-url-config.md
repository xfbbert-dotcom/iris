# Iris Database URL Config Implementation Plan

**Goal:** Fail malformed or non-Postgres database URLs during config loading.

**Architecture:** Keep the existing missing-config typed error, then validate
nonblank `DATABASE_URL` values with `URL` and an explicit Postgres protocol
allowlist.

**Tech Stack:** TypeScript, Vitest.

---

## File Structure

- Modify `apps/core/src/database/database-config.ts`.
- Modify `apps/core/tests/database-config.test.ts`.
- Modify `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`.
- Create `docs/superpowers/specs/2026-07-04-iris-database-url-config-design.md`.
- Create `docs/superpowers/plans/2026-07-04-iris-database-url-config.md`.

### Task 1: Regression Tests

- [x] Add a test accepting `postgresql://` URLs with credentials and query
  parameters.
- [x] Add tests rejecting malformed and non-Postgres `DATABASE_URL` values.
- [x] Run `npm --workspace apps/core test -- database-config.test.ts` and
  observe RED.

Observed: database config tests failed because malformed `DATABASE_URL` values
were accepted.

### Task 2: Implementation

- [x] Validate nonblank database URLs with `URL`.
- [x] Allow only `postgres://` and `postgresql://`.
- [x] Preserve `MissingDatabaseConfigError` for blank or missing values.
- [x] Run `npm --workspace apps/core test -- database-config.test.ts` and
  observe GREEN.

Observed: database config tests passed with 4 passing tests.

### Task 3: Architecture And Verification

- [x] Update the architecture whitepaper runtime configuration safety section.
- [x] Run `npm run verify`.
- [x] Commit and push.
- [x] Watch PR #3 checks.

Observed: `npm run verify` passed. Core reported 743 passing tests and 4 skipped
tests. Python worker tests reported 7 passing tests. Docker Compose config
rendered successfully.

Observed: pushed commit `36f0eb3`; GitHub Actions reported AI Worker and Core
success for PR #3.
