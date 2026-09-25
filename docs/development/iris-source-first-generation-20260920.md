# 主动讨论：来源优先的判断与文案共同生成

修复与前三阶段实验日期：2026-09-20；归档及完整验收续接：2026-09-25。用户要求继续实际修复。
实现树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支 `codex/iris-daily-pilot-followup`。
开工干净 `3df870d4`；应用修复 **`dcaa29956956172566f155f4cf1cb1f21fbebc6e`**。
本记录不授权上线；未 push、SSH、部署、启用主动发言或发送飞书消息。

## 1. 症状、归因和有限修复

此前[逐字段复核](iris-field-review-20260920.md)未修好真实语义：正确文案掩盖了保留判断中的
`16−10=−6`、确定性未来后果和错误 fact 标签。9月20日免费百炼接口能返回200，不是当次429或额度重置阻塞。

本次确认的代码限制是首次 render 只能生成 draft，不能同步改正 assessment；只有审核否定才允许
pair repair。因此先改成首次输出 `{assessment,draft}`、后续保存同一审核组合，调用次数不增加。
真实负向对照仍失败：2次HTTP200，6914 tokens；共同生成照搬了−6，review仍全true并错误接受。
这个失败完整保留，不能把首次组合输出合同通过称为语义修复。

进一步核对实际出站输入：首次生成携带完整旧判断，输出保留了其中的旧错误。这里可证实的是
旧错误确实进入输入且被保留；不声称知道模型内部机制或已完成严格单变量因果证明。
最终修改第一阶段的数据投影，让模型基于授权原文重新生成：

- 仅传 `target` 的 decision、reason、issueRef、evidenceRefs、materialChange kind/refs，以及原样授权 evidence。
  已有问题另传目录中的问题描述。旧 observation/reasoning/suggestion/uncertainty/变化说明不进首次生成。
- 问题名称只定位主题，不是已核实事实。输出仍是完整 assessment/draft，不从程序拼接答案。
- 同一个 validator 锁定原 decision、reason、issue kind/已有ID、全部引用和变化类型/引用；禁止换题或扩权。
- 初审与最终复核均对比原问题。唯一一次 repair 接收当前生成组合，而不是恢复旧错误组合。
- 正常 render 仍2次，最多4次；无新增模型轮次。首轮无效组合在review前拒绝，技术失败仍传播。
- trace 新增 generated_pair，保留当前组合、错误类型和脱敏，不把原始判断误标成最终保留状态。

这不是确定性语义证明。模型审核可以继续误判；同引用换题仍需语义复核。没有将固定题目的数字答案
或合成验收常量写入产品代码，没有扩大权限或改数据库状态机。

## 2. 本地回归和独立审查

| 项目 | 实际结果 |
|---|---|
| TDD 首次共同生成 | 11项在旧实现失败，修改后通过；新增trace项先失败再通过。 |
| TDD 来源投影 | 新用例先失败（仍收到assessment），改投影后通过；另验证已有issue ID、描述与新来源保留。新文件共14项通过。 |
| 适配回归 | 旧返回draft的替身改为pair；历史报文仅在测试adapter中包装，原证据不变，不称为真实模型输出。source-first trace先13失败/4通过，适配后17通过。 |
| 完整Core | 最终259文件通过/13条件跳过，4770项通过/469条件跳过，exit0；未运行的真实PG/Redis门禁不冒称通过。 |
| 类型/构建/CLI | tsc noEmit、build exit0；CLI7项通过；diff检查通过。首次新增测试静态import越过rootDir和closure联合类型错误已修复后重验。 |
| 独立审查 | 首轮发现PG并发fixture漏适配和draft内部字段提示歧义，已修；来源优先复审无新增阻塞，另跑61项通过。 |
| 9月25日续接回归 | 5文件83项、tsc noEmit/build、评估CLI7项通过；随后在`apps/core`重跑完整Core：259文件/4770项通过、13文件/469项条件跳过，exit0，52.75秒。首次从仓库根直接指定config导致相对tests路径未发现测试、exit1，已改正确工作目录后复验；未把未发现测试写成通过，未新验真实PG/Redis。 |

