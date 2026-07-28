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

## Semantic Thread/Action Follow-up - 2026-07-26

- Candidate SHA: `c2bd13ca0f959d83eb8a877948748183a150d736`.
- PR #13 checks `Core` and `AI Worker` were both `SUCCESS` before deployment.
- Running Core and AI Worker image tags matched the candidate SHA after deployment.
- Fix added: V2 semantic extraction prompt now forbids reusing existing actions unless both the thread topic and concrete task match current evidence; otherwise it must create a new action bound to the current thread.
- Local verification passed: `python -m pytest workers/ai/tests/test_memory_extraction.py -q` (`67 passed`), `node --test --test-concurrency=1 scripts/pilot-operations.test.mjs` (`25 passed`), and `npm run typecheck`.
- Real internal replay remains blocked by provider availability: the Gamma internal acceptance replay created the first candidate thread, then the second model call failed with `upstream_status=503` and `classification=provider_unavailable`.
- Fail-closed state was restored and verified after the blocked replay: `globalEnabled=false`, `desiredGlobalEnabled=false`, `proactiveSpeech=false`, Caddy inactive, Core/Postgres/Redis/AI Worker healthy, and memory DLQ empty.
- Do not mark the semantic thread/action gate complete until Gemini is available and a fresh ordered replay passes the lifecycle/action inspector.

## Semantic Thread/Action Heartbeat - 2026-07-27 03:31 CST

- Read-only safety check passed before any model call: `globalEnabled=false`, `desiredGlobalEnabled=false`, `proactiveSpeech=false`, Caddy inactive, Core/Postgres/Redis/AI Worker healthy, memory extraction disabled/running=false, and memory DLQ empty.
- PR #13 checks were still green and the deployed VPS candidate remained `c2bd13ca0f959d83eb8a877948748183a150d736`.
- A single minimal provider probe succeeded with `status=200`, so a fresh isolated Delta internal acceptance marker was seeded.
- Ordered Delta replay did not pass: the first message created a candidate thread, then the second model call hit `upstream_status=429` with `classification=provider_rate_limited`.
- The replay stopped immediately; no further model retries were made. Delta request 02 was marked `skipped/provider_rate_limited_429`; later Delta requests remain pending for a future controlled replay.
- Final state remained fail-closed: `globalEnabled=false`, `desiredGlobalEnabled=false`, `proactiveSpeech=false`, Caddy inactive, memory extraction disabled/running=false, and memory DLQ empty.

## Semantic Thread/Action Heartbeat - 2026-07-27 05:31 CST

- Read-only safety check passed before any model call: `globalEnabled=false`, `desiredGlobalEnabled=false`, `proactiveSpeech=false`, Caddy inactive, Core/Postgres/Redis/AI Worker healthy, memory extraction disabled/running=false, and memory DLQ empty.
- PR #13 checks were still green and the deployed VPS candidate remained `c2bd13ca0f959d83eb8a877948748183a150d736`.
- A single minimal provider probe succeeded with `status=200`, so a fresh isolated Epsilon internal acceptance marker was seeded.
- Ordered Epsilon replay did not pass: the first replay request hit `upstream_status=429` with `classification=provider_rate_limited`.
- The replay stopped immediately; no further model retries were made. Epsilon request 01 was marked `skipped/provider_rate_limited_429`; later Epsilon requests remain pending for a future controlled replay.
- Final state remained fail-closed: `globalEnabled=false`, `desiredGlobalEnabled=false`, `proactiveSpeech=false`, Caddy inactive, memory extraction disabled/running=false, and memory DLQ empty.

## Semantic Thread/Action Heartbeat - 2026-07-27 17:04 CST

- Read-only safety preflight passed before the only provider probe: `globalEnabled=false`, `desiredGlobalEnabled=false`, `proactiveSpeech=false`, Caddy inactive, Core/Postgres/Redis/AI Worker healthy, memory extraction disabled/running=false, all event/document/reindex/memory pending and DLQ counts zero, and the semantic DLQ empty.
- The deployed candidate remained `c2bd13ca0f959d83eb8a877948748183a150d736`; running Core and AI Worker image tags matched that SHA. PR #13 head `ab9915814e7961db23e2b44e98ce7857504c0eee` still had successful `Core` and `AI Worker` checks.
- The one permitted minimal V2 provider probe succeeded with HTTP `200`.
- A fresh isolated Eta group and six append-only marker messages were then created with no pre-existing thread or action state. The six extraction requests were replayed strictly one at a time in original message order, waiting for all extraction queues to drain before each next request.
- All six provider requests completed successfully, but each returned zero memory, thread, action, resolution, and dependency candidates (`v3:p0:a0:r0:d0:c0`). The read-only lifecycle inspector therefore failed with zero qualifying threads; the Eta group also contained zero actions. This was initially recorded as a semantic empty-result acceptance failure; the byte-level evidence below later invalidated that classification.
- No further provider request was made after the failed lifecycle inspection. Append-only messages and run history were retained.
- Final fail-closed state was restored and rechecked: `globalEnabled=false`, `desiredGlobalEnabled=false`, `proactiveSpeech=false`, Caddy stopped, memory extraction disabled/running=false with blank thread/action allowlists, Core/Postgres/Redis/AI Worker healthy, all event/document/reindex/memory pending, processing, delayed, DLQ, and projection-repair counts zero, and Core/AI Worker still on the deployed candidate SHA.

## Eta Empty-Result Root Cause - 2026-07-27

- A byte-level Postgres readback showed that all six Eta `conversation_messages.text` values had already lost their Chinese text before extraction. Long runs of literal ASCII `?` (`0x3f`) occupied the missing spans; this was stored data, not terminal rendering.
- The prior `v3:p0:a0:r0:d0:c0` responses therefore do not establish a Gemini semantic failure. The provider received corrupted evidence and correctly produced no grounded operations.
- Zeta rows in the same database retained valid UTF-8 Chinese and had produced non-empty semantic operations, further isolating the fault to the Eta fixture insertion path.
- The seed and reseed helpers now read the persisted text before any registration, reset, deletion, or enqueue side effect and fail closed on Unicode replacement characters or long high-density runs of ASCII question marks.
- Eta history remains append-only and is not reused. The next gray run must use a fresh isolated marker, UTF-8/base64-safe transport, and byte-for-byte Postgres readback before the single provider replay window.
