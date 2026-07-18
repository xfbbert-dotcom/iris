# Iris Phase 5A 知识草稿事实层验收手册

> 适用范围：Phase 5A。本文只验收可审计的知识草稿中间层，不验收群内预览、用户确认、管理员批准、飞书发送或知识库发布。

## 1. 不可越过的边界

- 生产与真实飞书灰度开始前，必须确认 `globalEnabled=false`，并保持 Caddy stopped。
- Phase 5A 执行 **no model call**：创建和治理草稿不得调用 Gemini 或 AI Worker。
- Phase 5A 执行 **no answer retrieval**：草稿表、草稿修订及其内容不得进入回答检索或文档向量索引。
- Phase 5A 执行 **no Feishu send**：内部 API 不得向群聊发送草稿或通知。
- Phase 5A 执行 **no confirm/approve/publish route**：不存在确认、批准、发布、发送或写入知识库的路由。
- 证据失效后执行 **evidence invalidation redaction**：保留草稿元数据，但标题、正文、审核人与发布建议必须在读取结果中消失。
- 任一门禁失败后执行 **fail-closed rollback**：关闭全局运行时、停止边缘入口并记录失败，不把该能力判定为可用。

## 2. 验收环境

变更依赖 PR #8 的冻结事实层，数据库迁移必须按顺序执行到 `0030_knowledge_draft_facts.sql`。写入型验收只能在一次性 Postgres 验收库中执行；生产库只允许进行状态读取，避免留下测试草稿。

必需条件：

1. Core 镜像和待验收提交 SHA 完全一致。
2. Core、Postgres、Redis 健康，event/document/reindex/memory 队列与 DLQ 均为 0。
3. `IRIS_INTERNAL_API_TOKEN` 已配置，令牌只通过进程环境注入，不写入命令历史或验收日志。
4. 真实入口关闭；生产读取检查期间保持 `globalEnabled=false`。

## 3. 静态边界检查

在仓库根目录运行：

```powershell
npm run typecheck
npm test -- --run tests/knowledge-draft-state-machine.test.ts tests/knowledge-draft-api.test.ts tests/knowledge-draft-runtime.test.ts
rg -n "confirm|approve|publish|send|write" apps/core/src/knowledge-governance/knowledge-draft-api.ts
rg -n "knowledge_drafts|knowledge_draft_revisions" apps/core/src/agent apps/core/src/memory apps/core/src/documents
```

通过标准：

- 聚焦测试全部通过；
- 第一个 `rg` 不出现 Phase 5B 动作路由；
- 第二个 `rg` 不出现草稿事实被回答、记忆或文档检索读取；
- `knowledge-draft-api.ts` 不依赖模型提供方、飞书消息发送器或知识库写入适配器。

## 4. 一次性数据库验收

在专用验收库运行全部迁移，然后以应用角色启动 Core。不要复用生产数据库。

### 4.1 初始状态

调用：

```text
GET /internal/knowledge-drafts/status
```

应返回 `enabled=true`、`companyCreationEnabled=false` 和五种状态的非负计数。缺少数据库或内部鉴权时必须返回 503，不得退化为内存草稿。

### 4.2 创建与幂等

保持外部入口关闭，仅在内部测试进程中临时打开全局运行时、`generateKnowledgeDrafts` 能力和一个验收群。使用现存且当前有效的消息、thread/action 版本或文档来源作为证据：

```text
POST /internal/knowledge-drafts
GET /internal/knowledge-drafts
GET /internal/knowledge-drafts/:id
GET /internal/knowledge-drafts/:id/events
```

同一个 `operationKey` 和同一负载重放时必须返回 `already_applied`；复用相同 key 但改变负载必须返回 409。来源群被禁用后，新建必须返回 `knowledge_draft_generation_disabled`。

### 4.3 修订与治理

验证：

```text
POST /internal/knowledge-drafts/:id/revisions
POST /internal/knowledge-drafts/:id/request-revision
POST /internal/knowledge-drafts/:id/reject
```

每次变化必须增加版本、追加不可变事件，并要求正确的 `expectedVersion`。关闭新建门禁后，上述已有草稿治理仍可工作。`rejected` 为终态；Phase 5A 不得进入 `published`。

### 4.4 权限撤销与脱敏

对验收证据执行一种真实失效操作：撤销文档可读权限、改变来源 `updatedAt`、删除消息证据，或推进 thread/action 版本。随后再次读取草稿：

- `evidenceState.status=invalidated`，原因属于固定安全枚举；
- 草稿 ID、状态、版本、风险等级、作者和时间仍可审计；
- 响应中不存在标题、正文、reviewer、suggestedPublication 和证据正文；
- 旧修订同样不可绕过当前证据守卫读取内容；
- 任何后续修订写入都必须被 409 拒绝，不能把失效证据重新包装成有效内容。

## 5. Phase 5B 路由缺席

以下请求必须为 404，且不得产生数据库事件、模型调用、飞书消息或知识库写入：

```text
POST /internal/knowledge-drafts/:id/confirm
POST /internal/knowledge-drafts/:id/approve
POST /internal/knowledge-drafts/:id/publish
POST /internal/knowledge-drafts/:id/send
POST /internal/knowledge-drafts/:id/write
```

这项 404 是产品边界，不是待修复错误。群内确认和知识库发布由 Phase 5B 在独立批准后实现。

## 6. 失败回滚与退出条件

无论验收成功或失败，都要在 `finally` 路径中：

1. 设置 `globalEnabled=false`，关闭 `generateKnowledgeDrafts` 灰度能力；
2. 停止 Caddy，确认公开 `/internal/*` 仍不可访问；
3. 停止一次性 Core，销毁一次性数据库及其卷；
4. 确认所有生产队列和 DLQ 仍为 0；
5. 记录提交 SHA、迁移版本、通过项和失败原因。

只有静态边界、一次性数据库、证据撤销、幂等、状态机和回滚全部通过，才可判定 **Phase 5A code complete**。这不代表 IRIS-CORE-007、IRIS-CORE-008 或完整 Iris 已实现；真实群内预览、确认、审批和知识库幂等发布仍属于 Phase 5B。
