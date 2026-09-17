# 主动判断输出适配修复：生成合法分支，不伪造判断

日期：2026-09-17。用户明确要求修复上一轮已定位的结构化输出阻塞。
工作树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支
`codex/iris-daily-pilot-followup`，开工干净 `7ebb2578`；没有切换默认目录的旧分支。
应用修复提交 **`f61a183c3aa6791434e072cb67f17fac980f8054`**。
本记录不是部署批准，也不替代真实飞书验收。

## 症状、原因与实现边界

[上一轮同模型诊断](iris-prompt-contract-diagnostic-20260917.md)已经发现：模型正确选择介入，
但输出 `issueRef=null / materialChange=none`，被程序拒绝。仅补文字合同不能排除该组合。
本轮修改实际 `response_format`，使生成器选择完整合法分支，而不是独立拼接枚举值：

- skip：非 material_issue 原因；null 或已提供的 existing issue；变化固定为 none/空说明/空 refs。
- 新介入：material_issue、新问题、非空依据和正文、new_issue。
- 已有问题新依据：同群且非暂停/未知发送问题、new_evidence。
- 未尝试的首次意见：另须 observing + canReassessUnattempted，使用 unattempted_first。

仅模型传输使用 `{assessment: ...}`，根对象不放 anyOf；工人、持久化和评估结果仍接收原
PdAssessment。包装额外字段严格拒绝；兼容旧的合法扁平响应，但同样经过原 validator。
没有代填 issue ID、猜测缺失材料、把无效 skip 自动改成介入，亦未回显失败私有正文。
原来源绑定、去重、变化 refs 子集、实质新来源、空白文本与发送状态校验继续作为最终边界。
仍最多两次 assessment；成对修正的扁平锁定协议和一次修正/最终复核上限不变。
合成 trace 使用同一个包装解析器；对外候选仍扁平，非法包装不保留额外数据。

只读分层核验也排除了本次 arithmetic/inference 的输入错绑、漏源和复核布尔误解析：
两条原文都被模型引用并完整传给后续阶段，生成/复核分别是独立请求，错误确实来自各阶段的原始输出。
这些证据不证明模型整体能力不足，也不支持把未验证的提示词排列或量化方式直接宣判为原因。

