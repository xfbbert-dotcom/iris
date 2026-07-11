# Iris Feishu Legacy Idempotency Plan

**Goal:** Make the Feishu Gateway legacy queue fallback idempotent for retried callbacks without explicit event ids.

- [x] **Step 1: Add failing gateway coverage**
  - Add a direct FeishuGateway test for v2 `header.event_id` on the legacy queue path.
  - Add a direct FeishuGateway test proving two identical id-less callbacks dedupe by a stable body hash.

- [x] **Step 2: Reuse stable raw event id resolution**
  - Remove the random UUID fallback.
  - Make legacy idempotency use the same normalized event id resolver as raw event enqueueing.

- [x] **Step 3: Verify focused and full suites**
  - Run focused Feishu Gateway tests.
  - Run typecheck, Python tests, Docker Compose config, and the full npm test suite.

- [x] **Step 4: Commit and update PR**
  - Commit the patch with a scoped message.
  - Push the branch and append the PR description.
