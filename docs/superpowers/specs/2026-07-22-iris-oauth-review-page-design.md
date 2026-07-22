# Iris 飞书 OAuth 完整正文审阅页设计

> 日期：2026-07-22  
> 状态：已按《Iris 知识草稿审批与发布设计》选定实现路径  
> 范围：Phase 5B-2B，不执行飞书知识库写入

## 1. 目标

为 `publish_knowledge_draft` 提供一个最小、已认证、可审计的完整正文审阅页，使负责人或管理员在批准前看到当前草稿修订版的完整正文、内容哈希、风险、目标和审批要求。

本阶段只补齐“知情审阅”事实。最终批准仍必须来自经过验证的飞书卡片回调；Web 页面不能创建批准或执行事实。

## 2. 已选方案

采用 Core 内置审阅模块：

1. 飞书审批卡片链接到 `/review/action-proposals/:proposalId`；
2. Core 发起飞书 OAuth Authorization Code + PKCE S256；
3. OAuth callback 换取短时 `user_access_token`，调用用户信息接口取得当前应用下的 `open_id`；
4. Core 不保存 access token 或 refresh token，只创建 15 分钟、HMAC 签名、HttpOnly 的本地审阅会话；
5. 每次显示正文前，Postgres 仓储实时复核 proposal、草稿版本、目标策略、证据状态和当前用户审批资格；
6. 用户在完整正文页点击“已完成审阅”，Core 写入绑定 proposal/version/revision/content hash/actor 的 append-only 审阅事实；
7. 飞书卡片批准回调在写 approval 的同一事务内要求存在当前审阅事实，并再次执行原有实时授权检查。

### 2.1 未选择的方案

- **独立前端与独立认证服务**：对 20-30 人内部 pilot 增加部署、密钥和会话故障面，当前没有收益。
- **只用签名链接展示正文**：链接持有者不等于当前审批人，违反“链接本身不是授权”。
- **页面直接批准**：会绕过飞书卡片回调的真实身份与统一 Approval Service，违反已批准架构。
- **只记录页面 GET**：浏览器预取或链接扫描器可能触发 GET，不能代表真人完成审阅。

## 3. 数据模型

新增 `0034_action_review_attestations.sql`。现有仓库已经占用 `0033_approval_interaction_intents.sql`，因此原总设计中将 5B-3 写成 `0033_knowledge_publications.sql` 的编号属于过期实施注记；5B-3 后续使用 `0035_knowledge_publications.sql`，不改变领域架构。

`action_review_attestations` 是 append-only 事实：

- `id`；
- `proposal_id`；
- `actor_open_id`；
- `subject_revision`；
- `subject_version`；
- `proposal_version`；
- `content_hash`，固定为小写 SHA-256；
- `session_id_hash`，不保存浏览器 session 原值；
- `operation_key` 与 `operation_fingerprint`；
- `reviewed_at`。

唯一约束覆盖 `(proposal_id, proposal_version, actor_open_id, content_hash)`。更新、删除和 truncate 全部由 append-only trigger 拒绝。

审阅事实不等于批准。proposal、草稿、策略、权限或正文变化后，旧事实因版本或哈希不匹配自动失效。

## 4. OAuth 与会话边界

### 4.1 配置

新增默认关闭配置：

- `IRIS_ACTION_REVIEW_ENABLED=false`；
- `IRIS_REVIEW_PUBLIC_ORIGIN`，pilot 为 `https://iris.quello.cn`；
- `IRIS_REVIEW_SESSION_SECRET`，至少 32 个 UTF-8 字节；
- `IRIS_FEISHU_OAUTH_AUTHORIZE_URL`，默认 `https://accounts.feishu.cn/open-apis/authen/v1/authorize`；
- 复用 `FEISHU_APP_ID`、`FEISHU_APP_SECRET` 和 `FEISHU_OPEN_BASE_URL`。

启用审阅页但缺少任何必要配置时，Core 启动失败；默认关闭时不读取或要求这些密钥。

### 4.2 OAuth 事务 Cookie

- 名称：`__Host-iris_review_oauth`；
- `Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=300`；
- HMAC-SHA256 签名；
- 只包含随机 state、proposal ID、PKCE verifier、签发和过期时间；
- callback 必须同时匹配 query state 与 Cookie state；
- 成功、拒绝或失败后都立即清除。

### 4.3 审阅会话 Cookie

- 名称：`__Host-iris_review_session`；
- `Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=900`；
- HMAC-SHA256 签名；
- 只包含随机 session ID、proposal ID、用户 open ID、CSRF token、签发和过期时间；
- 不包含飞书 access token、refresh token、草稿正文或审批理由。

Core 重启不影响签名会话；密钥轮换会使旧会话失效并要求重新登录，这是安全失败。

### 4.4 飞书调用

