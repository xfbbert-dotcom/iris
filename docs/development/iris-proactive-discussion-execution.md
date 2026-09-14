# 主动工作讨论：实施进度与测试环境

开始记录：2026-09-14；最新更新：2026-09-15。对应[已批准设计](../superpowers/specs/2026-09-09-iris-proactive-discussion-design.md)和[8 项实施计划](../superpowers/plans/2026-09-14-iris-proactive-discussion.md)。Task 8 的有限端到端、保留失败、实模缺口与发布 runbook 集中在[最终门禁交接](iris-proactive-discussion.md)；本页保留 Tasks 1–7 的历史实测与审查，不以局部修复声称整个功能发布。

## 当前状态

- 2026-09-15 全分支审查后的唯一 I1–I4 合并修复见[专门记录](iris-proactive-discussion-final-fixes.md)：
  补文字完整来源、未尝试首次意见恢复、所有者续租与启动重试；实际应用 SHA、RED/GREEN、最终门禁、
  0060/旧数据限制和四处处置均单列。下方 Task 1–8 的历史失败/审查仍按原日期保留，不把新修复覆盖为
  旧候选已正确；实模和生产仍未验收。

- 用户选择子任务实施与逐项审查。实现工作树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支 `codex/iris-daily-pilot-followup`；执行起点 `1f1a5efe`。
- Task 1 基础实现 `24c090fc` 已通过独立审查；Task 2 候选 `9f9f51a0` 的长消息存储/实时身份混用已由 `4ec806d6` 修复并通过范围复审；Task 3 `23c08ba5` 的结构判断/草稿/范围复核通过本地测试与独立审查。没有真实模型验收、飞书发送或部署证据。
- Task 4 候选 `12d1280b` 初审两处阻塞由 `b1c6564f` 修正并通过范围复审；Task 5 最终发送声明、结果未知保护与对账持久化 `30f75a98`、Task 6 连续追问来源 `1071dfc3`、Task 7 实际运行装配与控制面 `ab0f7dfe` 已通过独立规格/质量审查。Task 8 本地端到端/runner/CI 与剩余门禁见[专项交接](iris-proactive-discussion.md)；模型配置未提供，尚无实模、真实发送或生产启用验收。
- 已实现基础类型、消息完整内容哈希绑定、`0059_proactive_discussion.sql`、完整评估/反馈/发送 PostgreSQL repository，并以隔离 schema 运行真实数据库测试。发送 worker 的远端边界使用合成替身，没有接入生产入口。
- Task 8 应用 `89f299f5`：端到端/两轮合成评估 CLI/CI 门禁；最终 Core 4607 通过 / 445 条件跳过、逐文件 PG 86 通过（83 真实 PG）、Python 181、pilot 脚本 182、类型/构建/Compose 通过。11 项并行 PG 超时、顺序复跑与四处处置保留；独立审查的 SHA 指代歧义已由文档 `9288cce0` 修正并通过复审，模型/真实群门禁仍缺，见[专项记录](iris-proactive-discussion.md)。全分支四项修复的唯一复审也已通过；应用与文档 SHA 分开，不将本地审查提升为发布。
- 20:44 本机 Docker 已恢复启动；随后在独立 PostgreSQL 16.14 中取得实际缺表失败及修复后通过证据。数据库可用和基础测试通过仍不等于主动讨论端到端可用。

## 已取得的测试证据

| 层级 | 命令 / 结果 | 边界 |
|---|---|---|
| 开发前基线 | `npm test -- --reporter=dot`：4486 通过 / 345 条件跳过，239 测试文件通过 / 9 跳过，52.20 秒 | npm 将 reporter 参数识别为配置并警告；后续直接调用 workspace 测试。不是新增代码通过 |
| 初始测试骨架 | `npm --workspace apps/core test -- migration-runner.test.ts postgres-proactive-discussion-repository.test.ts`：1 失败 / 39 通过 / 12 条件跳过，另有缺模块导致的 suite 失败 | 缺迁移预约及模块只证明骨架为红，不是真实 PG 缺表证明；该次计数对应当时草稿 |
| 消息绑定聚焦测试 | `npm --workspace apps/core test -- postgres-proactive-discussion-repository.test.ts -t 'message bindings'`：1 通过；移除 CRLF 规范化时实际 SHA 不匹配，恢复后通过 | 单元/变异证据，不是 PG 行为、最终完整回归或任务验收 |
| 历史停止前聚焦测试 | 20:28 再运行上述两个测试文件：40 通过 / 1 预期失败 / 23 条件跳过；`npm run typecheck` 唯一 TS2307 为当时不存在的具体仓储模块 | 当时草稿未通过开发门禁；这次没有真实 PG 证据 |
| 恢复后真实 SQL RED | 20:46，在 0059 尚不存在时运行 `npm --workspace apps/core test -- migration-runner.test.ts -t 'migrates proactive discussion tables once'`：实际迁移旧 schema 后查询新表报 PostgreSQL `42P01`；1 失败 / 51 按测试名过滤跳过 | 实际缺表失败，不是缺模块或条件跳过证明 |
| 首轮真实 PG 回归失败 | 两个聚焦文件：49 通过 / 15 失败；14 项受到 vector 扩展在临时 schema 中并发创建/清理影响，1 项先被 FK 拒绝而未到达预期 TRUNCATE trigger | 保留失败；只在专用测试库初始化 public 扩展并修正测试断言，不改历史应用迁移 |
| Task 1 真实 PG GREEN | `npm --workspace apps/core test -- migration-runner.test.ts postgres-proactive-discussion-repository.test.ts`：64 通过 / 0 跳过，13.30 秒；`npm run typecheck` 退出 0 | PostgreSQL 16.14 / vector 0.8.5，基础持久化与并发/回滚验证，不是评估或发送验收 |
| Task 1 完整 Core 回归 | `npm --workspace apps/core test -- --reporter=dot`：4488 通过 / 357 条件跳过，240 文件通过 / 9 跳过，47.79 秒 | 此命令未设置数据库环境变量；新增 12 个条件 PG 用例已在上行单独实际运行。其余服务条件跳过不算通过 |
| Task 2 行为 RED | 实现前处理器未登记、登记失败未冒泡；定向测试还复现权限检查发生在读取之后、无回复目标反馈被误建 assessment、等义文档绑定因键顺序不同被拒绝 | 各缺口分别修复后转绿；缺模块红灯单独保留，不充当行为证明 |
| Task 2 聚焦与完整回归 | ingress/context/processor/history 四文件 139 通过；最终 `npm --workspace apps/core test -- --reporter=dot`：4517 通过 / 357 条件跳过，242 文件通过 / 9 跳过，27.13 秒；`npm run typecheck` 退出 0 | 对应 `9f9f51a0`；最后一次来源校验实现改动后重新跑全量。未修改 PG 行为、不重跑 Task 1 PG；无生产装配或发送 |
| Task 3 行为 RED 与最终回归 | 导出 API 空壳后的实际行为 16 失败 / 7 通过；最终 model/既有 grounded renderer 两文件 208 通过；`npm --workspace apps/core test -- --reporter=dot`：4541 通过 / 357 条件跳过，243 文件通过 / 9 跳过；`npm --workspace apps/core run typecheck` 退出 0 | 对应 `23c08ba5`；fake client 检查严格 schema、合法引用、跳过静默、一次修复、草稿范围复核。包含此前 Task 2 修复后的完整 Core 回归；不是实模或真实 PG 结果 |

