# 主动讨论：程序持有不可变身份和引用

2026-09-29。应用`3e7636b8244d4a6ff6732fb658052fdb81c53de6`，起点`0b852b10`，此前应用`8b39e8db`。工作树/分支见
[交接](current-handoff.md)。无push、生产访问、部署、飞书外发或能力启用。

## 问题与实现路径

[上一窗口](iris-generated-recovery-20260929.md)6HTTP/21799tokens：恢复与更新通过，
风险生成却在assessment引用中少抄一段hash，审核前被拒。该窗口仍失败。
确定的职责问题：初判已锁定的身份、引用，在后续生成及修正中仍让模型原样输出。
程序验证能拒绝错抄，却不需要让模型承担这项复制职责。

生成及唯一修正现在只请求严格`{prose:{issueDescription,observation,reasoning,
suggestion,uncertainty,changeExplanation,draftText}}`。程序从已验证初判绑定不可变
字段，覆盖全部可变正文，再校验完整pair并继续原语义审核。新问题描述可修正；
已有问题描述必须null，ID由程序持有。初判仍负责选问题与来源，不能自动把全部
材料当作证据。来源绑定不证明正文受来源支持，也不豁免身份/重复/事实/算术审核。

live只接受prose：旧完整pair即使合法也拒绝，prose内额外身份或引用同样拒绝，
不静默覆盖。独立审查曾发现双格式兼容缺口，已删除live兼容；旧完整pair校验及
8b39e8db残缺恢复仅保留为明确离线历史复现函数，未进入当前render路径。
trace分别保留原始prose和程序组合后的boundCandidate；记录不冒充模型生成引用。

实施顺序：新契约回归先失败→绑定实现→生成/修正接入→trace与历史测试迁移→
全量检查与独立复核→有限实模→证据及四处闭环。无额外模型调用或新重试。
旧语义测试通过仅测试使用的wire编码器迁移；错误身份/引用夹具不得被转换为
合法prose。直接入口测试独立确认旧格式及额外字段拒绝，不能用夹具编码器代替。

## 有限验收

本地全量 **Core4845通过 / 469条件跳过**；随后修正测试适配器的issueRef额外键
检查并新增负例，最终定向43项、typecheck/build通过；CLI7通过。新契约首批6项
在实现前2失败，修复后通过。独立复核确认live双格式阻塞已解除，另跑44项通过；
指出的测试适配器额外键遗漏已修复并回归。零HTTP preflight通过，不代替实模。
无真实PG/Redis或CI结果。实模使用新应用的完整流程依次执行原目录
qualified-risk、paraphrase、arithmetic、inference、material-update，各一轮。
风险必须限定后果、建议验证依赖；重复必须skip；已知16/6及24/+8完整，未知金额
不得编0；建议不能用审批替代证据。首次执行或独立语义失败停止，无同配置重采。
上限22HTTP、70000 reported tokens、20分钟、每请求60秒，精确qwen3.8-max免费
额度每请求前新鲜核对≥100K及用完即停，无付费回退。

## 实际窗口：审核识别错误，但唯一修正未能返回合格对象

**4次HTTP200 / 11706 reported tokens**，首例qualified-risk失败后停止；
paraphrase、arithmetic、inference、material-update均未调用。结束时间
2026-09-29T02:15:19.493Z。没有同配置重采或追加变体。

1. 初判有无依据的确定后果，但旧初判正文仍未流入生成。新prose生成进入真实
   审核，程序持有引用；生成reasoning却把业务状态写为“已验证接口0、必需至少1、
   缺口1”的确定算术，原文未提供可核算的接口数量。
2. 初审准确指出该错误，reasoning=false、整体false、requiredNumbers=[]。
   **这是识别了目标缺陷的拒绝**，不能记成标签失败或审核漏检。
3. 唯一修正删除了reasoning中的伪算术，却返回issueDescription=null；target为
   new，请求schema要求非空string。因此本地拒绝，render=null，没有终审。
4. 独立阅读还确认changeExplanation把“修改reasoning”当作业务实质变化，并
   声称draft同步删除数字，而前稿draft本就没有这段数字。即使只补描述，也不能
   把这个候选判为语义通过。缺少的是符合完整契约、准确描述业务问题/新依据的
   修正稿及真实终审，不是用户许可、额度或HTTP可达性。

独立审查核对上述事实；[执行审计](evidence/iris-bound-prose-20260929.audit.json)
逐一验证raw/client一致、wire/response hash和每次quota新鲜度。
[15份脱敏证据清单](evidence/iris-bound-prose-20260929-manifest.json)保存实际
请求、响应、运行器、启动器、停止及额度记录。结束页面878.8K/1M，用完即停开启，
2026-12-18到期；页面读数滞后，不作tokens账单对账。

**代码已改、本地通过；本窗口实模未通过；真实飞书未验收、未部署。**
取消不可变字段复制解决一个执行职责问题，不能推断解决模型语义能力。修正把
本轮编辑和真实业务变化混为一谈仍未解决；模型能力、提示复杂度与任务分工的
因果影响尚未分离。该窗口结束，不追加同类变体，也不把历史两例提升为本应用
的风险或重复验收。下一项应针对修正可变字段的业务语义职责设计，保留此次
“审核正确拒绝、修正失败”反例；尚未确定或验证新的修复方案。

## 四处文档处置

| 核对项 | 处置 |
|---|---|
| 白皮书 | **updated**：[第6节](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)说明不可变结构由程序持有，正文仍须来源和语义审核。 |
| 工程故障台账 | **updated**：[台账](../operations/engineering-failure-ledger.md)增加模型复制已锁定身份/引用的职责教训及本记录链接。 |
| 核心需求覆盖基线 | **updated**：[基线](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)记录本轮契约变更，部分实现不升级为已验收。 |
| README / AGENTS / current-handoff | **updated**：[交接](current-handoff.md)与[README](../../README.md#current-product-state)定位本应用及失败窗口；**reviewed-unchanged**：[AGENTS](../../AGENTS.md)授权及闭环规则未改变。 |

整体主动能力未关闭；没有真实飞书或部署结果。