- token：`POST {FEISHU_OPEN_BASE_URL}/open-apis/authen/v2/oauth/token`；
- user info：`GET {FEISHU_OPEN_BASE_URL}/open-apis/authen/v1/user_info`；
- 两次调用都使用有界响应体和 5 秒超时；
- 只按 HTTP 状态和结构化 `code` 判断成功，不把上游正文、token 或用户信息写入普通日志；
- token 仅存在于单次 callback 的局部内存中，取得 open ID 后立即丢弃。

官方合同依据：

- https://open.larksuite.com/document/common-capabilities/sso/web-application-end-user-consent/guide
- https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token
- https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/authen-v1/user_info/get

## 5. 授权与正文读取

未认证请求不查询 proposal 是否存在，直接开始 OAuth，避免公开存在性探测。

认证后 `getAuthorizedReviewContext({ proposalId, actorOpenId })` 必须同时满足：

- proposal 为 `pending_approval`；
- 草稿为 `pending_review`，revision/version 与 proposal 精确一致；
- 目标策略启用且 version 精确一致；
- 当前修订版证据仍 current；
- 至少一个 pending 人工审批要求当前允许该 open ID：
  - `designated_owner` 必须精确等于该用户；
  - `iris_admin_or_authorized_owner` 必须实时读取当前 role grant；
- 当前内容存在且不超过事实层 100,000 字符上限。

任何失败都返回相同的 403 审阅不可用页，不区分 proposal 不存在、用户不匹配、撤权或 stale version。

展示字段只有：标题、完整正文、SHA-256 内容哈希、风险、草稿修订号、proposal 版本、目标可读名称、审批要求的类型与状态。页面不展示 open ID、证据原文、内部策略 token 或飞书 access token。

## 6. 页面与交互

公开路由精确为：

- `GET /review/action-proposals/:proposalId`；
- `GET /review/oauth/callback`；
- `POST /review/action-proposals/:proposalId/attest`。

页面使用服务端 HTML，无前端框架和第三方脚本。正文按纯文本 `white-space: pre-wrap` 展示并完整 HTML 转义，不解释其中的 Markdown/HTML。

页面结构面向工作审阅：紧凑标题区、状态摘要、正文主区域、风险与审批要求侧栏、内容哈希、明确的“已完成审阅”按钮。移动端变为单列，任何正文和哈希都能换行，不出现嵌套卡片。

POST 必须验证：签名 session、proposal 绑定、CSRF token、当前授权和精确内容哈希。成功后只显示“审阅已记录，请返回飞书卡片完成批准”，不提供 Web 批准按钮。

所有审阅响应设置：

- `Cache-Control: no-store`；
- `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`；
- `Referrer-Policy: no-referrer`；
- `X-Content-Type-Options: nosniff`；
- `X-Frame-Options: DENY`。

## 7. 批准回调门禁

当 `IRIS_ACTION_REVIEW_ENABLED=true`：

- `approve` 在 preflight 和最终事务中都必须找到当前 actor、proposal version、subject revision/version、content hash 的审阅事实；
- `request_revision` 和 `reject` 不要求审阅事实，用户始终可以安全地要求修改或拒绝；
- 缺少或过期审阅事实时返回稳定分类 `review_required`，不创建 approval、execution 或草稿状态变化；
- runtime 关闭、角色撤销或草稿变化仍优先按现有门禁 fail closed。

当该功能关闭时，5B-2A 的既有合同和测试保持不变。

## 8. Caddy 与公网边界

Caddy 只代理上述三个精确 review 路由、现有两个飞书回调和 `/health`。`/review` 的其他路径、方法以及所有 `/internal/*` 继续返回 404。

## 9. 测试与退出条件

自动化必须覆盖：

- OAuth URL、PKCE、state Cookie、过期、篡改、拒绝和 callback 重放；
- token/user-info 非零 code、超时、畸形与有界响应；
- 未认证时不查询 proposal；
- 精确 reviewer、管理员、授权 owner、撤权、stale proposal、失效证据；
- HTML 全转义、完整正文、哈希、无敏感字段、安全响应头和移动端布局约束；
- CSRF、proposal/session 交叉使用、重复 attestation 幂等；
- approve 无 attestation 时拒绝，有精确 attestation 时通过；
- request revision/reject 不受 attestation 阻塞；
- Postgres append-only、唯一约束、重启持久性；
- Caddy 精确路由和公网 `/internal/*` 404；
- 默认关闭、配置缺失 fail closed、Core/AI Worker CI success。

真实 pilot 退出条件：负责人从飞书卡片进入审阅页，完成 OAuth，看到唯一标记的完整正文与哈希，记录审阅后回卡片批准；撤权用户、stale 链接和未审阅直接批准均不能创建 approval。验收后恢复全局、群、审阅、知识卡片与行动门禁为关闭，Caddy 停止，所有队列和 DLQ 为 0。

## 10. 非目标

- 不在 Web 页面批准、要求修改或拒绝；
- 不保存或刷新 user access token；
- 不建设批量审阅、筛选、租户登录或完整 Admin Console；
- 不创建 `action_executions`；
- 不调用飞书知识库写接口；
- 不处理 Phase 5B-3 的发布、对账或结果回群。
