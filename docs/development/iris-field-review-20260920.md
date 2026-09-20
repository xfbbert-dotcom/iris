# 主动讨论：内部判断逐字段复核

日期：2026-09-20。用户要求继续修复已证实的复核误通过，不等待或反复抽样。
实现树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支
`codex/iris-daily-pilot-followup`，开工干净 `bd8eb652`。
应用修复提交 **`66c7a3c0bc7a32dcb9d1ec3aea82205610e09157`**；未推送、部署或启用主动发言。

## 1. 确认的问题与有限修复

[当日原始错误组合](evidence/iris-bailian-20260920-json-arithmetic.json)的草稿正确，
但最终保留的内部reasoning将16减10写为−6，并断言未来必然履约失败或违规，uncertainty仍为fact。
真实review收到完整assessment、原文及draft，却返回true；其可核对的凭据仅来自正确draft。
这不是输入漏传、429、日额度或必须换模型的问题。提示已有逐项核查要求，但输出合同允许只有总判定，
没有可检查的assessment字段覆盖义务；为什么模型仍误判的完整内部机制不能从报文得知。

修复限定在现有复核合同、提示与诊断，不新建判断引擎、不注入题目答案、不增加调用次数：

- `fieldChecks`必须且仅含issueRef、observation、reasoning、suggestion、uncertainty、materialChange。
  每项有boolean判定和1–400字符非空白具体理由；已有issue也须报告身份核对，不省略。
- schema与本地validator一致。整体true必须与六项全部true以及原草稿引文/数字连续性门禁共同成立。
  整体false不能被六项true覆盖，任一字段false不能被正确草稿或整体true掩盖。
- 复核共用生成/修正的fact与qualified_inference约定，并核对算式方向、符号、单位及未来结果限定。
  合理核实建议和有依据的限定推断仍允许，不要求原文逐字写出建议动作。
- 否定项及理由进入现有唯一一次pair repair；最终复核使用修正后的assessment并保留原问题比较、
  原数字诊断。成功render仍2次，修正最多4次；最终失败null，不新增重试或付费回退。
- 初审格式错误仍抛错，最终格式错误仍拒绝；旧无fieldChecks输出不以默认true兼容。
  evaluator复用同一validator，trace保留六项理由并脱敏；不读取脱敏后的文本作实际判定。

这关闭的是字段覆盖/合取缺口。模型可以对六项都作出错误判断，因此不能声称确定性证明语义正确，
也不能把适配后的测试替身当成真实模型成功。

## 2. 本地验证与审查

| 验证 | 实际结果 |
|---|---|
| 原有基线 | receipts34 + pair-review16，共50项通过。 |
| TDD RED | 新21项中11项失败：原始false-positive仍被接受，新逐字段合取尚不存在；其余形状拒绝测试已能被旧严格合同拒绝，不冒称21个独立缺陷。 |
| TDD GREEN | 21项全部通过：原样归档合同拒绝、六项逐个否定、逐个缺失、未知项/空白/超长理由、wire/runtime一致、唯一修正/最终拒绝及qualified正向。 |
| 完整Core | 17:09北京时间，258文件通过/13文件条件跳过；4756项通过/469项条件跳过。未配置真实PG/Redis等的门禁没有冒充通过。 |
| 类型/构建 | 分别执行tsc --noEmit与tsc build，exit0。 |
| CLI | proactive-discussion-eval.test.mjs 7项通过，未接入飞书发送依赖。 |
| 独立只读审查 | 无阻塞发现；审查者另跑7文件137项、类型及diff检查。不是人工审批或实模验收。 |

新增trace回归确认：roottrue+reasoningfalse被实际render拒绝、两次诊断保留，指定secret被脱敏。
旧数字连续性历史重放仅在测试adapter里补新字段，明确不修改原归档、不是历史模型判定。

```text
node node_modules/vitest/vitest.mjs run apps/core/tests/proactive-discussion-field-review.test.ts
cd apps/core && node ../../node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc --noEmit -p apps/core/tsconfig.json
node node_modules/typescript/bin/tsc -p apps/core/tsconfig.build.json
node --test scripts/pilot/proactive-discussion-eval.test.mjs
```

## 3. 真实模型对照边界

独立新窗口仅用于修复假设检验；此前native/JSON失败与halt原件全部保留，不覆盖或重开。
同一测试key、北京endpoint和qwen3.7-plus；仅合成材料，不发送真实聊天、文档或生产密钥。
调用前控制台刷新确认剩993.22K/共1M、到期2026-12-18、免费用完即停已开启。
非思考、max_tokens2048、60秒/请求、串行间隔6秒，无transport retry，首非成功/异常finish停止。
旧负向及人工正确对照仅重放第一次draft，其余走真实Core render；分别最多3和1个HTTP请求。
正向若误拒不追加修正；只有独立读完两个结果后，才允许原算术全新生成（最多6个HTTP）。
已有单次pair repair是产品内的修正，不是盲目多次采样。HTTP200与模型true不作为语义验收。

### 实际结果：字段合同通过，目标语义仍失败

09:15:13–09:15:45 UTC，归档负向对照实际3次HTTP200且finish_reason均stop，无截断或429：

1. 首次review虽然填齐六项，却全部true。其reasoning核查理由写的是正确的16−10=6，
   没有指出实际被审字段写的是−6；还声称没有未来过度推断、fact正确，均与输入不符。
