# Iris c7a286f3 免费 CI 通过与本地镜像准备

执行日期2026-10-08，文档闭环2026-10-09。用户本次明确允许推送当前修复分支，并在确认免费后运行CI；授权不含
生产SSH、部署、重新开窗、普通QA启用或飞书外发。实现树为
`D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支
`codex/iris-daily-pilot-followup`。默认工作树、master及历史失败记录保持。

## 来源和免费边界

进入时工作树干净；远端分支为`be306b96946f0267918daef384024cc42b55760d`，本地
`f103ff6ab4850cafd5b845f11a23f020388bccc8`是其后15个提交，已普通快进推送，无force。
最新应用仍为`c7a286f37a85afa5c023359135b1331fdc556e94`，f103ff6a仅归档其有限合成
验收。待推送132个文件已作有界新增文本/凭据与真实窗口原文载荷检查，未发现确认泄露；
此检查不宣称可以形式化识别任意自然语言个人信息。

本次GitHub API查询仓库为PUBLIC，两个job均使用标准`ubuntu-latest`，没有larger
runner或制品上传。按[GitHub当前计费说明](https://docs.github.com/en/billing/concepts/product-billing/github-actions)，
公开仓库的标准runner免费；现有cache为23,243,643字节，远低于10GiB免费存储，锁文件
和workflow相对远端未变。cache storage-limit读取返回402、要求有效支付方式，未以此
变更支付或费用配置，也没有购买额度、付费回退或扩大存储上限。这是本次执行路径的
免费条件核对，不是账户历史账单审计。

[现有workflow](../../.github/workflows/ci.yml)使用runner内临时PG/Redis/Compose和CI
假凭据，无生产secrets、SSH或部署。会下载并运行本地Ollama向量模型，以四条固定文本
检查embedding；不调用百炼或外部业务LLM，不使用真实群数据或真实飞书发送。
备份恢复、回调与开关故障注入均限runner，最后清理其测试容器和卷。

## 精确 CI

本次仅dispatch一次：[run 37763096629](https://github.com/xfbbert-dotcom/iris/actions/runs/37763096629)，
event为workflow_dispatch，headSha已回读确认是f103ff6a完整SHA。workflow Git blob为
`d3313a7df1601800e942e2c422a336fd3b58d6e4`，lock blob为
`842a2d9c5d20a7eb7e2a122cac5502e6104620b6`。

门槛是整个现有workflow成功，包括类型、构建、Core、pilot合同、PostgreSQL集成、
Compose/readiness、数据库权限、成对备份恢复和Redis不可用检查；重点保留实际PG的
主动讨论repository/concurrency/e2e/final-fixes/reviewed-pair结果。历史模型归档回放
使用记录的响应及飞书替身，不等于新实模或真实飞书验收。

18:23:00—18:33:12北京时间，两job均success，首次运行通过，没有失败重试或应用修改。
[GitHub运行元数据](evidence/iris-ci-20261008-f103ff6a-run.json)与
[测试摘要](evidence/iris-ci-20261008-f103ff6a-summary.json)保留精确SHA、阶段及原日志哈希。

- Core：5118通过、471条件跳过；类型检查、生产构建通过。
- 单独PG阶段：23个文件、530项通过，其中主动讨论repository43、concurrency39、
  e2e6、final-fixes18、reviewed-pair6。e2e含历史source-plan归档回放与普通@追问路径。
  这些是各阶段计数，不能去重相加，也不宣称一般套件的471项跳过全部被后续执行。
- pilot合同217项通过；AI worker181项通过。Compose/readiness、数据库角色、成对备份
  恢复、Redis故障拒绝与恢复全部通过，清理完成。
- CI镜像构建prune报告运行依赖0告警；开发工具9项历史告警以及pg/anyio弃用提示仍保留，
  不把本次通过写成全依赖无告警。没有借此扩展依赖升级。
- 完成后cache共46,494,627字节，仍低于免费上限；无计费设置变更。

## 本地 Docker 启动失败与恢复

CI中的镜像只在临时runner验证，没有上传或导出为部署制品。本机已用git archive保存
精确c7a286f3源码，归档SHA256为
`38bdacc296e6fc320b676b9ddbd34905468d109ccdf6ec0817585b55b47a8420`。
隐藏启动已安装Docker Desktop后，180秒目标等待未取得desktop-linux引擎管道；最终无
Docker进程、com.docker.service停止。随后尝试启动该服务返回“Cannot open
'com.docker.service' service on computer '.'”，当前进程无法启动服务；未提升权限或
改WSL/服务配置。此时没有查明Desktop退出根因，不能将服务错误当作完整根因。

[本地准备记录](evidence/iris-local-image-20261008-c7a286f3-blocked.json)区分了成功源码
归档与当时未执行的镜像构建、运行依赖审计和断网检查。保留这个失败阶段，不覆盖它。

用户随后要求自行操作。backend日志确认10:25:30 UTC实际崩溃点是初始化Inference
manager时无法移除`Docker/run/dockerInference`；为0字节遗留AF_UNIX reparse point。
先保留run并重建后，启动推进至第二个相同错误：`docker-secrets-engine/engine.sock`。
仅处理第二处后，前次失败留下的新run节点又阻塞；没有重复原配置盲启动。

确认Docker已停止、相关目录仅含0字节reparse point、源/目标绝对路径均在明确的
LocalAppData范围后，原目录分别保留为`.stale-20261008`和`.stale2-20261008`，再创建
空运行目录。`docker desktop start --detach`成功，19:06北京时间`docker info`返回
`29.6.1 linux/x86_64`；Windows Docker服务仍Stopped，证实此次恢复不依赖提权启动服务。
未删除原目录、镜像或卷，未更改WSL、权限或服务配置，未做factory reset。
已确认的是两个本地IPC节点阻塞启动；Windows为何不能访问这些旧节点的底层归因仍未知。
本轮到引擎可用及精确镜像验证为止，不扩大为Docker/Windows通用修复。

## 精确本地镜像与导出

19:06:10—19:06:53北京时间，从上述c7a286f3 Git归档正常构建既有固定Node22 Dockerfile，
build exit0。镜像为`iris-core:c7a286f3-local-20261008`，linux/amd64、USER node，revision
为完整应用SHA，image ID：
`sha256:19cce91342a177a68bb5cb94efb86e69c011cf54829a118f40ef990974bbea4e`。
主执行者另行inspect核对一致；镜像内`npm audit --omit=dev --json`退出0、已知告警0。

[断网脚本](evidence/iris-local-image-20261008-c7a286f3-smoke.mjs)在`--network none --read-only`
容器中执行通过：新模块存在，完整连续原文取回、dependency条件行动、旧target和quote-only
拒绝、3个撤回原因、生成/修正schema均符合当前合同；开发工具未进入镜像。它仅导入编译
模块、不启动应用、不连接数据库或模型/飞书，也不代替实际模型采用撤回分支的证据。

[镜像/恢复结果](evidence/iris-local-image-20261008-c7a286f3.json)保留各步骤退出码及范围。
已本地导出84,104,192字节镜像归档，SHA256为
`04616cc23732f064141f0f174fc0369c3d2ba4c285014836c415205efa2b4370`，存于操作员本机
发布目录。尚未上传、部署或验收生产，不把CI镜像、本地制品或记录提交混为上线。

## 后续发布范围草案（未执行）

相对最后核验的生产51937b95，本候选应用仅修改主动讨论的三个源码文件；无新迁移，
锁文件、Dockerfile、pilot配置和AI worker源码未变。根package.json仅扩充本地pilot
测试命令。拟固定精确c7a286f3镜像，只替换Core，保留现场Caddy/非Core镜像及有效配置。

发布前必须重新核验现场版本、关闭状态、队列与未确定投递，按现有手册完成成对备份与
验证；若现场与最后快照不符，先核实差异。应用切换后检查健康、数据库与公网边界，
global/desired/PD和普通QA保持关闭。失败时停止并使用旧镜像/原配置回退，不清空或重发
unknown记录。本次没有执行任何这些生产操作。

普通QA未开启的追问缺口不由该镜像自动解决。后续真实验收必须明确包含主动意见后的
@追问，先验证其路由、原消息上下文和免费调用保护，再在用户就绪后执行有界窗口。
不能再让用户在QA关闭或窗口已结束时发送追问，也不能把PD专用免费门禁视作普通QA
已有同等保护。此处仅记录下一产品门槛，没有新增启用或外发授权。

## 白皮书11.2四处处置

| 位置 | 处置 |
| --- | --- |
| 白皮书 | **reviewed-unchanged**：[白皮书](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md)的来源/建议合同及分层验收边界未变；本轮是既有修复的发布验证，不增加产品能力。 |
| 工程故障台账 | **updated**：[台账](../operations/engineering-failure-ledger.md)补充本机Docker启动失败要先核对backend日志、保留运行目录再验证的经验；真实误判、引用漏字和无价值建议及有限修复保持，CI不关闭真实意见或追问缺口。 |
| 核心需求覆盖基线 | **reviewed-unchanged**：[覆盖基线](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)的IRIS-CORE-005仍部分实现，四例合成通过不等于完整真实群验收。 |
| README / AGENTS / current-handoff | **updated**：[交接](current-handoff.md)记录本次实际CI通过和本地镜像准备；[修复记录补注](iris-decision-gate-20261008.md)指向后续验证。**reviewed-unchanged**：[README](../../README.md)的生产51937b95说明及交接入口、[AGENTS](../../AGENTS.md)的工作树和授权/闭环规则仍有效。 |

最新应用修复、本地测试、四例实模语义、精确CI、真实飞书和部署仍分别记账；不将本记录
或后续文档提交当作已部署。生产最后证据仍为[16:31关闭核验](iris-pd-real-opinion-20261008.md)，
本轮未重新读取生产状态。
