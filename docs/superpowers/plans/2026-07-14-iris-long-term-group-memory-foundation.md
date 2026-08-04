# Iris Long-Term Group Memory Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Iris 增加可持久化、可追踪、可纠错、可删除、严格按当前群隔离的长时记忆事实层，并把 active 记忆接入回答上下文。

**Architecture:** TypeScript Core 继续拥有产品行为和事实层。Postgres 保存 group/thread/action memory 及其原始群消息证据；回答运行时通过当前 `chatId` 读取 active 记忆，不进行跨群查询。这个阶段提供受内部 API 保护的创建、查询、纠错和删除能力；Python 自动抽取和 Redis 异步队列属于紧随其后的 3B 阶段，不在本计划中伪装实现。

**Tech Stack:** TypeScript 5、Fastify、Postgres 16、Vitest、现有 `pg` Queryable 和 `npm run verify` 门禁。

## Global Constraints

- `2026-06-30-iris-architecture-whitepaper.md` 是最高架构依据；本计划不得改变其权限、知识权威、部署或多租户边界。
- 当前仅允许读取请求 `chatId` 对应群的记忆；不得实现跨群检索。
- 每条新记忆必须至少绑定一条 `conversation_messages` 证据，并验证证据消息属于同一群。
- 证据消息被记忆引用时不得单独删除；必须先在同一治理流程中删除或失效相关记忆，避免 active 记忆失去证据。
- 长时记忆是语义辅助，不是事实权威；提示词必须携带 memory ID 和 evidence message IDs。
- 纠错必须创建新版本并让旧版本立即退出 active 检索；删除必须物理删除记忆和关联证据。
- `readGroupContext=false`、群被禁用或全局禁用时，回答运行时不得读取该群长时记忆。
- 最近原始群聊仍是 Context Anchor，必须位于提示词最底部；记忆不能稀释或覆盖 live chat。
- 单次回答最多注入 8 条 active 记忆；单条格式化内容最多 600 字符。
- 所有写操作必须有最大长度、有限数值、幂等键和内部 API 认证；不得记录记忆正文到审计摘要。
- 幂等重放必须比较持久化的规范化请求 SHA-256；纠错请求省略可选字段与显式传入相同最终值属于不同请求，必须返回冲突。

---

### Task 1: Postgres 记忆事实表

**Files:**
- Create: `apps/core/migrations/0017_group_memories.sql`
- Modify: `apps/core/tests/migration-runner.test.ts`

**Interfaces:**
- Produces: `group_memories` and `group_memory_message_evidence` tables for Tasks 2-6.

- [ ] **Step 1: Write the failing migration contract test**

在 `migration-runner.test.ts` 中断言迁移列表包含 `0017_group_memories.sql`，并检查 SQL 定义以下约束：

```ts
expect(sql).toContain("CREATE TABLE IF NOT EXISTS group_memories");
expect(sql).toContain("UNIQUE (group_id, idempotency_key)");
expect(sql).toContain("REFERENCES conversation_messages(id) ON DELETE RESTRICT");
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm --workspace apps/core test -- migration-runner.test.ts`

Expected: FAIL because migration `0017_group_memories.sql` does not exist.

- [ ] **Step 3: Add the migration**

Create two normalized tables:

```sql
CREATE TABLE IF NOT EXISTS group_memories (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL CHECK (char_length(group_id) BETWEEN 1 AND 512),
  memory_scope TEXT NOT NULL CHECK (memory_scope IN ('group', 'thread', 'action')),
  category TEXT NOT NULL CHECK (
    category IN ('project', 'preference', 'person', 'term', 'workflow', 'decision', 'action', 'summary')
  ),
  thread_key TEXT CHECK (thread_key IS NULL OR char_length(thread_key) BETWEEN 1 AND 512),
  content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 4000),
  importance SMALLINT NOT NULL CHECK (importance BETWEEN 1 AND 5),
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded')),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 512),
  origin TEXT NOT NULL CHECK (origin IN ('extractor', 'operator', 'system')),
  created_by TEXT NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 512),
  supersedes_memory_id TEXT REFERENCES group_memories(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_id, idempotency_key),
  CHECK (
    (memory_scope = 'thread' AND thread_key IS NOT NULL)
    OR (memory_scope <> 'thread' AND thread_key IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS group_memory_message_evidence (
  memory_id TEXT NOT NULL REFERENCES group_memories(id) ON DELETE CASCADE,
  conversation_message_id TEXT NOT NULL REFERENCES conversation_messages(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (memory_id, conversation_message_id)
);
```

Add indexes for `(group_id, status, importance DESC, updated_at DESC, id ASC)`, `supersedes_memory_id`, and evidence message lookup.

- [ ] **Step 4: Run migration tests and real Postgres integration**

Run: `npm --workspace apps/core test -- migration-runner.test.ts`

