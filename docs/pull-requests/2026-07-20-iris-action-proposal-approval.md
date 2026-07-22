# Iris Phase 5B-2A Action Proposal And Approval

## 范围

本阶段实现白皮书 Phase 5B-2A：把已确认且仍然有效的知识草稿转换成版本绑定的 `publish_knowledge_draft` 行动提案，按 low/medium/high 风险生成审批要求，并通过真实飞书用户卡片完成批准、要求修改或拒绝。

本阶段不包含 Phase 5B-2B 完整正文 OAuth 审阅页，不调用飞书 Wiki 创建/写入 API，也不把草稿标记为 `published`。知识库发布仍属于 Phase 5B-3。

## 主要实现

- 新增迁移 `0032_action_approval_facts.sql`，持久化目标策略、角色 grant、proposal、requirement、approval、append-only event、卡片 presentation/outbox，以及仅预留的 execution 事实。
- 新增有界 planner，把当前 `pending_review` 草稿幂等转换为风险绑定 proposal；草稿、证据、策略或版本变化会取消旧 proposal 并使旧审批失效。
- 复用 5B-1 的签名验证、ack-first 飞书卡片入口和 Redis durable callback queue，以 discriminated job 处理行动审批，不增加第二个公网回调。
- 新增版本绑定的负责人/管理员审批卡片、Postgres outbox dispatcher、实时授权 worker 和确定性结果卡片。
- low-risk 来源群确认可直接满足；medium 只允许当前精确 reviewer；high 只允许当前 admin 或同时具备当前高风险 grant 的精确 reviewer。
- 重放会比较不可变 intent；时间戳只用于审计。相同 operation key 的冲突 payload 不会复用旧成功。
- 新增内部 proposal/policy/grant/status 与治理 API，但没有“传 actor 即批准”的 API；人工批准只能来自验证后的真实飞书回调。
- 新增生产运行时组合、生命周期关闭、默认关闭配置、内容无关状态和 readiness 门禁；Caddy 公网边界保持不变。
- dispatcher 在外部发送前按草稿精确来源群二次检查 runtime；单群生产 planner 不摄入公司级或非 allowlist 草稿，避免生成无法完成审批的卡片。
- lifecycle 按 knowledge-card、action-approval、event-worker 顺序启动并反向关闭；dispatcher 与治理事务统一 presentation -> outbox 锁序。
- readiness 会拦截 planner/dispatcher 最新失败批次和真正的终态 outbox 故障，同时保留合法 `governance_disposition` 审计历史。

## 安全边界

- `IRIS_APPROVAL_ACTIONS_ENABLED=false` 且 allowlist 为空是仓库默认值。
- runtime/global/group/`generateKnowledgeDrafts`、当前草稿证据、proposal/version、policy/version、presentation/recipient、成员资格与当前 grant 在 mutation 前重新读取并 fail closed。
- callback job、普通日志、status 和 DLQ 摘要不保存草稿正文、证据正文、token、原始 callback 或 provider 原文。
- 卡片发送进入 `external_attempting` 后的失败按 outcome unknown 处理，不盲目重发。
- 内部治理 request-revision/reject 不会插入人工 approval；所有 append-only facts 保留。
- 本阶段不会创建 `action_executions`，不会访问飞书 Wiki 写接口。
- 公网只保留 `/health`、`/feishu/events`、`/feishu/card-actions`；`/internal/*` 继续为 404。

## 代码提交

- `02179e4d`：组合 action approval 生产运行时、内部 API、状态与 readiness。
- `e05d42d3`：不可变 approval intent 与 policy version 重放校验。
- `34f1c233`：回调时间戳只参与审计，不改变幂等 intent。
- `b3eb84f3`：共享 callback 防重放与冲突语义。
- `1a974e6b`：实时授权与原子审批动作。
- `cb23cc7f`：版本绑定审批卡片与可靠投递。
- `60f8c97d`、`cd215d32` 及更早提交：共享回调、planner、持久化与事实合同。

## 本地证据

文档提交前已完成阶段性验证：

- Core：121 个测试文件通过、2 个跳过；2,197 passed、153 skipped，共 2,350。
- 真实 Postgres action repository：22/22 通过，包含 proposal/presentation 锁序并发回归。
- 真实 Postgres knowledge-card repository：44/44 通过。
- Python：178/178 通过；pilot 运维套件：119/119 通过。
- `npm run verify` 完整通过，覆盖 `git diff --check`、Core typecheck/build/tests、Python、pilot、根 Compose、15/15 readiness 与 `pilot:config`。
- `pilot:config` 确认 action/card 新门禁保持 false/empty。
- 两轮独立复审最终结论：Critical 0、Important 0；一个仅影响测试稳健性的 Minor 已进入后续清单，不延长本阶段。

上述数字不能替代真实飞书验收。

## 当前完成边界

- 5B-2A 本地代码闭环：已实现。
- 独立代码审查：通过；首轮 6 个 Important 及复审发现的 2 个相邻缺口均已修复，最终 Critical/Important 为 0。
- 最新完整仓库门禁：通过。
- GitHub 堆叠草稿 PR 与精确 SHA checks：待推送。
- VPS 默认关闭部署和真实飞书 pilot：未执行，不声明通过。
- 5B-2B 完整正文 OAuth 审阅页：未实现。
- 5B-3 飞书知识库发布：未实现。

## 预期 PR

- Base：`codex/iris-knowledge-approval-actions`
- Head：`codex/iris-approval-action-layer`
- 类型：Draft
- 合并：需要用户另行明确授权

真实验收按 `docs/runbooks/iris-action-proposal-approval-acceptance.md` 执行。退出后直接进入 5B-2B，不用非阻断硬化继续占用 5B-2A。

## 后续清单

- 将 PostgreSQL 锁序并发测试中的固定 `100ms` 调度等待替换为 `pg_locks`/`pg_stat_activity` 条件轮询；这是测试稳健性改进，不阻断 5B-2A。
