# Iris Repository Limit Sanitization Plan

**Goal:** Prevent non-finite repository limits from reaching SQL queries.

- [x] **Step 1: Add failing repository coverage**
  - Recent conversation message listing sends limit `0` for `Infinity` and `NaN`.
  - Missing-profile snapshot listing sends limit `0` for `Infinity` and `NaN`.

- [x] **Step 2: Add finite-aware limit helpers**
  - Sanitize conversation message repository limits.
  - Sanitize document snapshot repository missing-profile limits.

- [x] **Step 3: Verify focused and full suites**
  - Run focused repository tests.
  - Run typecheck, Python tests, Docker Compose config, and full npm tests.

- [x] **Step 4: Commit and update PR**
  - Commit the patch with a scoped message.
  - Push the branch and append the PR description.
