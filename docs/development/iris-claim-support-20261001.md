# 保守的原句支持门禁：待完整迁移验收

2026-10-01，应用基线7ad82a87。此前[三分类对照](iris-minimal-claim-20261001.md)
Qwen3.7第一例正确拒绝必要后果，第二例却将依据不足误判事实否定，2HTTP200/
661tokens后失败，c未调用；该原判定不变，未修好三分类能力。

## 改变程序消费职责，不提升旧判定

新增本地helper claim-support.ts，不接入runtime或model。沿用完全相同的source-only
模型任务，但程序只接受supported作为额外必要许可；insufficient/contradicted均
仅返回未获支持的字段名，不向修正器返回原理由、事实否定或相反结论。若以后接入，
程序诊断只能说尚未获支持、须独立核对来源，不能强迫反向改写真实内容。

机械遍历完整observation/reasoning/suggestion，每次仅原始来源文本和该完整字段；
不手选已知错句，不拆散条件、限定或引号。后续只允许canonical一致正文使用此
门禁，以覆盖描述/变化说明/draft；其他合同不能擅自接入。算术、身份、原审核及
唯一修正/终审都须保留，门禁不能覆盖既有否定，绝不能靠全拒获得验收。

## 冻结迁移与退出

精确qwen3.7-plus，先调用此前未调用的c（尚未联调，交付可能受结果影响），必须
supported；再将assessment-opinion-continuation原坏风险完整三字段全部独立核对，
必须仅reasoning未获支持且理由实际指出条件后的必然后果（不能仅因首次介入文字
拒绝）；再source-focus原健康风险完整三字段，必须全获支持，包括合理建议。
不存在人工正确选项同屏，也不改变原三分类预期。实际支持检查不接受替原句重写。

最多7HTTP/20000reportedtokens下次调用前停/15分钟/单次60秒，首执行或独立语义
失败停该候选，不重采。每HTTP精确型号免费>=150K/有效期未来/用完即停/观察60秒
以内与wire绑定，绝无付费回退。通过后还需产品初审/一次修正/终审及新鲜六例，
当前不是已修复或已接入。此probe本身没有新鲜生成，明确是冻结完整候选迁移。

## 本地证据和四处闭环

新测试先因helper缺失RED；4项GREEN（完整字段、保守拒绝且诊断不泄漏、非法返回、
取消边界），typecheck/build通过。未声称这证明语义能力，也未重跑全Core。

| 位置 | 处置 |
| --- | --- |
| 白皮书 | **reviewed-unchanged**：[架构](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md)要求事实推断、价值与最终审核，本地可选helper未改稳定架构。 |
| 工程故障台账 | **updated**：[台账](../operations/engineering-failure-ledger.md)将拒绝许可与声称已否定分开，保留原三分类FAIL。 |
| 覆盖基线 | **reviewed-unchanged**：[基线](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)整体仍未通过，helper尚未接入，无覆盖提升。 |
| README / AGENTS / handoff | **updated**：[交接](current-handoff.md)指向当前候选；**reviewed-unchanged**：[README](../../README.md)部分实现/未实群验收仍有效，[AGENTS](../../AGENTS.md)授权定位和闭环规则不变。 |

未部署、未生产访问、未push、未改变生产模型、未飞书外发。
