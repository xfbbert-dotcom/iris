# 审核凭据职责消融：首例未通过，候选停止

日期：2026-09-29。应用保持 `a2b3c449`，本记录不是应用修复或部署。
前置事实：[定点修正窗口](iris-repair-updates-20260929.md)的新鲜风险候选同时含
无依据的0/100%及全部工作量、条件下必然无法履约；六字段初审全部批准，最后仅
因unit空发生结构拒绝。不能将此当语义识别成功。

## 有界问题与不采用的方案

只验证：移除数字和建议凭据的提取/填表职责、保持原候选全文与其余语义要求，
同一模型能否忠实识别两类错误？这是职责删除的诊断，不是添加正确答案或逐句
增强措辞；与[已淘汰的逐句迁移](iris-immutable-review-20260926.md)不同。

暂不建设来源绑定计算凭据系统：合法来源数字与运算仍不能证明业务对象、进度
口径和因果后果；模型也能漏报或把100%换成“全部”。只增加拒稿不会改善该例。
不扩大初审格式恢复、不放宽unit、不重试旧配置。

## 冻结变换与验收

- 使用归档 `iris-repair-updates-20260929.json` 中 qualified-risk 初审原输入。
  `user` 消息逐字不变，包含完整assessment、draft、evidence、identity及discussion。
- 系统仅删除以 `requiredNumbers 区分`、`数字凭据是字面出现证明` 开头的两段，
  以及 `adviceQuote` 原文引用指令一句。保留同段后半的必要数字/建议缺失判定、
  原算术有效性/完整性要求、风险限定、六字段和整体语义判断。schema仅去掉
  requiredNumbers、adviceQuote；保留其余结构、理由上限，不增加任何判题提示。
- 保存原system/schema、删除文本、实验system/schema、原user哈希和实际wire。
- 第一例必须具体否定无依据0、100%/全部工作量及条件下必然后果；仅整体false、
  uncertainty错误或挑出其他问题都不通过。不要求把“依据不足”说成已被事实否定。
- 第一例通过才运行 `iris-generated-recovery-20260929.json` 中 frozen-arithmetic
  原完整正例；认可有来源支持的16万元总额与6万元差额，不能靠全面拒绝算术通过。
- 最多2请求，首个执行或独立语义失败停止，无重试、无修正、无追加prompt变体。
  qwen3.8-max、non-thinking、max_tokens2048；每请求60秒，总窗口10分钟，发起下一
  请求前16000 reported tokens停止阈值。每次请求精确免费额度≥100K、未过期、
  用完即停开启且页面观察≤60秒；复用受保护合成key，无付费回退。

离线preflight已核对两份完整输入、删除范围、schema及历史返回在简化结构下的
解析。它是诊断脚本检查，不是产品测试。独立设计审查认可本探针的差异，但明确
提示长度、输出schema和职责同时改变，不能据单次表现证明历史故障的因果归属。

即使两例通过，也只允许继续设计职责拆分，不能直接移除产品数字保障。产品接入
还需要独立数字/引用/连续性检查的组合、新鲜风险、预算增量、未知金额、重复、
唯一修正边界的端到端验收。失败则淘汰这个直接拆分候选，保留原应用。

## 实际结果

冻结设计提交 `2cb65f21` 后，实际 **1次HTTP200 / 3240 reported tokens**。
模型明确拒绝把“尚未联调”变成0或100%的精确算术；reasoning=false、整体false。
但它没有指出“全部工作量缺口”这一非数字表述仍无依据，也没有指出“一旦……
将直接导致无法按期履约”的必然后果超出来源。uncertainty=true仅认可标签，
不能替代原句强度核验。合理建议没有被误拒。

主代理及独立审查均按事前双重目标判 **失败**，正向算术例未调用。运行器已经
停止，没有第二请求、重采、修正或额外变体。应用代码未变；此拆分候选不接入产品。
这次输出在数量识别上与历史原件不同，但不能据此声称凭据职责是根因，更不能
推断模型能力是唯一原因。完整上下文与判断对象没有变；提示长度和schema随职责
一并变化，因果归属仍未完成。

[原始请求与响应](evidence/iris-review-duty-ablation-20260929.json)、
[独立审查](evidence/iris-review-duty-ablation-20260929.independent-review.json)、
[执行审计](evidence/iris-review-duty-ablation-20260929.audit.json)、
[停止记录](evidence/iris-review-duty-ablation-20260929.halted.json)、
[12份文件哈希清单](evidence/iris-review-duty-ablation-20260929-manifest.json)。
审计核对原user逐字不变、system仅约定删除、schema仅去两字段、raw/client content
一致、请求/响应哈希、单请求用量及quota观察距请求9.053秒。开始及结束页面均为
852.89K/1M、2026-12-18到期、用完即停开启；页面可能滞后，不当作账单对账。

本轮仅有诊断脚本的语法、PowerShell AST、离线preflight和证据审计；没有应用
修改，因此没有重跑或重新宣称Core全量通过。a2b3c449的4853/469仍是前一轮本地
证据。**代码未改／本轮实模诊断失败／真实飞书未验收／未部署**。

## 四处文档处置与未解决条件

| 核对项 | disposition与理由 |
|---|---|
| 白皮书 | **reviewed-unchanged**：[第6节](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)要求全候选来源/推断复核，且明确结构合规不证明语义；失败探针没有改变产品契约。 |
| 工程故障台账 | **updated**：[主动讨论条目](../operations/engineering-failure-ledger.md#proactive-collaboration-is-not-a-deadline-reminder)补充职责消融的解释边界与失败出口，避免因数字识别改善而放过其他目标。 |
| 需求覆盖基线 | **reviewed-unchanged**：[IRIS-CORE-005当前实现](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md#2026-09-29-program-bound-proactive-prose)仍是部分实现；没有应用修复、端到端或真实群覆盖提升。 |
| README / AGENTS / current-handoff | **updated**：[README](../../README.md#current-product-state)与[交接](current-handoff.md#当前正在推进)指向此失败且保留应用a2b3c449；**reviewed-unchanged**：[AGENTS](../../AGENTS.md)定位、授权与闭环规则仍适用。 |

当前卡点具体是：同一完整风险候选被识别出数量问题后，仍没有形成针对其必然
后果的有效诊断。数字计算、字段恢复或减少凭据字段均未提供这一能力的验收证据。
缺少的是能够忠实核对这种自然语言断言、并在新鲜生成→修正→终审中保持效果的
已验证方案；不是缺用户许可、不是429、不是等免费额度。没有依据把本轮的职责
删除直接产品化。整体缺陷继续开放，不把归档完成写成修复完成。
