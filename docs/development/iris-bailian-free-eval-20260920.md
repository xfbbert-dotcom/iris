# 百炼免费候选：原生合同拒绝与 JSON 模式语义失败

日期：2026-09-20；接续9月18日用户批准的免费替代模型测试。工作树
`D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`、分支 `codex/iris-daily-pilot-followup`，
开工干净 `75340039ce4223a2a96d2f0ad1744060f0ef4370`，应用仍为
`d699761e7e0c9855a2bbcfb6e500a80375470706`。默认checkout未切换、合并或重置。
本文是模型/集成实验记录，不是新应用修复、部署或能力启用批准。

## 1. 本轮边界与费用保护

- 在用户当次确认后创建一个测试专用百炼 API Key，本机 Windows DPAPI CurrentUser 加密保存；
  已将密钥授权收窄为 Qwen3.7-Plus 并重新打开设置核实。没有把明文密钥、密钥ID或加密文件纳入仓库。
- 使用控制台提供的北京 workspace OpenAI-compatible endpoint，精确模型 `qwen3.7-plus`。
  调用前刷新页面确认免费额度剩余1M/共1M、到期2026-12-18，**免费额度用完即停已开启**。
  这是有限试用额度，不是永久免费的模型。未充值、购买、启用付费回退或其他模型权限。
- 创建阶段曾短暂观察到未显示该模型额度，随后模型详情与刷新后的额度表均显示可用；
  不将这段UI变化归因为已证实的开通延迟或永久无资格。
- 只发送原仓库合成材料。没有真实群聊、公司文档、生产密钥、SSH、线上模型切换或飞书消息。
- 非思考 `enable_thinking:false`；最小格式 `max_tokens=256`，原算术/完整集预设2048；
  每请求60秒，非格式请求串行且间隔6秒。上限分别为1/6/180请求、70/420/1800秒。
  没有传输重试、自动格式降级、模型回退、搜索或工具调用。保留产品原有的一次合同修正/一次组合修正上限。
  若输出因上限截断，只能记为配置限制，不得当成语义失败；本次所有HTTP200均正常stop，无截断。

