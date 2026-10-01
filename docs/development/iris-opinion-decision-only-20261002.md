# 沉默分支仅返回结构化决定

2026-10-02；应用为本记录同次提交，实际HEAD由preflight冻结。候选默认关闭，未接
正式runtime/eval，未切换生产模型。

## 实际失败与本次取舍

前应用`515f81044e592e80ad16b4c572629e08d63bff8d`的
[恢复窗口](iris-opinion-plan-recovery-20261002.md)实际7HTTP200/22941reported tokens。
权限与付费推断两例最终pair有限通过，均未触发绑定恢复。第三paraphrase正确返回
skip/duplicate且没有draft，但保留的reasoning声称“发送结果未知”，与输入中的
`hasUnknownDelivery=false`、`state=surfaced`矛盾。完整assessment语义FAIL，窗口停止；
其余五个新鲜例及两项负控未调用。[25份证据及清单](evidence/iris-opinion-plan-recovery-20261002-manifest.json)
保留原始失败，不把正确沉默改写为该例整体通过，也不声称绑定恢复已经实模验证。

本次改变skip输出合同，而非补写状态提示词：仅在opinionPlan候选中，schema要求
observation、reasoning、suggestion三个字段均为空字符串，本地同样拒绝非空。保留原
最多两次格式生成尝试；不静默删除模型正文，不把历史错误解释修饰成正确解释。
intervene完整意见与legacy路径不变。

结构化reason、issueRef、evidenceRefs仍保留并受校验；其中resolved会影响问题状态并
取消prepared发送，不能把它当无副作用标签。三个自由正文不驱动这些操作；本次查明
错误skip正文实际影响审计记录，未发现它进入后续上下文或群输出。明确代价
是失去自然语言沉默解释，审计仍可对照结构化决定、真实状态和授权来源；这不证明
reason分类或问题选择正确，也不放宽新鲜正例必须生成有用意见的要求。

## 本地证据与下一门槛

新增9项回归：初始5失败/16通过，实现后相关24项通过；定向66项通过。全量Core4991
通过、469条件跳过（278文件通过、13文件跳过）；独立审查9文件128项通过，无阻断。
数据库条件测试本轮跳过，不声明本轮已执行。首次typecheck发现新增测试字段索引类型
错误TS7053，已仅加as const修正测试类型；最终typecheck、build均exit0，CLI7/7通过、
exit0。没有改变业务预期或将条件跳过计为数据库验收。

下一私有prefix为`opinion-decision-only-20261002`，同一精确`qwen3.8-max`、
non-thinking、max_tokens=4096。全部从assess新鲜执行，顺序为paraphrase、handled、
hypothesis、separate-next、inference、qualified-risk、arithmetic、material-update，
再执行原两项数值角色/新旧单价机械互换负控。保持
[原完整业务门槛](iris-opinion-plan-20261001.md#一次新鲜八例窗口及两项负控)：前三例
正确沉默，后五例返回受完整审核的有用意见；负控须由实际模型拒绝并识别目标错误，
不能仅靠本地拒绝或无关理由。当前合同的新空正文不撤销旧窗口的完整语义FAIL。

上限仍40HTTP、180000reported tokens下次请求前停止、45分钟、单次60秒、无HTTP
自动重试。每次调用检查精确型号至少200K免费余额、未来到期、用完即停、60秒内
观察及实际wire哈希。初判失配在render前停，任何执行或语义首败停止该窗口，不重采、
不改预期；绑定恢复仍占原唯一修正预算，不能增加修正次数。

## 白皮书11.2四处处置

| 位置 | 处置 |
| --- | --- |
| 白皮书 | **reviewed-unchanged**：[§6](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)有据介入、真实历史、授权边界与完整审核仍有效；这是默认关闭候选的skip合同收缩，未成为正式稳定路径。 |
| 工程故障台账 | **updated**：[台账](../operations/engineering-failure-ledger.md)记录正确沉默夹带错误历史、原FAIL与本次解释能力取舍，整体缺陷不关闭。 |
| 核心需求覆盖基线 | **reviewed-unchanged**：[IRIS-CORE-005基线](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)仍部分实现；两例有限通过、恢复分支未触达及负控未跑不足以提升覆盖。 |
| README / AGENTS / current-handoff | **updated**：[交接](current-handoff.md)指向实际失败与当前候选；**reviewed-unchanged**：[README](../../README.md)未完整验收状态、[AGENTS](../../AGENTS.md)工作树、授权及闭环规则仍有效。 |

当前为本地候选，新窗口未启动；原失败和未解决问题保留。没有push、生产访问、
生产模型切换、部署或飞书外发；真实群验收未完成，生产SHA未核验。
