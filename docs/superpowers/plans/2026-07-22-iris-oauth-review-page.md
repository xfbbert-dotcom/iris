# Iris 飞书 OAuth 完整正文审阅页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 Phase 5B-2B：负责人或管理员通过飞书 OAuth 查看精确草稿正文并记录不可变审阅事实，未审阅时批准必须 fail closed。

**Architecture:** 在现有 Fastify Core 内增加独立 review 模块，使用 Authorization Code + PKCE、HMAC 短时 Cookie 和 Postgres append-only attestation。Web 只完成身份确认与审阅证明，最终批准仍由现有飞书卡片回调和 Approval Service 提交。

**Tech Stack:** TypeScript、Fastify 5、Node `crypto`/`fetch`、Postgres、Vitest、Caddy、现有 Docker Compose pilot。

## Global Constraints

- 以 `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md` 和 `docs/superpowers/specs/2026-07-22-iris-oauth-review-page-design.md` 为准。
- `IRIS_ACTION_REVIEW_ENABLED` 默认 `false`；关闭时现有 5B-2A 行为与测试不变。
- Web 页面不能创建 approval 或 execution；批准只接受飞书卡片回调。
- 不持久化或记录 user access token、refresh token、正文、证据原文或用户 open ID 到普通日志。
- Cookie 固定 `Secure; HttpOnly; SameSite=Lax; Path=/`；OAuth 事务 300 秒，审阅会话 900 秒。
- 所有外部响应有 5 秒超时、响应体预算和稳定错误分类。
- Caddy 只开放三个精确 review 路由；所有 `/internal/*` 继续 404。
- 不添加前端框架或 OAuth 依赖。
- 不改写、不删除现有 5B-1/5B-2A 审批事实。

---

### Task 1: Append-only 审阅事实与授权查询

**Files:**
- Create: `apps/core/migrations/0034_action_review_attestations.sql`
- Modify: `apps/core/src/action-approvals/action-proposal-repository.ts`
- Modify: `apps/core/src/action-approvals/postgres-action-proposal-repository.ts`
- Test: `apps/core/tests/postgres-action-review-repository.test.ts`

**Interfaces:**
- Produces: `ActionReviewContext`, `RecordActionReviewAttestationInput`, `getAuthorizedReviewContext`, `recordReviewAttestation`, `hasCurrentReviewAttestation`.
- Consumes: existing proposal/draft/policy/evidence rows and `requireApprovalAuthorization` semantics.

- [ ] **Step 1: Write migration contract and repository failing tests**

```ts
expect(migration).toContain("CREATE TABLE action_review_attestations");
expect(migration).toContain("action_review_attestations_append_only");

const context = await repository.getAuthorizedReviewContext({
  proposalId: proposal.id,
  actorOpenId: "ou_owner",
});
expect(context).toMatchObject({
  proposalId: proposal.id,
  subjectRevision: 1,
  title: "Pilot SOP",
  content: "full body",
  contentHash: sha256("full body"),
  riskLevel: "medium",
});
```

Add negative tests for wrong actor, disabled grant, stale proposal/draft version, disabled policy, invalid evidence, and missing proposal. They must all return `undefined` rather than leak which condition failed.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm --workspace apps/core test -- tests/postgres-action-review-repository.test.ts`

Expected: FAIL because migration and repository methods do not exist.

- [ ] **Step 3: Add the migration**

```sql
CREATE TABLE action_review_attestations (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  proposal_id TEXT NOT NULL REFERENCES action_proposals(id) ON DELETE RESTRICT,
  actor_open_id TEXT NOT NULL CHECK (char_length(actor_open_id) BETWEEN 1 AND 512),
  subject_revision INTEGER NOT NULL CHECK (subject_revision >= 1),
  subject_version BIGINT NOT NULL CHECK (subject_version >= 1),
  proposal_version BIGINT NOT NULL CHECK (proposal_version >= 1),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  session_id_hash TEXT NOT NULL CHECK (session_id_hash ~ '^[0-9a-f]{64}$'),
  operation_key TEXT NOT NULL UNIQUE CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  operation_fingerprint TEXT NOT NULL CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  reviewed_at TIMESTAMPTZ NOT NULL,
  UNIQUE (proposal_id, proposal_version, actor_open_id, content_hash)
);
```

Add the same append-only update/delete/truncate trigger pattern used by `action_approvals`.

- [ ] **Step 4: Add repository types and exact authorization query**

```ts
export type ActionReviewContext = {
  proposalId: string;
  proposalVersion: number;
  draftId: string;
  subjectRevision: number;
  subjectVersion: number;
  title: string;
  content: string;
  contentHash: string;
  riskLevel: KnowledgeDraftRiskLevel;
  targetDisplayName: string;
  requirements: Array<{ kind: ActionApprovalRequirementKind; state: "pending" | "satisfied" | "invalidated" }>;
};

