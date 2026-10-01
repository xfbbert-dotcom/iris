# 内部介入价值与群聊业务正文分离

日期：2026-10-01；基线6549a979；候选实现提交707eddc2。
这是本地显式候选修复，不是默认应用启用或语义缺陷关闭。

## 仓库事实与范围

[前次失败](iris-claim-support-20261001.md)的坏稿含“这是首次指出该实质缺口，具有介入价值”。
代码canonical-opinion.ts要求reasoning同时说明业务依据和why-now，又将同一文字复制到
materialChange.explanation并拼入draft。初判直接投影候选也复用该合同。这是已确认的
程序/职责混淆，不能据此推定所有必然后果错批均由它造成。

本次只修复一个明确边界：在显式separateInterventionValue模式中，模型返回独立必填
changeExplanation；segments只产生业务观察、论证和建议，内部说明由程序独立保存，
不会被程序自动拼进draft。内部说明仍接受原materialChange完整审核和确定性算术检查。
生成同时获得只用于当前处理状态/新增价值的discussion与evaluationContext；事实引用仍
限于已选择evidence，不传本轮旧评估正文作为历史或事实，不回填缺失说明。

新模式要求sourceBoundIdentity和canonicalOpinion，排除assessmentOpinion；默认关闭。
旧canonical合同与系统文本保留，用于既有候选和原响应回放，不用新字段伪造旧实模响应。
唯一修正必须输出完整新合同，终审保持原规则，不把独立字段当免审区。

## 执行与退出

- 新helper测试先4失败/1通过，再5通过；model集成先4失败，再5通过。
- 定向22通过，随后补充独立说明中的明确负算术拒绝，集成5通过。
- Core4925通过/469条件跳过，275文件通过/13跳过；历史固定响应回放仍通过。
- 类型检查发现测试Ajv默认导入不兼容，已改为仓库已有named导入；最终类型检查、构建与CLI7通过，独立代码审查无阻断项。
- 未接入runtime默认，未push、生产访问/部署、模型切换或飞书外发，生产SHA未重新核验。

窄修退出：本地测试/类型/构建和独立审查通过即记录为代码边界修复。不能据此宣称模型
不再自行重复内部话术，也不能冲销已知必然后果或供应商前提错批。旧审核合同未变，
不原样重采旧坏稿。不立即把六例偶然通过当审核修复。

继续工作的有界步骤是验证自然语言到含义结构的忠实性：输入只有完整原句，无来源或
人工正确选项，避免审核时先替候选合理化；把断言强度、条件、行动建议和实体前提分开。
最多三个冻结原句、每例一次、首次语义/执行错误停转换候选，不修改预期或追加同类prompt。
三例通过仅允许下一完整候选迁移，不能接入应用。既有明确算式核算保持独立。

## 四处闭环

| 位置 | 处置与理由 |
| --- | --- |
| 白皮书 | **reviewed-unchanged**：[白皮书§6](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)与[主动讨论设计](../superpowers/specs/2026-09-09-iris-proactive-discussion-design.md)区分结构化介入判断和自然意见，本候选恢复该边界，未改变稳定产品策略。 |
| 故障台账 | **updated**：[台账](../operations/engineering-failure-ledger.md)记录内部介入说明不可强制成为用户业务论证，所有存续文字仍须审核。 |
| 覆盖基线 | **reviewed-unchanged**：[IRIS-CORE-005](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)仍部分实现，完整实模语义和真实飞书未通过，无覆盖提升。 |
| README / AGENTS / handoff | **updated**：[当前交接](current-handoff.md)指向明确当前修复；**reviewed-unchanged**：[README](../../README.md)未完整交付表述仍有效，[AGENTS](../../AGENTS.md)定位、授权和闭环规则不变。 |