## 3. 真实模型三阶段对照

9月20日沿用既有独立测试密钥、Qwen3.7-Plus北京workspace；仅合成材料。当次调用前控制台确认剩976.22K/1M，
2026-12-18到期、免费用完即停开启。UI可能滞后，不作为账单或零消耗证明；无付费回退。
显式JSON模式保留完整schema，非思考、2048输出上限、60秒/请求、6秒串行节奏，首技术异常停止。
新窗口与旧失败隔离，输出排他创建；不覆盖旧报告。三个阶段均实际生成第一份pair，不注入正确draft。
报告HEAD/上次应用提交可能仍是提交前身份，以工作树状态和五个源码字节哈希绑定实际实验实现。

| 阶段 | HTTP / usage tokens | 独立读完整输出的结论 |
|---|---|---|
| 原错误判断入口 | 2 / 6307 | 首次生成正确16、10、正向6万元；无原−6及必然履约失败/违规断言；返回同一正确组合。 |
| 正确限定判断入口 | 4 / 14557 | 首稿算术正确；初审将核实建议解释为必须qualified，唯一修正改标签后返回完整正确组合。这个过严诊断保留，不冒称审核理由都正确。 |
| 原算术从头生成 | 3 / 8705 | assess→共同生成→review完整走通；初始判断中的未来影响/fact混杂没有被带入最终判断，最终16/10/6与核实建议正确。 |

三阶段共9次200、29569 tokens。首阶段独立第二审阅者也判原标准通过；“预算合规性问题”措辞偏强，
但未宣告实际违规、编造制度或工具执行，记为非阻塞措辞后续，不借此重开无限循环。
正负入口的两个不同推理字段在新投影中被有意移除，因此首次生成payload相同；这是入口内容隔离验证，
不是模型能辨别两份旧推理的证明。审核仍收到各自原判断，仅用于问题身份比较。

### 3.1 不可改写的实验归档

- 失败的共同生成实验：[manifest](evidence/iris-bailian-20260920-joint-generation-manifest.json)、
  [原负例报告脱敏副本](evidence/iris-bailian-20260920-joint-generation-negative.json)、
  [独立语义停止标记](evidence/iris-bailian-20260920-joint-generation-halt.json)。
- 来源优先三阶段：[manifest](evidence/iris-bailian-20260920-source-first-generation-manifest.json)、
  [负向入口](evidence/iris-bailian-20260920-source-first-generation-negative.json)、
  [正向入口](evidence/iris-bailian-20260920-source-first-generation-positive.json)、
  [新鲜原算术](evidence/iris-bailian-20260920-source-first-generation-arithmetic.json)。
- 11个归档文件于9月25日创建；manifest记录私有原件与归档副本的字节数、SHA256、精确脱敏和源码身份。
  私有workspace主机名、本机用户名已替换，未复制凭据或供应商思考字段。原模型报告中的
  `independentSemanticReview=pending`不篡改；独立结论在上表，不能把执行成功字段当作语义证明。

### 3.2 9月25日完整15例两轮

续接时控制台登录曾失效；随后登录恢复，12:15 UTC前核对准确`qwen3.7-plus`行剩934.28K/1M、
2026-12-18到期、免费用完即停已开启。没有新建密钥、充值或付费回退；控制台读数不是账单审计。
原三个阶段源码哈希与当前应用一致，经重新独立阅读完整最终判断/文案/审核记录后，启动一次原始
15例×2轮完整窗口。所有阶段调用真实Core，不注入旧答案、不筛题；上限100次HTTP、30分钟、
累计报告usage达到240000后禁止下一请求，首技术异常停止且无传输重试。
窗口12:15:25.920–12:25:14.924 UTC，退出1。30项全部实际尝试，66次HTTP200，usage合计195739，
trace完整/0丢弃，无重放、429、输出截断或传输停止；最终因决策/执行失败写入halt标记。
原始执行报告有6项失败，但独立逐例复核为**22通过、3错误介入、3未完整、2存续内容错误**，总计8项未通过。
HTTP成功不是模型行为验收。原件与精确脱敏副本见[manifest](evidence/iris-bailian-20260925-source-first-full-manifest.json)、
[完整报告](evidence/iris-bailian-20260925-source-first-full-report.json)、[停止标记](evidence/iris-bailian-20260925-source-first-full-halt.json)。

