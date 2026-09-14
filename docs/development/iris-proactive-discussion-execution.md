# 主动工作讨论：实施进度与测试环境

记录日期：2026-09-14。对应[已批准设计](../superpowers/specs/2026-09-09-iris-proactive-discussion-design.md)和[8 项实施计划](../superpowers/plans/2026-09-14-iris-proactive-discussion.md)。这是未完成实施的交接记录，不是发布或 Bug 关闭记录。

## 当前状态

- 用户选择子任务实施与逐项审查。实现工作树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支 `codex/iris-daily-pilot-followup`；执行起点 `1f1a5efe`。
- Task 1 进行中，Task 2–8 未开始。尚无本轮应用提交、任务审查通过、模型验收、飞书发送或部署证据。
- 已写基础类型、消息内容规范化与哈希绑定，以及数据库行为测试/隔离 schema fixture；它们目前是未提交的工作区草稿。`0059_proactive_discussion.sql` 和 PostgreSQL repository 实现尚未创建，不能把测试骨架当成可用功能。
- 20:44 本机 Docker 已恢复启动、独立 PostgreSQL 测试库已就绪，Task 1 在原草稿上继续。不得跳过真实缺表失败测试、使用生产库代替测试库，或把条件跳过记为 PG 通过。

## 已取得的测试证据

| 层级 | 命令 / 结果 | 边界 |
|---|---|---|
| 开发前基线 | `npm test -- --reporter=dot`：4486 通过 / 345 条件跳过，239 测试文件通过 / 9 跳过，52.20 秒 | npm 将 reporter 参数识别为配置并警告；后续直接调用 workspace 测试。不是新增代码通过 |
| 初始测试骨架 | `npm --workspace apps/core test -- migration-runner.test.ts postgres-proactive-discussion-repository.test.ts`：1 失败 / 39 通过 / 12 条件跳过，另有缺模块导致的 suite 失败 | 缺迁移预约及模块只证明骨架为红，不是真实 PG 缺表证明；该次计数对应当时草稿 |
| 消息绑定聚焦测试 | `npm --workspace apps/core test -- postgres-proactive-discussion-repository.test.ts -t 'message bindings'`：1 通过；移除 CRLF 规范化时实际 SHA 不匹配，恢复后通过 | 单元/变异证据，不是 PG 行为、最终完整回归或任务验收 |
| 停止前聚焦测试 | 20:28 再运行上述两个测试文件：40 通过 / 1 预期失败 / 23 条件跳过；`npm run typecheck` 唯一 TS2307 为尚不存在的具体仓储模块 | 当前草稿不通过完整开发门禁；没有真实 PG 证据。未重跑完整套件 |

恢复时重新运行聚焦测试；不要将本页开发前的完整绿色基线套用到当前未完成草稿。

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

## 继续实施

本机数据库阻塞已解除，已恢复原 Task 1 实施者。若测试容器以后停止，tmpfs 数据将消失，重新核对隔离环境后运行测试，不恢复或混用生产数据：

1. 从[当前接手入口](current-handoff.md)规定的 git/文档核对开始，保留当前草稿。
2. 读取本计划的 `.superpowers/sdd/2026-09-14-iris-proactive-discussion/progress.md` 与 `task-1-report.md`；这是忽略的本机执行记录，不能作为唯一跨机器证据。不要重新派发已存在的 Task 1 草稿。
3. 在 0059 仍不存在时，运行 migration runner 的真实缺表失败测试，再继续 Task 1；通过真实 PG 与类型检查后进行独立审查，随后按序执行其余任务。
4. 未经当前任务新的部署授权，不推送、部署、发飞书消息或开放任何能力。

## 已作的实现裁决

| 裁决 | 理由 | 判断错误的代价 |
|---|---|---|
| Task 1 声明最终仓储合同，但只实现策略、登记、读状态、领取/失败评估与状态统计的 foundation 子集；其余行为分别留给 Task 4/5；0059 一次建立所需全部表 | 避免在发送门禁依赖尚未就绪时放入占位方法或重复后续任务 | 后续消费者需要显式扩展返回类型，可能少量返工 |
| 迁移/CLI 验证必须断言实际数据库或进程行为；文件名/缺 import 不算完整红绿证据 | 防止源码字符串匹配或测试跳过制造完成假象 | 聚焦测试稍长，环境依赖明确暴露 |
| resolved 问题只有出现经验证的实质新前提才可重开；user_paused 不因模型、策略版本或时间自动恢复 | 按已批准设计解决计划中简写注释的歧义 | 需额外显式状态转换测试或返工 |

## 四处文档处置（未关闭功能）

| 核对项 | 处置 |
|---|---|
| 白皮书 | reviewed-unchanged：[主动工作讨论规则与11.2](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md)仍有效；只是本机测试阻塞，未改变产品行为或关闭缺陷 |
| 工程故障台账 | reviewed-unchanged：[故障台账](../operations/engineering-failure-ledger.md)仍有效；没有新增确认的 Iris 生产根因或已完成修复，环境现象留在本记录 |
| 需求/验收基线 | reviewed-unchanged：[覆盖基线](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)仍将新主动讨论列为未完成；未提升任何验收层级 |
| 开工入口 | updated：[current-handoff](current-handoff.md)更新执行起点、草稿状态与恢复入口；reviewed-unchanged：[README](../../README.md)、[AGENTS](../../AGENTS.md)的工作树定位和当前交接链接仍有效 |
