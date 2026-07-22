# Iris Phase 5B-2B 飞书 OAuth 完整正文审阅验收手册

> 本手册只验收 `publish_knowledge_draft` 的完整正文审阅事实和批准前门禁。它不创建 `action_executions`，不调用飞书知识库写接口，也不代表 Phase 5B 或 Iris 全部核心功能已经完成。

## 1. 验收边界

- 候选提交只有一个；Core 与 AI Worker 镜像标签必须精确等于该提交 SHA，GitHub Core/AI Worker checks 必须为 `success`。
- PR 保持 Draft，未经明确授权不得合并。
- 开始和结束时都必须满足：global 与全部已知群 disabled，`writeKnowledgeBase=false`，Caddy stopped，event/document/reindex/approval-interaction 队列和 DLQ 全为 `0`。
- 新门禁默认关闭：`IRIS_ACTION_REVIEW_ENABLED=false`，`IRIS_REVIEW_PUBLIC_ORIGIN=`，`IRIS_REVIEW_SESSION_SECRET=`。
- 任何 token、session secret、Cookie、草稿正文、证据正文、用户 open ID 和飞书响应正文都不得写入命令历史、普通日志、验收记录或 PR。
- 任一身份、版本、迁移、运行时、队列、数据库或公网边界检查失败，立即执行第 9 节回滚，不带病继续。
- 本阶段退出条件通过后直接进入 5B-3；非阻断的样式和性能改进进入后续清单，不延长 5B-2B。

## 2. 本地与 CI 退出门禁

在仓库根目录运行，全部退出 `0`：

```powershell
git diff --check
npm run typecheck
npm run build
npm test
npm run test:python
npm run test:pilot
npm run pilot:config
npm run readiness -- --env-file deploy/pilot/ci.env
```

`deploy/pilot/ci.env` 必须继续保持 review、action approval 和 knowledge card 默认关闭，且不得包含真实 session secret。自动门禁通过只允许默认关闭部署，不等于真实 OAuth 验收通过。

## 3. 部署前只读核对与备份

在 VPS 仓库目录设置本轮非敏感变量，敏感值只进入权限为 `600` 的 `.env.pilot`：

```bash
set -euo pipefail
candidate_sha="$(git rev-parse HEAD)"
test "$candidate_sha" = "$(git rev-parse origin/codex/iris-oauth-review-page)"
test "${IRIS_IMAGE_TAG:?}" = "$candidate_sha"

docker compose --env-file .env.pilot -f deploy/pilot/docker-compose.yml stop caddy
docker compose --env-file .env.pilot -f deploy/pilot/docker-compose.yml ps
```

确认 Core、Postgres、Redis、AI Worker healthy，Caddy stopped。通过内部 bearer 读取 `/internal/status`、`/internal/runtime-control/status`、`/internal/approval-interactions/status` 和 `/internal/action-approvals/status`：

- `globalEnabled=false` 且 `desiredGlobalEnabled=false`；
- pilot 与全部非 pilot 已知群均 disabled；
- `generateKnowledgeDrafts=false`、`writeKnowledgeBase=false`；
- event/document/reindex/approval-interaction 的 pending、processing、delayed、deadLetter 全为 `0`；
- knowledge-card/action-approval outbox 的 pending、processing、external_attempting、outcome_unknown、terminalFailed 全为 `0`；
- 不存在 `executing` 或 `reconciliation_required` proposal，不存在本轮 execution。

执行配对加密备份并记录其路径和校验值，不记录解密身份：

```bash
backup_file="$(deploy/pilot/backup.sh)"
test -s "$backup_file"
sha256sum "$backup_file"
```

## 4. 默认关闭部署与迁移

先在 `.env.pilot` 保持：

```text
IRIS_ACTION_REVIEW_ENABLED=false
IRIS_REVIEW_PUBLIC_ORIGIN=
IRIS_REVIEW_SESSION_SECRET=
```

构建同 SHA 镜像，运行迁移，再启动除 Caddy 外的服务：

```bash
docker compose --env-file .env.pilot -f deploy/pilot/docker-compose.yml build core ai-worker
docker image inspect "iris-core:$candidate_sha" >/dev/null
docker image inspect "iris-ai-worker:$candidate_sha" >/dev/null
docker compose --env-file .env.pilot -f deploy/pilot/docker-compose.yml up -d --wait postgres redis migrate core ai-worker
```

只读确认迁移历史精确包含且只包含一次 `0034_action_review_attestations.sql`，并确认 `action_review_attestations` 的 update/delete/truncate append-only trigger 已安装。不得修改已应用迁移。`0035_knowledge_publications.sql` 保留给 5B-3，本轮不得创建。

## 5. 飞书 OAuth 与功能配置

在飞书开放平台为 Iris 当前应用登记精确重定向地址：

```text
https://iris.quello.cn/review/oauth/callback
```

应用必须具备当前用户授权和读取用户身份所需权限，且使用与生产机器人相同的 `FEISHU_APP_ID`。不新增另一个身份系统，也不保存 user access token 或 refresh token。

生成独立的高熵 session secret，写入 `.env.pilot` 后不要回显：

```text
IRIS_KNOWLEDGE_CARD_ENABLED=true
IRIS_KNOWLEDGE_CARD_GROUP_IDS=<唯一 pilot 群 ID>
IRIS_APPROVAL_ACTIONS_ENABLED=true
IRIS_APPROVAL_ACTION_GROUP_IDS=<同一 pilot 群 ID>
IRIS_ACTION_REVIEW_ENABLED=true
IRIS_REVIEW_PUBLIC_ORIGIN=https://iris.quello.cn
IRIS_REVIEW_SESSION_SECRET=<至少 32 UTF-8 字节的独立随机密钥>
```

