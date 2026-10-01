# 原文定位新问题的可执行边界

2026-10-01，基线4e0c10c1。用户要求单个候选失败后继续处理整体缺陷，不把每轮
实验停止当作工作终点。[此前canonical候选](iris-canonical-opinion-20261001.md)仍失败。

## 观察、改动与冻结窗口

此前“严重样本偏差”先出现在assess的新问题description，再进入生成和审核。
projectIdentityTarget保留该自由文本，身份仅供定位的提示没有阻止结论传递。
传播路径已确认，但尚未证明因果。此次改变可执行数据合同，不追加反例审核：
sourceBoundIdentity默认false，仅配合canonicalOpinion；assess的新description
只能选schema中的来源句子，程序要求它确实属于已选择evidence。下游只接收
sourceFocus{sourceRef,sourceQuote}作为新问题定位，不传初判描述或分析正文。
引文不等于事实认可；scope仍检查是否同一主题、候选是否受支持。既有ID、真实
历史、权限、数字历史、初终审及唯一修正不变。原文句长上限2000，不能绑定时
不回退到自由诊断。默认runtime和正式eval未启用。

7项新增回归，旧代码4失败/1通过；新增修正/拒绝回退后定向7通过。主动讨论
356通过/121条件跳过，typecheck及build通过；未将此前全Core结果搬到本提交。
独立复核通过，主题/推断正确性仍由语义验收决定。

一次冻结窗口：全新inference→qualified-risk→arithmetic→material-update→
paraphrase→handled。沿用上一轮六例语义标准：未知代表性不能写成已证实严重
偏差；未验证接口不能保证失败；16/6及24/+8/14完整；已提醒或人已处理时沉默。
没有旧assessment/generation/review注入。最多24HTTP/100000reported tokens下次
发起前停/30分钟/单次60秒；逐例独立语义gate，首失败停止该候选，不重采同配置。
精确qwen3.8-max non-thinking/max_tokens2048，逐HTTP UI核对免费额度≥150K、
到期未过、用完即停开启、观察≤60秒并绑定请求hash；无付费回退。

## 实际窗口与中文人数回放修复

应用dab6135c实际11HTTP200/36632tokens：inference、qualified-risk独立语义通过；
arithmetic在唯一修正后终审true，完整候选独立语义也通过，但本地数字凭据拒绝
“招聘两人”对应2人，返回null。原窗口executionPassed=false，首败停止；后三例
material-update/paraphrase/handled未调用。原失败不改判，不重新抽样预算例。
[33份证据与哈希](evidence/iris-source-focus-20261001-manifest.json)、
[原始请求响应](evidence/iris-source-focus-20261001.json)、
[独立审查](evidence/iris-source-focus-20261001.independent-review.json)。

确认程序根因是numberQuoteMatches只扫描阿拉伯数字，误拒常见中文人数。
此次修复只映射零至十的单个计数词（含两），仍要求原文引用、完整词元、相同单位；
带符号、更大数词、小数、分数和近似数保守拒绝，不声称通用中文数值解析。
最初正例旧实现5失败；独立审查发现混合小数/斜杠分数/全角正号边界，补3例RED后
修复。当前凭据53项通过；原5响应零HTTP完整回放通过，最终assessment/draft与
原终审输入逐字相同，没有修改原响应或语义预期。回放不是新增真实模型通过。
结束精确型号页面784.08K/1M、2026-12-18到期、用完即停开启；页面非账单审计。

## 下一有界续测

修复及回放通过后，仅对原窗口尚未调用的material-update→paraphrase→handled
从assess开始新鲜测试；不注入原响应，不重采已失败预算例。相同精确模型与免费
控制，每请求前独立刷新额度；最多12HTTP/60000tokens下次发起前停/20分钟。
语义标准不变：新成本24万、相对旧16万增加8万、对10万预算缺口14万完整；已提醒
改写及成员已处理应skip。任一执行/语义失败停止续测，保留证据后继续解决具体缺陷。
候选仍默认off，runtime及正式eval尚未接入；未部署、未真实飞书验收，原bug开放。

## 白皮书11.2四处闭环

| 位置 | 处置 |
| --- | --- |
| 白皮书 | **reviewed-unchanged**：[架构](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md)主动价值、来源边界及发送前审核不变；可选候选尚未成为稳定架构。 |
| 工程故障台账 | **updated**：[台账](../operations/engineering-failure-ledger.md)区分真实语义错误与凭据误拒，记录固定响应回放规则。 |
| 核心需求覆盖基线 | **updated**：[基线](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)记录两例新鲜通过、预算原执行失败及修复回放，不宣称完整能力。 |
| README / AGENTS / current-handoff | **updated**：[交接](current-handoff.md)保留失败和续测指针；**reviewed-unchanged**：[README](../../README.md)产品仍部分覆盖、未实群验收，[AGENTS](../../AGENTS.md)定位授权及闭环规则仍有效。 |


中文人数修复本地验证：Core4901通过/469条件跳过；回放测试随后改用本地冻结context
避免跨rootDir导入，定向再次通过；typecheck/build/CLI7通过。独立复核54通过。
修复提交以本记录所在提交为准（下一续测记录记录完整SHA）。

续测实际3HTTP200/10272tokens，在成本更新例新增无来源供应商关系而语义失败。
数字24/+8/14正确，两个去重例未调用；16份证据已归档，原候选仍不接入默认。
后续移除第二次作者的[直接投影候选](iris-assessment-opinion-20261001.md)另行验收。
