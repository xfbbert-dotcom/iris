# Iris 来源计划：限定语义验收与本地入口接入

日期：2026-10-04。实现工作树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支
`codex/iris-daily-pilot-followup`。**应用接入提交：`1ea3ae7e528ae5f7ceb38686d6853fea9e0e6877`。**
后续归档/文档提交不是新的应用修复或部署。

## 本轮结论与范围

受控来源计划应用 `397fedbf2f19c0950fdcd16c185c3011998d76ef` 通过冻结的八个业务案例、
两项数值角色/新旧时序负控的首次目标识别，以及两项唯一修正后的完整 assessment/draft。
新接入提交只增加共享模式、正式 runtime/eval 装配及准确追踪，没有改变本轮已验收的
模型提示、编译语义、模型配置或修正上限。默认 `legacy`，显式选择 `source-plan` 才使用新路径。

这是限定合成语义通过和本地接入通过。**真实飞书未验收、生产版本未核验、未部署，
整体主动协作能力缺陷未关闭。** 本轮没有 push、生产访问、模型切换、主动发送或飞书外发。

## 问题与确认的改善

旧完整审核会为算术负号、无依据的确定后果等错误候选辩解；来源引用、schema和字面
凭据不能证明语义正确。此前多个失败窗口仍保留，见[受控计划记录](iris-opinion-plan-20261001.md)、
[结论角色修复](iris-opinion-conclusion-20261001.md)、[绑定恢复](iris-opinion-plan-recovery-20261002.md)
和[结构化沉默合同](iris-opinion-decision-only-20261002.md)。

当前路径把可执行核算交给程序、把生成限制为来源绑定的计划并编译完整pair，仍由模型
核对角色、时序、推断和介入价值。它避免将初判自由正文继续当成生成依据。显式绑定
失败可使用原唯一修正预算；完整审核失败也使用同一预算，不能叠加第二次。skip只保留
结构化决定/身份/引用，三段自由正文为空；代价是没有自然语言沉默解释。

新增入口之前，候选只能通过库参数调用。当前 runtime 读取
`IRIS_PROACTIVE_DISCUSSION_OPINION_MODE=legacy|source-plan`，eval 读取
`--opinion-mode legacy|source-plan`；共享映射只选择已有三项选项，非法/空显式值拒绝。
来源权限、模型配置和发送开关仍是各自独立的配置与门禁。

新 trace 记录实际 scope 请求中的 assessment/draft/sourcePlan；`compiledObserved`
表示实际观察到已编译候选，`acceptedDraft` 仅在 render 返回接受结果后成立。原计划、
绑定失败的 localValidation 和语义修正的真实 review 输入分开记录，均受现有脱敏/长度限制。
没有 scope 时不伪造编译结果，scope HTTP失败仍保留实际送审候选。审查发现 source-plan
初判被运行时拒绝时旧诊断可能错标通过，已补齐空skip正文和原句身份校验，两个回归先失败后通过。

## 实际模型窗口与原始证据

[72个原字节文件及manifest](evidence/iris-opinion-decision-resumed-20261004-manifest.json)
保存请求、响应、脚本、免费额度记录、逐例独立判断、负控来源/突变和停止状态。恢复窗口
运行HEAD是文档提交 `8fa43544`，实模应用仍397fedbf。2026-10-04 07:16:34–07:44:21 UTC，
23次HTTP200、86304 reported tokens，正常完成；加原首例1HTTP/3104为合计24HTTP/89408。
每次调用前均核对精确 `qwen3.8-max` 免费余额、未来到期和“用完即停”，无付费回退。
页面读数不是账单审计。non-thinking、max_tokens4096、首败停及原预算均未放宽。

原首例 paraphrase 的独立PASS来自跨天等待中断窗口，其报告未消费gate；原报告仍失败于
执行等待，不改写成单窗成功。随后登录失效的续跑为0HTTP/0tokens，也保留原件。
本次首例不重采，其余七例从assess新鲜执行，再做两负控；不是单次无中断八例窗口。

