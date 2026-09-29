# 初次生成残缺发言稿的有界恢复

2026-09-29，起点 `6bbd3cd4`，原应用 `88f7a169`。当前工作树及分支见
[交接](current-handoff.md)。本记录不关闭整体主动讨论缺陷，不代表部署。

## 证据与边界

[此前窗口](iris-unavailable-numbers-20260929.md)在算术生成阶段失败：完整评估已包含
16万元需求、6万元差额及建议，draft 却仅有半句 text、没有 evidenceRefs。
原始服务响应与客户端 content 一致，finish_reason=stop、619输出 tokens；生成
不完整的供应方原因仍未知。确认的应用恢复缺口是初次 pair 校验失败直接退出。

本修复只处理严格的 `{assessment, draft:{text}}` 初次输出。评估必须通过既有
结构、身份及引用锁校验；程序使用本次新评估的 observation、reasoning、suggestion
组成新候选，引用由已锁定来源派生，不把残缺原稿补成模型成功输出。保留原始
候选及 `draftOrigin=assessment_projection` 诊断标记。错误/重复引用、额外字段、
缺失评估、空稿、过长新稿及正文泄漏内部引用均拒绝；不截断、不重采、不用旧初判
正文。新候选仍进入原初审、至多一次语义修正及终审；修正阶段不使用该恢复。

这是可用性修复，不是事实核验替代。评估内容可能不自然、重复或错误，必须通过
原有语义标准，不能以结构完整宣告成功。

## 验证与退出条件

归档失败对象回归在旧代码中2项失败，修复后12项通过；增加 trace 原始内容及
恢复来源回归。Core **4837通过 / 469条件跳过**，typecheck/build、CLI7通过。
没有真实PG/Redis或CI结果。独立代码审查及实模结论待补，不引用旧窗口为新通过。

有限实模窗口：冻结上述失败生成对象，通过真实 render 审核链验证恢复，再运行
material-update、qualified-risk、paraphrase 各一轮。最多18次HTTP、60000 reported
tokens、20分钟、单请求60秒；首次执行或独立语义失败停止，不重采。原语义标准
保持：预算16万/差额6万；更新24万/+8万；风险不得无据确定；重复应跳过。
仅既有合成授权及精确 qwen3.8-max 免费模式，每请求前核对实时额度≥100K、
用完即停及期限，绑定请求 hash；无付费回退。冻结例不算新鲜生成证明。

## 四处文档处置

| 核对项 | 处置 |
|---|---|
| 白皮书 | **reviewed-unchanged**：[第6节](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)原来源约束、语义审核及一次修正边界继续适用；恢复只产生待审核候选，无新权限或自动批准。 |
| 工程故障台账 | **reviewed-unchanged**：[台账](../operations/engineering-failure-ledger.md#proactive-collaboration-is-not-a-deadline-reminder)已记完整对象与语义通过不同、合法JSON不等于完整输出；本次不改变其规则，具体恢复和证据在本记录。 |
| 核心需求覆盖基线 | **reviewed-unchanged**：[基线](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md#2026-09-29-不可核算数字状态)整体仍部分实现，既有窗口失败和未完成正对照仍有效；尚无新实模覆盖可以升级。 |
| README / AGENTS / current-handoff | **updated**：[交接](current-handoff.md#当前正在推进)加入本次实现及有限门禁；**reviewed-unchanged**：[README](../../README.md#current-product-state)、[AGENTS](../../AGENTS.md)仍通过交接定位最新事实，授权、未部署及四处核对规则不变。 |

无push、生产访问、部署、能力启用或飞书外发。
