# 本地免费候选：格式通过，原算术单例未通过

日期：2026-09-17。用户批准按免费/本地后备方案直接操作；不推导为付费、生产切换或
主动发言上线授权。开工基线为干净`6cc02fa3`，实现工作树仍为
`D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`、分支`codex/iris-daily-pilot-followup`。
被评估应用为`ee9a8ae2cd8d3c1d596c42e0728331169827ed12`；本次无应用修复提交。

## 选择与成本边界

第三次授权窗口的Zhipu单次探测仍HTTP429，[全部失败均保留](iris-free-model-probe-20260917.md#第三窗口与本地后备)，
本窗口没有追加其他云端模型调用。对两个备选作只读官方资料核查：

- [OpenRouter](https://openrouter.ai/docs/api/reference/limits)零充值免费模型为50请求/日、20RPM，
  既有run6已记录57次completion，故不能保证同日完成同一完整集；不为扩大额度充值，不用随机免费
  路由冒充固定模型对照。未注册、建key或调用；供应商[数据政策](https://openrouter.ai/docs/guides/privacy/provider-logging)仍须逐模型核实。
- [Gemini免费层](https://ai.google.dev/gemini-api/docs/billing)仍需账号/项目/key和
  [实际项目额度](https://ai.google.dev/gemini-api/docs/rate-limits)；不启用账单。
  [地区清单](https://ai.google.dev/gemini-api/docs/available-regions)与实际合法使用地须匹配，
  不假定用户所在地或账号资格。免费数据可用于改进产品，故即使以后可用也仅发合成材料。
  本次未注册、读取该服务凭据或发送模型请求。

实际选择官方开源Qwen3-4B的本地量化模型作有限后备实验。它不产生模型API费用，
但占用本机磁盘、内存、CPU及下载带宽；没有声称性能强于原模型或适合上线。
开始前本机可见RAM23.29GiB、空闲8.41GiB；AMD780M，未发现现成ollama/lms/llama-server命令。
选CPU模式，不安装驱动、不改PATH、不创建Windows服务或开机启动项。

## 下载与隔离运行

独立目录：`C:/Users/59912/AppData/Local/Iris/local-eval-20260917/`，在Git之外。
只下载官方发布物，文件长度及SHA256均与官方元数据相符后才执行/加载：

| 物料 | 官方来源、固定标识 | 长度与SHA256 |
|---|---|---|
| 便携式CPU运行程序 | [llama.cpp b11011](https://github.com/ggml-org/llama.cpp/releases/tag/b11011)，Windows CPU x64；`--version`为0.4.1-dev/build11011/aa39d7a3e | ZIP18438128字节；`54511f3fec3273715725736197dfb7abefbb97932656c90104fb2a0d09e21a94` |
| 官方Q4_K_M模型 | [Qwen/Qwen3-4B-GGUF](https://huggingface.co/Qwen/Qwen3-4B-GGUF)，`Qwen3-4B-Q4_K_M.gguf`，Apache2.0 | 2497280256字节；LFS SHA256 `7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5` |

运行参数见[启动器快照](evidence/iris-local-free-model-20260917-launcher.txt)：仅
`127.0.0.1:18089`、CORS精确同一本机origin，关闭webui/agent/MCP代理，无工具调用。
CPU生成/批处理各4线程、单槽、ctx16384、batch256/ubatch128、GPU层0、最大输出2048，
reasoning off，temperature0.7/top-p0.8/top-k20/min-p0。不改原Iris提示、schema或校验器。
独立看门狗最多30分钟，模型请求timeout仍60000ms；本次在单例失败后主动结束。

准备过程的失败/警告保留：HF元数据读取曾EOF，文件下载随后一次完成并校验；最初误写
不存在的`llama-server-impl.exe`产生ENOENT，未启动推理，实际发行物为exe加载impl.dll。
首次正常启动观察到默认宽CORS警告，在发送任何模型请求前停止并改为精确本机origin；
旧`enable_thinking`模板参数弃用警告通过使用该版本已有`--reasoning off`参数消除。
模型控制token类型警告仍存在，不能把它认定为本次算术/结构失败的根因。

## 实际门禁结果

[测试封装快照](evidence/iris-local-free-model-20260917-harness.txt)复用原应用client、
`createPdModel`和原factory/evaluator；不读真实群聊、知识库、生产配置或Zhipu密钥。
仅允许固定本机URL及模型，禁止重定向、流式和工具，结果路径在请求前检查。
完整集入口虽然保留在封装内，但本次没有运行。

| 门禁 | UTC时间 / 实际请求 | 结果 |
|---|---|---|
| 最小格式 | 03:11:17.640–03:11:20.844，1次HTTP200 | `result=16`及仅在schema中的固定label均正确，退出0；不证明所有strict schema特性受支持 |
| 原arithmetic一轮 | 03:11:36.356–03:12:54.022，2次HTTP200 | 首次assessment及应用已有一次结构修正后，仍`assessment_failed / assessment_validation`；退出1 |
| 原15例两轮 | 未启动 | 单例未通过即停止，没有额外修正循环或重复抽样 |

最小格式使用与Zhipu相同问题/schema，但不同本地运行参数，不能混为同一模型结果。
llama.cpp的schema支持是[子集](https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md)，
不是Iris字段关系或语义校验的替代。单例请求间隔6000ms只用于测试，不是产品发言冷却。

主代理与独立只读复核一致：

1. 两个候选均`decision=skip`且`reason=material_issue`，违反原`validatePdAssessment`。
   skip的`materialChange.explanation`也非空。应用确实拒绝，最终assessment/draft均null。
2. 首稿称两人各8万元没有超过10万元，算术错误。修正稿写16万元超预算，但仍skip、
   未说6万元差额，并添入材料未支持的预算分配/其他费用解释；不能视为合法介入。
3. 统计为**1项未完整、0有效最终判断、0草稿**，并保留两个原候选的实际错误。
   `decisionMismatches=[]`仅因它不统计null；不能称决策100%正确。
   `completionRecords.complete=true`仅表示得到文本，不表示应用校验通过。

原[run6的26通过/4失败](iris-proactive-discussion-joint-review-20260916.md#run6联合复核后的固定合成集)仍是
上一模型完整集证据。当前小模型/量化/非思考模式未满足门禁，不能泛化成所有免费模型失败，
也不能归因为未被直接证明的runtime、硬件或schema兼容缺陷。

## 留存、清理与下一步

- [格式报告](evidence/iris-local-free-model-20260917-format.json)，SHA256
  `a829f11bd9ee10980bdd7b53a8b63c0fd0a2ba2719f522a502a7684271984519`。
- [算术报告](evidence/iris-local-free-model-20260917-arithmetic.json)，SHA256
  `0d15c02a6e4faff8fb54e29ec21452fc0eb99bbfbdd99211b4a41c16709a5313`。
- 归档JSON只规范化末尾换行，内容与本机结果一致。requests结束时间是收到HTTP响应时刻，
  完整文本处理时刻以completionRecords为准；这里不把它们当作生产延迟SLA。
- 停止精确核验的本次进程40356；此前首次启动进程50040也已停止。两个启动监督进程已退出。
  后置核验18089监听0、llama-server进程0；没有安装或遗留后台服务。
  模型和便携程序保留在上述独立目录供后续复现，模型约2.33GiB，ZIP约17.6MiB，未删用户文件。
- 本次未修改应用/测试/CI，未运行Core/PG/远端CI，未SSH或核对生产健康，未push、部署、
  修改生产模型/能力/授权、发送飞书消息；现有线上问答未因本次测试被修改。
- 当前没有合格的新模型可用于主动功能，不据此开放。停止密集Zhipu重试和该本地配置的
  原样重跑；后续只在新的可用性事实/独立较晚窗口复测免费云端，或明确选择另一配置后
  做有限对照。若需要付费、新账号身份操作、长驻安装或产品校验架构变化，须另行明确。
  没有创建定时重试，也没有承诺无人值守继续调用。

文档收口核验：README、交接和两份本次记录的92条本地链接/锚点通过；新3份JSON与
本机报告解析后逐字段一致，归档hash一致，先前3份云端失败hash不变。
应用/测试/CI相对ee9a8ae2仍无diff，`git diff --check`通过；不冒充重跑应用回归。
停止服务后再次核对进程/监听均0、空闲内存8.91GiB。

## 四处文档处置

| 位置 | 本次处置 |
|---|---|
| 白皮书 | reviewed-unchanged：[第6节](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)和[11.2](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#112-mandatory-bug-fix-documentation-closure)的最终组合、权限及分层验收规则未变；本次为隔离候选测试，不改产品行为 |
| 工程故障台账 | reviewed-unchanged：[容量停止规则](../operations/engineering-failure-ledger.md#treat-model-capacity-and-latency-as-runtime-state-not-a-code-hypothesis)本窗口只有一次上游探测；[主动讨论条目](../operations/engineering-failure-ledger.md#proactive-collaboration-is-not-a-deadline-reminder)关于完整语义、未完整结果与固定标准继续适用，不新增无证据根因 |
| 需求覆盖基线 | reviewed-unchanged：[IRIS-CORE-005及联合复核](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md#2026-09-16-判断文案联合复核)仍未通过实模门禁；只有本地格式成功不能提升为交付 |
| README/AGENTS/当前交接 | updated：[README](../../README.md#current-product-state)、[当前交接](current-handoff.md#当前正在推进)与[免费探测记录](iris-free-model-probe-20260917.md#第三窗口与本地后备)指向新实证与停止边界；reviewed-unchanged：[AGENTS](../../AGENTS.md)的工作树和四处同步规则仍准确 |