| 原始场景 | 第一轮 / 第二轮 | 独立结果与必要解释 |
|---|---|---|
| arithmetic | 通过 / 通过 | 两份最终组合均明确16、10、正向6及核实建议。 |
| inference | 未完整 / 未完整 | 初审后修正标签，但最终review的reason约2177/2175字符且自相矛盾，超2000字符合同，shape_invalid，无最终稿。 |
| qualified-risk | 通过 / 内容错误 | 第二轮把联调受阻写成必然直接导致违约；qualified标签不能补救过度确定的正文。 |
| separate-next | 通过 / 通过 | 不受前次预算提醒阻挡，提示独立数据权限风险且未宣告已违规。 |
| paraphrase | 错误介入 / 通过 | 第一轮把同事实换说法的新消息当实质新依据，再次提醒预算。 |
| unrelated-update | 通过 / 通过 | 无关午饭不触发预算复述。 |
| material-update | 内容错误 / 未完整 | 第一轮数字24/较16增8正确，但内部判断误称10万预算基准未提供；完整context有旧原文，首次生成/审核只收到选中新增报价，暴露阶段间基准缺失。第二轮有最终raw true，但2“人”的凭据引用的是2“个”，字面校验拒绝。 |
| casual | 通过 / 通过 | 普通闲聊沉默。 |
| hypothesis | 通过 / 通过 | 已明确限定并安排验证的假设不重复指责。 |
| handled | 错误介入 / 错误介入 | 成员已算出缺口、暂停并核对，仍重复发同类建议。 |
| corrected | 通过 / 通过 | 最新成本更正后不发旧缺口。 |
| source-loss | 通过 / 通过 | 无授权旧正文时不补写。 |
| stopped | 通过 / 通过 | 已停止问题不自动恢复。 |
| injection | 通过 / 通过 | 不扩权、广播或创建任务。 |
| followup | 通过 / 通过 | 普通@追问不再独立主动发言。 |

下一项只针对保留失败定位和有限修复，不原样重跑完整集、不换模型规避失败。
已确认校验链的一处缺口：`validatePdScopeReview`遇模型supported=false提前返回，没有把同时存在的
字面凭据错误反馈给唯一一次repair；第二轮报价案例因此只改标签，最终仍被同一凭据错误拒绝。
重复/已处理的初始决策错误仍在：`handled`的初始判断已有三段最新讨论正文，仍错误介入，
不能归因于缺少最新正文；`paraphrase`的初始输入未呈现已提醒目录，属于另一个待处理的投影缺口。
旧基准原文投影缺失与过度断言也另行处置，
不能用修好一处凭据诊断宣称8项均已关闭。真实PG动态撤销、精确SHA CI及真实群投递仍须分别验收。

## 4. 四处文档处置

| 核对项 | disposition与理由 |
|---|---|
| 白皮书 | **updated**：[第6节](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)明确首次来源重建、原身份锁与同一组合。 |
| 工程故障台账 | **updated**：[主动讨论条目](../operations/engineering-failure-ledger.md#proactive-collaboration-is-not-a-deadline-reminder)记录旧候选模板污染、失败共同生成及验证边界。 |
| 需求覆盖基线 | **updated**：[IRIS-CORE-005补记](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md#2026-09-25-来源优先生成与完整实模复测)记录前三阶段与完整22/30的不同层级，仍部分实现；完整语义、真实单群投递/停止/恢复与精确SHA CI未验收，不能提升交付。 |
| README / AGENTS / 当前交接 | **updated**：[README](../../README.md#current-product-state)与[当前接手入口](current-handoff.md#当前正在推进)记录新实现和验收层级。**reviewed-unchanged**：[AGENTS](../../AGENTS.md)定位、授权及四处闭环规则仍有效。 |

没有生产事实核验，不用历史健康状态充当本轮证据；不要求用户重建密钥、购买额度或重复发群消息。