Expected: PASS.

Run the existing isolated Postgres test procedure and verify all migrations apply with application-role DML access and without DDL access.

- [ ] **Step 5: Commit**

```bash
git add apps/core/migrations/0017_group_memories.sql apps/core/tests/migration-runner.test.ts
git commit -m "feat: add durable group memory schema"
```

### Task 2: GroupMemoryRepository and Postgres implementation

**Files:**
- Create: `apps/core/src/memory/group-memory-repository.ts`
- Create: `apps/core/src/memory/postgres-group-memory-repository.ts`
- Create: `apps/core/tests/postgres-group-memory-repository.test.ts`

**Interfaces:**
- Produces:

```ts
export type GroupMemoryScope = "group" | "thread" | "action";
export type GroupMemoryCategory =
  | "project" | "preference" | "person" | "term"
  | "workflow" | "decision" | "action" | "summary";

export type GroupMemory = {
  id: string;
  groupId: string;
  scope: GroupMemoryScope;
  category: GroupMemoryCategory;
  threadKey?: string;
  content: string;
  importance: number;
  confidence: number;
  status: "active" | "superseded";
  idempotencyKey: string;
  origin: "extractor" | "operator" | "system";
  createdBy: string;
  supersedesMemoryId?: string;
  evidenceMessageIds: string[];
  createdAt: Date;
  updatedAt: Date;
};

export interface GroupMemoryRepository {
  create(input: CreateGroupMemoryInput): Promise<{ memory: GroupMemory; created: boolean }>;
  getById(id: string): Promise<GroupMemory | undefined>;
  listActiveByGroup(input: { groupId: string; limit: number }): Promise<GroupMemory[]>;
  listByGroup(input: { groupId: string; limit: number }): Promise<GroupMemory[]>;
  correct(input: CorrectGroupMemoryInput): Promise<{ memory: GroupMemory; created: boolean }>;
  deleteById(id: string): Promise<"deleted" | "not_found">;
}
```

- [ ] **Step 1: Write repository tests first**

Cover create, duplicate idempotency, same-group evidence validation, missing evidence rejection, cross-group evidence rejection, active ordering, bounded limits, atomic correction, idempotent correction, hard delete, row mapping and cloned arrays/dates.

- [ ] **Step 2: Verify RED**

Run: `npm --workspace apps/core test -- postgres-group-memory-repository.test.ts`

Expected: FAIL because repository modules do not exist.

- [ ] **Step 3: Implement repository with transactions**

Use `randomUUID()` for IDs. Before insert, select every evidence message by ID and verify count and `chat_id` match `groupId`. Create and correction must use `BEGIN`/`COMMIT`, and `ROLLBACK` on every failure. Duplicate `(group_id, idempotency_key)` 只有在持久化的规范化请求 SHA-256 完全一致时返回已有记忆；同键不同请求必须返回幂等冲突，不得误报成功。新增 `0018_group_memory_request_fingerprints.sql` 为既有试验数据写入不可匹配的 fail-closed 占位指纹，禁止根据最终记忆状态猜测历史请求。

Correction transaction order:

```text
lock original memory FOR UPDATE
-> if correction idempotency key already exists, verify it belongs to this exact correction; otherwise reject conflict
-> verify original is active
-> reuse original evidence plus any new evidence
-> insert replacement with supersedes_memory_id
-> mark original superseded
-> commit
```

Do not expose a query that can list memories without `groupId`.

- [ ] **Step 4: Verify GREEN**

Run: `npm --workspace apps/core test -- postgres-group-memory-repository.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/memory/group-memory-repository.ts apps/core/src/memory/postgres-group-memory-repository.ts apps/core/tests/postgres-group-memory-repository.test.ts
git commit -m "feat: add group memory repository"
```

### Task 3: Validation service and auditable mutations

**Files:**
- Create: `apps/core/src/memory/group-memory-service.ts`
- Create: `apps/core/tests/group-memory-service.test.ts`
- Modify: `apps/core/src/audit/audit-log.ts`
- Modify: `apps/core/tests/audit-log.test.ts`

**Interfaces:**
- Consumes: `GroupMemoryRepository` from Task 2.
- Produces: `GroupMemoryService` with `create`, `list`, `correct`, and `delete` methods.

- [ ] **Step 1: Write failing service tests**

Test blank/oversized IDs, content, thread key, createdBy and idempotency key; finite confidence; integer importance; deduplicated evidence IDs; unsupported enum values; repository error normalization; and audit records that contain memory IDs/evidence IDs but never content.

- [ ] **Step 2: Verify RED**

Run: `npm --workspace apps/core test -- group-memory-service.test.ts audit-log.test.ts`

Expected: FAIL because service and memory audit event types do not exist.

- [ ] **Step 3: Implement validation and audit events**

