# Iris 来源计划：本地 PostgreSQL 到模拟发送验收

日期：2026-10-04。工作树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支
`codex/iris-daily-pilot-followup`。受测应用为
`1ea3ae7e528ae5f7ceb38686d6853fea9e0e6877`；本轮只补跨模块测试，不改变应用行为。
测试提交：`dae37c652ddaaf39528a324108739014c510369e`。后续文档提交不代表应用修复或部署。

## 验收缺口与边界

上轮[本地接入](iris-opinion-runtime-20261004.md)已经验证模式装配及正式 eval 的实际响应
回放，但终点是 accepted pair。已有 PG e2e 使用手写 `PdModel`，未直接证明来源计划的
最终 pair 能经过真实评估落库、待发任务和发送回执。这是验收证据缺口，尚未发现新的
应用故障；不把缺少测试当成已确认的运行时 bug。

[本轮计划](../superpowers/plans/2026-10-04-iris-opinion-postgres.md)限定两个案例：
arithmetic 的正确意见和 hypothesis 的结构化沉默。响应取自已提交的
[原始合成归档](evidence/iris-opinion-decision-resumed-20261004.json)，内容不改写；通过
真实 `createPdModel`、context builder、registrar、evaluation worker、PG repository 和
delivery worker，仅来源读取及飞书回复使用合成接口。多余模型调用直接失败，无网络回退。

真实数据库的 context/catalog 版本不改成历史值；请求比较只允许这两个动态计数差异，
其余业务材料、引用、模型阶段和 schema 必须一致。因此这是旧响应驱动的跨模块验证，
不属于新鲜模型语义验收，也不是旧 HTTP 请求逐字重放。

## 环境与执行证据

本轮启动 Docker 时，日志确认 `Docker/run/dockerInference` 旧零字节运行时描述符
无法访问。核对本轮进程及目录内容后，停止本轮启动的进程，保留两个套接字目录：

- `C:/Users/59912/AppData/Local/Docker/run.iris-test-20261004-1623.bak`
- `C:/Users/59912/AppData/Local/docker-secrets-engine.iris-test-20261004-1623.bak`

一次重启后 engine 可用。备份名是标签，实际重启时间为北京时间16:20:56；没有重置
Docker、删除镜像/容器/数据卷、上传诊断或改系统权限。这里只确认此次恢复，未证明
Windows 套接字问题根治；先前相同症状仍保留于[历史环境记录](iris-proactive-discussion-execution.md)。

核对并启动既有专用容器 `iris-pd-test-20260914-b`：只绑定 `127.0.0.1:55439`，镜像为
`pgvector/pgvector:pg16@sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb`，
挂载既有专用合成测试卷 `iris-pd-test-data-20260914-2339`。SQL 与主机 TCP 连接均确认
数据库/角色 `iris_pd_test`，PostgreSQL16.14、vector0.8.5/public；没有连接生产数据库。
测试沿用随机隔离 schema、全迁移及测试后清理，未修改全局 PG 参数。
测试结束后已正常停止本轮启动的专用容器，状态Exited(0)，专用数据卷保留。

实际门槛命令和结果：

[执行工具输出摘录](evidence/iris-opinion-postgres-20261004-verification.md)保留原命令、
会话、退出码及关键输出；明确是摘录，不冒称完整原始stdout。

| 命令 / 核对 | 结果 |
| --- | --- |
| 专用本地 `IRIS_TEST_DATABASE_URL`，`npm --workspace apps/core test -- proactive-discussion-e2e.test.ts --no-cache` | 6通过、0跳过，exit0，18.82秒；北京时间16:24:56开始。含新增2例真实PG、既有2例真实PG和2例eval。 |
| `npm run typecheck` | exit0。 |
| `git diff --check` | exit0；仅Git换行提示。 |

新增正例精确核对 evaluation 的最终 assessment/draft、issue 正文及来源、prepared正文，
模拟回复一次后留下sent/reply id，第二次delivery为idle。沉默例仅消耗assessment响应，
三段自由正文为空、无draft/issue/delivery。两个案例均断言全局fetch从未调用。
新路径从消息持久化和registrar开始；原有两例覆盖原始飞书事件适配、普通追问和暂停。
不声称同一新例也执行了原始webhook信封。

测试文件SHA256为 `1f2cb9b2833dd74e3e23f76137c7c03cdc555bb6104c3176fa3e28ae8eb59917`。
初次未设数据库的加载检查为2通过/4条件跳过，未计为PG验收；初版类型检查缺少动态
导入回调类型和registrar的`mentionedIris`字段，修正测试后通过。此前同文件有缓存运行
6/6、21.25秒通过，最终结果以上述no-cache为准。没有修改生产代码或声称bug修复RED/GREEN。
既有普通追问链路出现同一pg client并发query将于pg9弃用的警告，当前不导致失败；保留
为依赖升级跟进项。本轮仅测试文件变更，未重复整套Core/build或旧实模窗口。
独立审查确认测试符合限定计划，无可操作问题；受测文件哈希与最终测试提交内容一致。
单次成功投递和下一轮idle的验证，不扩称故障/并发条件下的exactly-once保证。

## 实际验收层级和保留问题

- 代码：本轮测试变更，应用实现仍为1ea3ae7e；无新增模型配置或发送开关变更。
- 本地真实 PG：新增2例与既有用例共6通过、0跳过；类型检查通过。
- 实模语义：沿用上轮限定八业务例和两负控；本轮新增模型HTTP为0，未读取模型凭据。
- 真实飞书、生产精确版本、部署：本轮均未执行，也未验收。

初判仍有过强后果、审核解释不精确、模板覆盖及负控交叉线索的局限均见
[上轮保留问题](iris-opinion-runtime-20261004.md#保留的问题)，整体能力缺陷继续开放。
本轮门槛通过后不追加同类抽样、提示词或无界加固；下一项产品验收是明确范围的真实
单群投递/停止/恢复和精确部署版本，这些需要另行授权，当前“继续”不扩大授权。

## 白皮书11.2四处处置

| 位置 | 处置与有效链接 |
| --- | --- |
| 白皮书 | **reviewed-unchanged**：[§6及§11.2](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md)的最终pair、发送门禁与分层验收合同不变；本轮仅补该合同的本地跨模块证据。 |
| 工程故障台账 | **updated**：[2026-10-04 PG验收条目](../operations/engineering-failure-ledger.md)补充“模型pair通过不代表最终落库/投递链路通过”的证据边界及本轮有界门槛，不重复旧语义故障。 |
| 核心需求覆盖基线 | **updated**：[基线](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)增加来源计划真实PG到模拟发送的本地证据，IRIS-CORE-005仍部分实现，真实群/部署缺口不提升。 |
| README / AGENTS / current-handoff | **updated**：[README](../../README.md)和[当前交接](current-handoff.md)链接本记录，区分测试提交与应用1ea3ae7e。**reviewed-unchanged**：[AGENTS](../../AGENTS.md)的工作树核对、授权边界与四处文档闭环规则仍适用。 |