2. review把draft中的10/16/6万元分别报成100000/160000/60000元。金额换算在数学上等价，
   但引文没有这些完整数字token，不满足既有字面凭据合同，因此本地将supported改为false。
   不能把这一拒绝归功于新六字段语义检查，也不能声称金额换算本身算错。
3. 唯一一次修正将原assessment与draft原样返回，错误符号、过度断言与fact全部保留。
   最终review仍六项true及相同换算凭据，仍被原字面门禁拒绝，最终pair=null。

主代理核对三次真实出站body哈希；两次review均含新逐字段要求、完整schema、共享uncertainty规则、
原错误reasoning、fact和两条原文。错误没有在传输前被改正或遗漏。修正实际收到的是
“复核凭据未通过当前草稿原句核对”，并未收到一个被模型真正发现的reasoning/uncertainty缺陷。
因此本次仅证实合同执行与旧门禁拦截，**没有证实模型逐字段判断或修正成功**。
负向窗口按约停止；正向、新鲜原算术与15×2完整集均未启动，不移除halt去续跑。
本轮3次响应合计12177 tokens；测试后UI仍显示993.22K和保护开启，存在显示延迟/粒度，不能当作零消耗或账单。

证据：[原始负向完整往返](evidence/iris-bailian-20260920-field-review-negative.json)、
[停止标记](evidence/iris-bailian-20260920-field-review-halt.json)、
[私有封装脱敏副本](evidence/iris-bailian-20260920-field-review-harness.txt)、
[启动器](evidence/iris-bailian-20260920-field-review-launcher.txt)、
[原件与副本哈希](evidence/iris-bailian-20260920-field-review-manifest.json)。
只替换私有workspace hostname和本机用户名；密钥及DPAPI文件未归档；旧报文未变。
私有脚本的file URL imports经TypeScript CompilerHost映射后严格检查0诊断，PowerShell AST 0错误；
直接tsc不能解析file URL的检查失败保留为工具限制，不冒充该命令成功。

### 后续单请求目标原文对照：仍失败，未推广

在独立只读核验上述事实后，仅做一次不同表示方式的私有诊断：将相同原文、完整六个实际待审字段
以`assessmentFields/targetText`明确列出，draft单列；每项结果额外要求完整原样`targetQuote`，
uncertainty目标包含原fact标签和完整reasoning。仍同模型、非思考、2048上限、免费保护，最多1请求。
它同时改变输入布局和输出要求，不能作为“正确draft导致干扰”的单因素因果证明。

09:22:12–09:22:30 UTC，1次HTTP200、stop，4820 tokens，六项原样引用均匹配。
但reasoning项引用了错误的−6，仍称算术正确；uncertainty项引用fact和未来后果，仍判定为可接受。
整体与六项继续全部true；这次draft数字凭据使用10/16/6万元，字面上匹配，也不能证明字段语义正确。
因此该假设**失败**，无positive、修正或全量后续；单独写停止标记，不推广targetQuote或该输入布局到产品。
观察结果进一步排除了“没收到完整字段”作为这份报文的解释，但不证明所有模型或其他配置必然失败。

[单请求完整往返](evidence/iris-bailian-20260920-field-target-negative.json)、
[独立停止标记](evidence/iris-bailian-20260920-field-target-halt.json)、
[封装](evidence/iris-bailian-20260920-field-target-harness.txt)、
[启动器](evidence/iris-bailian-20260920-field-target-launcher.txt)、
[原件/副本哈希](evidence/iris-bailian-20260920-field-target-manifest.json)。
私有脚本strict/noEmit与PowerShell AST通过；仅此一次请求。连同前述3次，本轮合计4次HTTP200、16997 tokens。

### 退出与下一项

- 已完成：六字段必填和本地合取、诊断脱敏、调用上限、回归与文档闭环。
- 尚未解决：真实模型把错误assessment判为通过，未能修正符号与事实/推断类别；不可称为主动语义已修好。
- 两个实验窗口均已停止。不要用同配置重新抽样、添加更多布尔项或正确引文来冒充理解，也不要重建密钥。
- 后续需新的有限可验证假设（例如同一固定负例、仅改变推理配置的对照），保留正确/qualified对照，
  通过后才恢复原生成及完整集。该后续未在本轮运行，不是付费、部署或扩大权限批准。

## 4. 四处文档处置

| 核对项 | disposition与理由 |
|---|---|
| 白皮书 | **updated**：[第6节](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)明确六项覆盖、合取与语义能力边界。 |
| 工程故障台账 | **updated**：[主动协作条目](../operations/engineering-failure-ledger.md#proactive-collaboration-is-not-a-deadline-reminder)记录输出义务不足、正确draft不能证明内部判断以及有界退出。 |
| 需求覆盖基线 | **reviewed-unchanged**：[IRIS-CORE-005](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md#2-核心需求追踪)仍部分实现；字段合同与个别控制样本不构成完整实模、真实飞书或部署验收。 |
| README / AGENTS / 当前交接 | **updated**：[README](../../README.md#current-product-state)与[当前交接](current-handoff.md#当前正在推进)记录新应用身份、验收层级和后续。**reviewed-unchanged**：[AGENTS](../../AGENTS.md)定位和四处闭环规则仍有效。 |

未进行SSH、生产健康核验、配置变更、部署、主动能力开启、审批或飞书发送。历史线上状态不冒充当前事实。