表中 Task 1 最终验证对应 `24c090fc`；既有事件/OAuth 负向用例日志保留为基线噪声。独立审查已确认局部规格与质量通过；扩展 bootstrap、进度文档及基线日志的 P2 发现分别记录在本页或交给 Task 8。不把本页开发前基线替代新增代码证据。

Task 2 初审范围为 `8a557ed7..9f9f51a0`：只接可选处理器登记、严格人类触发、明确反馈解析、同群实时上下文和来源复验。原普通 @ 不新增主动 assessment；反馈应用仍属于 Task 4，发送复验属于 Task 5，生产装配属于 Task 7。

### Task 2 审查发现：长消息身份混用（本地修复已复审）

- 观察症状：超过存储预算的原消息虽然成功登记，未改动的实时完整正文却构建不出上下文。
- 已确认根因：`postgres-conversation-message-repository` 将正文按 8000 字符上限添加截断标记；registrar 对该存储表示求 hash，而 context builder 将其直接与完整实时正文 hash 比较。初版预算测试手写完整 hash，未走实际生产者链路。
- 修复提交 `4ec806d6`：抽出并复用原有存储表示函数做登记新鲜度校验，存储行为不变；完整实时正文独立绑定模型证据。实际仓储归一化/upsert→登记器→实时上下文的测试先复现失败，再通过；Queryable 为模拟，不是真实 PostgreSQL I/O。`npm --workspace apps/core test -- proactive-discussion-context.test.ts proactive-discussion-ingress.test.ts postgres-conversation-message-repository.test.ts`：55 通过 / 3 条件跳过；`npm --workspace apps/core run typecheck` 退出 0，真实变化仍拒绝。范围复审 `9f9f51a0..4ec806d6` 确认发现已解决、无新增阻塞。
- 验收边界：本地未发布候选的审查缺陷，不是生产事故归因；Task 2 本地门禁完成，其他门禁未提升。未在这次窄修复后重跑完整 Core，`9f9f51a0` 的 4517 通过与最终定向证据分别记录。

### Task 4 审查发现：跨版本依据与实时历史合同（本地修复已复审）

- 候选 `12d1280b`：评估/问题/反馈状态机、同 job 重排和策略授权事实。API 空壳的行为 RED 为 9 失败 / 12 通过；环境恢复后的最终聚焦 64 通过 / 0 跳过（35 真实 SQL + 1 绑定 + 17 worker + 11 ingress）；完整 Core 4558 通过 / 381 条件跳过，类型检查通过。条件跳过不是 PG 通过。
- 初审范围 `16c7ab8d..12d1280b` 确认两处问题：I1，A/B → C 后，未变化的 A 因离开最新 basis 而再次被判为新依据；I2，实时可读取但没有本地 ingestion 行的历史来源，会与无效触发消息混为一谈并永久取消任务。原回归未覆盖这些实际生产者/历史序列，不能用此前绿色结果否定发现。
- 修复 `b1c6564f`：通过已有不可变评估/投递/来源历史检查该问题实际消费过的依据，未引用但曾暴露的内容不误算为已消费；不把历史正文并入当前模型上下文。分别检查严格本地触发身份与所有上下文来源的消息锁/墓碑；合法 history-only 来源可用，已知非触发源删除/变化则原 job 重评，不伪造补录事件。
- 实际 RED/GREEN：I1 普通和 resolved/reopen 两种三轮序列均先错误 `prepared`，修后拒绝第三份依据；I2 五个场景先 4 失败 / 1 通过，修后 5 通过。最终 `npm --workspace apps/core test -- postgres-proactive-discussion-repository.test.ts proactive-discussion-evaluation.test.ts`：60 通过 / 0 跳过（42 真实 PG + 1 绑定 + 17 worker），73.59 秒；Core 类型检查和 diff 检查通过。此次窄修复未重跑完整 Core。
- 实际层级：本地合成 SQL/受控 fake 历史边界，不是飞书投递、模型质量或生产验收。范围复审 `12d1280b..b1c6564f` 确认 I1/I2 已解决、无新增阻塞或额外发现；Task 4 本地门禁及四处文档闭环完成。Task 5 需延续相同 history-only 与最终发送保护边界。

