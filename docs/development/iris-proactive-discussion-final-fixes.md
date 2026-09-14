# 主动讨论全分支审查修复：I1–I4

记录日期：2026-09-15。工作树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支
`codex/iris-daily-pilot-followup`。修复基线 `9288cce06c31b852f366daca60a41b894fed2b79`；
应用/测试/CI 修复提交 `7a0a2e38932ff228dfab5c6785e715f1d2b8c8c7`。文档随后单独提交，不替代应用或部署 SHA。

最终全分支审查发现 0 Critical、4 Important、3 个保留 Minor。本轮只修 I1–I4；
既有 Task 4、Task 8 失败和接受记录继续保存在[执行记录](iris-proactive-discussion-execution.md)
及[有限验收记录](iris-proactive-discussion.md)。没有新生产事故归因，也没有访问生产、
真实模型、飞书发送、push、部署或启用。一次限定范围复审已经通过；实模/远端 CI/
单群投递验收不因本地通过而完成。

## 最终范围复审与接手点

独立范围复审覆盖 `9288cce06c31b852f366daca60a41b894fed2b79` →
`f266da49339111c54d54ec54a45ffdca23d33c29`：两次提交、28 份文件；后者是修复文档提交，
应用仍为上面的 `7a0a2e38`。I1–I4 全部 ADDRESSED，0 个新增 Critical/Important，
没有重跑相同 SHA 的测试套件或另开全分支审计。审查逐项核对完整文字来源、持锁首次资格、
实际续租与失租/停止检查，以及实际启动队列/普通问答去重回归。此前发现与失败不删除。

本地实现及代码审查到此结束；Task 8 的两轮真实模型与人工质量核对仍未完成，不能标记整项完成。
下一步仅需用户指出已有本地模型配置文件路径（不要在聊天中发送密钥），按既有无发送 runner
补真实模型门禁。不要搜索凭据库、从生产取密钥，或跳过门禁启用。远端精确 SHA CI、部署及
单群真实投递另需当次授权；保留本机测试卷、环境备份和忽略目录证据，不作自动清理。

保留三个非阻塞后续：手工零来源模型上下文 Schema 边缘输入（正常 builder 不会生成）；
既有 pg 同连接并行 query 警告（升级 pg 主版本前定向消除）；100 条目录及无完整来源旧项的
可用性限制（真实试点触及时单独设计生命周期，不丢弃暂停/未知身份）。本次没有声称修复它们。
最后交接仅补审查状态和公开 R26–R29 决策行；下方四处处置继续适用，架构/故障/覆盖边界未再改变。

## 症状、根因与修复

| 发现 | 已确认根因与修复 |
|---|---|
| I1 旧问题文字携带已失效来源 | 描述保持不变，但 `basis_sources` 只存最近引用；未引用的暴露资料和跨问题目录文字来源也会丢失。新增不可回写旧迁移的 0060，nullable `prose_sources` 与当前引用依据分开。新建保存全部暴露来源，更新保留存续文字的累计来源；上下文、实际模型 payload、evaluation 和 delivery 传播并复验全部证明。旧记录 null 不猜测回填，隐藏文字但保留身份/状态；目录不完整仍阻止新身份绕过。超过 1000 来源不截断证明继续发言 |
| I2 未曾发送的首次意见被永久去重 | prepare 消耗依据，context_stale 虽重排任务，模型/SQL 仍要求新依据。新增服务端派生 `canReassessUnattempted` 与明确 `unattempted_first`；只有 observing 且全部历史投递均 cancelled/context_stale/未尝试、无暂停/解决史时允许重新评估。提交持锁重算资格；不可用 caller flag 绕过。所有已尝试/发送/未知/其他取消/暂停/解决历史继续保护，取消记录不删除 |
| I3 合法慢模型工作耗尽租约 | 原固定 60 秒小于多个独立模型调用的正常预算，失租提交还返回 processed。新增所有者 token/attempt/完整任务身份/未过期 CAS 续租，每 20 秒续 60 秒，短事务无模型等待。每次 complete 前和 worker 阶段边界检查停止/失租；停止后不续租，不启动后续修复/草稿/复核。commit 返回 lease_lost 报 failed；已成功重排的 context stale 仍 processed。已进入的远端 HTTP 不被宣称取消 |
| I4 成功启动期间事件登记丢失 | app 的 raw worker 已运行，但 enabled registrar 在 delegate 未就绪时静默返回。精确群人类事件现在返回可重试登记错误，沿用 raw queue/DLQ；processor 仍先完成普通回答及去重。disabled 可无依赖 no-op；不属 PD 的群/非人类输入不制造重试。成功启动后的重放实际创建一次普通评估和一次停止反馈 |

