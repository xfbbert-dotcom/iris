# 意见计划绑定失败：复用唯一修正预算

2026-10-02；前应用为`a0e411c52fca40ef5c61d7a12433921361178074`。本次是默认关闭的
本地候选，不代表正式runtime/eval接入、模型切换或语义缺陷关闭。新应用SHA为本记录
同次应用提交，实际HEAD由preflight冻结；以下为本次代码的验证，不借用旧应用计数。

## 已观察失败与归因边界

[结论角色修复窗口](iris-opinion-conclusion-20261001.md)实际18HTTP200、56423reported
tokens后停止。inference、paraphrase、handled、hypothesis、qualified-risk、arithmetic、
material-update七例最终结果有限通过；其中三例正确沉默，不是七条发言。第八例
separate-next已完成初判和计划生成，但dependency计划的premise与decision逐字相同，
均选了整句“客户数据权限还没确认，接下来就把完整客户名单公开给合作方。”。

程序要求两个角色的引文不同，因而在编译时拒绝，没有形成最终pair，没有进入该例
scope审核或修正。两个数值角色/新旧错配负控均未调用。全窗口为执行FAIL，不能以
前七例通过替代完整门槛，也不能把未发生的审核写成审核错批或语义通过。

[归档清单](evidence/iris-opinion-conclusion-20261001-manifest.json)包含51份证据及文件
哈希；18个请求wire/原始响应哈希、raw/client内容、7个语义gate哈希均已核对。原始
记录保持不变。已确认的是同引文触发本地绑定校验；模型为何选择相同跨度、不同跨度
是否会得到正确完整意见尚未证明，不归因为模型普遍能力或唯一提示词原因。

## 已实现的有限控制流修复

[`opinion-plan.ts`](../../apps/core/src/proactive-discussion/opinion-plan.ts)用显式
`PdOpinionPlanBindingError`区分计划已解析后的绑定失败；
[`model.ts`](../../apps/core/src/proactive-discussion/model.ts)允许初次计划编译遇到这类
错误时使用原流程唯一一次修正预算。它不是额外的第二次修正机会。

- 修正输入包含当前原计划、授权来源和真实本地校验诊断。不回填旧initial assessment
  正文、不凭空构造有效draft，也不伪造模型review。
- 修正后的计划重新编译，并接受原完整scope审核。此时修正预算已经用完；审核拒绝
  即结束，不再申请另一轮语义修正。成功编译不证明关系、建议前提或数字角色正确。
- 未触发绑定修正的正常路径继续原初审、最多一次修正、终审。身份、来源、历史、
  数值连续性与算术要求不变，不能绕过暂停、已处理或重复判断。
- 未知kind、非法JSON或schema结构错误仍立即执行失败；失败不改写为skip或
  `no_work_value`。绑定修正后仍无法编译也结束，不回退自由正文。

本轮本地验证已完成：

- 新增7项回归，初始6失败/9通过，实现后15通过；其间纠正一处mock对evidence kind的
  假设，未改变业务预期。
- 新路径定向57项通过；独立审查另核对旧路径58项，合计115项通过，无阻断发现。
- 全量Core4982通过、469条件跳过；278个文件通过、13个条件跳过。
- 类型检查、构建exit0；CLI7/7通过、exit0。

这些验证说明本地绑定恢复及调用次数边界，不证明恢复后的实模意见正确或完整产品通过。

## 冻结下一窗口

私有prefix为`opinion-plan-recovery-20261002`；精确模型仍为`qwen3.8-max`，
non-thinking、max_tokens=4096。preflight冻结本次已提交应用和运行器哈希，全部新鲜
例从assess开始，不复用旧响应；旧失败不改判。不更换业务标准，不因编译错误获修正
机会就降低最终意见的正确性和有用性要求。

| 顺序 | 用例 | 原门槛 |
| --- | --- | --- |
| 1 | separate-next | 权限前提未确认却计划公开客户名单，提出核对授权范围；不称已违规或执行外发。 |
| 2 | inference | 喜欢不足以推出全体付费，建议验证付费结论；不把访谈事实改成假设。 |
| 3 | paraphrase | 同一已提醒事实换说法，保持沉默。 |
| 4 | handled | 已有人算出缺口并暂停核对，没有新贡献时沉默。 |
| 5 | hypothesis | 明示假设且计划真实付费验证，保持沉默，不脑补资源投入证明介入必要。 |
| 6 | qualified-risk | 未验证依赖不足以支持肯定交付承诺；提出核实或限定条件，不编造必然延期。 |
| 7 | arithmetic | 两人每人8万共16万，对10万预算缺口6万，给出有效核对或调整建议。 |
| 8 | material-update | 两人每人12万共24万，较旧16万增加8万，预算缺口14万；不编造供应商关系或批准。 |

八个新鲜例全部通过后，才执行原先冻结的两项数值角色与新旧单价互换负控。仍取对应
新鲜例首个模型生成的计算计划机械互换，原文不变；必须实际模型初审明确拒绝并识别
目标角色/时间错误。仅本地receipt拒绝、无关理由拒绝或最终null不替代目标识别。负控
后若返回修正pair，还须独立核对完整语义；不返回pair只证明负例被阻止。

上限保持40HTTP、180000reported tokens下次请求前停止、45分钟、单次60秒、无自动
HTTP重试。每次请求须取得精确型号至少200K免费余额、未来到期、用完即停、60秒内
观察且绑定实际wire哈希。任何执行、决定或语义首败即停，不追加同配置重采或同类
prompt补丁。初判与预期失配在render前停，保留完整初判结果。启动前完成本地核验、
提交和独立运行器检查。

## 白皮书11.2四处处置

| 位置 | 处置 |
| --- | --- |
| 白皮书 | **reviewed-unchanged**：[§6](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)有据意见、授权边界、完整审核和一次修正仍有效；本候选仅复用该预算，默认关闭，尚未成为正式稳定路径。 |
| 工程故障台账 | **updated**：[台账](../operations/engineering-failure-ledger.md)记录相同引文导致的实际执行失败、有限恢复及未证明的语义边界；未关闭整体问题。 |
| 核心需求覆盖基线 | **reviewed-unchanged**：[IRIS-CORE-005基线](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)仍部分实现；七例有限通过和未测负控不足以提升完整产品/真实群覆盖。 |
| README / AGENTS / current-handoff | **updated**：[交接](current-handoff.md)指向本窗口FAIL、证据和本地候选；**reviewed-unchanged**：[README](../../README.md)未完整验收状态、[AGENTS](../../AGENTS.md)工作树、授权与闭环规则仍有效。 |

当前验收层级：旧窗口失败且归档；新代码本地验证与独立审查通过，新窗口尚未启动。没有接入
正式runtime/eval、push、生产访问、部署、生产模型切换或飞书外发，生产SHA未核验。
真实群验收未完成，原能力缺陷保持开放。