| Task 4 四处核对项 | 处置 |
|---|---|
| 白皮书 | updated：[第 6 节](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)明确问题历史依据不能遗忘，实时授权历史不以本地入库为前提；完整来源/最终复验边界不变 |
| 工程故障台账 | updated：[问题历史与实时生产者合同](../operations/engineering-failure-ledger.md#preserve-issue-history-and-the-actual-live-context-producer-contract)记录症状、根因、回归与已通过范围复审的有限出口，不把代码提交当已发布 |
| 需求/验收基线 | updated：[IRIS-CORE-005](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)链接 Task 3–4 局部实现/修复证据，保持整条链路未完成 |
| 开工入口 | updated：[当前交接](current-handoff.md)保留候选、发现、修复与下一步；reviewed-unchanged：[README](../../README.md)仍指向当前手册且未声称新功能完成，[AGENTS](../../AGENTS.md)的实际工作树、四处闭环和有限出口仍有效 |

### Task 5 发送门禁与结果未知（本地审查通过）

- 应用提交 `30f75a98`：领取时绑定真实运行修订；发送前实时复验全部来源和最近人类讨论，再在短事务内核对策略、运行状态、消息/墓碑、文档/授权、上下文、问题及领取身份。实际发送调用只在 `sending` 提交后发生一次，稳定 UUID 由投递身份生成；超时、空回执或回执写入失败保持 sending/unknown，不自动重发。同问题所有版本受未知结果约束，独立新问题不受固定冷却影响。
- 开发中实际 SQL 发现普通来源 `FOR SHARE` 不会阻止新快照 INSERT 的 FK `KEY SHARE`，会让旧快照检查后出现新快照。修为仅主动路径提前按排序获取来源 `FOR UPDATE`，保持来源先于 grant 的既有写入顺序；原被动问答仅抽取最小字段公共锁 helper，不改变行为。
- 回归：`npm --workspace apps/core test -- proactive-discussion-delivery.test.ts postgres-proactive-discussion-concurrency.test.ts postgres-proactive-discussion-repository.test.ts` 为 81 通过 / 0 跳过；运行中新增的反向快照竞争另以 `-t 'snapshot insert holds source FK lock first'` 得到 1 通过 / 24 名称过滤跳过。共覆盖当前 82 个不同测试，其中 81 个真实 PG、1 个纯绑定单测。旧 `postgres-answer-reply-repository.test.ts` 的 `round-trips an exact grant binding and serializes send start against revoke` 另取得 1 项真实 PG 通过 / 103 名称过滤跳过。两种快照先后顺序、纠正先后顺序、丢失租约、回滚、结果未知和外部 await 不持事务均有实际断言。
- 完整 Core：`npm --workspace apps/core test` 为 4558 通过 / 427 条件跳过（244 文件通过 / 11 跳过），26.93 秒；`npm run typecheck` 退出 0。此全量未设置 PG URL，PG 接受证据来自上一行，不能将条件跳过计为通过。早期 4 项 5 秒迁移/fixture 超时保留；新测试文件预算改为 30 秒，SQL statement timeout 仍为 3 秒，随后有限回归通过。旧 pg 并发查询 deprecation warning 作为非阻塞既有测试噪声保留，不抑制。
- 独立审查 `1d9a6a44..30f75a98`：规格与质量通过，0 Critical / 0 Important / 1 Minor（上述 pg warning）。内部仓储对账不证明真人身份或远端回执真实性，Task 7 必须补受保护 API 的真实 Iris 身份、群、正文和回复目标核验；运行装配、实模和真实投递均未声明完成。

| Task 5 四处核对项 | 处置 |
|---|---|
| 白皮书 | reviewed-unchanged：[第 6 节](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)已要求最终复验、明确本地线性化边界与未知不重发；本次只是落实短事务锁和领取证明，不改变授权/产品语义 |
| 工程故障台账 | updated：[发送锁的外层事务与写入顺序](../operations/engineering-failure-ledger.md#check-the-outer-message-transaction-when-adding-cross-source-send-locks)补快照 FK 锁的实际 RED/GREEN 和反向竞争，保留既有事故边界 |
| 需求/验收基线 | updated：[IRIS-CORE-005](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)推进到 Task 5 局部发送门禁通过，保留连续追问/装配/实模/部署缺口 |
| 开工入口 | updated：[当前交接](current-handoff.md)指向 Task 6–8；reviewed-unchanged：[README](../../README.md)及[AGENTS](../../AGENTS.md)的工作树、交接和四处闭环规则仍正确，没有新增安装或生产启用步骤 |

### Task 6 连续追问的完整来源（本地审查通过）

- 应用提交 `1071dfc3`：从实际 sent 主动回执读取严格 v1 来源，和旧被动回执合并排序后最多取 2 条；实时读取 Iris 正文前后复验全部文档/本群/共享来源。完整本群绑定通过两次改写、实际 responder prepare、fingerprint、不可变 trace、最终发送和再读取延续，不靠引用选句保存依据。旧 markerless 文档回执只在非严格模式保留原授权校验；未知来源不升级。
- 实际行为 RED：初轮 5 失败 / 19 通过，本群绑定丢失或来源变化/无 verifier 仍复用正文；持久化/发送阶段 7 失败 / 175 名称过滤跳过，复现缺 trace、运行关闭仍发送和校验缺失。实际删除操作的 send-first 场景又复现局部 trace 没进未决发送保护；补精确 OR EXISTS 后沿用既有冲突与结算语义。错误的 prepare 返回形状、直接 SQL 删除及 embedding 数量测试替身已修正并保留于执行报告，不能当作生产故障。
- 聚焦命令：`npm --workspace apps/core test -- proactive-discussion-lineage.test.ts assistant-source-lineage.test.ts shared-chat-source-propagation.test.ts answer-reply-delivery-service.test.ts answer-reply-receipt-validator.test.ts assistant-conversation-context.test.ts feishu-mention-answer-responder.test.ts`：297 通过 / 0 跳过。单独设置专用 PG URL 后运行 `postgres-proactive-discussion-concurrency.test.ts postgres-shared-chat-answer-concurrency.test.ts`：42 通过 / 0 跳过，59.46 秒。真实 SQL 覆盖主动 sent → 两次普通 responder/service/repository 改写、来源变化排除、trace 不可变、history-only 无伪造补录、混合来源互引及运行关闭/删除竞争。
- 完整 Core `npm --workspace apps/core test`：4585 通过 / 435 条件跳过（245 文件通过 / 11 跳过），29.55 秒；`npm run typecheck` 和 diff 检查退出 0。全量和聚焦有重叠，不叠加计数；pg warning 与既有负向日志保留。独立审查 `e4a242cf..1071dfc3` 规格/质量通过，0 Critical / 0 Important / 1 Minor（既有测试日志）。
- 边界：Task 7 仍须完成 answer-draft-runtime → app → event-worker 的普通本群 verifier 与主动 receipt provider 接线，包括 mention-responder helper 及其内部 delivery-service 的两级传递（不是新增第二个 service）；本提交不证明运行应用自动启用，也没有生产/真实模型/飞书外发。已测领域链与生产装配分开验收。

| Task 6 四处核对项 | 处置 |
|---|---|
| 白皮书 | reviewed-unchanged：[第 6 节](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)的完整来源、派生回答复验和失权不复用规则继续适用；空集合兼容与统一锁属于实现，不改变产品权限 |
| 工程故障台账 | updated：[发送锁与完整派生来源](../operations/engineering-failure-ledger.md#check-the-outer-message-transaction-when-adding-cross-source-send-locks)补本群 trace 删除保护、混合来源锁与两次真实持久化改写证据 |
| 需求/验收基线 | updated：[IRIS-CORE-005](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)推进到 Task 6 本地链通过，保留 Task 7 接线和实模/生产缺口 |
| 开工入口 | updated：[当前交接](current-handoff.md)指向 Task 7–8 和实际证据；reviewed-unchanged：[README](../../README.md)、[AGENTS](../../AGENTS.md)现有定位、文档同步和有限门禁规则仍有效，不需要为内部类型扩展新增安装指引 |

### Task 7：默认关闭装配与控制面（本地门禁完成）

应用提交 `ab0f7dfe` 完成独立 runtime、已登记队列的后台 worker、受保护状态/策略/恢复/对账 API，以及 Task 6 的普通问答 provider/verifier 实际接线。精确配置仍默认关闭，群集合为空；只有原试点群可配置启用，现有普通问答、共享群聊及旧提醒/任务/Wiki 开关不变。独立审查 `dbcf9a97..ab0f7dfe` 的规格与质量两项通过，无 Critical/Important，1 项既有验证日志 Minor 留作有限后续；尚不据此宣称整功能完成。

- 本地实际装配回归暴露并修正：普通文档可读判定不能代替精确 grant、最新成功 snapshot 或来源资格证明；旧问题正文在来源换版、授权撤销、同步失效或 Wiki 能力关闭后仍可能进入模型。主动路径现在在实时权限请求前后核对这些证明，排除不可用旧问题正文；原目录不完整门禁保留，不能借此新建同一问题。普通 Q&A 的权限实现未被放宽或重构。
- 操作者来自服务端 `IRIS_INTERNAL_API_AUDIT_ACTOR`，记录 `internal-api:` 角色，不信任请求自填真人身份；sent 对账重新读取并核对 Iris、精确群、正文及回复目标。operator resume 使用同一状态 SQL，但事件来源与真实成员反馈区分，不自动发旧稿。
- 关闭只承诺有界等待，不承诺强制终止已开始远端 I/O。停止后禁止新模型/范围复核/发送入口，已有发送可结算；超时显式 `drainPending`/降级，自有连接池在实际收尾后只关闭一次，sending/unknown 不返回 prepared。

| 验证 | 实际结果与边界 |
|---|---|
| 来源权限实际 RED/GREEN | 合成 transport＋真实 PG 的工厂测试复现模型输入中出现已失效正文；最后 Wiki/同步资格两项 RED 为 2 失败 / 37 按名跳过，修正后工厂 7 通过 / 32 按名跳过。最初 Wiki fixture 因无效跨群授权提前拒绝而无效转绿，已修正为真正执行撤销的本地 Wiki fixture，未把无效绿灯算作证据 |
| 运行时/控制面六文件 | 84 项通过，覆盖默认关闭、认证、生命周期、状态、启动和事件桥接；已包含在全量，不重复累计 |
| 首次完整 Core | 4602 通过 / 3 失败 / 441 条件跳过；3 项旧状态快照仍预期 15 组件，新组件实际为第 16 项。只修正期望后两文件 185 项通过，原失败保留 |
| 首次并行真实 PG | 81 通过 / 13 项超时，均报告原 5 秒测试预算耗尽；并行迁移负载是可能原因，未独立追踪证明。随后串行 30 秒有界测试预算 94/94 通过；未更改产品超时或历史迁移 |
| 最终完整 Core | `npm --workspace apps/core test`：4605 通过 / 443 条件跳过，247 文件通过 / 11 跳过，30.25 秒；最终应用修改后运行 |
| 最终真实 PG | `npm --workspace apps/core test -- postgres-proactive-discussion-concurrency.test.ts postgres-proactive-discussion-repository.test.ts proactive-discussion-delivery.test.ts --fileParallelism=false --testTimeout=30000 --hookTimeout=30000`：96 通过 / 0 跳过，168.04 秒；命令级测试库变量指向专用本机库 |
| 不重复计数 | 最终两组联合为 4700 项不同用例通过，348 项其他条件测试未执行；96 中的 1 项非 PG 单测已在完整 Core 中运行 |
| 构建与配置 | 最终代码 `npm run typecheck`、`npm run build`、根和 pilot 的 `docker compose ... config --quiet`、`git diff --check` 均退出 0；不打印合并配置。既有 pg 同连接并发 query 告警、负向测试日志和 LF/CRLF 提示仍保留 |

根 Compose 仅含基础服务，无需添加虚构 Core；新配置接实际 pilot Core。通用状态汇总器已经遍历完整组件 map 并复制全部字段，reviewed-unchanged，实际 app/API 快照覆盖新增组件。这里是测试边界与文件处置，不是生产健康声明。

| 四处同步 | 处置 |
|---|---|
| 白皮书 | reviewed-unchanged：[第 6 节](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)已有来源失效、权限复验、独立开关和不伪造审批规则；本轮补实际装配与证明，不改变稳定授权 |
| 工程故障台账 | updated：[回答时权限复验](../operations/engineering-failure-ledger.md#recheck-permissions-at-answer-time)补精确授权/快照/来源资格与旧派生正文的真实工厂回归 |
| 需求/验收基线 | updated：[IRIS-CORE-005](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)记录 Task 7 本地与独立审查通过，Task 8 实模与真实群门禁仍缺 |
| 开工入口 | updated：[当前交接](current-handoff.md)记录候选与下步；reviewed-unchanged：[README](../../README.md)、[AGENTS](../../AGENTS.md)仍准确说明实施未全部完成、正确工作树与有限验收边界 |

没有真实模型、实时飞书消息、SSH、推送、部署、生产操作者配置或能力启用。Task 8 继续端到端语料/脚本及有限验收；真实模型配置路径仍缺，不用合成结果替代。

## 历史：本机环境阻塞及已做的操作

`IRIS_TEST_DATABASE_URL` 未设置，未找到已运行的本地 PostgreSQL/pgvector。Docker Desktop 启动日志确认 Windows Unix listener 的旧运行时描述符无法访问，错误反复出现；没有就绪的 Docker engine。

仅停止了本轮启动的 Docker 进程（核对 PID、名称及启动时间），没有停止其他既有应用、重置 Docker、删除镜像/容器/volume、安装系统服务、修改权限或连接生产。

为验证旧运行时描述符是否阻塞启动，两个零字节套接字保留在下列备份，未删除其内容：

- `C:/Users/59912/AppData/Local/Docker/run/dockerInference.iris-test-20260914.bak`
- `C:/Users/59912/AppData/Local/docker-secrets-engine.iris-test-20260914.bak/engine.sock`

第二处仅含该零字节 socket，核对后重命名目录。后续启动仍生成无法访问的新描述符，说明尚未修复 Docker；没有继续重置或扩大环境改动。

备用便携 PostgreSQL 工具来自 [pg0 v0.15.1 原始发布](https://github.com/vectorize-io/pg0/releases/tag/v0.15.1)，下载在本计划忽略目录 `local-pg/pg0.exe`；SHA256 `25da2436bb9865e7dde348b2e47436a59f128067e76e16a3f4ac1b05591f0562`（本地计算，不声称发行方签名验证）。随后包含发行资产检查和 `start --help` 的组合命令整体被工具策略拒绝，未确认具体命中片段；没有绕过该限制或启动备用数据库。

## 20:44 本机环境恢复（不是应用验收）

用户要求直接操作电脑后，通过 computer-use 观察 Docker 的相同错误窗口并点击 Quit。只读核对：无 Docker 进程存活，`Docker/run` 只含四个零字节运行时文件；`docker-secrets-engine` 原路径已不存在。

通过资源管理器将 `C:/Users/59912/AppData/Local/Docker/run` 改名为 `run.iris-test-20260914-2040.bak` 保留，然后启动已安装的 Docker。界面显示 **Engine running**，`docker ps` 成功返回。上节第一份 socket 备份也随父目录移动，现位于 `C:/Users/59912/AppData/Local/Docker/run.iris-test-20260914-2040.bak/dockerInference.iris-test-20260914.bak`。

Windows 版本为 `10.0.26200`，与[上游相同错误报告](https://github.com/docker/desktop-feedback/issues/460)吻合；报告是用户复现，不是维护者确认的根因。这里仅确认一次恢复成功，未证明系统套接字问题根治。没有重置、清理容器/镜像/volume、上传诊断、执行备用程序或安装新版本。Docker 界面自行显示下载更新，未点击应用更新。

新建本任务专用容器 `iris-pd-test-20260914`，使用本机已有镜像 `pgvector/pgvector:pg16@sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb`，仅绑定 `127.0.0.1:55439`，数据库目录是 1 GiB tmpfs，不挂载任何既有数据卷。SQL 核对为 PostgreSQL **16.14**、可用 pgvector **0.8.5**。测试库是 `iris_pd_test`，不存在生产数据；服务就绪不等于新迁移已通过。

恢复后的并发测试发现既有 0003 迁移在扩展不存在时将 vector 安装到当前临时 schema，随后清理会影响并发 fixture。在专用 `iris_pd_test` 中确认扩展尚不存在后，执行一次 `CREATE EXTENSION vector WITH SCHEMA public` 并核对 0.8.5/public。后续聚焦测试通过；该测试库 bootstrap 需在 Task 8 的 CI/runbook 中复现，不能改写历史迁移或混用生产库。

## 继续实施

### 23:36 测试库空间耗尽，23:43 切换专用磁盘卷

Task 4 后续 SQL 回归出现连接终止、recovery mode，随后本机 TCP `SELECT 1` 为 `ECONNREFUSED`；该次 17 通过 / 19 失败及一个未处理连接错误不算最终验收。Docker 日志确认 `15:36:15 UTC` 在写 `pg_wal/xlogtemp` 时 `No space left on device`，恢复过程也因空间耗尽退出 1；`OOMKilled=false`。这是原 1 GiB tmpfs 容量不足，不能写成应用断言故障。

保留旧退出容器及日志，未删除或启动既有业务容器。23:43 新建 `iris-pd-test-20260914-b`（`8461609b58ad25c3159f4c9137bc2ea9d270eb1c7dde6a724d1a753057516554`），使用同一已缓存镜像、同一仅本机 `127.0.0.1:55439` 端口，以及新建专用卷 `iris-pd-test-data-20260914-2339`。测试库仍为 `iris_pd_test`，只存合成数据；旧 tmpfs 的测试数据随容器退出消失，不用于恢复业务。

新库初始化 `vector` 到 `public`，SQL 确认 PostgreSQL 16.14 / vector 0.8.5；主机 TCP `SELECT 1` 成功。配置测试库 `max_wal_size=256MB`、`min_wal_size=64MB`、`checkpoint_timeout=60s`，不用固定小内存盘承受连续迁移测试。原失败记录保留，Task 4 恢复后必须重新取得受影响用例的实际 RED/GREEN 和最终回归，不能沿用早前 59 通过作为终态。

本机数据库阻塞再次解除，Task 1–6 已提交并通过独立审查。后续使用上述新磁盘卷实例；若再次停止，先核对本任务容器和数据卷，不恢复或混用生产数据：

1. 从[当前接手入口](current-handoff.md)规定的 git/文档核对开始，保留已有提交和用户改动。
2. 读取本计划的 `.superpowers/sdd/2026-09-14-iris-proactive-discussion/progress.md`、各任务 report 与审查记录；这是忽略的本机执行记录，不能作为唯一跨机器证据。不要重做已完成的 Task 1–6。
3. Task 1 已审查 `1f1a5efe..24c090fc`；Task 2 初审 `8a557ed7..9f9f51a0` 后复审 `9f9f51a0..4ec806d6`；Task 3 审查 `3484159d..23c08ba5` 无阻塞发现；Task 4 初审 `16c7ab8d..12d1280b` 后复审 `12d1280b..b1c6564f` 通过；Task 5 审查 `1d9a6a44..30f75a98` 通过。继续 Task 6–8；不得为重现 RED 删除或改写已提交的 0059。100 条目录容量与 resolved 身份生命周期列为有界后续，不能静默丢弃身份，也不在本轮扩建归档系统。
4. Task 6 审查 `e4a242cf..1071dfc3` 通过；继续 Task 7–8，落实已记录的 runtime 三文件接线，不能因注入测试通过就遗漏真实应用装配。
5. 未经当前任务新的部署授权，不推送、部署、发飞书消息或开放任何能力。当前还缺已配置本地模型的可用路径，已请求用户提供路径而非密钥；先完成其余获准本地工作，到实模门禁仍缺配置则如实停在该边界。

Task 3 审查 P2：直接手工构造零来源 `PdContext` 时 schema 的 `enum: []` 非法；当前 builder 返回上下文前必须找到触发消息，因此正常生产构建器不可达。留给 Task 8 场景/最终审查判断是否进入修复，不写成已解决。LF/CRLF 提示单独作为本机基线噪声保留。

## 已作的实现裁决

| 裁决 | 理由 | 判断错误的代价 |
|---|---|---|
| Task 1 声明最终仓储合同，但只实现策略、登记、读状态、领取/失败评估与状态统计的 foundation 子集；其余行为分别留给 Task 4/5；0059 一次建立所需全部表 | 避免在发送门禁依赖尚未就绪时放入占位方法或重复后续任务 | 后续消费者需要显式扩展返回类型，可能少量返工 |
| 迁移/CLI 验证必须断言实际数据库或进程行为；文件名/缺 import 不算完整红绿证据 | 防止源码字符串匹配或测试跳过制造完成假象 | 聚焦测试稍长，环境依赖明确暴露 |
| resolved 问题只有出现经验证的实质新前提才可重开；user_paused 不因模型、策略版本或时间自动恢复 | 按已批准设计解决计划中简写注释的歧义 | 需额外显式状态转换测试或返工 |
| Task 2 依赖实际需要的 register/readState 子合同；历史读取显式扩展 user 类型并保留既有语义 | 避免要求尚未实现的 Task 4/5 方法或放入假方法，同时满足本群人类来源复验 | 少量依赖类型调整和历史 reader 定向回归 |
| Task 7 新增服务端内部操作者角色配置 `IRIS_INTERNAL_API_AUDIT_ACTOR`；缺认证或角色时拒绝变更，不信任请求头/正文的操作者身份 | 现有共享 bearer 只能证明凭据持有者，不能证明用户自填的成员身份；审计必须如实区分 internal operator 与飞书成员 | 多一个非密钥部署配置；只能归因到凭据/角色，按真人区分仍需后续认证设计 |
| Task 4 发现目录中有问题因依据无法复验而未进入模型上下文时，拒绝新增问题并记录目录不完整；已提供且验证通过的问题仍可按自身门禁转换 | 不能泄露不可读的旧问题正文，也不能让已暂停/结果未知的问题因上下文缺项而被重新建成新问题 | 来源暂不可用时新问题检测降级；恢复有效来源或另行授权的生命周期处理前不隐式放行，不在本轮扩建归档系统 |
| Task 3 的一致性 skip/none 可以使用空正文、空证据和空 materialChange 说明；真正 intervene 仍须完整且有界的依据、理由与建议 | 保持沉默不应被“所有字段不得为空”的简写误拒绝，亦与既定 skip fixture 一致 | 需条件校验和测试调整；不会放宽实际发言要求 |
| Task 4 补反馈 expectedIssueVersion/verifiedReplyMessageId 与同 job 重排；只撤销当前冲突的领取计数，不清零之前技术失败；中间冲突记追加事件，终态仍记评估/来源事实 | 反馈 CAS 缺输入，同 job 的评估 attempt 唯一约束不能用重置计数后重复插入解决；保留已应用 0059 | 少量内部接口扩展；丢弃的中间模型正文不另存评估行，原因/版本仍可审计；暂时不可读取的来源可能让 job 保持待处理 |
| Task 6 严格来源回执保持 v1，另设仅旧被动问答可用的 null 标记候选；保留其完整文档校验，禁止带本群/跨群聊天来源，严格模式全部拒绝 null；补实际 responder 的传递点 | 避免把未知来源升级为 v1，也避免抽取公共 provider 时破坏旧文档改写行为；原文件清单漏了唯一生产 prepareAnswer 入口 | 一个明确内部兼容分支及最小接入改动；不新增第二套正文选择流程，不放宽新主动来源 |
| 反馈确认不匹配记 blocked/cancelled；历史/成员服务抛出的技术错误仍有限重试并可见，不往群里报错 | 短暂服务故障不应让明确停止请求被静默视为无效 | 复用失败接口的一种明确领域原因；暂时错误可能保持待处理，而非被无声丢弃 |
| Task 4 为 @ 反馈持久化 registrar 真正匹配到的 Iris mention key；实时同人同群正文身份匹配后才可按该字面前缀解析 | 登记器支持 @+停止，worker 却缺少已验证 mention 信息，不能靠去掉任意 @ 字样补齐 | 小型内部 proof 字段及共享解析器；它证明原入口元数据与未变正文，不声称实时 reader 又核验了 mention 映射 |
| Task 4/5 只要求触发消息具有本地事实；其他已实时验证的历史来源不强制先入库，仍锁身份/墓碑并按上下文变化重评 | 实际历史生产者不保证本地行存在，不能把计划中“全部来源检查”误写成全部入库条件 | 依赖明确的实时读取＋本地线性化边界；不声称远端修改与本地发送原子 |
| 历次已消费的问题依据通过既有不可变历史查询，不把所有旧源并入当前 basis | 仅记上一轮会遗忘更早依据；全并入当前模型上下文又会扩大失权影响 | 多一次历史检查；已消费的未变依据不能在 resolved/reopen 后重新授权，但真正新依据仍可使用 |
| Task 5 实时最近人类窗口须包含于保存的完整来源绑定，并独立复验所有已保存来源；不要求与旧问题依据的并集相等 | 没有另存窗口快照，旧有效前提可能在最近窗口之外 | 辅助来源失效也可能保守取消；不增加 schema，也不声称远端原子快照 |
| 领取投递新增 checkedRuntimeRevision，最终发送在锁内比对且检查实际开关；普通只读 DTO 不伪造领取证明 | 原接口缺少领取时的真实修订，无法正确比较 | 小型类型/测试调整；配置来回变化也会取消重评 |
| 主动文档门禁先 managed advisory，再排序来源 FOR UPDATE/快照，再复用 freshness/grant helper；被动路径不变 | 避免与 source→grant 写入顺序倒置，FOR SHARE 又不足以阻挡快照 FK 插入 | 短事务暂时串行化来源写入；网络和模型均在事务外 |
| Task 6 的空本群来源数组在 fingerprint 中规范为省略，非空集合必须完整计入；v1 下完整零行查询表示已知空，旧 null 不升级 | 历史回执没有区分显式空/省略空的新标记，不能让升级改变旧 fingerprint | 不区分两种空表示；丢失非空来源仍须拒绝，不新增迁移 |
| 既有共享消息锁 helper 增加有界 typed local bindings；统一排序共享/本群/传入消息，一次完成 runtime 与墓碑门禁 | 分开追加本群锁会倒序，复制 runtime SQL 会使规则漂移 | 一个内部接口/文件扩展；本群派生回答新增普通读/回复门禁，旧无源行为不变 |
| Task 7 完成 answer-draft-runtime → app → event-worker 的本群 verifier/provider 生产接线，Task 6 只闭合领域与真实测试链 | 三份 runtime 文件已归属下一装配任务，不能只有注入测试而漏实际应用 | Task 6 单独提交还不能自动生效；该接线是 Task 7 必需项 |
| 本群派生回答的未决发送加入既有内部证据删除冲突查询，保留相同状态与锁序 | 原检查只覆盖 incoming/shared，遗漏新增本群 trace | 多一条精确查询；在途派生回答需结算后才能完成内部删除，不承诺撤回远端消息 |
| Task 7 复用现有配置/客户端工厂，使用 PD 自有生命周期和同一仓储；增加可选内部 control facade 供 API 使用 | 既有 Q&A runtime 不暴露底层实例，计划的 runtime 又未暴露 API 所需仓储 | 少量类型扩展及独立 token cache；不新增服务，禁用时不创建隐形第二连接 |
| 非法启用群配置仍拒绝启动；禁用模式无依赖，启用后的运行故障只将 PD 标记 stopped/degraded，不中止 Q&A | 原共享 onReady 链会传播拒绝；必填 registrar 又可能误迫使禁用模式初始化依赖 | 新增局部生命周期/有界关闭测试；Q&A 可用不代表 PD 健康，状态不能伪造成功计数 |
| 根 Compose 仅数据库/Redis，保持不变并记录原因；环境变量接实际 pilot Core；独立文档上下文仍按既有精确目的群授权校验 | 不为修改清单新增无关服务，也不能把已授权文档混同为跨群原始聊天 | 一项文件处置；授权证明缺失则拒绝来源，不自动创建授权、不读取他群原始/派生聊天 |
| 关闭采用有界等待及最小 worker 停机检查；已有 I/O 结算后再关闭自有 pool，超时明确待收尾/降级 | 既有传输没有取消合同，不为停机扩建整套 AbortSignal 基础设施或包裹所有仓储方法 | 关闭等待返回后仍可能有已开始 I/O 和延后资源释放；不得声称已清理完毕，sending/unknown 不得重发 |
| Task 7 的通用状态汇总器保持不变，由 app 提供新增组件并更新实际 API 期望 | 现有 Object.entries 汇总与递归字段复制已承载新状态，无需为文件清单制造无效修改 | 若后续增加非通用字段仍需定向调整；当前装配测试必须证明新增组件及降级状态实际可见 |
| R26：新增 0060 nullable prose_sources，将存续文字的全部暴露/传递来源与引用依据分开；旧 null 隐藏文字但保留身份，超过 1000 来源整项拒绝 | 最新引用不能证明未变描述、未引用资料及跨问题文字的来历，不能猜测历史来源或截断证明后继续输出 | 新增字段和迁移；旧项或超预算项保守不可用，可能降低新问题发现能力 |
| R27：新增服务端派生 canReassessUnattempted 与 unattempted_first；仅全部历史为未尝试 context_stale 取消且无暂停/解决史的原问题可重新首次判断，持锁重算 | 从未尝试的草稿不应当作已经发过；observing 或模型自报不能证明资格，也不能把旧依据伪称新依据 | 增加窄内部投影/模型合同；其他无害但不满足条件的取消仍可能无法重试 |
| R28：精确所有者/attempt/未过期 CAS 每 20 秒续 60 秒，串行续租；每次模型调用及阶段间检查，明确区分 lease_lost 与已重排 stale | 合法三次 25 秒模型调用超过固定 60 秒；不能移除过期保护、复活旧所有者或把网络等待放进事务 | 多一次仓储接口及周期查询；已进入 HTTP 可能稍后结束，但不能启动后续阶段或失权提交 |
| R29：禁用时才可对合格输入无依赖 no-op；启用未就绪/故障沿既有 raw queue 重试，已知非范围输入排除，普通回答先完成且持久去重 | 启动期间成功确认却未登记会永久丢失工作讨论和真实停止反馈 | 启动或故障期间可能积压/进入既有 DLQ，需要可见运维恢复；不增加无限队列或启动等待 |

## 四处文档处置（未关闭功能）

| 核对项 | 处置 |
|---|---|
| 白皮书 | updated：[主动工作讨论规则与11.2](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md)补存储事件身份与完整实时来源身份的区别，链接执行证据；整体行为与授权范围不变 |
| 工程故障台账 | updated：[故障台账](../operations/engineering-failure-ledger.md)新增存储/实时 hash 混用的复用防错规则、真实生产者链路测试要求与有限出口；明确是未发布候选审查发现，不伪称生产事故 |
| 需求/验收基线 | updated：[覆盖基线](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)从计划未执行更正为实现中，链接基础证据和 Task 2 修复；IRIS-CORE-005 仍部分实现，不提升实模或部署层级 |
| 开工入口 | updated：[current-handoff](current-handoff.md)更新执行起点、Task 1 提交/审查证据、Task 2 进行状态与恢复入口；reviewed-unchanged：[README](../../README.md)、[AGENTS](../../AGENTS.md)的工作树定位和当前交接链接仍有效 |