设计澄清见[5.3](../superpowers/specs/2026-09-09-iris-proactive-discussion-design.md#53-来源与连续对话)，
并同步[实施计划](../superpowers/plans/2026-09-14-iris-proactive-discussion.md)。0059 保持原样；0060
不回填旧文字的未知来源、不重写不可变历史。旧无证明目录项仍会降低新问题可用性，这属于已保留
目录生命周期限制，不提供自动归档/解除暂停/未知重发入口。

## 实际验证与退出条件

只使用专用本地 PG16.14/pgvector0.8.5、localhost:55439 和逐例隔离 schema；不重启/删除测试
容器或业务数据。PG 文件顺序执行。外部消息/成员/模型边界均为明确合成替身。

| 命令（仓库根目录，PG 项设专用 IRIS_TEST_DATABASE_URL） | 最终结果 |
|---|---|
| `npm --workspace apps/core test -- --reporter=dot` | 4613 通过 / 463 条件跳过，248 文件通过 / 12 跳过；31.96 秒。没有 PG URL，跳过不算真实 PG |
| `npm --workspace apps/core run typecheck` / `npm --workspace apps/core run build` | 两者退出 0 |
| `npm --workspace apps/core test -- postgres-proactive-discussion-repository.test.ts` | 43 通过 / 0 跳过，其中 42 真实 PG；74.97 秒 |
| `npm --workspace apps/core test -- postgres-proactive-discussion-concurrency.test.ts` | 39 通过 / 0 跳过，全部真实 PG；102.01 秒 |
| `npm --workspace apps/core test -- proactive-discussion-delivery.test.ts` | 14 通过 / 0 跳过，全部真实 PG；29.18 秒 |
| `npm --workspace apps/core test -- proactive-discussion-e2e.test.ts` | 4 通过 / 0 跳过，其中 2 真实 PG、2 runner；6.31 秒 |
| `npm --workspace apps/core test -- proactive-discussion-final-fixes.test.ts` | 18 通过 / 0 跳过，全部真实 PG；38.23 秒 |
| `node --test scripts/pilot/proactive-discussion-eval.test.mjs` | 4 通过 / 0 跳过，两个本地假 HTTP provider 轮次；不是实模验收 |
| `npm exec --workspace apps/core -- tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --esModuleInterop --skipLibCheck ../../scripts/pilot/proactive-discussion-eval.ts` | 退出 0；runner 的新 issue fixture 合同单独严格编译 |

新增 [18 项真实 PG 回归](../../apps/core/tests/proactive-discussion-final-fixes.test.ts)覆盖 birth → 后续
依据 → 原始/未引用/跨问题来源撤销后的实际模型输入与 delivery 来源；context_stale → 原问题
原依据重新判断 → 恰好一次首次发送；7 种不可伪造资格；旧 null 来源/R6；真实租约续期、到期及
所有者换代；75 秒模型流水线、内部草稿阶段失租和停止；实际 app/registrar/processor/raw queue
延迟启动重放、普通 Q&A 真实持久回执去重、停止反馈最终 user_paused。原 no-repeat 测试显式断言
`issue_evidence_already_consumed`，避免被新增来源保护提前拒绝而掩盖旧回归。

单测另覆盖 1000 来源整项拒绝、未知 issue 来源在模型调用前拒绝、默认定时器实际续期和清理，
以及 lease_lost 与上下文重排状态区别。CI 显式增加最终 PG 回归文件。Python 和全部 pilot 脚本
没有相关实现改动，本轮不重跑，其 181/182 项旧证据仍按原日期保存。模型域手工零源 Schema P2
未修改。有限出口已达到：上述本地门禁、四处文档及一次修复范围复审完成，回到实模与单群试用门禁。

以上 5 份 PG 文件合计 118 项不同用例，其中 115 项使用真实 PostgreSQL、3 项非 PG；
不能与完整 Core 数字简单相加。文档 QA 实际覆盖 10 份 Markdown 的 204 个本地路径和 44 个
标题锚点，全部有效；`git diff --check` 通过。

## 保留的失败和实际边界

- 原始真实 PG RED：4 项失败，分别观察原始来源从下一上下文消失、未引用来源未进入下一投递、
  未尝试草稿重新评估失败、续租方法不存在。启动 RED 两个事件错误返回 processed。
- 慢流水线 RED 初稿重复了 m2 的 exact-read fixture，导致在上下文阶段退出；修正 fixture 后，
  3 次合成 25 秒 complete 实际执行、75 秒提交无投递，旧所有者错误返回 processed。停止分支
  原本已有阻止后续 render 的行为，本次 RED 只证明缺少可取消的续租生命周期，未虚构旧 shutdown 漏发。
- 模型边界新增 null/空来源回归 RED 为 2 项，本来仍向客户端暴露旧问题文字；修复后调用前拒绝。
- 首轮旧 PG repository 42/43：resolution fixture 暴露 C 派生问题却没有 C 来源，被新保护阻止。
  修正 fixture 传递完整来源，并保留 resolution 与 lifetime-novelty 的实际断言。不是放宽来源保护。
- 启动普通回答回归增强时，初稿只返回 answerText，缺少真实 orchestrator 的 allowedFragments；
  16/17 通过，Q&A 失败。替换为真实 orchestrator 后实际一次回复、重放 duplicate_message。
- 两次中间 typecheck 发现新 issue 字段 fixture/隐式 any 和缺失 planner/renderer；均作为测试合同
  修正保留。最终类型/构建证据单列。既有 pg 同 client concurrency deprecation 与预期事件/OAuth
  负向日志不抑制；未据此诊断新死锁或数据丢失。

缺模型配置的真实两轮命令仍保持此前退出 2 的记录，本轮未重跑、未搜索凭据。
没有远端 exact-SHA CI/部署/真实飞书投递或成员停止/恢复验收。默认不开启，未来发布沿用
[单群 runbook](iris-proactive-discussion.md#单群发布-runbook)，额外确认 0060 已执行且旧 null
来源项的可用性限制可见。启动重试超过现有次数仍进入可见 DLQ，需要原有运维恢复，不能声称
新建了无限重试/自动历史重放服务。

## 四处文档处置

| 位置 | 处置 |
|---|---|
| 白皮书 | updated：[第 6 节](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)明确文字来源/引用去重分离、首次未尝试例外、租约及启动登记；[11.2](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#112-mandatory-bug-fix-documentation-closure)闭环要求不变 |
| 故障台账 | updated：[可复用预防规则](../operations/engineering-failure-ledger.md#preserve-prose-provenance-and-distinguish-unattempted-work-from-completed-effects)记录四个确认根因、真实回归和有限出口 |
| 需求覆盖基线 | updated：[本轮状态](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md#status-amendment---2026-09-09-proactive-discussion-design)链接修复及分层门禁；IRIS-CORE-005 仍是部分实现、未获实模/单群验收 |
| README/AGENTS/当前交接 | updated：[README](../../README.md#current-product-state)、[当前交接](current-handoff.md#当前正在推进)、[执行记录](iris-proactive-discussion-execution.md)指向本次应用/修复/后续；reviewed-unchanged：[AGENTS](../../AGENTS.md)的工作树核验、四处闭环及有限出口仍准确，无新规则需重复 |
