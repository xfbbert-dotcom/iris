# 判断正文直接形成待审意见

2026-10-01，基线861aa6f4；授权继续本地修复，不要求重新确认设计。

## 已知事实与选路

[source-focus续测](evidence/iris-source-focus-continuation-20261001.json)成本更新3HTTP200/
10272tokens：24/+8/14正确，第二次生成新增来源没有的供应商关系，审核批准。
原窗口语义失败，不改判；paraphrase/handled未调用。此前“来源定位”不能阻止
生成阶段引入新事实。不将此归因模型整体能力，也不重复同配置请求。

选择移除多余作者阶段：初次assessment已有观察、理由和建议，程序按此顺序直接
连接为待审意见，投影存储文本；不再单独调用generation。仍用sourceFocus绑定
新问题主题，既有身份/证据保持。发送前初审、最多一次canonical修正和终审不变。
这只保证不额外产生一份正文，不能保证初次判断正确；不削弱语义门槛。

新选项assessmentOpinion默认false，仅与canonicalOpinion/sourceBoundIdentity组合。
assess校验投影总长<=1200，格式错误最多原有2次尝试；skip不投影。render也校验，
直接调用render不能绕过。正文中的算术、数量凭据及真实历史仍走原完整审核。
不修改PdModel接口，不缓存跨调用候选，不更改主动发送开关或部署。

## 回归与有界验收

测试：第一次调用render必须是scope（没有generation）；投影与初判逐字一致；
skip无review；不受支持稿仅修一次且终审拒绝保持null；过长稿最多2次初判纠正；
身份、证据、历史仍可见且旧初判分析不作为外部证据；sourcefocus和旧路径回归。
随后新鲜material-update→arithmetic→qualified-risk→inference→paraphrase→handled，
六例标准沿用此前，不注入旧响应。最多24HTTP/100000reportedtokens/30分钟，
每HTTP精确qwen3.8-max免费额度≥150K、有效期未来、用完即停已开，观察<=60秒。
首执行或语义失败停此窗口；不重采，不修改原判定，不把格式拒绝当语义识别。
通过后才将同一实现接入runtime和正式eval，并验证trace；当前默认off。

## 执行计划

- [x] 加直接投影RED测试（4失败/1通过），实现有限选项，定向13 GREEN。
- [x] 独立代码复核无阻断；Core4906通过/469条件跳过，type/build/CLI7通过。
- [ ] 固定六例一次真实免费窗口；逐例独立语义判断。
- [ ] 仅通过时接入runtime及eval，回归并记录实际验收层级。

## 四处闭环（11.2）

| 位置 | 处置 |
| --- | --- |
| 白皮书 | **reviewed-unchanged**：[架构](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md)介入价值、事实推断边界和终审不变，可选候选未接入稳定路径。 |
| 工程故障台账 | **updated**：[台账](../operations/engineering-failure-ledger.md)新增建议预设也需核对来源，以及减少重复作者的候选边界。 |
| 核心需求覆盖基线 | **updated**：[基线](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)原候选失败，当前仅本地通过。 |
| README / AGENTS / current-handoff | **updated**：[交接](current-handoff.md)记录候选及失败证据；**reviewed-unchanged**：[README](../../README.md)原部分覆盖/未上线结论仍有效，[AGENTS](../../AGENTS.md)定位、授权及闭环规则有效。 |

此前续测在861aa6f4执行，[16份完整证据](evidence/iris-source-focus-continuation-20261001-manifest.json)
保持FAIL；本候选代码提交即本记录所在提交。没有push、生产访问或飞书外发。
materialChange.explanation投影为reasoning，新增价值需在实际reasoning中成立，
不能因字段一致视为语义通过。全部已有数值/建议核对仍执行。

## 1265af02实际窗口及逗号边界修复

4HTTP200/20416tokens，首例material-update初审拒uncertainty，修正后最终完整pair
独立语义PASS；程序仍返回null，原因是861aa6f4新增中文词元边界把正常“12万，两人”
中的逗号吞入词元/当成数值前缀。属程序误拒，原执行FAIL保留；其余5例未调用。
[17份证据](evidence/iris-assessment-opinion-20261001-manifest.json)、
[独立判定](evidence/iris-assessment-opinion-20261001.independent-review.json)。

修复将正常分句逗号与数值边界分开；混合小数、分数、符号负例仍拒。新增2正例
RED后凭据55通过，原4响应零HTTP完整回放通过且输出与原终审输入逐字相同。
不修改原窗口判定、不把回放当新实模通过。修复提交即本补充所在提交。

下一续测仅arithmetic→qualified-risk→inference→paraphrase→handled，精确模型、
24HTTP/100000tokens/30分钟及逐HTTP免费/逐case语义门槛不变，不重采成本更新。
四处处置沿用上表：台账/基线/交接同步误拒修复及剩余范围，白皮书/README/AGENTS
仍reviewed-unchanged，候选仍默认off、未部署未飞书验收。

逗号修复：独立复核55凭据+两次固定回放共57通过，typecheck/build通过；未将
1265af02的Core4906结果冒充本次新增3项后的完整Core统计。