getAuthorizedReviewContext(input: {
  proposalId: string;
  actorOpenId: string;
}): Promise<ActionReviewContext | undefined>;
```

Compute `contentHash` with SHA-256 in Core. Load proposal, current draft revision, current policy and requirements in one transaction; require `pending_approval`, `pending_review`, exact versions, current evidence and at least one pending requirement authorized for the actor.

- [ ] **Step 5: Record and query idempotent attestations**

```ts
recordReviewAttestation(input: {
  proposalId: string;
  actorOpenId: string;
  expectedProposalVersion: number;
  expectedSubjectRevision: number;
  expectedSubjectVersion: number;
  expectedContentHash: string;
  sessionIdHash: string;
  operationKey: string;
  at: Date;
}): Promise<{ outcome: "applied" | "already_applied" }>;
```

Re-run the complete authorization query in the write transaction, compare every expected field, insert once, and treat exact operation replay as `already_applied`; conflicting payload returns the existing operation conflict error.

- [ ] **Step 6: Run tests**

Run: `npm --workspace apps/core test -- tests/postgres-action-review-repository.test.ts tests/postgres-action-proposal-repository.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/core/migrations/0034_action_review_attestations.sql apps/core/src/action-approvals/action-proposal-repository.ts apps/core/src/action-approvals/postgres-action-proposal-repository.ts apps/core/tests/postgres-action-review-repository.test.ts
git commit -m "feat(core): persist exact action review attestations"
```

### Task 2: Cookie codec 与飞书 OAuth 客户端

**Files:**
- Create: `apps/core/src/action-reviews/action-review-session.ts`
- Create: `apps/core/src/action-reviews/feishu-review-oauth-client.ts`
- Test: `apps/core/tests/action-review-session.test.ts`
- Test: `apps/core/tests/feishu-review-oauth-client.test.ts`

**Interfaces:**
- Produces: `createActionReviewSessionCodec`, `createFeishuReviewOAuthClient`.
- Consumes: Web Crypto-compatible Node `crypto`, injected `fetch`, app credentials and bounded URLs.

- [ ] **Step 1: Write failing Cookie tests**

```ts
const codec = createActionReviewSessionCodec({ secret: "x".repeat(32), now });
const transaction = codec.createOAuthTransaction("proposal-1");
expect(transaction.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
expect(codec.readOAuthTransaction(transaction.cookieValue, transaction.state)?.proposalId)
  .toBe("proposal-1");
expect(codec.readOAuthTransaction(tamper(transaction.cookieValue), transaction.state)).toBeUndefined();
```

Cover expiry, wrong state, wrong proposal, malformed base64/JSON, non-canonical numbers, secret below 32 bytes and clock boundaries.

- [ ] **Step 2: Implement signed canonical payloads and cookie serializers**

```ts
type ReviewSession = {
  sessionId: string;
  proposalId: string;
  actorOpenId: string;
  csrfToken: string;
  issuedAtMs: number;
  expiresAtMs: number;
};
```

Use random base64url values, HMAC-SHA256, `timingSafeEqual`, PKCE verifier length 64 and `S256`. Export exact set/clear cookie strings for the two `__Host-` cookies.

- [ ] **Step 3: Write failing OAuth client tests**

```ts
expect(client.buildAuthorizationUrl({ state, codeChallenge }).toString()).toContain(
  "code_challenge_method=S256",
);
await expect(client.exchangeCode({ code, codeVerifier })).resolves.toEqual({ actorOpenId: "ou_owner" });
```

Cover redirect URI exactness, token non-zero code, user-info non-zero code, wrong token type, missing open ID, response over budget, timeout, invalid JSON and secret-free error messages.

- [ ] **Step 4: Implement the client**

```ts
export type FeishuReviewOAuthClient = {
  buildAuthorizationUrl(input: { state: string; codeChallenge: string }): URL;
  exchangeCode(input: { code: string; codeVerifier: string }): Promise<{ actorOpenId: string }>;
};
```

POST `/open-apis/authen/v2/oauth/token`, then GET `/open-apis/authen/v1/user_info`. Use a fresh `AbortController` per request, 5,000 ms timeout, maximum 16 KiB JSON, and never include token/upstream body in thrown errors.

- [ ] **Step 5: Run tests**

Run: `npm --workspace apps/core test -- tests/action-review-session.test.ts tests/feishu-review-oauth-client.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/core/src/action-reviews/action-review-session.ts apps/core/src/action-reviews/feishu-review-oauth-client.ts apps/core/tests/action-review-session.test.ts apps/core/tests/feishu-review-oauth-client.test.ts
git commit -m "feat(core): add bounded Feishu review OAuth"
```

### Task 3: 安全完整正文页面

**Files:**
- Create: `apps/core/src/action-reviews/action-review-renderer.ts`
- Test: `apps/core/tests/action-review-renderer.test.ts`

**Interfaces:**
- Produces: `renderActionReviewPage`, `renderActionReviewRecordedPage`, `renderActionReviewUnavailablePage`, `actionReviewSecurityHeaders`.
- Consumes: `ActionReviewContext`, session CSRF token.

- [ ] **Step 1: Write failing renderer tests**

```ts
const html = renderActionReviewPage({ context, csrfToken: "csrf-1" });
expect(html).toContain("完整正文");
expect(html).toContain(context.contentHash);
expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
expect(html).not.toContain("<script>alert(1)</script>");
expect(html).not.toContain("ou_owner");
```

Assert no remote scripts/images/fonts, no nested cards, responsive single-column breakpoint, long hash wrapping, correct revision/version and exact form action.

- [ ] **Step 2: Implement one deterministic HTML renderer**

Render semantic `header`, `main`, `article`, `aside`, `dl` and one POST form. Escape `& < > " '` in every dynamic value. Put content in a `<pre>` with `white-space: pre-wrap; overflow-wrap: anywhere`.

- [ ] **Step 3: Add security headers**

```ts
export const actionReviewSecurityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};
```

- [ ] **Step 4: Run tests and commit**

Run: `npm --workspace apps/core test -- tests/action-review-renderer.test.ts`

Expected: PASS.

```bash
git add apps/core/src/action-reviews/action-review-renderer.ts apps/core/tests/action-review-renderer.test.ts
git commit -m "feat(core): render secure full draft reviews"
```

### Task 4: Review API、运行时与默认关闭配置

**Files:**
- Create: `apps/core/src/action-reviews/action-review-api.ts`
- Create: `apps/core/src/runtime/action-review-runtime.ts`
- Modify: `apps/core/src/config/env.ts`
- Modify: `apps/core/src/app.ts`
- Test: `apps/core/tests/action-review-api.test.ts`
- Test: `apps/core/tests/action-review-runtime.test.ts`
- Modify: `apps/core/tests/env.test.ts`

**Interfaces:**
- Produces: `registerActionReviewApi`, `createActionReviewRuntime`, `readActionReviewRuntimeConfig`.
- Consumes: session codec, OAuth client, renderer and `ActionApprovalRuntime.repository`.

- [ ] **Step 1: Write failing env/runtime tests**

```ts
expect(readActionReviewRuntimeConfig({})).toEqual({ enabled: false });
expect(() => readActionReviewRuntimeConfig({ IRIS_ACTION_REVIEW_ENABLED: "true" }))
  .toThrow(/IRIS_REVIEW_PUBLIC_ORIGIN/u);
```

Require exact HTTPS public origin, 32-byte session secret, Feishu credentials, exact authorize URL without credentials/query/fragment and existing open API base URL.

- [ ] **Step 2: Write failing API tests**

Cover:

```ts
expect(repository.getAuthorizedReviewContext).not.toHaveBeenCalled(); // initial unauthenticated GET
expect(start.statusCode).toBe(302);
expect(start.headers["set-cookie"]).toContain("__Host-iris_review_oauth=");

expect(callback.statusCode).toBe(303);
expect(callback.headers.location).toBe("/review/action-proposals/proposal-1");

expect(review.statusCode).toBe(200);
expect(attest.statusCode).toBe(200);
expect(repository.recordReviewAttestation).toHaveBeenCalledWith(expect.objectContaining({
  expectedContentHash: context.contentHash,
}));
```

Add wrong state, denied OAuth, missing code, tampered/expired cookies, wrong proposal session, CSRF, callback replay, unauthorized actor, revoked actor, stale context and no-runtime 404 tests.

- [ ] **Step 3: Implement API flow**

- Initial GET creates OAuth transaction and 302s to Feishu without querying Postgres.
- Callback validates state Cookie, clears it, exchanges code, performs the first authorized context query, creates the review session, then 303s back.
- Authenticated GET re-queries context and renders full body.
- POST validates form budget, signed session, CSRF, exact proposal and records attestation before rendering success.
- All errors render generic bounded pages; only safe classification reaches logs/audit.

- [ ] **Step 4: Wire runtime into `buildApp`**

Add optional dependency injection matching existing runtime patterns. Register routes only when runtime exists. Add bounded `application/x-www-form-urlencoded` parsing only for the attestation endpoint. Ensure startup cleanup and `onClose` include the runtime.

- [ ] **Step 5: Run tests**

Run: `npm --workspace apps/core test -- tests/env.test.ts tests/action-review-runtime.test.ts tests/action-review-api.test.ts tests/server-startup.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/core/src/action-reviews/action-review-api.ts apps/core/src/runtime/action-review-runtime.ts apps/core/src/config/env.ts apps/core/src/app.ts apps/core/tests/action-review-api.test.ts apps/core/tests/action-review-runtime.test.ts apps/core/tests/env.test.ts apps/core/tests/server-startup.test.ts
git commit -m "feat(core): expose authenticated action reviews"
```

### Task 5: 批准必须绑定当前审阅事实

**Files:**
- Modify: `apps/core/src/action-approvals/action-proposal-repository.ts`
- Modify: `apps/core/src/action-approvals/postgres-action-proposal-repository.ts`
- Modify: `apps/core/src/action-approvals/action-approval-worker.ts`
- Modify: `apps/core/src/runtime/action-approval-runtime.ts`
- Modify: `apps/core/src/knowledge-cards/approval-interaction-worker.ts`
- Test: `apps/core/tests/action-approval-worker.test.ts`
- Test: `apps/core/tests/postgres-action-review-repository.test.ts`
- Test: `apps/core/tests/approval-interaction-worker.test.ts`

**Interfaces:**
- Consumes: `requireReviewAttestation: boolean` on approval preflight and apply inputs.
- Produces: stable worker result `review_required` without business mutation.

- [ ] **Step 1: Write failing approval gate tests**

```ts
await expect(repository.applyApprovalAction({
  ...approvalInput,
  action: "approve",
  requireReviewAttestation: true,
})).rejects.toThrow(ActionProposalReviewRequiredError);
```

After recording exact attestation, the same approve succeeds. Wrong actor, old proposal version, old content hash and old subject version fail. `request_revision` and `reject` remain allowed without attestation.

- [ ] **Step 2: Enforce twice**

Add the review requirement to `preflightApprovalAction` for fast feedback and repeat it inside the final `applyApprovalAction` transaction immediately before inserting `action_approvals`.

- [ ] **Step 3: Map the stable callback result**

```ts
if (error instanceof ActionProposalReviewRequiredError) {
  return { kind: "rejected", reason: "review_required" };
}
```

The user-facing card message says “请先打开完整正文审阅页并完成审阅”，without exposing proposal existence or role details.

- [ ] **Step 4: Run tests and commit**

Run: `npm --workspace apps/core test -- tests/action-approval-worker.test.ts tests/approval-interaction-worker.test.ts tests/postgres-action-review-repository.test.ts`

Expected: PASS.

```bash
git add apps/core/src/action-approvals apps/core/src/runtime/action-approval-runtime.ts apps/core/src/knowledge-cards/approval-interaction-worker.ts apps/core/tests/action-approval-worker.test.ts apps/core/tests/approval-interaction-worker.test.ts apps/core/tests/postgres-action-review-repository.test.ts
git commit -m "feat(core): require exact review before approval"
```

### Task 6: Caddy、readiness 与 pilot 默认关闭门禁

**Files:**
- Modify: `deploy/pilot/Caddyfile`
- Modify: `deploy/pilot/docker-compose.yml`
- Modify: `deploy/pilot/ci.env`
- Modify: `apps/core/src/admin/internal-rollout-readiness.ts`
- Modify: `apps/core/tests/internal-rollout-readiness.test.ts`
- Modify: `scripts/pilot-compose.test.mjs`
- Modify: `scripts/pilot-smoke-lib.test.mjs`

**Interfaces:**
- Produces: exact public routing and readiness failure when enabled config is incomplete.

- [ ] **Step 1: Write failing routing/readiness tests**

Assert only these public review routes proxy:

```text
GET /review/action-proposals/*
GET /review/oauth/callback
POST /review/action-proposals/*/attest
```

Assert `/review`, extra suffixes, wrong methods and `/internal/*` return 404. Assert CI env keeps `IRIS_ACTION_REVIEW_ENABLED=false` and has no real secret.

- [ ] **Step 2: Update Caddy and Compose**

Use method+path matchers, not a broad `/review/*` proxy. Pass default-off envs to Core; never put a production session secret in tracked files.

- [ ] **Step 3: Add readiness checks**

When review is enabled require action approvals, knowledge cards, review origin, session secret, Feishu credentials, migration 0034 and a running review runtime. When disabled report `disabled` without requiring secrets.

- [ ] **Step 4: Run tests and commit**

Run: `npm --workspace apps/core test -- tests/internal-rollout-readiness.test.ts`

Run: `npm run test:pilot`

Expected: PASS.

```bash
git add deploy/pilot/Caddyfile deploy/pilot/docker-compose.yml deploy/pilot/ci.env apps/core/src/admin/internal-rollout-readiness.ts apps/core/tests/internal-rollout-readiness.test.ts scripts/pilot-compose.test.mjs scripts/pilot-smoke-lib.test.mjs
git commit -m "feat(pilot): gate public action review routes"
```

### Task 7: 文档、全量验证与 GitHub

**Files:**
- Modify: `docs/superpowers/specs/2026-07-19-iris-knowledge-approval-publication-design.md`
- Modify: `docs/superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md`
- Create: `docs/runbooks/iris-action-review-acceptance.md`
- Create: `docs/pull-requests/2026-07-22-iris-oauth-review-page.md`

**Interfaces:**
- Produces: default-off deployment, rollback and real Feishu acceptance contract.

- [ ] **Step 1: Update implementation status and migration numbering**

Record 5B-2A real pilot completion, 5B-2B code status, `0034_action_review_attestations.sql`, and reserve `0035_knowledge_publications.sql` for 5B-3. Do not mark 5B complete.

- [ ] **Step 2: Write the runbook**

Include exact preflight, backup, migration, SHA/image equality, default-off gates, OAuth redirect configuration, one medium-risk success case, unauthorized/stale/no-review negative cases, runtime disable, Caddy boundary, queue/DLQ zero and rollback steps.

- [ ] **Step 3: Run focused and full verification**

Run: `git diff --check`

Run: `npm run typecheck`

Run: `npm run build`

Run: `npm test`

Run: `npm run test:python`

Run: `npm run test:pilot`

Expected: all PASS.

- [ ] **Step 4: Verify the design and plan contain no placeholders**

Run: `rg -n "T[B]D|T[O]DO|待[定]|实现后[再]|稍后[补]" docs/superpowers/specs/2026-07-22-iris-oauth-review-page-design.md docs/superpowers/plans/2026-07-22-iris-oauth-review-page.md docs/runbooks/iris-action-review-acceptance.md`

Expected: no output.

- [ ] **Step 5: Commit and push**

```bash
git add docs/superpowers/specs/2026-07-19-iris-knowledge-approval-publication-design.md docs/superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md docs/superpowers/specs/2026-07-22-iris-oauth-review-page-design.md docs/superpowers/plans/2026-07-22-iris-oauth-review-page.md docs/runbooks/iris-action-review-acceptance.md docs/pull-requests/2026-07-22-iris-oauth-review-page.md
git commit -m "docs: define OAuth action review rollout"
git push -u origin codex/iris-oauth-review-page
```

- [ ] **Step 6: Open a stacked Draft PR**

Create a Draft PR from `codex/iris-oauth-review-page` to `codex/iris-approval-action-layer`. Do not merge either PR without explicit user authorization.

## Plan Self-Review

- Spec coverage: OAuth/PKCE、无 token 持久化、实时身份、完整正文与哈希、append-only attestation、回调二次门禁、Caddy 精确边界、默认关闭、自动和真实验收均有对应任务。
- Placeholder scan: no unfinished placeholder terms.
- Type consistency: repository、runtime、worker 和 API 统一使用 `proposalId/actorOpenId/proposalVersion/subjectRevision/subjectVersion/contentHash`。
- Scope: 不包含 5B-3 写知识库、完整 Admin Console、批量审阅或多租户。