Extend `AuditEvent` with:

```ts
type GroupMemoryAuditEvent = {
  type: "group_memory_created" | "group_memory_corrected" | "group_memory_deleted";
  documentId: string;
  fragmentIds: string[];
  operatorHint?: string;
  message?: string;
};
```

Use `documentId` for the memory ID and `fragmentIds` for evidence message IDs. Audit write failure must not roll back an already committed safe memory mutation, but the service must surface it through a provided non-throwing observer.

- [ ] **Step 4: Verify GREEN**

Run: `npm --workspace apps/core test -- group-memory-service.test.ts audit-log.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/memory/group-memory-service.ts apps/core/tests/group-memory-service.test.ts apps/core/src/audit/audit-log.ts apps/core/tests/audit-log.test.ts
git commit -m "feat: govern group memory mutations"
```

### Task 4: Internal memory API and runtime composition

**Files:**
- Create: `apps/core/src/memory/group-memory-api.ts`
- Create: `apps/core/tests/group-memory-api.test.ts`
- Modify: `apps/core/src/runtime/answer-draft-runtime.ts`
- Modify: `apps/core/src/app.ts`
- Modify: `apps/core/tests/answer-draft-runtime.test.ts`

**Interfaces:**
- Consumes: `GroupMemoryService` from Task 3.
- Produces protected endpoints:
  - `GET /internal/group-memories?groupId=<id>&limit=<1..100>`
  - `POST /internal/group-memories`
  - `POST /internal/group-memories/:id/corrections`
  - `DELETE /internal/group-memories/:id`

- [ ] **Step 1: Write failing API tests**

Test internal bearer authentication, body budget, invalid JSON, validation errors as 400, not-found correction/delete as 404, repository failures as bounded 500 responses, no content in errors, idempotent create response, and query isolation requiring `groupId`.

- [ ] **Step 2: Verify RED**

Run: `npm --workspace apps/core test -- group-memory-api.test.ts answer-draft-runtime.test.ts`

Expected: FAIL because routes and runtime service do not exist.

- [ ] **Step 3: Implement API plugin and composition**

`registerGroupMemoryApi(app, service)` registers only `/internal/*` routes, so the existing `onRequest` bearer gate applies. Extend `AnswerDraftRuntime` to expose `groupMemoryService`; create repository/service from the same Postgres pool already owned by that runtime. `buildApp` receives either an injected service or `answerDraftRuntime.groupMemoryService` and passes it to the plugin. Pool ownership and close order remain unchanged.

`x-iris-operator` is required for create/correct/delete and bounded to 512 characters.

- [ ] **Step 4: Verify GREEN**

Run: `npm --workspace apps/core test -- group-memory-api.test.ts answer-draft-runtime.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/memory/group-memory-api.ts apps/core/tests/group-memory-api.test.ts apps/core/src/runtime/answer-draft-runtime.ts apps/core/src/app.ts apps/core/tests/answer-draft-runtime.test.ts
git commit -m "feat: expose protected group memory controls"
```

### Task 5: Context assembly with current-group memories

**Files:**
- Modify: `apps/core/src/memory/context-assembly.ts`
- Modify: `apps/core/tests/context-assembly.test.ts`
- Create: `apps/core/src/memory/group-memory-context-provider.ts`
- Create: `apps/core/tests/group-memory-context-provider.test.ts`

**Interfaces:**
- Produces:

```ts
export type PromptGroupMemory = {
  id: string;
  scope: GroupMemoryScope;
  category: GroupMemoryCategory;
  content: string;
  evidenceMessageIds: string[];
};

export interface GroupMemoryContextProvider {
  loadActiveMemories(input: { groupId: string; limit?: number }): Promise<PromptGroupMemory[]>;
}
```

- [ ] **Step 1: Write failing provider and assembly tests**

Assert current-group repository calls, max 8 items, blank filtering, defensive cloning, XML escaping, 600-character item cap, bounded ID/evidence attributes, and exact prompt order:

```xml
<background_documents>...</background_documents>
<group_memories>...</group_memories>
<live_chat_context>...</live_chat_context>
```

The last closing tag must remain `</live_chat_context>`.

- [ ] **Step 2: Verify RED**

Run: `npm --workspace apps/core test -- group-memory-context-provider.test.ts context-assembly.test.ts`

Expected: FAIL because group memory context is unsupported.

- [ ] **Step 3: Implement provider and bounded XML assembly**

Format each item as:

```xml
<memory id="..." scope="group" category="decision" evidence_message_ids="msg-1,msg-2">...</memory>
```

Use existing XML escaping and bounded formatting helpers; do not duplicate incompatible escaping logic.

- [ ] **Step 4: Verify GREEN**