| 案例 | 独立结果与依据 |
| --- | --- |
| paraphrase | 保留PASS：同预算事实换说法，skip/duplicate，无重复意见。 |
| handled | PASS：已算出缺口、暂停招聘并核对，skip/already_handled；不冒称已解决。 |
| hypothesis | PASS：明确限定假设且已安排付费实验，skip/no_work_value。 |
| separate-next | PASS：独立权限缺口仍介入，先核实权限再定共享范围/条件，无已违法/已执行断言。 |
| inference | PASS：5人喜欢不足以推出全部用户付费，建议围绕该结论验证；无必然夸大结论。 |
| qualified-risk | PASS：接口未联调与肯定交付承诺的前提缺口，建议核实后限定条件；无必然延期。 |
| arithmetic | PASS：2×8=16，对预算10多6，建议确认差额覆盖/调整预算或人数。 |
| material-update | PASS：现24、原16、新增8、预算10缺口14，同一issue及真实新增报价。 |
| negative-role-swap | 首次模型审核明确识别单价8/预算10互换；唯一修正后的16/10/6完整pair通过。 |
| negative-time-swap | 首次模型审核明确识别新12/旧8颠倒及sourcePlan角色错误；唯一修正后的24/16/+8/14通过。 |

负控取对应正例最早的真实计算计划，机械交换完整binding，其余不动。没有人工正确选项，
不向模型提示“负例”。两项raw model supported=false且拒绝原因具体命中目标错误；
uncertainty仍true，不能归功于标签或本地receipt拒绝。原changeExplanation依规则保留，
其中正确关系可能提供交叉线索，所以不宣称证明任意输入泛化或完成全部因果分离。

## 本地验证与退出条件

实现计划：[2026-10-04接入计划](../superpowers/plans/2026-10-04-iris-opinion-runtime.md)。

- `npm --workspace apps/core test -- --no-cache`：最终5012通过、469条件跳过；281测试文件通过、13跳过，exit0。
- `npm run typecheck`、`npm run build`：最终均exit0。
- `node --test scripts/pilot/proactive-discussion-eval.test.mjs`：最终9/9通过，exit0。
- runtime新入口独立17项、eval/trace独立44项通过；有界代码审查无剩余阻断项。
- 新eval 11项先RED后GREEN；全量首次执行赶上两个新增诊断回归的RED，为2失败/5010通过，
  修复后以上完整全量重新执行通过，不隐藏中间失败。
- [正式入口离线回放](evidence/iris-opinion-decision-resumed-20261004-runtime-replay.json)：
  trace开/关各回放18条既有真实响应，八案例实际模型messages/schema及最终pair逐字一致；
  零网络、未读凭据。其余七个目录案例故意报告无归档响应，**不算本轮实模语义通过**。
- 归档72文件内容、长度和SHA256已由归档者与主代理分别核对；72份暂存Git原始字节亦逐一匹配manifest。

本轮退出条件已达到：限定语义门槛、实际本地入口、追踪回归、全量验证和四处文档闭环。
不再追加相同配置抽样或prompt变体。后续真实单群投递/暂停恢复与精确部署版本验收需要
单独授权；在当前边界内不执行这些外部操作。

## 保留的问题

初判仍会写出“收入预期将极度夸大”“接口问题将直接导致无法按期交付”等过强表述，
本轮最终计划/pair没有沿用；不能据此宣称初判能力已修复。原文中的“已授权预算”表述
也可能混淆可读来源与业务批准，最终意见未保留这一断言。

审核解释仍把角色错配泛称“算术错误”，把旧错误数字概括为“遗漏”，角色负控首审的
总体解释也混淆了数字存在与角色正确。角色修正的changeExplanation含内部修正叙述，
但同时有首次业务矛盾依据；真实历史没有旧issue，因此本例新增价值仍成立。此类表述
保留为后续质量问题，不作为语义通过的依据。风险建议仅达到核实前提/限定条件的最低
实用要求，表达具体性仍有限；三个计划类别不是任意讨论内容的通用推理完备性证明。

## 白皮书11.2四处处置

| 位置 | 处置与有效链接 |
| --- | --- |
| 白皮书 | **updated**：[§6](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)增加可选来源计划、核算/语义职责、唯一修正、结构化沉默、默认模式及实际追踪合同。 |
| 工程故障台账 | **updated**：[2026-10-04条目](../operations/engineering-failure-ledger.md)记录确认改善、原始失败保留、负控线索限制及未解决初判/审核表述问题。 |
| 核心需求覆盖基线 | **updated**：[基线](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)将IRIS-CORE-005的限定合成语义更新为通过，仍为部分实现，真实群和部署缺口未提升。 |
| README / AGENTS / current-handoff | **updated**：[README](../../README.md)与[交接](current-handoff.md)说明入口、应用提交、最新验收和后续边界。**reviewed-unchanged**：[AGENTS](../../AGENTS.md)工作树核对、禁止误推部署和四处闭环规则仍有效；当前实际定位在交接顶部给出。 |
