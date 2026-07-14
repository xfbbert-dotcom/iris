# Iris 群长期记忆 Phase 3A 验收手册

## 1. 验收边界

本手册只验收 Phase 3A：可持久化、可追溯、可纠错、可删除、严格按当前群隔离的长期记忆事实层，以及回答时检索。

本阶段不包含从群聊自动抽取记忆。记忆通过受保护的内部 API 由操作员创建；自动抽取属于 Phase 3B。

## 2. 前置条件

- 候选提交已通过 `npm run verify` 和真实 Postgres 集成测试。
- Core 使用 Postgres 持久化运行时控制，所有 `/internal/*` 请求携带 `IRIS_INTERNAL_API_TOKEN`。
- 测试群已启用，`readGroupContext=true`，全局 Iris 已按验收环境策略启用。
- 准备两个不同群：目标群 `GROUP_A` 和隔离对照群 `GROUP_B`。
- 在 `GROUP_A` 发送两条唯一文本消息，记为 `MESSAGE_A1`、`MESSAGE_A2`；在 `GROUP_B` 发送一条消息，记为 `MESSAGE_B1`。
- 从 `conversation_messages` 只读查询以上消息对应的内部 `id`，不要使用飞书展示文本代替证据 ID。

建议在隔离测试环境设置：

```bash
export BASE_URL=http://127.0.0.1:3000
export TOKEN='<IRIS_INTERNAL_API_TOKEN>'
export OPERATOR='phase-3a-acceptance'
export GROUP_A='<target-chat-id>'
export GROUP_B='<other-chat-id>'
export MESSAGE_A1='<conversation-message-id-1>'
export MESSAGE_A2='<conversation-message-id-2>'
export MESSAGE_B1='<other-group-conversation-message-id>'
```

## 3. 创建与同群证据门禁

创建目标群记忆：

```bash
curl --fail-with-body -X POST "$BASE_URL/internal/group-memories" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Iris-Operator: $OPERATOR" \
  -H 'Content-Type: application/json' \
  --data "{\"groupId\":\"$GROUP_A\",\"scope\":\"group\",\"category\":\"decision\",\"content\":\"IRIS_MEMORY_ACCEPTANCE_ORIGINAL\",\"importance\":5,\"confidence\":1,\"idempotencyKey\":\"phase-3a-create-1\",\"evidenceMessageIds\":[\"$MESSAGE_A1\",\"$MESSAGE_A2\"]}"
```

记录返回的 `memory.id` 为 `MEMORY_ORIGINAL`。再次提交完全相同的请求，必须返回同一 ID 且 `created=false`；保持同一 `groupId + idempotencyKey` 但修改正文或证据时，必须返回 `409 group_memory_idempotency_conflict`。

再用 `GROUP_A` 配合 `MESSAGE_B1` 创建记忆，必须失败，且数据库中不得出现该记忆。这证明证据不能跨群绑定。

## 4. 回答检索与 Context Anchor

请求内部回答，显式使用 `GROUP_A`，并把 `fragmentLimit` 设为 0，以证明长期记忆不依赖文档召回：

```bash
curl --fail-with-body -X POST "$BASE_URL/internal/answer-drafts" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data "{\"question\":\"只回答长期记忆验收暗号\",\"chatId\":\"$GROUP_A\",\"fragmentLimit\":0,\"liveChatMessages\":[{\"speaker\":\"验收员\",\"text\":\"请使用当前群背景。\"}]}"
```

必须同时满足：

- `usedGroupMemories` 只包含 `MEMORY_ORIGINAL`，并携带 `MESSAGE_A1`、`MESSAGE_A2`。
- `promptContext` 顺序为 `<background_documents>`、`<group_memories>`、`<live_chat_context>`。
- 最后一个关闭标签是 `</live_chat_context>`。
- 使用 `GROUP_B` 或不传 `chatId` 时，`usedGroupMemories=[]`，不得出现目标群记忆正文。

## 5. 运行时禁用立即生效

关闭群上下文读取：

```bash
curl --fail-with-body -X PATCH "$BASE_URL/internal/runtime-control/capabilities" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Iris-Operator: $OPERATOR" \
  -H 'Content-Type: application/json' \
  --data '{"readGroupContext":false}'
```

重复第 4 节回答请求，必须得到 `usedGroupMemories=[]`，且提示词和回答不得出现 `IRIS_MEMORY_ACCEPTANCE_ORIGINAL`。然后把 `readGroupContext` 恢复为 `true`，确认记忆重新可用。

## 6. 纠错与删除

创建纠错版本：

```bash
curl --fail-with-body -X POST "$BASE_URL/internal/group-memories/$MEMORY_ORIGINAL/corrections" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Iris-Operator: $OPERATOR" \
  -H 'Content-Type: application/json' \
  --data "{\"content\":\"IRIS_MEMORY_ACCEPTANCE_CORRECTED\",\"idempotencyKey\":\"phase-3a-correct-1\",\"evidenceMessageIds\":[\"$MESSAGE_A2\"]}"
```

记录新 ID 为 `MEMORY_CORRECTED`。随后回答必须只使用 `IRIS_MEMORY_ACCEPTANCE_CORRECTED`；旧值不得出现在 active 记忆、提示词或回答中。查询全部记忆时，旧版本必须为 `superseded`，新版本必须为 `active`。

删除新版本：

```bash
curl --fail-with-body -X DELETE "$BASE_URL/internal/group-memories/$MEMORY_CORRECTED" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Iris-Operator: $OPERATOR"
```

再次回答时，新旧两个验收暗号都不得出现，`usedGroupMemories=[]`。再次删除同一 ID 必须返回 404。

## 7. 最终安全门禁

验收结束前必须确认：

- `/internal/status` 中 event、document sync、reindex 的 pending 与 DLQ 全为 0。
- `group_memory_created`、`group_memory_corrected`、`group_memory_deleted` 审计事件存在。
- 审计摘要只包含记忆 ID、证据消息 ID 和操作员提示，不包含记忆正文。
- Postgres 中删除的 replacement 及其 evidence 关联已经物理消失。
- 尝试直接删除仍被 active 记忆引用的 `conversation_messages` 时，Postgres 必须拒绝外键删除；不得留下无证据 active 记忆。
- `readGroupContext` 已恢复到验收前状态。
- 任一步失败都不得继续宣称 Phase 3A 通过；保持 Iris fail closed 并保存响应、审计和队列状态。
