# 主动讨论：程序持有不可变身份和引用

2026-09-29。起点`0b852b10`，此前应用`8b39e8db`。工作树/分支见
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
额度每请求前新鲜核对≥100K及用完即停，无付费回退。当前没有实模通过声明。

## 四处文档处置

| 核对项 | 处置 |
|---|---|
| 白皮书 | **updated**：[第6节](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)说明不可变结构由程序持有，正文仍须来源和语义审核。 |
| 工程故障台账 | **updated**：[台账](../operations/engineering-failure-ledger.md)增加模型复制已锁定身份/引用的职责教训及本记录链接。 |
| 核心需求覆盖基线 | **updated**：[基线](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)记录本轮契约变更，部分实现不升级为已验收。 |
| README / AGENTS / current-handoff | **updated**：[交接](current-handoff.md)定位本轮；**reviewed-unchanged**：[README](../../README.md#current-product-state)保留此前已提交事实并指向交接，[AGENTS](../../AGENTS.md)授权及闭环规则未改变。最终验收后同步README。 |

整体主动能力未关闭；没有真实飞书或部署结果。