[官方额度说明](https://help.aliyun.com/zh/model-studio/new-free-quota)与
[结构化输出说明](https://help.aliyun.com/zh/model-studio/qwen-structured-output)支持上述费用门禁与两种格式区分。
实际账户资格来自当次控制台，不仅凭模型宣传页。测试后刷新仍显示1M和“已开启”，
这一粗粒度/可能延迟的读数不能证明零消耗或替代账单。5次HTTP200报告合计6783 tokens；
另1次HTTP400无usage，不把缺失usage写为已证实零计费。全程使用免费额度保护，没有授权付费。

## 2. 原生格式：最小例通过不等于完整合同兼容

| 阶段（UTC） | 调用与结果 | 实际验收层级 |
|---|---|---|
| 08:43:51–08:43:53 原生最小格式 | 1次HTTP200；result=16、label正确，66 tokens | 只证明简单schema格式通过。 |
| 08:44:04 原算术assessment | 1次HTTP400；`invalid_parameter_error`，无模型判断 | 未完整；不是算术语义失败，也不是429/额度耗尽。 |

服务端错误明确指向 `response_format.json_schema.schema` 的数组约束，提及
`uniqueItems/contains/minContains/maxContains`。实际出站schema含3处 `uniqueItems:true`，
后三项均未出现；其来源是原 `assessmentResponseFormat` 的 evidenceRefs 数组。
根因已定位到这个请求的原生schema兼容边界，不能泛化为平台完全不支持JSON Schema。
也不能把最小格式中的固定result枚举当成模型推理能力证明。

原生窗口立即停止并保留halt。下一步选用**已有**的显式 `json_object` 配置，独立报告与门禁；
没有删除uniqueItems、放宽validator或自动在失败后重试同一请求。
既有client将完整原schema附入system，本次fetch边界逐次验证字节一致并记录哈希；
wire `response_format` 只含 `type:json_object`。这是既有兼容方案验证，不是应用新提交。
它同时改变服务端解码合同和schema可见性，不能称为严格单因素推理质量对照。

## 3. 显式 JSON 模式：接通，但最终组合语义不合格

| 阶段（UTC） | 调用与结果 | 实际验收层级 |
|---|---|---|
| 08:47:47–08:47:48 最小格式 | 1次HTTP200，格式通过，131 tokens | JSON格式通过。 |
| 08:47:58–08:48:20 原arithmetic | assessment→draft→scope_review，共3次HTTP200，6586 tokens | 本地结构/引用门禁通过，程序返回完整组合；独立语义复核失败。 |

原题是本季度招聘预算10万元、两人每人成本8万元。按原标准核查所有assessment字段与draft，
而非只看最终中文或模型的 `supported=true`：

- 最终draft正确说明16万元总成本、6万元缺口，并建议核对/调整预算、人数或单人成本；
  没有声称已追加预算、已改计划或已执行任务。
- 但最终保留的 `assessment.reasoning` 明写“需求总额16万元减去可用预算10万元，差额为-6万元”，
  减法方向与符号错误。不能因同一输出其他位置写对6万元就抹去该错误。
- 同一reasoning断言“若不纠正将导致承诺无法履行或违规超支”；原文没有录用承诺或违规制度证据，
  `uncertainty=fact` 也不能覆盖这类未经限定的未来后果推断。
- 第三次review返回 `supported=true`，其数值引文确实存在于正确draft，但漏查上述保留判断。
  这是**真实的联合复核误通过**。引用存在/数字列表连续性门禁没有证明算术和所有判断文字正确。

主代理与独立只读代理得到同一失败结论，不是人类签字或伪造人工验收。
原report的 `executionPassed:true` 和 `independentSemanticReview:pending` 原样保留，
本节是执行结束后的独立判读，不回填篡改原记录。私有窗口另写语义halt，阻止后续误用full参数。
因此**未跑15例两轮，不再抽样同配置，不采用新模型，不改产品提示/validator**。
本候选仅解决了这个调用的传输兼容，尚未解决原主动讨论的语义验收缺口。

下一项应以这次保留的错误组合为固定负向对照，处理联合复核仍漏检assessment算术/断言的问题，
同时保留正确组合与有依据不确定建议的正向对照。先形成有限、可测的修复假设；
不能再只靠换模型、继续抽样、注入固定答案或机械关键词把同一报告变绿。
这不是对任意新增验证架构、付费调用或部署的授权。

## 4. 补齐9月18日429归因证据

此前[生成续测记录](iris-free-generation-followup-20260918.md)的06:20 UTC报告没有保留业务码，
该历史事实不改写。之后用户要求查明持续429，独立的两次有界诊断已保留原件，本次补入仓库：

- 06:52:25 UTC原生Node fetch、无Iris client/SDK/并发/重试/response_format，1次HTTP200，
  13.774秒返回OK，usage11。只证明该时刻简单调用可用。
- 06:54:03 UTC原Core client显式JSON最小请求，1次HTTP429、162毫秒；实际业务码
  **1305**，消息为模型当前访问量过大。没有返回Retry-After或重置时间。

[官方错误码](https://docs.bigmodel.cn/cn/faq/api-code)把1305列为模型访问量过大，
不能写成账户日额度耗尽、1302账户速率限制或“明天重置就好”。这两次并非严格同请求对照，
不能由一次简单200证明Iris格式导致429；已捕获的是该次平台容量拒绝，旧未记录码的拒绝仍保留未知。
本轮9月20日没有重试智谱，没有应用429修复提交。

## 5. 持久证据与本地验证

[原件/脱敏副本哈希清单](evidence/iris-bailian-20260920-manifest.json)记录每个文件两种SHA256。
百炼证据只替换精确私有workspace hostname和本机用户名；保留其余出站body、response raw、
状态、业务码、request ID、usage、finish_reason及源码身份。
报告内嵌原始文件哈希对应私有原件，不冒称与脱敏副本字节相同。
原生文件名虽含20260918，**实际运行日期以startedAt的2026-09-20为准**。

| 证据 | 用途 |
|---|---|
| [原生最小格式](evidence/iris-bailian-20260920-native-format.json) / [原算术拒绝](evidence/iris-bailian-20260920-native-arithmetic.json) | 成功的小schema与失败的完整合同分别保留。 |
| [JSON最小格式](evidence/iris-bailian-20260920-json-format.json) / [原算术完整组合](evidence/iris-bailian-20260920-json-arithmetic.json) | 实际三个阶段与复核误通过，无期待答案注入。 |
| [原生封装](evidence/iris-bailian-20260920-native-harness.txt) / [JSON封装](evidence/iris-bailian-20260920-json-harness.txt) | 原Core入口、完整出站记录与请求停止门禁；不是自动降级。 |
| [原生启动器](evidence/iris-bailian-20260920-native-launcher.txt) / [JSON启动器](evidence/iris-bailian-20260920-json-launcher.txt) | DPAPI解密仅入子进程环境，退出清理；归档无密钥。 |
| [智谱直接调用](evidence/iris-zhipu-429-20260918-direct-diagnostic.json) / [Core调用](evidence/iris-zhipu-429-20260918-client-diagnostic.json) | 9月18日补充归因，原样字节归档。 |

两种私有封装均经严格TypeScript静态检查；JSON启动器经PowerShell AST解析，无错误。
16:47北京时间执行既有5个文件：client12、数字连续性15、pair-review16、receipts34、trace16，
合计**93项通过**。这不是完整Core回归或实模语义通过，应用源码没有修改。

交接核验：10份证据的原件/副本哈希均匹配，139个本地链接目标存在，源码与各报告记录的哈希一致，
未出现完整集启动标记，独立语义halt存在，`git diff --check`通过。
一次独立只读范围复审确认结果、四处处置、脱敏变换与哈希，无新增阻塞；它不代表人类审批。

```text
node node_modules/vitest/vitest.mjs run apps/core/tests/openai-compatible-chat-completions-client.test.ts apps/core/tests/proactive-discussion-review-continuity.test.ts apps/core/tests/proactive-discussion-pair-review.test.ts apps/core/tests/proactive-discussion-review-receipts.test.ts apps/core/tests/proactive-discussion-eval-trace.test.ts
```

## 6. 四处文档处置

| 核对项 | disposition与理由 |
|---|---|
| 白皮书 | **reviewed-unchanged**：[第6节](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)已要求显式格式、完整本地校验、判断/文案联合核查及分级验收；本次未改变稳定产品合同。 |
| 工程故障台账 | **updated**：[主动协作条目](../operations/engineering-failure-ledger.md#proactive-collaboration-is-not-a-deadline-reminder)补充“最小schema通过不能证明完整合同兼容”、保留业务码和本次误通过证据。 |
| 需求覆盖基线 | **reviewed-unchanged**：[IRIS-CORE-005](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md#2-核心需求追踪)仍部分实现，实模主动语义仍不合格，不能因免费候选接通提升验收级别。 |
| README / AGENTS / 当前交接 | **updated**：[README](../../README.md#current-product-state)、[当前交接](current-handoff.md#当前正在推进)指向本轮实际状态。**reviewed-unchanged**：[AGENTS](../../AGENTS.md)的定位、有限退出及四处闭环规则仍有效。 |

本次没有应用修复提交、push、部署、生产健康核验、能力开启或飞书发送；
旧生产记录不冒充当前在线事实。用户无需重新创建密钥、购买额度或重复群聊测试。
