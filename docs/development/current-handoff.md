# Iris 当前接手入口

记录日期：2026-09-09。这是新会话的仓库定位与证据索引，不是实时生产探针，也不是新的上线批准。

## 当前正在推进

用户已确认现有三个试点群共享普通工作讨论，无需逐消息写知识库。正在按
[共享工作群聊设计](../superpowers/specs/2026-09-09-iris-shared-working-chat-design.md)与
[实施计划](../superpowers/plans/2026-09-09-iris-shared-working-chat.md)落实；新能力尚未部署/开启。
最新进度、四处文档处置和实际验收见[专项记录](iris-shared-working-chat.md)。这取代下面
“下一步仅原范围反馈”的工作排序，但不改写此前版本的隔离与验收事实。

## 先确认从哪里继续

- 本机已核实的实现工作树：`D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支 `codex/iris-daily-pilot-followup`。
- 本轮同步前该分支为 `985af6cf`（发布文档补记），包含运行应用 `748b8404`。后续文档提交不会改变运行镜像。
- 默认目录 `D:/work/AGE-org` 是另一个工作树，本轮开始时在 `codex/iris-proactive-feedback-loop-task-1` / `c0eac350`。这里只补接手用的 AGENTS 指引；不能从目录名称推断它拥有最新实现。
- 每次先运行 `git status --short`、`git diff`、`git log -8 --oneline`、`git worktree list`，再核对本页与实际分支。路径或分支不存在、记录与新提交冲突时，先只读定位并说明差异，不能自行切换、重置或合并旧分支。
- 仅在当前任务涉及且授权生产检查时核对服务器提交、镜像、健康、队列和治理事实；不要因读到旧发布/自动化记录就启动部署、发卡或开权限。

## 开工必读与权威顺序

| 层级 | 文档 | 解决的问题 |
|---|---|---|
| 架构规则 | [白皮书](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md)，尤其5.5与11.2 | Iris 应有什么行为、不能越过什么边界；修复如何完成同步 |
| 失败经验 | [工程故障台账](../operations/engineering-failure-ledger.md) | 已踩过的坑、预防规则、回归保护与停止条件 |
| 能力与验收 | [需求覆盖基线](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)及其2026-09-09修订 | 哪些已实现、以哪种方式验收、哪些仍缺失 |
| 实际交接 | 本页、[README](../../README.md)、[AGENTS](../../AGENTS.md)、[连续问答发布记录](iris-continuous-dialogue.md) | 在哪个工作树继续、最近部署了什么、还有什么未解决 |

当前明确的用户决定优先；稳定行为按白皮书和较新的已批准专项设计执行。是否部署以对应日期的发布证据为准，不能从设计、勾选计划或文档提交推断。
同一范围的新设计可以取代旧设计，但必须显式标注：连续问答设计中的检索前置方式已由[先意图后检索设计](../superpowers/specs/2026-09-08-iris-intent-before-retrieval-design.md)取代；原有上下文、来源及权限规则保留。
没有新部署核验时，只能说“最近一次记录的部署”，不能把历史状态写成当前在线事实。

## 最近一次记录的部署与边界

2026-09-09 00:17（北京时间）记录：应用 `748b8404c56330df9941a008f8f8343312949aa6`，公开入口恢复、运行修订3370、就绪21/21、队列/死信/未决回复0；[精确 SHA CI](https://github.com/xfbbert-dotcom/iris/actions/runs/34247915894)通过。
备份、镜像摘要、回滚及验收续跑详情只维护在[发布记录](iris-continuous-dialogue.md)，本轮文档整理未重新探测生产。

- 普通交流在资料加载前分流；历史查阅、两版比较与建议继续使用授权来源。
- 该次部署的原始群聊、记忆、线程和行动项不跨群开放；既有获批单文档共享与其撤销规则不变。
- 这轮修复没有开启知识库写入、任务执行、主动发言或新增群授权。
- 真实飞书原文＋真实模型＋内部草稿验收，不等于向飞书群发送了验收消息。
- 文案改写使用实际上轮模型输出的内存对话；真实发送回执/身份/来源链由自动及 Postgres 集成覆盖，不能称本轮又完成真实回执飞书改写验收。

## 修复证据索引

这些是本次补齐的近期问题簇，不是宣称重新审计全部历史 Bug。更早经验保留在故障台账与既有带日期的需求基线。

| 问题簇 | 修复提交 / 现有来源 | 回归入口与验收边界 |
|---|---|---|
| 本群问卷明明存在却找不到；回调缺失、回复标签或日期窗口丢失 | `1d6caf27`、`797bbf4c`、`c11f301b`、`6d649bc3`；[历史修复计划](../superpowers/plans/2026-09-07-live-history-relevance-repair.md) | [实时历史](../../apps/core/tests/answer-draft-live-history.test.ts)、[有界历史](../../apps/core/tests/historical-live-chat-context.test.ts)、[真实SQL](../../apps/core/tests/postgres-historical-chat-context.test.ts)；回调缺失原因未由保留日志证明，未伪造补录 |
| 单份能回答、两版不能比较，或追问/改写失去主题 | `cec4781b`、`1284f796`、`e844ffad`、`88f76e47`、`f0ebadcb`；[连续问答计划](../superpowers/plans/2026-09-08-iris-continuous-dialogue.md) | [两组原文](../../apps/core/tests/topic-aware-chat-window.test.ts)、[长文与改写](../../apps/core/tests/continuous-dialogue-routing.test.ts)、[日期追问](../../apps/core/tests/followup-live-chat-context.test.ts)、[来源链](../../apps/core/tests/assistant-source-lineage.test.ts)；不是无限历史或跨群原文共享 |
| 饥饿/情绪/语气反馈仍找知识库、抄日记 | `32ac1915`、`2ba91b2f`、`ae828488`；[意图修复计划](../superpowers/plans/2026-09-08-iris-intent-before-retrieval.md) | [路由边界](../../apps/core/tests/openai-compatible-request-context-router.test.ts)、[生产装配与零检索](../../apps/core/tests/intent-before-retrieval.test.ts)、[模型边界](../../apps/core/tests/openai-compatible-model-provider.test.ts)；重复实模及部署内部草稿检查通过 |
| 原文齐全仍因“缺作者结论/实测”拒绝推荐 | `7a640154`、`627eeba0`，包含于最终`748b8404`；[拒绝候选及最终验收](iris-continuous-dialogue.md) | [证据规划](../../apps/core/tests/openai-compatible-evidence-planner.test.ts)、[建议呈现](../../apps/core/tests/openai-compatible-grounded-answer-renderer.test.ts)；最终两轮有依据建议及A/B无证据负向通过，原失败HTTP首个故障阶段未直接捕获 |
| 中文不确定回答泄露英文策略词，替换又可能伤及URL/代码 | `808005c8`、`441413d0`、`c4f83ee7`、`748b8404`；[中文修正记录](iris-continuous-dialogue.md) | [22项呈现回归](../../apps/core/tests/openai-compatible-grounded-answer-renderer.test.ts)；保留结构化状态/置信度、显式英文及字面片段，不靠升级证据状态改善措辞 |

验收脚本对“暂无授权证据”的误判属于本机忽略目录内脚本修正，不是应用新提交；其失败、断言回归及同镜像续跑已在发布记录单独说明。临时脚本不作为唯一持久证据入口。

## 未完成事项与下一步

- P2：缺少第三版的补充场景曾把已知新版错称第三版；后续重放正常不证明根治。原定两版比较若发生同类混淆，应重新判断是否阻塞。
- P2/P3：来源标签和正式措辞、意图不确定时的提示表达；继续用具体用户反馈驱动，不无限扩展本轮修复。
- 独立待办：无主题的无限历史、全量回调补录、广泛跨群记忆/原文共享，不属于已交付范围。
- 运维待办：免费额度/短暂超时和既有依赖告警仍按[完整待办](iris-continuous-dialogue.md#非阻塞后续)跟踪，不能写成已修复。

下一步是原范围日常试用及具体问题反馈，不是重新开权限或重新部署文档。若明确进入新核心能力，先按白皮书判断授权和架构边界。

## 每次修复后的四处同步记录

在该次受版本控制的修复/发布记录中填写下表，四行都不能省略；具体强制规则见[白皮书11.2](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#112-mandatory-bug-fix-documentation-closure)。
每行必须是“已更新＋链接”或“已核对无需改动＋具体原因＋仍有效的链接”。这不是要求每次机械修改四份正文。

| 核对项 | 必须填写的内容 |
|---|---|
| 白皮书 | 本次是否改变/澄清稳定规则，对应章节及更新或无需改动理由 |
| 故障台账 | 对应失效教训和回归保护；已有条目覆盖时说明复用哪个条目 |
| 需求/验收基线 | 受影响需求、真实验证层级、部署状态及未完成事项，或状态未变的理由 |
| 开工入口 | README/AGENTS和当前交接中的路径、分支、修复记录及待办指向是否仍正确 |

记录同时包含症状、已确认根因或未确定之处、修复提交、测试命令/文件及实际结果。完成后核对链接、提交和四行状态；文档修复用结构/链接核验，不冒充应用回归或生产验收。