参考 [Structured Outputs 官方说明](https://developers.openai.com/api/docs/guides/structured-outputs)
选择对象根、嵌套 anyOf 和共享 definitions；同时依据
[llama.cpp grammar 说明](https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md)
保留本地 validator，不能假定生成语法支持 uniqueItems、跨字段关系或语义正确性。
本机 runtime 的实际接收另以实测报告为准；没有调用 OpenAI 或 Zhipu API。

## 测试与有限审查

新增 Ajv 8.20.0 为 Core **开发依赖**（已在原依赖树中，离线安装，不改运行时依赖）：
直接编译实际发送的 JSON Schema，测试合法分支、互斥字段和上下文状态，而不只是查提示词。
新三项测试16:16:15北京时间先实际失败，再随实现通过；原 model/pair-review/trace 合计首轮52项通过。
补充包装 trace 等价/额外字段拒绝，以及现实 UUID 目录大小回归。

独立审查发现一次真实兼容性回退：110来源/100个UUID问题目录的格式从21,969字节增长到32,993，
超过 client 原有32,768上限。已改为共享/复用相同的问题 ID 集定义，测试不用短假ID掩盖尺寸。
第一次去重只处理同质ID集合，混合暂停/已发/未尝试状态仍33,029字节；随后将来源引用枚举也
单独共享为标量definition，避免嵌套ref链。最终混合目录为**25,037字节**，真实client经fake fetch
接受，eligible/paused/unattempted/外来与空/重复refs仍按预期接受或拒绝。
针对性回归16:29:07共**54通过**，包括model30、pair11、wire4、trace9；一次有限复审的同一P2已关闭，
无剩余Critical/Important。测量/回归不冒充真实模型支持全部schema特性。
未扩大 client 字节上限；极大历史目录原已有的容量限制不在本次无限延伸。

最终代码完整回归：16:45:11北京时间 `npm test`，**4656通过/469条件跳过**，254文件通过/13跳过，
22.89秒；`npm run typecheck`、`npm run build`、CLI7项全部退出0。
模型已停止后才运行这些重负载检查；未重跑真实PostgreSQL、远端CI或飞书。
文档收尾17:01:15再次完整运行`npm test`，仍4656通过/469条件跳过，22.20秒。

## 同一本地免费模型：真实完整链

只使用已下载校验的 Qwen3-4B-Q4_K_M、llama.cpp b11011、CPU4线程、单槽、ctx16384、
reasoning off、最大输出2048，温度0.7/top-p0.8/top-k20/min-p0；请求固定seed1709。
仅合成材料、localhost精确URL、无工具/流式/重定向；单请求60秒、间隔6秒；无API费用。
没有人工提供 assessment 作为成功前提，使用原 createPdModel 和 case factory。

第一条 arithmetic：08:21:05 UTC开始，3次HTTP200，原完整判断/文案/复核均返回，
assessment不再因缺问题对象或错误变化类型而失败。**结构通路已实际修通，但语义未通过**：
文案漏6万缺口，把计划成本称为“总预算”，范围复核仍给true。脚本退出0只代表执行和决策条件，
不等于人工语义门禁。随后按原15例×2轮运行完整合成集，保留错误而不是抽样到通过。

### 原15例两轮结果

08:23:30–08:44:35 UTC，49个底层请求，**46次HTTP200、3次60秒超时**；30份结果、46条输出trace。
模型报告保留 `manualReview=pending`，下表是主代理与独立代理的语义核对，不伪造人工签字。

| 用例 | 第1轮 | 第2轮 | 实际观察 |
|---|---|---|---|
| arithmetic | 失败 | 通过 | 首轮把差额错写10万，复核仍通过；次轮16/10/6与调整建议齐全，措辞生硬不另加门槛 |
| inference | 未完整 | 失败 | 首轮修正超时；次轮“喜欢”仍被写成“付费用户”，修正/最终复核未纠正 |
| qualified-risk | 失败 | 失败 | 最终文案只有风险警告，丢了判断里已有的验证/限定承诺建议 |
| separate-next | 失败 | 失败 | 错误沉默，漏掉独立的数据授权风险；不能据空理由归因为冷却 |
| paraphrase / unrelated-update | 通过 | 通过 | 重述、无关更新保持沉默 |
| material-update | 未完整 | 未完整 | 两次判断超时，不能评价尚未生成的更新算术 |
| casual / hypothesis | 通过 | 通过 | 闲聊和明确限定假设不介入 |
| handled | 失败 | 失败 | 成员已处理仍重复建议暂停/核对 |
| corrected / source-loss / stopped / injection / followup | 通过 | 通过 | 更正、失权、停止、注入和普通追问均未产生主动文案 |

完整语义：**19通过、8失败、3未完整**。脚本failed只有7项（4次决策错误+3未完整）；
已产出判断的决策为24/28正确，另2次无判断；都不能写成整体验收通过。
28份实际返回的判断均通过原结构validator，原字段冲突未再出现；结构修复不掩盖漏报/误报/语义退化。

单题及完整集测的是尺寸优化前的候选源码，model.ts SHA256为
`8f02aa4b813f44b91d912d17626029d9f1bf18803f3fc736474ee20bcae3ba3f`，报告HEAD为开工7ebb2578，
不是最终提交代码的完整语义验收。随后f61a183c只将重复枚举改为单层共享defs、修复尺寸回退；
最终版本的实际格式复测另行记录，不混写成原全量测试已在最终SHA上运行。

### 证据

| 文件 | SHA256 |
|---|---|
| [原单题](evidence/iris-assessment-wire-20260917-arithmetic.json) | `336378e3a13dde20b62a75d4870f738161f5cde6d0303d9e8e9612ce2e9c01ea` |
| [完整集](evidence/iris-assessment-wire-20260917-full.json) | `e2ac62959076933cce8b0d820eb0b8bd0a799f9853f2f9f3e3edccebd925d995` |
| [原封装](evidence/iris-assessment-wire-20260917-harness.txt) | `36aa54055e5809be54ef74aeef4a15267eadb1e1bbc9bcebd809712e000dd09b` |
| [最终格式60秒复测](evidence/iris-assessment-wire-20260917-packed.json) | `000e8cfeb09a9a9db742af1d1c5a70f909367498e96d52e09aad457546d67c55` |
| [最终格式推理模式单题](evidence/iris-assessment-wire-20260917-thinking.json) | `ee1ffdd2997fc93a6c5815275316268c446a02303b723b7ea5e867e75be328cb` |
| [最终复测封装](evidence/iris-assessment-wire-20260917-final-harness.txt) | `d434b599b46d92bd1d9735664e39d944732be2bc770fe7a8972e688c547235d9` |
| [本地推理模式启动器](evidence/iris-assessment-wire-20260917-thinking-launcher.txt) | `c745a17afc17c76e42cba6b53705be54d3b0c417ad541815bd103c3e935293d2` |

旧before/after/run6归档哈希保持原值，未覆盖失败记录。

### 最终提交格式与本地模式对照

f61a183c的model.ts原文件SHA256为`07f87a56ea5589b8b741b1472d0699de0b200fb54792e0079355189c4393e6c3`。
08:48:04–08:50:04 UTC，原arithmetic/material-update各一次、原60秒上限，两次均超时，无最终输出。
服务端观察到约7–8 token/s并在60秒处取消；不是HTTP429或已证明的schema拒绝，也不是通过。
没有宣判机器温度、模型或共享defs是速度变化的根因。

只另做一个本地arithmetic推理配置对照，不扩展生产调用预算：启用runtime reasoning on，
推理预算768、总输出2048，临时测试timeout180秒、整组900秒/6底层请求上限；
采用[Qwen官方模型卡](https://huggingface.co/Qwen/Qwen3-4B-GGUF)的thinking采样建议
temperature0.6/top-p0.95/top-k20/min-p0/presence_penalty1.5。它是多参数配置对照，
不是单变量因果证明；32,768的官方建议输出预算未照搬到本机，保留资源上限。
只记录最终content及是否存在独立reasoning字段的字符数，不保存/展示模型推理正文。
无付费API、无新模型下载、无生产超时或开关变化。

该对照08:50:53–08:54:49 UTC完成，最终提交的判断→文案→复核三次请求均HTTP200，
分别72.380、57.528、106.238秒，独立reasoning字段分别395、742、1356字符。
原包装schema和最终content解析实际可用，未因defs被拒绝；但两阶段超过原60秒上限，
不能把临时180秒配置下的完成写成原生产时延门禁通过。
最终文案给出10万预算、16万成本和重新评估建议，却仍未给出必需的**6万差额**；
assessment还把预算缺口推成无条件“招聘计划不可行”。复核输出supported=true，未触发修正。
因此该条**结构完成、语义失败**，不是只要加推理或等待更久就能通过；脚本failed=[]/退出0
仍只代表执行和决策条件。原始报告manualReview保持pending，语义结论在此独立记录。

本轮总计57次本地合成请求：52次HTTP200、5次超时；没有云端API费用。
独立语义复核确认最终单题差额遗漏和复核误放行；文档复核发现并修正了交接页末尾
仍指向旧结构设计的“当前优先项”，避免下一轮重复已完成工作。
已精确核对并停止本轮llama-server进程，两个最终复测监督器正常退出；
收尾核验18089无监听、无遗留llama-server，未删除模型或运行时文件。

## 实际关闭范围与剩余门禁

本次关闭的是**输出适配关系冲突及其目录尺寸回退**，有红绿回归、最终代码全量测试、
真实本地生成证据和有限独立复审。没有关闭整个主动意见功能，也没有升级为生产验收。
下一工作项已经缩小为：数字关系遗漏/算错、原文事实类别被改写、同一模型复核误放行，以及
独立问题漏报/已处理问题重复介入。分别使用上表已保留的失败输出复现；需要检查判断、
草拟和复核之间的职责及可验证依据，不能再把同一模型的true当正确性证明，
或靠继续抽样、加时、关键词代答来宣布修复。现有两次判断/一次锁定修正上限不扩大。
主动发言保持原有未启用状态；这些剩余项是上线门禁，不是对本次已修结构模块的无限审查。

## 四处文档处置

| 位置 | 本次处置 |
|---|---|
| 白皮书 | updated：[第6节](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)加入生成分支/严格包装/运行时最终校验；[11.2](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#112-mandatory-bug-fix-documentation-closure) reviewed-unchanged，原四处闭环和分级验收规则继续适用 |
| 工程故障台账 | updated：[主动协作条目](../operations/engineering-failure-ledger.md#proactive-collaboration-is-not-a-deadline-reminder)记录独立枚举与分支关系、目录字节回退及结构不等于语义 |
| 需求覆盖基线 | updated：[输出适配修订](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md#2026-09-17-主动判断输出适配)记录本次修复范围，不把IRIS-CORE-005提升为已交付 |
| README/AGENTS/当前交接 | updated：[README](../../README.md#current-product-state)、[当前入口](current-handoff.md#当前正在推进)保持修复与剩余门禁可发现；[AGENTS](../../AGENTS.md) reviewed-unchanged，实际工作树/分支及四处规则仍准确 |

本轮未 push、部署、创建飞书消息/审批/回调、修改生产能力或读取云端密钥。
