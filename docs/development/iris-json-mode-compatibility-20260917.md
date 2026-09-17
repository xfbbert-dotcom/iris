# 免费模型 JSON 模式兼容与草稿引用核验

日期：2026-09-17。用户要求继续修复主动判断，不在上一轮阶段结果处结束。
开工工作树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`、分支
`codex/iris-daily-pilot-followup`，干净基线 `9e4d9ea682036c196c854871e9cdd03419f02823`。
JSON模式兼容应用提交：**`a5e5e2e426ad0a6cb941770226b313417146762a`**，9个文件、265行新增/4行删除。
草稿引用核验应用提交：**`42db6b6c3678802acaf0c2936c67c8640e5f540c`**，10个文件、497行新增/59行删除。
第二项草稿引用存在性修复接入现有一次pair repair；固定失败稿的真实修正链
两次拦下错误肯定复核，最终返回null，仍未产生完整正确结果。随后正确稿对照也因审核借用其他字段的
引文而返回null，构成实际误拒；随后将quote wire收窄为当次draft真实句段/全文或null的枚举选择，
同一正确原稿1次HTTP200即返回原pair、没有修正调用。不放宽validator、不增加调用。
新接线负向稿3次HTTP200，两次raw true的虚假数字凭据均被拒绝，唯一一次修正仍未补6万元，最终null。
这证明局部误放行拦截而非生成完整正确。第二项最终Core4716通过/469条件跳过、类型/构建及
Compose+CLI40通过/1条件跳过已完成，本地模型已停止；只关闭这两项狭窄实现与文档闭环，
不把它们的本地通过升级为完整主动语义或交付通过。
本记录不代表部署或主动能力启用。

用户要求继续后，10:17–10:20 UTC又完成[两项私有修正假设](#继续修复的两项私有实验均未推广)，均未改善目标且未推广。
其中七字段edit实验的最终review漏列6万元，凭据检查与返回路径实际放过仍错误的pair；这是新增语义失败，
不以本节先前局部拦截掩盖。应用代码未改；随后[免费云端有限复测](#后续免费云端格式通过与算术失败或未完整分开)中，
glm-4-flash-250414与glm-4.7-flash均一次最小JSON格式通过，前者原算术合法skip但语义失败，后者算术首请求429、
没有语义结果。当前云端请求已停止，不能再概括成“所有云端格式未验证”，也不能称主动功能已修好。

## 症状、归因与实现

已有[输出适配记录](iris-assessment-wire-fix-20260917.md)保留了本地模型的结构修复、
完整合成集 19通过/8失败/3未完整，以及最终推理单题遗漏6万元差额、复核误放行的结果。
这些失败没有被本轮覆盖。继续排查发现一个可重现的传输兼容问题：
第四个免费云端窗口中，`glm-4.7-flash` 对携带原生 `json_schema` 的最小合成请求返回
HTTP200，但内容带 Markdown 围栏、缺少必填 `label`，且新增未允许的 `expression` 字段。
这次请求没有执行所要求的结构合同；HTTP200 和算出16都不代表格式验收通过。
不能据单次响应断言该服务永久不支持所有 schema，也不能把这项接口兼容缺口归为模型推理能力不足。

本轮修复在 Core 的共享 OpenAI-compatible client 增加显式配置
`IRIS_MODEL_STRUCTURED_OUTPUT_MODE=json_schema|json_object`：

- 未设置时仍用原生 `json_schema`；pilot Compose 和环境示例同样默认 `json_schema`。
- 只有显式选择 `json_object` 且调用方提供结构合同时，传输改用 `{type:"json_object"}`，
  将完整原 JSON Schema 加入 system 指令，保留既有 system 内容；无 system 时创建一条。
- 不修改调用方消息对象；不从用户材料生成 system 规则。不提供 schema 的普通请求不变。
- 原有格式大小校验、超时、有限请求重试和各调用方本地领域校验保持生效；不剥围栏、
  不补缺字段、不把无效结果改成合法判断，也不在失败后自动切换格式。
- 配置只接入 Core。独立 memory worker 的 provider 配置和运行路径不受影响。
  主动判断最多两次 assessment、最多一次 paired repair 与最终复核的上限未改变。

实现入口：[环境读取](../../apps/core/src/config/env.ts)、
[共享模型 client](../../apps/core/src/model/openai-compatible-chat-completions-client.ts)、
[pilot Compose](../../deploy/pilot/docker-compose.yml)、
[通用环境示例](../../.env.example)、[pilot 环境示例](../../.env.pilot.example)。
`json_object` 只能约束 JSON 对象表达，完整 schema 在提示中的存在不是服务端强制 schema 的等价证明；
本地领域校验和后续真实语义验收仍不可省略。

## 两次免费云端请求的实际结果

| 时间（UTC） | 请求及原始证据 | 结果与可作出的结论 |
|---|---|---|
| 09:14:10.642–09:14:11.512 | [window4 原生 schema 最小探测](evidence/iris-free-model-20260917-glm47-format-probe-window4.json) | 1次，HTTP200，`valid:false`；含 Markdown、缺必填 label，格式失败。仅合成8加8，不是主动语义评估。 |
| 09:20:14.216–09:20:14.615 | [显式 JSON 模式最小探测](evidence/iris-free-model-20260917-glm47-json-mode-format.json) | 1次，HTTP429容量拒绝，无模型输出；不能评价新模式实际兼容性或语义质量，未进入算术单例或15例两轮。 |

第二份报告中的 commit 是运行时 HEAD `9e4d9ea6`，当时应用修复尚未提交；
报告同时记录了实际读取的 config/client/model 文件 SHA256，不能用 HEAD 冒充未提交源码的身份。
其中 completions 的 `responseFormat` 是上层调用合同，不代表网络中仍发送原生 schema；
真实传输转换由本轮 client 实现及请求体回归覆盖。HTTP429没有返回可用于核对转换效果的模型输出。

本窗口收到429后停止，不继续重试；没有付费回退、云端工具调用、真实工作材料或飞书发送。
当次[受限测试脚本](evidence/iris-free-model-20260917-json-mode-harness.txt)同时归档：只执行了format模式，
arithmetic/full分支未启动；遇非成功HTTP即锁止后续请求。归档不包含密钥明文。
已有本机加密测试密钥无需重建或在聊天中提供。最小请求成功、兼容性通过、主动语义通过和真实群投递
是不同层级；此时不能声称新版通过实际云端验收。后续较晚窗口的最小格式通过另记于下节，不覆盖本次429。

## 实际 Core client 的本地格式正向证据

09:30:49.745–09:30:51.733 UTC，在应用 `a5e5e2e4` 上显式选择 `json_object`，
真实 Core client 向同一本地 Qwen3-4B-Q4_K_M 发出1次合成请求。
[原始记录](evidence/iris-json-mode-20260917-local-format.json)保留实际请求体：
`response_format:{type:"json_object"}`、原system加完整schema，以及实际回复
`{"label":"iris-free-format-check","result":16}`。
HTTP200，无Markdown，必填label/result完整、值正确且无额外字段；`formatPassed:true`。
请求耗时1.984秒，报告总跨度1.988秒；[本地脚本](evidence/iris-json-mode-20260917-local-format-harness.txt)同时归档。
这证明新适配在本地真实模型上走通一次最小格式，不能替代Zhipu兼容性、主动判断语义或生产时延验收。

## 未推广的本地语义实验

两项实验均基于同一本地免费 Qwen3-4B-Q4_K_M，仅使用合成材料，没有改为产品调用路径。
[实验脚本](evidence/iris-semantic-spike-20260917-harness.txt)及原始输入/输出保留如下：

| 实验 | 观察 | 处置 |
|---|---|---|
| [review 分项事实优先实验](evidence/iris-semantic-spike-20260917-review.json)，09:10:12–09:11:58 UTC，3次HTTP200 | 缺差额的算术草稿中，numbers finding 能算出6万元，却声称候选已表达并判 true；实际 draft 没有6万元。其他检查为 false，因此这次分项实验整体不是误通过。inference 识别事实类别缺陷；正确算术对照通过，但误判和不可靠复核理由仍存在。 | 未推广；不能以新增检查项或算对数字证明审核已可靠。 |
| [当前触发摘要优先实验](evidence/iris-semantic-spike-20260917-focus.json)，09:12:30–09:15:27 UTC，4次HTTP200 | separate-next 能概述权限未确认，却仍 skip；handled 能概述已暂停并核对，却仍重复 intervene。paraphrase、corrected 两个对照仍 skip。 | 未改善两个目标失败，停止该改法；不继续追加摘要字段或提示。 |

## 草稿引用存在性：原型验证与第二项狭窄修复

09:35:13.437–09:36:27.119 UTC，同一本地模型完成3次HTTP200、无自动重试。
[原始报告](evidence/iris-draft-quote-20260917-probe.json)使用已保留的失败/对照assessment与draft，
测试新的审核响应及本地引用核验，不重新生成判断或草稿，也没有在该probe中改动产品实现。
[原型脚本](evidence/iris-draft-quote-20260917-harness.txt)与私有原件字节级一致：
报告SHA256 `03c40315e0979a99125860085d0cac6d14043edadded1509e6a78f3f8a984fd9`，
脚本SHA256 `f79309bf32ab37402715a0eeb8430d6c9e771b77db350825227f4d81826dc3d1`。

| 固定输入 | 模型 supported | 本地 receiptValid | 原句及独立判读 |
|---|---|---|---|
| thinking记录中缺6万元的算术草稿 | true | false | 模型列出expectedValue=6、unit=万元，却引用“存在缺口”。原句确实在draft中，但不含6万元，局部数字凭据无效；10/16万元引文存在。 |
| full第2轮完整算术草稿 | true | true | 差额引用“超出预算 6 万元”，总额引用“招聘两人每人需 8 万元，共计 16 万元”，均在当前draft且完整包含所声明数字/单位。 |
| full第2轮把喜欢改为付费的inference草稿 | false | true | requiredNumbers=[]；建议引文“建议需进一步验证其他用户付费意愿，避免收入高估。”确实存在。模型拒绝理由仍误要求收入金额/数字，不是可靠识别了全部事实类别错误。 |

这组原型首次证明可以在模型supported=true时，按其自己声明的必要数字拦下无效引用。
它没有证明独立语义审核已经通过：空数字列表可以通过所有已返回项的检查，
真实存在的句子也可能包含错误事实、否定或错误口径。报告中的 `expectedCoverage` 是独立合成验收oracle，
其中的16/6/5等预期值未进入模型消息或receiptValid；不得把这些样例常量、关键词判断或该oracle接入产品。
退出0只代表收到全部3个最终响应，不代表所有凭据或语义通过。

用户继续修复的范围内，现决定实施第二项狭窄修复：在原审核响应增加必要数字和具体建议的当前draft原句，
程序核对引用存在性及完整数字词元/单位，不允许用16的尾数冒充6、不去assessment或旧稿中找引用。
已在`42db6b6c`将这项局部门禁接入[现有主动模型及一次pair repair](../../apps/core/src/proactive-discussion/model.ts)：
首次局部凭据失败进入已有的一次成对修正，最终复核只核对修正后的当前draft，再失败便终止，
不扩展调用次数、权限、来源或业务值规则。具体代码边界与最终回归见下节。

三例固定稿原型和下述实际正负修正链已完成；此前有限只读代码复审未发现本次范围内的实质阻塞，
但随后真实正确稿对照揭示引用生成的误拒，不能以静态复审代替这项实际失败。
收窄引用接线后的正确原稿1次实际review返回原pair，负向稿在唯一一次修正后最终被拒绝；
第二项最终提交和回归现已补齐；原生成及整体语义问题仍未关闭。
引用核验是限制误放行的一项局部措施，不能证明必要数字列表完整、算术正确、来源支持或建议语义正确，
也不能修复独立问题漏报、已处理问题重复介入。前两项未推广spike及原全部失败继续保留。

### 固定失败稿的实际审核、一次修正与最终拒绝

09:48:04.241–09:50:17.832 UTC，报告总跨度133.591秒；
[实际调用记录](evidence/iris-draft-quote-20260917-repair-chain.json)保留3次HTTP200，
分别为首次审核34.792秒、一次pair repair 63.802秒、最终审核34.914秒，无自动重试。
[脚本](evidence/iris-draft-quote-20260917-repair-chain-harness.txt)调用实际 `createPdModel.render`，
只把首次draft响应替换为已归档thinking记录的真实失败稿，并复用其assessment；
之后审核、锁定结构的成对修正和最终审核都是新模型请求。不是新的assessment/render生成验收或完整合成集。

| 步骤 | 原始模型响应与程序实际结果 |
|---|---|
| 首次审核 | 原始 `supported:true`；列出8万元及 `draftQuote:"每人要8万元"`。8万元来自授权原文，这句不在当前draft；实际helper改为false，pair repair输入保留这项无效凭据和固定诊断。第一次拦截不是程序自行发现或计算了6万元差额。 |
| 唯一一次修正 | 返回的assessment仍未写6万元差额，`materialChange.explanation`仍为“预算不足导致招聘计划不可行”；draft仍只有10/16万元和“存在缺口”，未补出6万元。不能称语义修正成功。 |
| 最终审核 | 再次原始 `supported:true`，声明 `expectedValue:"-60000" / unit:"元"`，却引用“本季度招聘预算10万元与实际总成本16万元存在缺口”；原句没有该完整数字/单位。程序再次拒绝，最终 `finalPair:null / returnedPair:false`，没有第二次pair repair。 |

两次原始肯定复核均被局部凭据检查拦住，证明当前草稿核验和一次修正后终止的实际调用路径。
最终没有可返回的完整结果，仍不能标为原算术语义通过；报价/预算解释、条件限定和必要数字列表完整性
没有因此获得保证。随后完成的正确原稿对照同样失败，详见下一节。

报告的applicationHead仍是 `a5e5e2e4`，当时第二项源码尚未提交，实际model/receipts/client哈希记录在
`sourceHashes` 中；不能把第一项提交冒充本次引用核验实现提交。两份归档均与私有原件SHA256一致：
报告 `0224fde9214245b0cc6fbcaed0934f61d745e3c2e11e023b7a2019eb1ec22997`；
脚本 `13f7ed53335699020caa57e427f752f49b533d17cd8f31c29b97d7e9ef5fe287`。

### 正确原稿对照：引用跨字段导致实际误拒

09:51:33.639–09:53:48.261 UTC，报告总跨度134.622秒；
[正确稿实际调用记录](evidence/iris-draft-quote-20260917-correct-chain.json)保留3次HTTP200，
分别为首次审核30.005秒、一次pair repair 70.731秒、最终审核33.800秒。
[脚本](evidence/iris-draft-quote-20260917-correct-chain-harness.txt)复用原full第2轮的assessment与正确draft，
只回放首次draft响应；其后3次为真实模型调用，不是完整assessment/render新生成。
原稿已写明“共计 16 万元，超出预算 6 万元”，并有“需进一步核实招聘预算的合理性及是否调整招聘计划
以符合预算限制”等建议；唯一一次修正返回的draft与原稿逐字相同。

| 步骤 | 原始模型响应与程序实际结果 |
|---|---|
| 首次审核 | 原始 `supported:true`，但16万元的引文“招聘两人，每人要 8 万元；我们认为这些预算足够”不是当前draft原句，且不含16。`adviceQuote`“需要重新评估招聘预算，或调整招聘计划以符合预算限制。”也不在draft中，而是assessment.suggestion。helper拒绝并进入唯一一次pair repair。 |
| 唯一一次修正 | 保留原正确draft，10/16/6万元及核实/调整建议仍在；不是因为修正漏掉差额而失败。 |
| 最终审核 | 再次原始 `supported:true`；10/16/6万元引文均在当前draft中，但adviceQuote仍借用上述assessment原句。helper再次拒绝，最终 `finalPair:null / returnedPair:false`。 |

这个正向对照是新门禁在真实路径中的误拒，不能把“所有null都安全”当作可用性验收通过。
局部validator确实执行了当前draft逐字核验；确认的接线缺口是quote仍由模型自由生成，
系统提示禁止跨字段借句也没有阻止它借用source或assessment。随后将quote输出收窄为当次draft
真实句段、全文或null的枚举选择；不修改数值、不放宽引用检查，不增加修正轮次，也不接入样例oracle。
新接线的正确稿及缺差额稿局部结果见后两节；本次误拒保留，最终完整回归、应用SHA及关闭范围另列。
两个局部对照分别证明正确稿可返回和失败稿被拦截，不代表全部主动语义已通过。

本报告与上一节使用相同的当时未提交model/receipts源码哈希，applicationHead仍是第一项兼容修复的`a5e5e2e4`。
归档与私有原件SHA256一致：报告 `45dff608669e4bf6dc2221ab151785d3ebacf3bd8965203fa3ca1695578fdc8f`；
脚本 `d50b5e57b09a0a2fe493dce3d19a1ef19a5d5848d828092e0458bc62f06a994b`。

### 当次草稿引文枚举：正确原稿局部对照通过

针对上节实际误拒，[引用schema构造器](../../apps/core/src/proactive-discussion/review-receipts.ts)
把数字与建议引文限制为当前draft原样句段、原样全文或null；不拼接来源/assessment，不修剪或改写引文。
[首次与最终review两处接线](../../apps/core/src/proactive-discussion/model.ts)分别传入首次draft和修正后的draft，
不会复用旧稿候选。此次收窄未再改review提示、validator、数字值或一次pair repair上限。
它只是生成候选的约束：仍须本地核对原句及完整数字，不能假定任何服务在json_object模式下都会强制执行enum。

09:59:06.883–09:59:48.775 UTC，报告总跨度41.892秒；
[新接线正向记录](evidence/iris-draft-quote-20260917-correct-enum-chain.json)实际只有1次review请求，
09:59:06.956–09:59:48.768 UTC，HTTP200、41.812秒。
[脚本](evidence/iris-draft-quote-20260917-correct-enum-chain-harness.txt)沿用上节同一正确assessment/draft，
仍只回放首次draft响应，之后review是真实Core client调用、使用原生json_schema；没有pair repair或最终review请求。

raw `supported:true`，10/16/6万元的引文均为当次draft第一整句：
“本季度招聘预算为 10 万元，但根据材料，招聘两人每人需 8 万元，共计 16 万元，超出预算 6 万元。”
建议引文选择当次draft第二整句：“此情况属于材料中提到的预算超支问题，需进一步核实招聘预算的合理性及是否调整招聘计划以符合预算限制。”
这些引文都在实际schema的enum中，且与声明的数字匹配；本地检查通过，`returnedPair:true`，
最终assessment/draft与原pair相同。此前正确稿误拒未在这一次局部对照重现。

这不证明fresh assessment/render生成、全部主动语义或Zhipu/JSON模式enum兼容性通过。
review理由中的“已通过证据引用进行核实”不是本地引用检查可证明的事实；仍按原材料及独立标准判读。
负向对照随后完成并记于下一节；最终完整回归与第二项提交也已补齐，但不将局部对照升级为整体语义验收。
报告applicationHead仍为`a5e5e2e4`；实际model哈希为`a2659b5277f5edb7337f6aa1937c9afedc203ffd19db25da2b6274ddd5a3f11e`，
receipts为`bfc9c99abc1590229f304dae9957bada6ca4beac24f5704e987b277aa484c224`，与上一节旧接线不同。
两份归档与私有原件SHA256一致：报告 `691736786db9dbc5ea042ad04fb7d5e6c69b01a98b72bd303bb6ad4cf438b0fa`；
脚本 `f978d0713f435962caf889e6684f4feb38b258014eedf4da0e331a5efd29040d`。

### 当次草稿引文枚举：缺差额稿仍失败并被拦截

10:00:25.633–10:02:39.875 UTC，报告总跨度134.242秒；
[新接线负向记录](evidence/iris-draft-quote-20260917-repair-enum-chain.json)保留3次HTTP200，
首次review 33.537秒、唯一一次pair repair 69.677秒、最终review 30.943秒，无自动重试。
[脚本](evidence/iris-draft-quote-20260917-repair-enum-chain-harness.txt)复用thinking中的原失败assessment/draft，
只回放首次draft响应；随后3次是真实Core client调用。model/receipts源码哈希与上一节正向enum对照相同。

| 步骤 | 原始模型响应与程序实际结果 |
|---|---|
| 首次审核 | raw `supported:true`，声明`expectedValue:"6" / unit:"万元"`，却引用“根据现有信息，本季度招聘预算10万元与实际总成本16万元存在缺口，需核实预算分配合理性。”这句确在当次draft和enum中，但只有10/16、没有完整6万元。helper改为false，实际pair repair输入包含固定凭据失败理由。不能从16尾数得到有效6万元凭据。 |
| 唯一一次修正 | draft与原失败稿逐字相同，仍未补6万元；assessment仍有“预算不足导致招聘计划不可行”，未解决原语义问题。 |
| 最终审核 | 再次raw `supported:true`，声明`expectedValue:"-60000" / unit:"元"`，却选择同一整句；当次draft里没有该数字/单位。helper再次拒绝，`finalPair:null / returnedPair:false`，没有第二次pair repair。 |

这里的enum阻止了跨字段自由造句，但没有阻止模型把不含所需数字的真实句子选为凭据；
完整数字词元核验仍不可省略。两个错误肯定复核被拦下，只证明误放行限制和既有调用上限实际生效，
不能称草稿生成、成对语义修正或原15例两轮通过。必要数字列表、事实类别和过度断言仍不是引用存在性
能独立证明的内容；最终null不能掩盖本次未产出完整正确意见。

归档与私有原件SHA256一致：报告 `414bbde8ae6bb4a3be0c0555f907ef5a6b5be7ac3ee1ad04b6fbc1e4fb8df25b`；
脚本 `1fbd8dcd48874ab62669449cc6310fd60d42e9c7c9223a3907a699e892acd68b`。
报告applicationHead仍为`a5e5e2e4`，不能替代当时未提交的第二项应用身份。
最终`42db6b6c`中的model、receipts与client SHA256已重新核对，分别与正负enum报告记录的
`a2659b52…`、`bfc9c99a…`、`f8a84ff1…`一致；完整哈希保留在原始报告。旧自由引文失败报告使用的是旧哈希，不能混同。

## 本地回归与有限审查

下表的兼容修复验证属于提交 `a5e5e2e4`，第二项引用核验另列，均来自本轮实际执行的验证；
文档同步没有重复运行模型或测试，第二项不能借用第一项的完整回归结果标为完成。

兼容修复按回归先行：17:18:25北京时间env/client新用例先7失败/120通过，
当时显式json_object仍被旧客户端发成json_schema；17:19:35随实现通过。
实际PD接线的同类回归先1失败/1通过、修复后2通过；Compose传播先因字段undefined失败，
补入实际配置后通过。以下4,673是第一项适配提交的完整回归，不冒充随后凭据修复的最终回归。

| 门禁 | 命令或入口 | 实际状态 |
|---|---|---|
| 环境、共享 client 与上层 provider 定向回归 | [env.test.ts](../../apps/core/tests/env.test.ts)、[client 测试](../../apps/core/tests/openai-compatible-chat-completions-client.test.ts)、[provider 测试](../../apps/core/tests/openai-compatible-model-provider.test.ts) | 115+12+47=174通过；覆盖显式选择、原生默认、完整 schema 指令、调用方对象不变、无 schema 请求及无自动降级。 |
| 主动讨论实际 client 接线 | `npm --workspace apps/core test -- tests/proactive-discussion-json-mode.test.ts`；[测试文件](../../apps/core/tests/proactive-discussion-json-mode.test.ts) | 2通过；JSON模式仍拒绝非法字段关系、围栏及无关结果，保留两次判断上限。 |
| Core / memory 配置边界 | `node --test --test-name-pattern="propagates the explicit Core structured-output mode" scripts/pilot-compose.test.mjs` | 1通过；只传入Core，不改memory provider。 |
| 全量 Core | `npm test`（Core Vitest入口；本轮17:25:37北京时间启动） | 4,673通过 / 469条件跳过；255文件通过 / 13文件跳过；27.73秒。 |
| 类型与构建 | `npm run typecheck`、`npm run build` | 随最终Core回归后均退出0。 |
| Compose及主动评估CLI | [Compose测试](../../scripts/pilot-compose.test.mjs)、[CLI测试](../../scripts/pilot/proactive-discussion-eval.test.mjs) | 合计41项：40通过 / 1跳过，其中CLI7通过；Docker daemon不可用导致真实Caddy边界探针跳过，未修复或启动Docker。 |
| 一次限定实现审查 | 本轮 env/client/Compose及相关回归范围 | 未发现阻塞项；不作为真实云端或产品语义验收。 |
| 第二项草稿引用核验实际模型路径 | `42db6b6c`；3例固定稿原型及实际正负修正链见上节 | 旧接线正确稿的误拒保留；新接线正确稿1次HTTP200返回原pair、无修正调用，负向稿3次HTTP200后两次raw true被拦、最终null。只证明局部返回/拦截，不证明生成成功；没有原完整15例两轮的新通过结果。 |

新quote enum的定向回归由实现子代理执行：先7失败/73通过，收窄接线后80通过；
4种1200字符草稿的response format分别为8109、18909、20909、15309字节，均小于32768字节上限。
这些局部回归及大小检查不证明provider会强制执行全部schema。随后主代理在最终源码冻结后执行
以下fresh验证，结果属于第二项应用`42db6b6c`，不沿用第一项结果：

| 第二项最终门禁 | 实际结果 |
|---|---|
| 完整Core：`npm test`，apps/core | 18:06:49 Asia/Shanghai启动，22.66秒；256文件通过/13文件跳过，4716项通过/469条件跳过。 |
| 类型与构建 | `npm run typecheck`、`npm run build`均退出0。 |
| Compose与主动评估CLI | node tests共40通过/1跳过，9782.7103毫秒；其中CLI7全部通过。Docker unavailable导致真实Caddy边界探针跳过，未启动或修复Docker。 |
| 变更空白检查 | `git diff --check`退出0。 |

主代理在最终完整回归前核对PID62148的精确runtime路径后停止本地模型；18:11:59北京时间再次核对，
18089无监听、没有llama-server进程。supervisor11899退出0，模型子进程因主动停止退出4294967295；这不是新的模型请求失败。
未创建常驻模型服务，未重启Docker。文档核对未额外运行模型、测试或服务。

没有新真实PG、精确SHA远端CI、部署、线上开关修改或真实飞书回执验收。
本地测试证明请求适配与既有校验边界，不证明HTTP429后的服务行为。

## 继续修复的两项私有实验：均未推广

本轮从干净文档HEAD`5611cef9c85ec46a61a791452fe6a50101c20639`继续，应用仍为`42db6b6c`，源码哈希未变。
两项均复用原assessment、draft与首次review，仅repair及最终review各1次真实请求，seed1709及本机runtime/profile不变。
当前pair validator、当次draft引用核验和调用上限均未改；不是fresh完整生成，也不是新的产品实现或整套验收。

| 私有假设与原始证据 | 实际结果与独立语义判读 |
|---|---|
| [七个可编辑字段](evidence/iris-semantic-spike-20260917-pair-edit.json)及[脚本](evidence/iris-semantic-spike-20260917-pair-edit-harness.txt)：10:17:33.908–10:18:38.489 UTC，总64.581秒；2次HTTP200，28.923/35.578秒 | 仅输出issueDescription、observation、reasoning、suggestion、uncertainty、materialChangeExplanation、draftText，由脚本原样拼回锁定字段再走现有validator。draft仍无6万元，issueDescription还被改成“预算不足导致招聘计划不可行”。最终raw supported=true只列10/16，两项引文有效但列表漏了必要差额，`returnedPair:true`。**独立语义失败，且确实发生误通过**；不能以模型布尔或字面凭据通过称修正成功。 |
| [具体凭据失败位置](evidence/iris-semantic-spike-20260917-pair-diagnostic.json)及[脚本](evidence/iris-semantic-spike-20260917-pair-diagnostic-harness.txt)：10:19:25.688–10:20:59.727 UTC，总94.039秒；2次HTTP200，64.864/29.088秒 | repair输入新增`requiredNumbers[2].draftQuote`失败位置、声明6万元，并明确这些只是引用诊断、不是数字事实。模型仍返回原pair，未补6万元且保留过度断言；最终raw true声明-60000元，但当前原句没有该值，helper拒绝，`returnedPair:false`。**语义修正失败，仅局部拦截生效**。 |

两种假设都未改善原目标，因此未运行其正向变体，未推广到产品、未增加回归或重复抽样。
edit的误通过发生于私有修改后的输出合同；它进一步实证了现有门禁不保证必要数字列表完整，
不等于已完成冻结产品原始完整输入的重新验收。继续保留原15例两轮、旧误拒及此次误通过，不缩减原criteria。
主代理于18:21:21.912+08:00停止本次短时模型PID50600；18089监听0、llama-server进程0，supervisor60383正常结束。
这两项本地实验没有云端模型请求、API费用、部署或外发；后续依据官方免费说明执行的独立云端探测另记于下节。

4份归档均与私有原件SHA256一致：edit报告`784614ede281e62648dc802261e8cf4a079f5d01859c2b626a3d0abb66a1f5e9`，
脚本`48aa77b6ff7aca5edc050844800c4875666967e6d87664208b2786a2bb4efaa8`；
diagnostic报告`8e530c76cb96455edbaf03ef22eb0157422d8cf3d0f78fffcebe4b7cb277ecf8`，
脚本`1805ed35c1cf78502a3b18cb89f2d0baaffdaa09b749bc4c66d7f8e6ba0bdace`。

## 后续免费云端：格式通过与算术失败或未完整分开

主代理于10:23 UTC核对[官方GLM-4-Flash-250414页](https://docs.bigmodel.cn/cn/guide/models/free/glm-4-flash-250414)，
其明确将该型号列为免费API；[当前对话补全接口](https://docs.bigmodel.cn/api-reference/模型-api/对话补全)
列出`glm-4-flash-250414`及`json_object`，thinking参数仅支持4.5及以上。
据此只用现有测试key对该明确免费型号做最小格式和原arithmetic，不带tools、search或thinking，未改产品配置。
GLM-4.5概览的只读打开超时后，未测试费用依据不明确的其他型号；没有声称已核对账单或实际配额消耗。

随后距09:20容量拒绝已约65分钟，在独立第五窗口仅复测原`glm-4.7-flash`：先最小JSON模式，
通过后进入原arithmetic；其thinking显式disabled。两份脚本均通过真实Core client的`json_object`模式，
本地检查实际payload类型；报告中的上层responseFormat仍是完整schema合同，不代表线上仍传原生schema。

| 模型/步骤与证据 | UTC时间及真实请求 | 实际结果 |
|---|---|---|
| [250414最小格式](evidence/iris-free-model-20260917-glm4flash250414-format.json) | 10:23:19.770–10:23:20.516；1次HTTP200，请求0.674秒 | `{"result":16,"label":"iris-free-format-check"}`，无多余字段/Markdown，`valid:true`。一次实际云端最小格式通过。 |
| [250414原算术](evidence/iris-free-model-20260917-glm4flash250414-arithmetic.json) | 10:23:35.275–10:23:37.998；1次HTTP200，请求2.637秒 | 返回合法`skip / insufficient_basis`；原标准应intervene，故是实际漏报、**语义失败**。assessment已产生但draft=null，未进入render、review或完整15例两轮。 |
| [glm-4.7-flash第五窗口格式](evidence/iris-free-model-20260917-glm47-window5-format.json) | 10:25:31.552–10:25:32.570；1次HTTP200，请求0.945秒 | 同样完整返回result16/label，`valid:true`；该型号JSON模式的一次云端最小格式现在已有通过证据。 |
| [glm-4.7-flash第五窗口原算术](evidence/iris-free-model-20260917-glm47-window5-arithmetic.json) | 10:25:50.147–10:25:50.419；首次assessment请求0.197秒、HTTP429 | 容量拒绝，`halted:true`，assessment/draft均null；**未完整、没有语义结果**，不是一次算术语义失败。未到render或完整集，随后停止全部云端请求。 |

[250414脚本](evidence/iris-free-model-20260917-glm4flash250414-harness.txt)与
[第五窗口脚本](evidence/iris-free-model-20260917-glm47-window5-harness.txt)同时归档；两者均未运行full分支。
六份归档均与私有原件SHA256一致，250414的格式/算术/脚本分别为
`cb03779cf02193589f53072c01aabab1798a8cc8a5b2f9a2194128413b258c98`、
`446788570b2c30d8523149bd312c68c10433f61fe23bb69cac40b06ae6f21557`、
`f1630b74caa3aad2f54421c0378bdcc6acd45fd532284b2c445519c58fa36625`；
第五窗口对应为`13dbfd7182c5534ec7076eb3aaecfe428e697aa8c940b91aa1ce6a61a21b6c83`、
`52f7f6e8b8cd1506b72c171201c93f3e00b10a25ee223cb979370ad6da90a3b5`、
`d5103416957bcf6fee665d5afac7945146f2123af880259f457fb268e50daefe`。

这些报告运行HEAD仍为`5611cef9`，应用model/client/config源码哈希未变；它们不撤销前两项已确认的集成修复，
也不足以把全部剩余失败简单归因于模型。最小格式通过不证明全部schema/enum兼容、主动语义或生产可用性。
未采用新模型、未测试其他型号、未部署/启用/外发，不将官方免费说明当成账单核对结果。

## 当前关闭范围与下一步

本轮针对已观察到的 schema 传输兼容缺口提供显式 JSON 模式适配，并保留全部本地校验。
应用 `a5e5e2e4` 已通过本轮本地回归、构建与有限审查，实际本地模型最小JSON格式通过；
这项适配实现及文档修复已有对应证据；后续两个免费型号的新模式云端最小格式各通过一次，
但250414原算术漏报、4.7第五窗口算术因429未完整，全部schema兼容和主动讨论整体实模门禁仍未通过。
原数字遗漏/算错、事实类别改写、复核误放行、独立问题漏报、已处理问题重复介入仍按
[原结果与标准](iris-assessment-wire-fix-20260917.md#实际关闭范围与剩余门禁)保留。

上节草稿引用存在性门禁已接入，锁定失败稿的实际修正链最终null，证明局部拦截而未得到完整正确输出；
旧接线正确稿对照也实际返回null，说明引用自由生成仍会造成误拒。收窄为当次draft引文枚举后，
同一正确稿已在1次真实review后返回原pair；负向稿完成3次真实请求、唯一一次修正后最终null，仍未补出6万元。
应用`42db6b6c`、最终4716项Core通过、类型/构建、Compose/CLI及本记录四处文档已补齐，
只关闭当前草稿引用证据的有限实现闭环；本地模型已停止，无push、部署、能力启用或外发。
分别保留原始模型布尔、凭据判定与语义判读，不把局部拦截当作生成成功。
修正链及正确稿失败记录均不覆盖。下一项仍是已保留的必要数字/事实类别、过度断言、
独立问题漏报和已处理问题重复介入；从具体剩余失败开展下一项有界修复，不重开已完成的引文接线审查，
也不以本记录授权无界审核或原样抽样。
随后两项私有修正假设已按同一缺6万元输入完成且失败，不再原样运行这两种变体。
剩余最小验收仍是按原criteria补齐必要差额、消除“计划不可行”的过度断言并返回完整pair，
同时不漏列必要数字；独立判读最终文本，不以review true、字面凭据通过或最终null替代语义通过。
同平台免费API核对后的有限探测已记录：格式不再是完全未知，但尚无可通过原算术/完整集的新增候选。
下一项仍从具体必要数字列表、事实类别和修正失败继续有界推进，不要求重找已有配置，不把本记录写成全部工作结束。

当前免费云端请求已在第五窗口算术429后停止；250414合法skip的语义失败与4.7容量未完整分开保留。
不密集重试、不对费用不明确型号试探，也不把最小格式成功或当前429写成原算术通过/失败。
无需重开Tasks1–8/I1–I4审查，不恢复旧包装结构设计，不以关键词代答或付费模型替代本轮证据。
任何部署、能力启用或真实外发仍需要当次任务授权；本记录及历史试点批准不新增权限。

## 四处文档处置

按[白皮书11.2](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#112-mandatory-bug-fix-documentation-closure)记录四项：

| 核对项 | disposition、链接与理由 |
|---|---|
| 白皮书 | **updated**：[主动模型合同](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)增加显式 JSON 模式传输边界、当次draft原样引文生成约束，以及引用不能代替语义/完整性判定的限制；局部正负对照与整体语义验收分开，禁止静默降级或无界修正。后续私有实验和免费云端探测为**reviewed-unchanged**：未改产品合同，既有必要数字完整性、格式/语义及无输出容量拒绝分层已覆盖新增结果。 |
| 工程故障台账 | **updated**：[主动协作条目](../operations/engineering-failure-ledger.md#proactive-collaboration-is-not-a-deadline-reminder)保留HTTP200格式失败、旧429、旧正确稿误拒及负向拦截；追加edit漏列误通过、diagnostic未修正，以及两个型号最小格式通过后分别算术漏报/容量未完整的结果。 |
| 核心需求覆盖基线 | **updated**：[2026-09-17 JSON 模式兼容](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md#2026-09-17-json-模式兼容)区分应用本地回归、云端最小格式已通过、完整兼容/语义未通过，以及局部返回/拦截和私有实验失败；IRIS-CORE-005仍部分实现。 |
| README / AGENTS / 当前交接 | **updated**：[README](../../README.md#current-product-state)、[当前交接](current-handoff.md#当前正在推进)及其未完成事项转向本记录；**reviewed-unchanged**：[AGENTS](../../AGENTS.md)，工作树/分支定位和四处闭环要求未变，已有current-handoff入口足以发现最新事实，故无需改动规则文件。 |
