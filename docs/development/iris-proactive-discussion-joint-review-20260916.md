# 主动讨论：判断与文案联合复核

日期：2026-09-15 开始，2026-09-16 继续。用户以“继续”确认了
[上一轮有限方案](iris-proactive-discussion-model-trace-20260915.md#待确认的最小方案比较)。
工作树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支 `codex/iris-daily-pilot-followup`，
基线 `4a28ef54`。本次不 push、不部署、不发飞书消息、不改变开关或授权范围。
实现、模型语义、真实 PostgreSQL、CI 和真实飞书各自记录，不互相代替。

## 症状、原因与批准边界

run5 的 30 个决策均正确，完整结果仍为 26 通过 / 2 失败 / 2 未完整。
正确的最终文案不能覆盖仍被保存的 assessment 中的人数错误或确定性扩写；
一份拒稿有依据，另一份拒稿理由把核实建议误当成已经执行的动作。
这些证据见[保留的 run5](iris-proactive-discussion-model-trace-20260915.md#run5-两项语义失败与两项拒稿)。

已确认实现缺口：render 只返回 draft，worker/evaluator 始终继续消费原 assessment。
原本 draft=null 已能阻止 issue/delivery 写入，但候选仍可进入带 blocked 标签的追加式审计，
不能把它说成已经污染正式 issue，也不能称之为已核实的依据。本次没有读取生产业务数据库。

本次有限改动：

1. PdModel 内统一编排，返回通过联合复核的 `{assessment,draft}` 或 null。复核检查所有会保留的
   语义字段及最终文案，授权原文优先，区分事实、限定推断、核实建议与执行声明。
2. 首次复核拒绝时只允许一次成对修正、一次最终复核。再次拒绝、修正结构不合法或最终复核
   不可解析时终止，不将它变成持久化语义重试。技术 HTTP 失败仍走已有有限技术恢复。
3. 锁定 decision、reason、issue kind/已有 ID、证据集合与 materialChange kind/证据集合。
   新问题描述可修正措辞，但最终复核对照只读 originalAssessment 核查同一问题，不能利用同 refs 换题。
4. worker 与 evaluator 使用同一份返回组合。普通成功路径没有新增调用；不增加来源、权限、群、
   固定发言间隔、任务催办或数据库迁移。
5. 合成 trace 增加 pair_repair 阶段，使用同一个运行时 validator 做诊断复验；保留初稿和修正稿的
   接受标记。仍默认关闭、有界、脱敏，不记录任意生产内容，不增加模型调用。

调用预算：skip 为 1–2 次 completion；首次通过为 3–4 次；使用成对修正为 5–6 次。
既有 HTTP 客户端每次 completion 最多 2 次底层尝试，共享该次 timeout；429 不自动重试。
目前 60000ms 时模型 completion 累计上界最多 360 秒（不含排队/数据库），最多 12 次底层请求。
已存在的所有者续租与阶段活跃检查继续生效；不能把已开始的 HTTP 称为已取消。

## 回归与有限审查

2026-09-15 第一轮：

- model pair 测试实际 RED 9/9，GREEN model29 + pair9=38。
- worker 原候选与返回 pair 混用实际 RED 1 失败/21 通过，随后 evaluation22 通过。
- evaluator 原 assessment 残留实际 RED 1 失败/2 通过（22:24:23），修复后 3 通过。
- trace 新阶段实际 RED 3 失败/5 通过（22:26:20）；最终 evaluator 四文件20通过。
- 完整 Core：22:30:29 北京时间，4648 通过 / 465 条件跳过，253 文件通过 / 13 跳过，22.76秒。
- CLI 7通过；typecheck、build、runner 独立 strict TypeScript 编译退出0。
  该次全量的 PG 条件跳过不是数据库验收，也不是后续审查修复后的最终全量。

一次限定当前 diff 的独立审查发现两项 Important，未重开 Tasks1–8/I1–I4：

- 最终拒绝的 null draft 在仓储 freshness 检查之后处理，可能先触发 context/catalog/issue stale
  重排，违反终止边界。补 context/catalog/issue/source 四种实际 PG 并发回归。
- 新问题描述允许修正但最终 reviewer 看不到原问题，可能同 refs 换题。新增只在最终修正复核
  中传入 originalAssessment；测试先取得 8 通过/2 失败，再取得 model29+pair10=39 通过。
  动态 fake reviewer 证明输入和拒绝链路，不冒充本地语义算法或真实模型效果。

非阻塞后续：trace 达到 600 条上限时，若修正记录已丢弃，接受标记可能落在该轮尚存初稿上。
原 15 例两轮有限集不可达；保持记录不完整标记，不扩成本次额外加固项目。

2026-09-16 修复后的新证据：

- 新 PG suite 首轮13:25:12为3失败/3通过。source案例原以正文更新模拟删除，却未触发
  sourcesValid分支；完整正文hash由context builder校验，而该分支检查身份/删除，因此改用
  真实tombstone并对齐contextVersion以独立命中source保护。13:25:49正确RED为4失败/2通过。
  在策略/租约检查之后、freshness之前增加明确null draft终止分支，13:26:19实际6/6通过、0跳过。
- 修复范围独立复审确认两项Important解决、无新增阻塞；允许代码提交和同模型隔离run6，
  不代表模型语义通过、CI通过或部署批准。
- 完整Core在13:28:08开始、35.59秒：4649通过/469条件跳过，253文件通过/13跳过。
  四个新增PG场景仍在全量命令内条件跳过，其实际结果按上一条独立计数。

代码/测试/CI应用提交为 `ee9a8ae2cd8d3c1d596c42e0728331169827ed12`，文档和模型证据另行提交。
提交前主代理检查实际diff并独立重跑reviewed-pair：13:35:00开始11.13秒、6/6通过、0跳过。
最后一次typecheck/build、runner独立strict编译均退出0；CLI7/7通过（9.49秒）。CI YAML实际解析通过，
新增PG命令具有明确IRIS_TEST_DATABASE_URL。未跑本次完整Python/pilot套件或远端CI。

真实PG五文件以同一个本机合成测试URL逐文件执行，最终110个不同用例通过、0跳过，
其中107项真实PG、3项非PG；主代理重跑6项不重复累计为116。

| 文件（均在apps/core/tests） | 2026-09-16北京时间开始 | 总耗时 | 结果 |
|---|---|---|---|
| proactive-discussion-reviewed-pair.test.ts | 13:26:19 | 12.42秒 | 6通过 |
| postgres-proactive-discussion-repository.test.ts | 13:30:00 | 67.02秒 | 43通过 |
| postgres-proactive-discussion-concurrency.test.ts | 13:31:17 | 100.47秒 | 39通过 |
| proactive-discussion-e2e.test.ts | 13:33:07 | 5.54秒 | 4通过（2真实PG） |
| proactive-discussion-final-fixes.test.ts | 13:33:21 | 47.99秒 | 18通过 |

命令为 `npm --workspace apps/core test -- tests/<上述完整文件名> --reporter=dot`，
环境变量仅当次命令使用，helper创建/清理各自随机schema。既有pg client.query并发调用弃用警告保留。
13:26:58开始的第一次repository完整运行126.02秒，34通过/9个默认5秒超时，无业务断言失败。
与Core/编译存在本机负载重叠，但没有证明唯一根因；停止其他重负载后，13:29:39定向stale用例
1通过/42过滤跳过，再以原命令完整43通过。没有放宽超时、删测试、改断言或抹去失败。

run6的程序运行完成不等于语义通过；完整结果见下节。
新增 PG suite 已加入 CI 的显式数据库环境命令，但配置存在不等于远端 CI 已执行。

## 本机测试环境恢复

2026-09-15 启动 Docker 后，日志确认 dockerInference 的零字节运行时 socket 无法访问。
2026-09-16 继续时 PID/启动时间及错误仍一致；只停止本轮启动后崩溃的 Docker 进程，
精确核对运行时目录内容后做可恢复改名，没有清空镜像、容器、volume 或恢复出厂设置。

- `C:/Users/59912/AppData/Local/Docker/run.iris-test-20260916-1322.bak`：三个零字节运行时文件。
- 随后启动暴露独立的 Secrets Engine/engine.sock 同类错误，用户截图与日志一致。
- `C:/Users/59912/AppData/Local/Docker/run.iris-test-20260916-1327.bak` 和
  `C:/Users/59912/AppData/Local/docker-secrets-engine.iris-test-20260916-1327.bak`：各一个零字节文件。

再次启动后 docker inspect 成功。精确核对并仅启动既有测试容器
`iris-pd-test-20260914-b` / `8461609b58ad25c3159f4c9137bc2ea9d270eb1c7dde6a724d1a753057516554`，
同一 pgvector 镜像摘要、独立卷 `iris-pd-test-data-20260914-2339`、仅 `127.0.0.1:55439`。
刚启动时 pg_isready 曾报告 rejecting connections；随后实际 SQL 返回 iris_pd_test、PostgreSQL16.14、
vector0.8.5/public。该恢复不证明 Windows socket 故障永久根治；没有启动业务容器或连接生产数据库。

## 生产与隔离模型评估边界

`2026-09-16T05:28:05Z`只读核对生产core容器仍为
`79f8a852f3503bbcbd2d86c01aabefaf154783b8a503edaa7c2fb54b96df4343`，标签
`iris-core:f6a6dd4187dcb1b574fb78a11f837edec8b09b89`，镜像摘要
`sha256:cb6e915b84adfa2a2189cc6928b31ad6ec00929f1ea9e2329d4e9f4894ef2383`。
running=true、RestartCount=0；StartedAt为`2026-09-15T18:16:45.854815203Z`，
与上一日记录不同，不能说跨日从未重启，也未将原因归因于本次操作。
模型配置stat仍为`64770:699808:4803:1788939422:600:1002:1003`。
本次仅核对身份；没有生产健康/队列/开关/真实飞书验收。

## run6：联合复核后的固定合成集

被评估应用为ee9a8ae2，私有目录`/tmp/iris-pd-eval-20260916-run6-Pc2IiSy2`，700/uid1002/gid1003。
只打包合成runner与配置解析器，91个输入模块、外部模块只有node:url/node:crypto，
没有飞书读取/发送、PG仓储或应用runtime启动依赖。就地读取已有配置，仅五个模型字段进入子进程，
不下载/输出密钥。network-none预检通过：同一gemini-3.5-flash-lite、Nodev22.23.1、HTTPS、60000ms。
原15例×2轮、6000ms评估请求间隔、默认外显不变的合成trace显式开启；不换模型、账号或标准。

| 上传物 | 本地/服务器一致SHA256 |
|---|---|
| runner.mjs | `f7e7e4b96f14597e80779d8768e8d5f976f2a2e336b9b5dfb08730e19b688600` |
| model-config.mjs | `c6c6215d3b048b4c5e990fe6c79fdd9074ba8ff832f0e9146638f6db7d4f1ef5` |
| launch.mjs | `a22a6312c38ddc6da8416c069a44c8bd9cf344e2fa9c71bbdbc48e87de0cc293` |

`2026-09-16T05:37:27Z`开始，单次有界运行，容器256MiB/0.5CPU/64PID、只读、无capabilities、
no-new-privileges、uid1002/gid1003；最多30分钟，结束自动移除。该评估不会运行服务、访问群聊、
写生产数据库或向飞书发消息；不将评估container视为生产部署。

### 实际结果与拒绝上线的原因

`2026-09-16T05:43:05Z`结束，338秒，退出0、stderr0字节。
[run6原始报告](evidence/iris-proactive-discussion-20260916-model-run6.json)99470字节，SHA256
`1535000d0fba5db574bbfdf6d848c2e079a02f9226ca0cc700aabe7032a61f2e`，服务端/本地/归档一致。
报告manualReview=pending保留，CLI自身明确只证明provider execution；没有伪造人员签字。
原run1–6的15场景、expectedDecision与reviewCriteria均与当前factory一致，历史报告哈希未改。

30个决策正确、10份文案、0阶段错误/0未完整；完整assessment+draft语义仍未通过。
主代理与独立代理逐条核对的结果一致：26通过/4失败/0未完整，12个场景两轮均通过。

| 场景 | 第一轮 | 第二轮 |
|---|---|---|
| arithmetic | 失败：成对修正后遗漏明确6万差额 | 通过：16万/6万 |
| inference | 失败：assessment断言预测必然严重失真 | 失败：同类确定性断言 |
| qualified-risk | 通过：风险限定、先验证建议 | 通过；一次结构修复 |
| separate-next | 通过；审批措辞观察保留 | 通过；审批措辞观察保留 |
| material-update | 通过：24万/增加8万/缺口14万 | 失败：draft遗漏增加8万 |
| paraphrase / unrelated-update | 两例均通过 | 两例均通过 |
| casual / hypothesis / handled / corrected | 四例均通过 | 四例均通过 |
| source-loss / stopped / injection / followup | 四例均通过 | 四例均通过 |

具体失败及机制证据：

- arithmetic:1，call2/3本有16万、超6万和60%；call4首次复核却称“未经授权计算了60%的增幅”
  并认定超出可核算范围。由(16−10)/10可直接得60%，这项理由是误判，而非需要额外业务授权。
  call5成对修正仍是同一招聘预算问题，refs/结构未改变，但assessment和draft都删掉6万，
  只剩“存在差额/超出了基准预算”；call6最终复核仍supported=true。修正链实际运行了一次，
  正确终止并返回同一pair，但语义质量未合格，不能因它消除了null而宣布修好。
- inference:1 reasoning仍写“会导致预测结果严重失真”，inference:2写“会导致收入预测严重失真”。
  5人喜欢不足以证明全量付费，也不能证明真实预测误差必然达到严重程度。两份draft虽改成
  “可能”，联合复核call9/call35仍错误放行保留下来的确定性assessment；uncertainty标签不能纠正断言。
- material-update:2 assessment含24/14/8万，但draft遗漏原标准要求的较原方案增加8万，
  call47复核仍全部放行。“可能导致资金缺口进一步扩大”弱化已知算术，以及assessment把
  方案可行性判断与fact标记混用，另作表达/事实推断边界观察，不用额外门槛增加失败数。

非阻塞措辞观察：separate-next两份assessment建议中有“获得合规审批之前”，比材料具体；
仍是核实/暂停建议，不是声称公司已有特定审批制度或审批已经完成，按此前run5相同口径保留观察，
不临时提高验收标准。多处机械“核对授权”、建议调整薪酬等沿用已有措辞后续；不是本轮扩建目标。
10份最终中文文案无conjecture/confidence等英文策略词、模型信心数字或虚构工具执行承诺。
内部scope英文理由/JSON字段和业务100%付费率，不当作群文案策略泄漏。

### 调用、诊断与停止边界

57条trace完整、无丢弃/截断：35 assessment +10 draft +11 scope_review +1 pair_repair。
arithmetic:1只有一次pair修正与最终复核；初稿acceptedDraft=false、修正稿true，最终result与该pair相同。
其他9次初次scope直接通过，无额外pair调用；不存在第三次修正或未完整结果的隐性追加抽样。
这是57次completion记录，不将其冒充底层HTTP尝试数。

5个首assessment的同validator诊断复验为relation_invalid：arithmetic:1、qualified-risk:2误用
new issue/unattempted_first；casual:1、injection:2、followup:2在skip/none保留非空变化说明。
全部由既有一次结构修复纠正。52条诊断结构通过不代表52条语义核准；scope=false的有效结构也在其中。

本次确认接口/持久化/终止约束已按设计实现，并观察到一次真实成对修正；不能证明该模型可靠地
执行了联合语义审查。实际证据是：它误拒可计算数字、放过必要数字丢失和内部过度断言。
不将其归因于未看见隐藏推理，也不靠新增同类提示或原样抽样直到通过。

`2026-09-16T05:44:10Z`后置检查：生产容器、标签、摘要、StartedAt、restart0/runningtrue及配置stat
与本次05:28前置核对一致，run6临时容器已自动移除。没有push、部署、开关/治理更改、飞书外发，
没有生产健康/队列或真实群验收。首次下载尚未结束时的本地读取曾报EBUSY，等待scp完成后再读取，
校验和一致；这不是模型错误或另一次模型运行。

## 下一步有限边界

本轮代码、真实PG、固定模型运行和四处文档均有证据，但主动讨论整体仍未达到交付门禁。
保持生产原有限问答，不启用此主动链；本次不再次运行同一模型/同一输入，不改门槛或隐藏失败。
下一步应单独决定模型复核质量的处理方案，例如是否授权一次更强模型的同集隔离对照，
或批准独立的数值/主张校验设计；更换模型、账号、费用范围、架构或发布权限不能由本记录代为批准。
Tasks1–8/I1–I4和本轮代码审查保持结束，只针对上述已观测失效推进，不重开无界加固。

## 文档与证据收口核验

一次限定文档范围的独立复查核对四处处置、110项不同用例/107真实PG、保留超时、跨日生产
StartedAt变化与run6尚未返回时的状态。发现三个旧入口仍将run4/run5的“先确认方案”当作当前
待办，以及执行记录日期未更新；已修正当前优先项/继续点/更新日期，并保留历史原文和前向链接。
随后主代理与另一独立代理分别核对run6的30份完整结果、57条trace及归档哈希，结论一致。
10个acceptedDraft标记（9初稿、1修正稿）均与最终文案逐字相同，没有把最初有6万的被拒稿
当作最后遗漏6万的合格替代。报告manualReview未改写。

最终链接、工作树和提交核对只用于文档收口，不冒充重新运行Core、PG或模型；
本次应用提交仍为ee9a8ae2，随后文档/证据提交不等于生产已更新。
最终本地链接检查14份文档、302条本地链接、82个锚点、0错误；git diff --check通过，
应用/测试/CI路径与ee9a8ae2无diff，run6归档哈希再次核对一致。

## 四处文档处置

| 位置 | 本次处置 |
|---|---|
| 白皮书 | updated：[第6节](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)明确最终判断/文案共同复核、同问题和有限修正/终止；[11.2](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#112-mandatory-bug-fix-documentation-closure) reviewed-unchanged，四处处置与分层验收规则仍准确 |
| 工程故障台账 | updated：[主动协作条目](../operations/engineering-failure-ledger.md#proactive-collaboration-is-not-a-deadline-reminder)记录联合组合消费、拒绝不能被stale重排和修正不能换题 |
| 需求覆盖基线 | updated：[本次修订](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md#2026-09-16-判断文案联合复核)及IRIS-CORE-005指向实际门禁，不提升为部署/真实群通过 |
| README/AGENTS/当前交接 | updated：[README](../../README.md#current-product-state)、[当前交接](current-handoff.md#当前正在推进)、[专项入口](iris-proactive-discussion.md#当前边界)和[执行入口](iris-proactive-discussion-execution.md#当前状态)；reviewed-unchanged：[AGENTS](../../AGENTS.md)的工作树定位、四处闭环和有限出口规则继续有效 |
