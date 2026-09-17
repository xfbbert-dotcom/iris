# Iris 免费模型隔离探测：容量阻塞，未进入语义验收

2026-09-16 完成账号与私有测试密钥准备；2026-09-17 执行接口探测。
工作树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支
`codex/iris-daily-pilot-followup`。开工重读 status/diff/log/worktrees，基线干净、HEAD
`80d8375f`，被评估应用仍为 `ee9a8ae2cd8d3c1d596c42e0728331169827ed12`。
本次没有应用修复提交；本记录及证据的文档提交不等于部署。

## 用户决定与费用边界

用户因预算明确要求先试其他免费模型，并授权电脑操作。创建测试密钥的具体确认问题之后，
用户回复要求直接继续，视为批准该独立测试密钥，不推导为付费或生产授权。
仅调用官方 `https://open.bigmodel.cn/api/paas/v4/chat/completions` 的明确免费型号；
不充值、不绑定付款、不订阅、不启用付费搜索、不调用 FlashX 或付费回退。
仅使用合成算术问题，没有向该新提供商发送真实群聊、企业文档或生产配置。

2026-09-16 浏览器直接核对、2026-09-17 官方页面检索复核的
[价格](https://bigmodel.cn/pricing)列明 GLM-4.7-Flash 和 GLM-4.6V-Flash 输入/输出免费。
[模型概览](https://docs.bigmodel.cn/cn/guide/start/model-overview)也标明两者免费，
GLM-4.5-Flash 标记即将下线，因此未作为新候选。这里记录公开定价和实际请求，
不是账单审计或无限可用承诺。未调用任何已知收费型号/工具。

## 本机凭据准备

- 用户手动完成登录；没有代填身份验证或读取密码管理器。
- 新建独立测试 key `iris-free-20260916`（平台名称最多20字符）；默认 key 保持不变。
- 一次性明文仅在浏览器和本机保存流程内存中传递，未输出到对话、Git、命令参数或日志。
  通过仅绑定127.0.0.1、随机路径、同源检查、单次写入的临时表单保存到 Windows DPAPI
  当前用户加密文件；私有目录仅当前 Windows 用户可访问。没有明文配置文件。
- 本机位置为 `%LOCALAPPDATA%/Iris/free-eval-20260916/zhipu-key.dpapi`，
  供本机后续合成测试使用；不要复制进仓库、服务器或公开文档，不输出解密值。
  key 不具备已验证的服务端“仅免费型号”限制，免费白名单由隔离探测脚本执行。
- 合成 DPAPI 自检先失败：Windows PowerShell 无法加载 Security 模块；改用本机现有
  PowerShell 7.6.5 后加密/解密合成值相等。未证明模块加载错误的更深原因，
  不将其描述为 Iris 应用故障或永久环境修复。
- 浏览器不支持 content export，普通表单未观察到保存；本机异步提交取得成功回执后
  才关闭明文窗口。最终确认加密文件652字节、限制ACL、明文弹窗已关闭、临时监听已停止。
  本机准备脚本是测试工具，不是产品实现或服务部署。

## 实际探测与停止条件

使用现有 `createOpenAICompatibleChatCompletionsClient`，官方域名和模型精确白名单，
禁止重定向，每个候选只允许1次HTTP尝试；timeout60000ms。
问题仅为“计算8加8”，返回 schema 要求 `result=16` 和只出现在 schema 中的固定 label。
这是接口格式探测，不是原15例中的模型语义测试。

只在该格式探测附加 `max_tokens=256`、`thinking.type=disabled`，控制单次输出；
这些不是生产配置或完整评测参数。原应用发 `response_format.type=json_schema`、strict=true。
官方[结构化输出说明](https://docs.bigmodel.cn/cn/guide/capabilities/struct-output)以
`json_object` 加提示内完整schema为主，因此 strict schema 是否真的可用必须实测，不能猜测。

| UTC 时间 | 候选 | 实际请求数 | 结果 | 证据 |
|---|---|---:|---|---|
| 2026-09-17 01:55:47.222–01:55:47.541 | glm-4.7-flash | 1 | HTTP429，模型当前访问量过大 | [原始脱敏记录](evidence/iris-free-model-20260917-glm47-format-probe.json) |
| 2026-09-17 02:01:07.558–02:01:07.878 | glm-4.6v-flash | 1 | HTTP429，同一容量提示 | [原始脱敏记录](evidence/iris-free-model-20260917-glm46v-format-probe.json) |

首个候选失败后没有原样重跑，第二次仅探测另一个已核实免费的候选，仍失败即停止。
流程偏差：既有台账的“一个窗口最多一次探测、任何非成功即停止”比本次两候选各一次
更严格。本次虽然属于用户已授权的免费候选比较，仍未严格执行首个失败即停止；不能把
“没有重复同一候选”写成完全遵守单窗口上限。不改写台账放宽规则，也不补发请求：
本轮已经停止，下次窗口总共只做一次探测（不是每个候选各一次）。
共2次HTTP尝试，两个进程退出1；无模型内容、无schema符合性结果、无算术单例结果，
原15例×2轮未启动。JSON中的 `valid=false` 表示没有获得有效结果，
**不证明 json_schema 不支持，也不能归因为密钥错误或模型推理能力差**。
根因已确认到提供商返回的容量拒绝；更深的服务端原因不透明。没有静默重试或付费切换。

归档SHA256：GLM-4.7-Flash为
`451f08e5dab32d5c30bc58d5811375661b8a67458f6b5d27b0273663878bd76e`；
GLM-4.6V-Flash为
`bb42dc6f2c399a81922f75ee231d50dbe2c468f82b0d966b9ee6249930628acc`。

## 第二窗口：用户再次要求继续，仍为容量拒绝

2026-09-17 用户再次明确“继续”，重新核对默认树、实现树status/diff/log/worktrees，
实现树干净、HEAD为`2b3fddf2`，应用仍为ee9a8ae2；重读交接、白皮书相关规则、
台账单窗口停止规则和需求基线。复核官方价格信息后复用本机加密key，未操作浏览器、
创建新key、充值或修改任何账号权限。

- 本窗口只有1次HTTP尝试，候选glm-4.7-flash，同一合成格式问题及上节参数。
- UTC `2026-09-17T02:42:16.992Z`开始、`02:42:17.383Z`结束，HTTP429，
  文案仍为模型当前访问量过大。进程退出1；无content、无单例或15例两轮评测。
- [本窗口脱敏记录](evidence/iris-free-model-20260917-glm47-format-probe-window2.json)，
  SHA256 `834ec8a10130f21bcffa0175c3dab84317cad5e077e21f69226e008da0959e6e`。
  先前两份失败不覆盖，两窗口累计3次尝试；本窗口未切换其他候选，也未继续重试。
- [官方速率限制说明](https://docs.bigmodel.cn/cn/api/rate-limit)把同一报错文案列为
  平台过载，并与账户自身并发限制区分。这里是文案与官方说明的对应，未采集到原始
  业务错误码，不能伪称已直接取得1305或更深服务端归因，也不能由此证明账号其他方面无误。
- 现有停止规则继续适用，不改应用代码或验收标准；没有接口兼容性、质量、生产或
  飞书通过结论。无需用户重复登录或提供密钥。暂未建立自动重试任务，不能声称稍后会自动运行。

本机探测脚本的当前输出路径已经存在；下次执行前必须选新的结果路径并提前核对不存在，
避免外部调用之后才遇到结果文件不可覆盖。此说明不授权额外探测或自动重试。
本窗口收口核验：独立只读复核确认新记录、原两份hash及应用无diff；主代理核对11条本地
链接/锚点、3份JSON、合计3次尝试和各自hash，`git diff --check`通过。下表四处处置仍成立，
只追加本次失败与当前入口，不提升任何验收层级。

## 下次继续的有限步骤

1. 本机私有 key 已保存，不需要重新注册、创建或让用户粘贴凭据。先确认官方免费定价仍成立，
   在新的测试窗口总共只做一次最小格式探测；失败按实际状态停止，不切换其他候选追加探测，
   不抽样直到通过。
2. 若请求成功却不遵守 strict schema，先保留实证。仅在隔离测试中使用完整 schema 入系统提示
   的 json_object 适配，保持应用的本地结构/关系校验；不能只改type而丢失字段定义，
   不能未经测试就改线上client。当前没有实现该适配。
3. 格式通过后先选原factory的 `arithmetic` 单例。原CLI的 `--rounds 1` 仍是15例，
   不能当成单例；可通过导出的factory、`createPdModel` 和通用evaluator有界执行单例。
4. 再做一次原15例×2轮、顺序6000ms pacing、合成trace、明确总时限的完整对照，
   保留全部失败和修正轨迹。单例/HTTP200/结构通过均不代替语义验收。
5. 分别报告决策正确/错误/缺失、执行完整性、最终assessment全部语义字段和draft。
   错误skip是失败而非未完整；修正时只评最终pair，不借初稿的正确内容掩盖最终遗漏。
   arithmetic需16万/缺6万；60%是合法可选算术。material-update需24万/增加8万，
   同时检查可算缺口14万；推断不得升级成必然损失、授权不得虚构。

这是免费候选准备及容量阻塞，不是新一轮通过或失败的完整语义评测。
[run6](iris-proactive-discussion-joint-review-20260916.md#run6联合复核后的固定合成集)仍为
决策30/30正确、完整语义26通过/4失败/0未完整。此前所有失败保留。
本次未运行Core/PG/CI、未SSH、未查生产健康/队列、未push、未部署、未改开关或治理事实、
未发飞书消息。主动功能没有因此启用；上一轮生产部署仅是历史记录，不是本次实时核验。

文档收口：10条本地链接/锚点、两份JSON状态/请求数及上述SHA256校验通过，
5份待提交文档/证据与真实key做精确比对未包含密钥，`git diff --check`通过。
应用/测试/CI相对ee9a8ae2无差异。限定独立核对指出旧“待选模型”入口和单窗口规则差异，
已分别更新当前继续点并如实记录流程偏差；未据此追加探测或放宽门禁。

## 四处文档处置

| 位置 | 本次处置 |
|---|---|
| 白皮书 | reviewed-unchanged：[第6节](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)与[11.2](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#112-mandatory-bug-fix-documentation-closure)仍适用；本次只做免费合成接口探测，不改变产品行为、来源、审批或验收层级 |
| 工程故障台账 | reviewed-unchanged：[模型容量条目](../operations/engineering-failure-ledger.md#treat-model-capacity-and-latency-as-runtime-state-not-a-code-hypothesis)的单窗口一次、失败停止和脱敏规则仍有效；首窗口两候选的流程偏差已在上文明确记录，不以比较授权掩盖或追溯放宽规则；第二窗口已严格执行总共一次 |
| 需求覆盖基线 | reviewed-unchanged：[IRIS-CORE-005及联合复核修订](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md#2026-09-16-判断文案联合复核)仍部分实现、实模未通过；无新的语义或真实群验收，不能提升完成度 |
| README/AGENTS/当前交接 | updated：[README](../../README.md#current-product-state)、[当前交接](current-handoff.md#当前正在推进)增加本次免费决定、已有凭据和阻塞入口；reviewed-unchanged：[AGENTS](../../AGENTS.md)的准确工作树、四处收口与有限出口规则仍有效 |
