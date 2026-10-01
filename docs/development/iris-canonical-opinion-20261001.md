# 单份意见与程序投影候选

日期2026-10-01，仓库基线178cd7b8；前一个[反例候选](iris-counterexample-review-20261001.md)
已失败并保持关闭。本轮不重跑该配置，不增加审核器或提示词变体。

## 原因与设计边界

已确认的结构事实：生成器独立写观察、理由、建议、描述、变化说明和文案；实际失败
中draft说可能，reasoning说必然，错误内部正文随后被审核批准。不能从该证据断言
重复生成是模型误判的唯一原因。新的假设是减少独立扩写能减少端到端错误产生。

本地选项canonicalOpinion默认false，并与counterexampleReview互斥；runtime和正式
eval均未启用。模型生成一份opinion：3–8个有role的自然语言片段与uncertainty。
片段原顺序连接成draft；按observation/reasoning/suggestion提取存储正文，新问题
description取observation，materialChange.explanation取reasoning。不新增独立解释。
三种用途必须齐备，总文字≤1200；顺序可变、用途可重复，不强制三段话或固定句式。
已有身份、来源、变化kind仍由程序持有。new_evidence解释增量，unattempted_first
解释原依据为何仍值得首次发言，不要求虚构变化。

生成→原范围初审→最多一次完整opinion修正→原范围终审；数字连续性、算术核算、
历史去重、权限和上下文取消保持。修改两份独立正文的updates合同仅在本候选被
替换；旧默认路径不变。片段角色不是事实/推断真实性证明，最终全部正文仍须正确。
普通问答不改，不改成固定提醒，不仅凭拒绝所有候选获得验收。

## 冻结验收与退出

先本地测试单一正文投影、非法独立字段、唯一修正、最终拒绝、取消、数字历史。
代码独立复核后提交候选，再执行一次全新合成链路，不注入旧评估/生成/审核答案：

1. qualified-risk：未联调≠必然延期，无伪数量/工作量，具体验证或限定承诺建议。
2. inference：5人喜欢≠全量付费，建议验证付费意愿，不能用批准代替证据。
3. arithmetic：16万总额/6万缺口，方向正确，无虚构制度或已执行动作。
4. material-update：24万总额/增加8万/缺口14万，实际历史与新报价分清。
5. paraphrase：同一已提醒事实换说法保持沉默。
6. handled：人已指出并处理同一缺口保持沉默。

逐例外部语义判断后才进入下一例；首个执行或语义失败停止。所有场景都正确才算
本窗口通过，不改变历史失败标准。最多24HTTP/100000 reported tokens（下次发起
前停）/30分钟，单次60秒，无自动重试/重采/同类变体。精确qwen3.8-max，non-thinking，
max_tokens2048；逐请求UI免费额度≥150K、到期在未来、用完即停开启，观察≤60秒并
绑定请求哈希。仅授权合成数据，不访问生产或发送飞书。

## 本地证据与四处核对

新测试在旧代码5失败/4通过，实现后相关26通过。Core4872通过/469条件跳过；
类型检查、构建、CLI7通过。独立复核指出unattempted_first不应要求新变化，已改；
再补数字历史及候选互斥后定向11通过，完整Core未重复计算新增2项。
真实模型尚未运行，产品缺陷未关闭。

| 核对项 | disposition与理由 |
|---|---|
| 白皮书 | **reviewed-unchanged**：[主动行为边界](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)及既有独立评估/受控生成/审核不变，候选默认关闭；若实模通过并接入默认，必须同步稳定契约。 |
| 工程故障台账 | **updated**：[主动讨论条目](../operations/engineering-failure-ledger.md#proactive-collaboration-is-not-a-deadline-reminder)记录独立扩写与投影的区别，不把投影当语义证明。 |
| 核心需求覆盖基线 | **updated**：[本轮候选](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md#2026-10-01-canonical-opinion-candidate)保持IRIS-CORE-005部分实现，不提升为实模/真实飞书通过。 |
| README / AGENTS / current-handoff | **updated**：[README](../../README.md#current-product-state)及[交接](current-handoff.md#当前正在推进)记录候选与验收状态；**reviewed-unchanged**：[AGENTS](../../AGENTS.md)定位、授权和四处闭环规则仍有效。 |
