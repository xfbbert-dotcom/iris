# 推断意见复用所选结论：限定修复与验收

2026-10-01；前应用5b48ad12的Q3.7与Q3.8失败均保留于
[完整记录](iris-opinion-plan-20261001.md)。当前为同次应用提交，首HTTP前preflight冻结HEAD。

## 已观察到的问题和修复范围

Q3.8窗口9HTTP200/26891tokens，推断例把已报告访谈依据当待验证假设，完整审核错批。
生成已有premise与decision角色，额外verificationTarget却允许另选任一引文；程序
因此将已知事实转写成假设。已确认的是选择错误、允许该角色错配的合同和审核漏检，
模型为何作出错误选择的内部原因仍未知。

本修复从inference schema移除verificationTarget；premise、decision、changeExplanation
保留。程序在明确引用所选结论后，建议围绕上述结论开展小范围验证并收集证据，根据
结果修订判断和推进条件。它不声称小范围即可证明全体、不自动从事实生成新假设，也
不靠业务关键词提取答案。dependency的核实目标、计算分支、完整审核/一次修正/终审
保持。系统说明仅同步字段职责，不增加新的审核提示词变体。

旧多余字段由strict合同拒绝，属于执行失败，不改成skip。程序消除了第三对象错配
入口，仍不能证明模型选对decision或来源关系，不能把原审核错批宣布已解决。
[实现](../../apps/core/src/proactive-discussion/opinion-plan.ts)及
[回归](../../apps/core/tests/proactive-discussion-opinion-plan.test.ts)。默认仍关闭。

## 本地证据

新合同回归先4失败/14通过，实现后18通过。全量Core4975通过/469条件跳过（278文件
通过/13跳过）；typecheck/build exit0，CLI7/7 exit0。独立设计及最终代码限定复核无阻断项，独立重跑18/18通过。这些是本地证据，不是实模、真实飞书或部署验收。

## 一次修复后新鲜窗口（首HTTP前冻结）

沿用[原8例和2负控的全部语义标准](iris-opinion-plan-20261001.md#一次新鲜八例窗口及两项负控)，
不改原文、不降低有用性要求。为先检查已失败部位，本窗口顺序改为：inference、
paraphrase、handled、hypothesis、qualified-risk、arithmetic、material-update、separate-next；
每例都从真正assess重新运行，不注入旧响应或人工计划，不以旧4例通过代替新结果。
8例全通过后才运行原冻结数值角色交换、旧/新成本交换两项负控，原始计划取首次模型
计算计划，机械互换完整binding，审核必须具体识别目标错误；同一唯一修正及终审保持。

精确qwen3.8-max，non-thinking，max_tokens4096；同一窗口最多40HTTP/180000reported
tokens下次请求前停止/45分钟，单次60秒、零网络重试。每次HTTP前新读精确型号免费
额度至少200K、未到期、用完即停开启、观察60秒以内并绑定wire。prefix为
opinion-conclusion-20261001；preflight冻结已提交应用、runner/launcher哈希。初判失配
在render之前停；执行/决定/语义首个失败即停，不重采同配置、不改预期，不追加同类
prompt。本轮全部通过才推进同代码本地runtime/eval接入；真实群验收与部署不在当前授权。

## 白皮书11.2四处处置

| 位置 | 处置 |
| --- | --- |
| 白皮书 | **reviewed-unchanged**：[§6](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)要求有据推理、最终评估与发言同审、一次修正及授权边界仍有效；这是默认关闭候选的角色合同修复，尚非正式稳定路径。 |
| 工程故障台账 | **updated**：[台账](../operations/engineering-failure-ledger.md)记录计划目标错配、审核错批和此有限修复；模型内部归因仍未解，不关闭整体bug。 |
| 核心需求覆盖基线 | **reviewed-unchanged**：[IRIS-CORE-005基线](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)仍部分实现；局部本地通过不足以提升主动讨论或真实群覆盖。 |
| README / AGENTS / current-handoff | **updated**：[交接](current-handoff.md)指向实际失败和新合同验收；**reviewed-unchanged**：[README](../../README.md)产品未完整验收状态、[AGENTS](../../AGENTS.md)工作树/授权/闭环规则仍有效。 |

当前：代码已改、本地通过；新合同实模未调用，真实飞书未验收，未部署。无push、生产
访问、生产模型切换、主动群发启用或飞书外发；生产SHA未核验。原能力缺陷仍开放。
