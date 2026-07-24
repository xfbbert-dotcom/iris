# Iris Phase 5B-2B 飞书 OAuth 完整正文审阅页

## 范围

本 PR 在 Phase 5B-2A 的 `ActionProposal` 与飞书审批卡片之上增加最小的完整正文审阅能力：

- 飞书 OAuth Authorization Code + PKCE S256；
- 5 分钟 OAuth 事务 Cookie 与 15 分钟签名审阅会话，不持久化 user token；
- 已认证用户的实时 proposal、版本、证据、目标策略和角色复核；
- 服务端渲染完整正文、内容哈希、风险、目标和审批要求；
- Postgres append-only `action_review_attestations`；
- 批准 preflight 与最终事务都要求当前 actor/version/revision/hash 的精确审阅事实；
- live readiness、迁移 `0034` 核对和 Caddy 三条精确公网路由。

本 PR 不创建 `action_executions`，不调用飞书知识库写接口，不实现 Phase 5B-3，也不宣称 Iris 全部核心功能完成。

## 安全边界

- `IRIS_ACTION_REVIEW_ENABLED=false` 为仓库和 pilot 默认值；session secret 不进入版本控制。
- 未认证 GET 不查询 proposal；链接本身不是授权。
- OAuth token 只存在于单次 callback 内存中，不持久化、不记录日志。
- Cookie 使用 `Secure; HttpOnly; SameSite=Lax; Path=/`，事务和会话均 HMAC 签名且有界。
- 展示、attest 和批准分别实时复核当前身份、grant、proposal、草稿、证据、策略、版本和哈希。
- request revision/reject 不受审阅事实阻塞；approve 缺少精确审阅事实时稳定返回 `review_required` 且无业务 mutation。
- Caddy 只开放三个精确 route/method 组合；错误方法、额外路径和所有 `/internal/*` 返回 `404`。
- live readiness CLI 只向 loopback/SSH 隧道端点发送内部 bearer，远端 HTTP/HTTPS 主机在 fetch 前被拒绝。

## 数据与迁移

- 新增 `0034_action_review_attestations.sql`，包含唯一约束和 update/delete/truncate append-only trigger。
- readiness 从真实 runtime 查询 `schema_migrations`，缺少 `0034` 时 fail closed。
- `0035_knowledge_publications.sql` 继续保留给 Phase 5B-3。

## Fresh 验证证据

- `npm run verify`：退出 `0`。
- Core typecheck 与 production build：通过。
- TypeScript：127 个文件通过、2 个条件跳过；2,253 passed、164 conditional skipped、0 failed。
- Python AI Worker：178 passed、0 failed。
- Pilot 运维与边界：123 passed、0 skipped、0 failed；包含固定 Caddy 镜像的真实 HTTP route/method 探测。
- 默认关闭 readiness：16/16 checks passed。
- 真实 Postgres action-review repository：12/12 passed、0 skipped；Task 5 绑定批准门禁组合测试为 70/70。
- Task 6 两轮定向独立复审最终结论：Critical 0、Important 0、Minor 0。
- `git diff --check`、根 Compose config 与 pilot Compose config：通过。

## 发布状态

- 代码候选和自动门禁完成。
- 真实飞书 OAuth pilot 尚未执行，本 PR 保持 Draft，功能保持默认关闭。
- 真实验收、回滚和零队列合同见 `docs/runbooks/iris-action-review-acceptance.md`。
- 5B-2A 已完成真实 Feishu pilot 并恢复默认关闭；5B-2B 真实 pilot 通过后才进入 5B-3。

## PR 关系

- Base：`codex/iris-approval-action-layer`（PR #12）
- Head：`codex/iris-oauth-review-page`
- 类型：Stacked Draft PR
- 合并：PR #12 与本 PR 均不得在没有用户明确授权时合并

## Real Pilot Acceptance - 2026-07-24

- Candidate SHA: `3d6797cbaee5c94d85ebc546a776b403bcda8153`.
- PR #13 head SHA matched the deployed candidate; GitHub checks `Core` and `AI Worker` were both `SUCCESS`.
- Running Core and AI Worker image tags matched the candidate SHA.
- Public boundary verified: `https://iris.quello.cn/health` returned `200`; public `/internal/status` returned `404`.
- Real Feishu OAuth review gate passed for the current action proposal: the designated reviewer opened the full-draft review route, completed OAuth review, and an append-only `action_review_attestations` fact was recorded for the current proposal version, subject revision, subject version, and content hash.
- The same Feishu approval card was then approved by the designated owner; the proposal reached `approved`, the owner requirement was satisfied, and the presentation was closed.
- No `action_executions` or `knowledge_publications` rows were created because `writeKnowledgeBase=false`; this PR still does not execute Feishu Wiki publication.
- Final fail-closed state restored: `globalEnabled=false`, `desiredGlobalEnabled=false`, the three known groups disabled, `proactiveSpeech=false`, `writeKnowledgeBase=false`, `callExternalTools=false`.
- Final queues/DLQs verified empty for event ingestion, document sync, reindex, knowledge cards, and action approval outbox.