重建 Core，但仍保持 global 和所有群 disabled、Caddy stopped：

```bash
docker compose --env-file .env.pilot -f deploy/pilot/docker-compose.yml up -d --wait --force-recreate core
docker compose --env-file .env.pilot -f deploy/pilot/docker-compose.yml exec -T core \
  node apps/core/dist/admin/internal-rollout-readiness-cli.js \
  --live-readiness-url http://127.0.0.1:3000/internal/readiness
```

只有输出 `status=ready`、`actionReviews=pass`、runtime running 且 migration 0034 applied 时才能继续。随后启动 Caddy，并从公网验证：

- `GET /health` 为 `200`；
- 所有 `/internal/*` 为 `404`；
- `GET /review/action-proposals/<单段 proposal ID>`、`GET /review/oauth/callback`、`POST /review/action-proposals/<单段 proposal ID>/attest` 能到达 Core；
- `/review`、尾随斜杠、额外路径段和错误方法均为 `404`。

最后只开启唯一 pilot 群和 global；所有非 pilot 群持续 disabled，`writeKnowledgeBase` 持续为 `false`。

## 6. 真实飞书验收矩阵

每个用例使用独立草稿和唯一无敏感测试标记；一次只操作一张最新卡片，等全部在途计数归零后再进行下一例。

### 6.1 中风险成功闭环

1. 在 pilot 群产生并确认一个 medium-risk 草稿，使其生成唯一 pending proposal 和指定负责人审批卡片。
2. 负责人从卡片打开审阅链接，完成飞书 OAuth。
3. 页面必须显示当前草稿的完整正文、标题、风险、目标、要求、revision、proposal version 和 64 位小写 SHA-256；正文中的 HTML/Markdown 只作为转义纯文本显示。
4. 点击“已完成审阅”后，只新增一条绑定当前 actor/proposal version/revision/subject version/content hash 的 append-only attestation。
5. 返回原飞书卡片批准。只新增一条 approval，proposal 进入 `approved`；不创建 execution，不写 Wiki。
6. 重复 attest 或重复 callback 不产生重复事实。

### 6.2 未审阅批准

指定负责人不打开审阅页，直接点击批准。结果必须为稳定的 `review_required`，不新增 approval、execution 或草稿状态变化；要求修改和拒绝仍可正常 fail-safe 使用。

### 6.3 未授权与撤权

1. 非指定负责人打开相同链接并完成 OAuth，只能看到统一 403 不可用页，不泄露 proposal 是否存在、正文、角色或 open ID，不新增 attestation。
2. 对 high-risk 用例，在页面打开后撤销当前管理员或授权 owner grant，再 attest 或批准，必须 fail closed；旧页面和旧 Cookie 不能放行。

### 6.4 stale 与精确绑定

负责人打开并看到页面后，推进草稿 revision/version、目标策略 version 或 proposal version。旧页面提交必须被拒绝，旧 attestation 不能满足新版本批准；当前版本重新 OAuth/审阅后才可批准。

### 6.5 runtime disable

在页面打开后 durable-disable pilot 群或 global。后续 attest 与飞书批准都必须拒绝且无业务 mutation。恢复前必须重新执行 live readiness 和零队列检查，不能依赖旧会话。

## 7. 数据与无泄密核对

只查询 ID、版本、哈希、状态、时间和计数，不选择草稿正文、证据正文、Cookie、token 或审批理由：

```sql
SELECT count(*) FROM schema_migrations
WHERE name = '0034_action_review_attestations.sql';

SELECT proposal_id, proposal_version, subject_revision, subject_version,
       content_hash, count(*)
FROM action_review_attestations
GROUP BY proposal_id, proposal_version, subject_revision, subject_version, content_hash
ORDER BY proposal_id, proposal_version;

SELECT status, count(*) FROM action_proposals GROUP BY status ORDER BY status;
SELECT count(*) AS approval_count FROM action_approvals;
SELECT count(*) AS execution_count FROM action_executions;
```

核对普通日志没有 access token、refresh token、session Cookie、session secret、正文、证据原文或 open ID。最终所有队列/DLQ 和阻断型 outbox 计数为 `0`。

## 8. 退出证据

私有部署日志与 Draft PR 只记录：候选 SHA、同 SHA 镜像、CI 状态、备份校验值、0034 存在、用例通过/失败、无敏感计数、最终零队列和回滚完成状态。真实身份和正文只保留在飞书与受控 Postgres 事实中。

只有第 6 节全部通过、第 7 节一致且第 9 节安全回收完成，5B-2B 才可标记“真实 pilot 通过”。在此之前只能称“代码候选与自动门禁完成”。

## 9. 回滚与安全回收

完成或任一失败时按固定顺序：

1. durable-disable global 和 pilot 群，设置 `generateKnowledgeDrafts=false`、`writeKnowledgeBase=false`。
2. 停止 Caddy 并从公网确认 review 与 internal 入口不可达。
3. 将 `.env.pilot` 恢复为 review/action/card disabled、两个群 allowlist 为空、review origin 和 session secret 为空；重建 Core。
4. 确认 live status/readiness 显示安全关闭，等待所有队列/DLQ 和阻断型 outbox 计数归零。
5. 保留 append-only proposal、approval、attestation 和 event 审计事实，不手工删除或改写。
6. 如迁移或数据一致性失败，使用第 3 节配对加密备份和 `deploy/pilot/restore-from-stdin.sh` 恢复；restore 只启动 Core，Caddy 必须最后单独启动。
7. 再次确认 `action_executions=0`、没有本轮 Wiki 节点/文档写入、候选 SHA 未变化。