Run: `npm --workspace apps/core test -- group-memory-context-provider.test.ts context-assembly.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/memory/context-assembly.ts apps/core/tests/context-assembly.test.ts apps/core/src/memory/group-memory-context-provider.ts apps/core/tests/group-memory-context-provider.test.ts
git commit -m "feat: assemble bounded group memory context"
```

### Task 6: Answer-time retrieval and runtime permission gate

**Files:**
- Modify: `apps/core/src/memory/document-retrieval-context.ts`
- Modify: `apps/core/tests/document-retrieval-context.test.ts`
- Modify: `apps/core/src/agent/answer-draft-orchestrator.ts`
- Modify: `apps/core/tests/answer-draft-orchestrator.test.ts`
- Modify: `apps/core/src/runtime/answer-draft-runtime.ts`
- Modify: `apps/core/tests/answer-draft-runtime.test.ts`

**Interfaces:**
- Consumes: `GroupMemoryContextProvider` from Task 5.
- Extends `DocumentRetrievalContextResult` and `AnswerDraftResult` with `usedGroupMemories`.

- [ ] **Step 1: Write failing integration tests**

Cover:

1. `chatId` loads only that group's active memories.
2. no `chatId` loads no memories.
3. `readGroupContext=false`, disabled group, or global disabled loads no memories.
4. memory still loads when `fragmentLimit=0` because document recall and group memory are separate layers.
5. repository failure fails the draft closed instead of silently answering with incomplete long-term context.
6. result metadata exposes IDs/evidence but preserves live chat as final prompt section.

- [ ] **Step 2: Verify RED**

Run: `npm --workspace apps/core test -- document-retrieval-context.test.ts answer-draft-orchestrator.test.ts answer-draft-runtime.test.ts`

Expected: FAIL because memory provider is not wired.

- [ ] **Step 3: Wire current-group memory retrieval**

Normalize `input.chatId` independently from document permission mode. Wrap the provider with a runtime gate using `canReadGroupContext(groupId)` and `canProcessGroupMessage(groupId)`. Pass the current group ID into the context builder; never accept a second group ID from the request body.

Load group memories before either the zero-document path or semantic document query, then pass them to `assemblePromptContext`. Return defensive copies in metadata.

- [ ] **Step 4: Verify GREEN and full suite**

Run: `npm --workspace apps/core test -- document-retrieval-context.test.ts answer-draft-orchestrator.test.ts answer-draft-runtime.test.ts`

Expected: PASS.

Run: `npm run verify`

Expected: typecheck, build, Core, Python, Pilot, Compose and readiness all PASS.

Run isolated Postgres integration with migration `0017` and verify zero skipped Core tests.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/memory/document-retrieval-context.ts apps/core/tests/document-retrieval-context.test.ts apps/core/src/agent/answer-draft-orchestrator.ts apps/core/tests/answer-draft-orchestrator.test.ts apps/core/src/runtime/answer-draft-runtime.ts apps/core/tests/answer-draft-runtime.test.ts
git commit -m "feat: retrieve current-group long-term memory"
```

### Task 7: End-to-end acceptance, documentation and PR

**Files:**
- Modify: `docs/superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md`
- Create: `docs/runbooks/iris-group-memory-acceptance.md`

**Interfaces:**
- Produces a repeatable local/pilot acceptance path for Phase 3A.

- [ ] **Step 1: Add acceptance procedure**

Document: create two same-group evidence messages, create memory, verify answer context contains it, disable `readGroupContext` and verify it disappears, correct memory and verify old value disappears, delete replacement and verify both values are absent, then verify queues/DLQs remain zero.

- [ ] **Step 2: Update coverage status truthfully**

Change IRIS-CORE-003 only from `缺失核心实现` to `部分实现（事实层与回答检索）`. Do not mark automatic learning complete until Phase 3B is deployed and passes real Feishu acceptance.

- [ ] **Step 3: Run final verification and review**

Run `git diff --check`, `npm run verify`, isolated Postgres integration, and the Phase 3A acceptance procedure. Request a whole-branch code review against the branch base and fix every Critical/Important finding.

- [ ] **Step 4: Push and open a stacked draft PR**

Base the PR on `codex/iris-durable-runtime-control` until PR #5 is merged. Include the coverage baseline, explicit Phase 3B gap, test counts and migration/deployment notes.

## Self-Review

- Spec coverage: schema, evidence, group isolation, correction, deletion, API, prompt budget, runtime gate, tests and rollout are each assigned to a task.
- Placeholder scan: no TBD/TODO or unspecified error handling remains.
- Type consistency: `GroupMemory`, `GroupMemoryRepository`, `GroupMemoryService`, `PromptGroupMemory`, and `usedGroupMemories` names are consistent across tasks.
- Scope: automatic extraction, proactive behavior, knowledge drafts, knowledge-base writes, Admin Console and multi-tenancy remain separate phases and are not falsely claimed here.
