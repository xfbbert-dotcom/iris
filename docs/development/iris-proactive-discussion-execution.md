# 主动工作讨论：实施进度与测试环境

记录日期：2026-09-14。对应[已批准设计](../superpowers/specs/2026-09-09-iris-proactive-discussion-design.md)和[8 项实施计划](../superpowers/plans/2026-09-14-iris-proactive-discussion.md)。这是未完成实施的交接记录，不是发布或 Bug 关闭记录。

## 当前状态

- 用户选择子任务实施与逐项审查。实现工作树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支 `codex/iris-daily-pilot-followup`；执行起点 `1f1a5efe`。
- Task 1 基础实现已提交为 `24c090fc`，独立审查已通过规格与质量两项，无阻塞发现；Task 2–8 尚未开始。没有模型验收、飞书发送或部署证据。
- 已实现基础类型、消息完整内容哈希绑定、`0059_proactive_discussion.sql` 和六方法 foundation PostgreSQL repository，并以隔离 schema 运行真实数据库测试。评估/反馈状态转换和发送方法仍分别属于 Task 4/5，没有占位运行方法，也没有接入生产入口。
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

以上最终验证对应 `24c090fc` 的 Task 1 应用改动；既有事件/OAuth 负向用例日志保留为基线噪声。独立审查已确认局部规格与质量通过；扩展 bootstrap、进度文档及基线日志的 P2 发现分别记录在本页或交给 Task 8。不把本页开发前基线替代新增代码证据。

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

本机数据库阻塞已解除，Task 1 已提交并通过独立审查。若测试容器以后停止，tmpfs 数据将消失，重新核对隔离环境后运行测试，不恢复或混用生产数据：

1. 从[当前接手入口](current-handoff.md)规定的 git/文档核对开始，保留已有提交和用户改动。
2. 读取本计划的 `.superpowers/sdd/2026-09-14-iris-proactive-discussion/progress.md`、`task-1-report.md` 和审查记录；这是忽略的本机执行记录，不能作为唯一跨机器证据。不要重做已提交的 Task 1。
3. 已通过的审查范围为原执行起点 `1f1a5efe` 至 `24c090fc`，不是只看最后一笔文档提交。继续 Task 2–8；不得为重现 RED 删除或改写已提交的 0059。Task 4 需处理 100 条目录容量中保留 resolved 身份的生命周期，不能静默丢弃去重身份。
4. 未经当前任务新的部署授权，不推送、部署、发飞书消息或开放任何能力。

## 已作的实现裁决

| 裁决 | 理由 | 判断错误的代价 |
|---|---|---|
| Task 1 声明最终仓储合同，但只实现策略、登记、读状态、领取/失败评估与状态统计的 foundation 子集；其余行为分别留给 Task 4/5；0059 一次建立所需全部表 | 避免在发送门禁依赖尚未就绪时放入占位方法或重复后续任务 | 后续消费者需要显式扩展返回类型，可能少量返工 |
| 迁移/CLI 验证必须断言实际数据库或进程行为；文件名/缺 import 不算完整红绿证据 | 防止源码字符串匹配或测试跳过制造完成假象 | 聚焦测试稍长，环境依赖明确暴露 |
| resolved 问题只有出现经验证的实质新前提才可重开；user_paused 不因模型、策略版本或时间自动恢复 | 按已批准设计解决计划中简写注释的歧义 | 需额外显式状态转换测试或返工 |
| Task 2 依赖实际需要的 register/readState 子合同；历史读取显式扩展 user 类型并保留既有语义 | 避免要求尚未实现的 Task 4/5 方法或放入假方法，同时满足本群人类来源复验 | 少量依赖类型调整和历史 reader 定向回归 |

## 四处文档处置（未关闭功能）

| 核对项 | 处置 |
|---|---|
| 白皮书 | reviewed-unchanged：[主动工作讨论规则与11.2](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md)仍有效；只是本机测试阻塞，未改变产品行为或关闭缺陷 |
| 工程故障台账 | reviewed-unchanged：[故障台账](../operations/engineering-failure-ledger.md)仍有效；没有新增确认的 Iris 生产根因或已完成修复，环境现象留在本记录 |
| 需求/验收基线 | reviewed-unchanged：[覆盖基线](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)仍将新主动讨论列为未完成；未提升任何验收层级 |
| 开工入口 | updated：[current-handoff](current-handoff.md)更新执行起点、草稿状态与恢复入口；reviewed-unchanged：[README](../../README.md)、[AGENTS](../../AGENTS.md)的工作树定位和当前交接链接仍有效 |
