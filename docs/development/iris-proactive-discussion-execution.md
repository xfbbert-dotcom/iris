# 主动工作讨论：实施进度与测试环境

开始记录：2026-09-14；最新更新：2026-09-15。对应[已批准设计](../superpowers/specs/2026-09-09-iris-proactive-discussion-design.md)和[8 项实施计划](../superpowers/plans/2026-09-14-iris-proactive-discussion.md)。这是未完成实施的交接记录；局部审查缺陷的处置不代表整个功能发布。

## 当前状态

- 用户选择子任务实施与逐项审查。实现工作树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支 `codex/iris-daily-pilot-followup`；执行起点 `1f1a5efe`。
- Task 1 基础实现 `24c090fc` 已通过独立审查；Task 2 候选 `9f9f51a0` 的长消息存储/实时身份混用已由 `4ec806d6` 修复并通过范围复审；Task 3 `23c08ba5` 的结构判断/草稿/范围复核通过本地测试与独立审查。没有真实模型验收、飞书发送或部署证据。
- Task 4 候选 `12d1280b` 已完成状态机/反馈实现与局部真实 PG；初审两处阻塞由 `b1c6564f` 修正，范围复审确认两项已解决、无新增阻塞。下一步 Task 5–8，尚无发送/运行时装配验收。
- 已实现基础类型、消息完整内容哈希绑定、`0059_proactive_discussion.sql`、基础及评估/反馈 PostgreSQL repository，并以隔离 schema 运行真实数据库测试。发送方法仍属于 Task 5，没有占位运行方法，也没有接入生产入口。
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

本机数据库阻塞再次解除，Task 1–4 已提交并通过独立审查。后续使用上述新磁盘卷实例；若再次停止，先核对本任务容器和数据卷，不恢复或混用生产数据：

1. 从[当前接手入口](current-handoff.md)规定的 git/文档核对开始，保留已有提交和用户改动。
2. 读取本计划的 `.superpowers/sdd/2026-09-14-iris-proactive-discussion/progress.md`、各任务 report 与审查记录；这是忽略的本机执行记录，不能作为唯一跨机器证据。不要重做已完成的 Task 1–4。
3. Task 1 已审查 `1f1a5efe..24c090fc`；Task 2 初审 `8a557ed7..9f9f51a0` 后复审 `9f9f51a0..4ec806d6`；Task 3 审查 `3484159d..23c08ba5` 无阻塞发现；Task 4 初审 `16c7ab8d..12d1280b` 后复审 `12d1280b..b1c6564f` 通过。继续 Task 5–8；不得为重现 RED 删除或改写已提交的 0059。100 条目录容量与 resolved 身份生命周期列为有界后续，不能静默丢弃身份，也不在本轮扩建归档系统。
4. 未经当前任务新的部署授权，不推送、部署、发飞书消息或开放任何能力。

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

## 四处文档处置（未关闭功能）

| 核对项 | 处置 |
|---|---|
| 白皮书 | updated：[主动工作讨论规则与11.2](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md)补存储事件身份与完整实时来源身份的区别，链接执行证据；整体行为与授权范围不变 |
| 工程故障台账 | updated：[故障台账](../operations/engineering-failure-ledger.md)新增存储/实时 hash 混用的复用防错规则、真实生产者链路测试要求与有限出口；明确是未发布候选审查发现，不伪称生产事故 |
| 需求/验收基线 | updated：[覆盖基线](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)从计划未执行更正为实现中，链接基础证据和 Task 2 修复；IRIS-CORE-005 仍部分实现，不提升实模或部署层级 |
| 开工入口 | updated：[current-handoff](current-handoff.md)更新执行起点、Task 1 提交/审查证据、Task 2 进行状态与恢复入口；reviewed-unchanged：[README](../../README.md)、[AGENTS](../../AGENTS.md)的工作树定位和当前交接链接仍有效 |
