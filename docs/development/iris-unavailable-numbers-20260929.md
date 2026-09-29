# 主动讨论：不可核算数值与草稿遗漏分开

2026-09-29。应用`88f7a169`，起点`7d822a46`（此前应用`1f00cc0e`），
工作树`D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支
`codex/iris-daily-pilot-followup`。无push、生产访问、部署、能力启用或飞书外发。

## 故障及有界修复

[9月27日失败原件](evidence/iris-advice-ablation-20260927.json)显示：来源只有5人
表示喜欢及全量用户会付费的结论，没有用户总数、单价、转化率。生成意见已建议
验证转化依据；初审仍把总额/差额/增量列成0、不适用。字面检查拒绝后，唯一修正
向稿件加入“不适用”，终审继续要求0元，最终render=null。

确认的结构缺口：requiredNumbers只有带十进制结果的分支，无法在项目内保留
“缺少计算输入”及原因；初审项目又流入修正及终审连续性。原协议已允许[]及有据
撤回，所以不能说schema强制模型编0，或本次状态表达必然能修复模型判断；此前
为何没有选择[]/撤回，模型能力与提示影响仍未因果分离。

本次采用原流程内的两个互斥分支，不增加模型调用或改动问题身份、来源及发送边界：

- 可计算项目保持原label、十进制expectedValue、unit、draftQuote；草稿遗漏/引文
  不符仍拒绝。真正的0也是实际数值，仍要求完整数字及单位凭据。
- 来源输入缺失时，expectedValue/unit/draftQuote必须全部null，并给出有界、非空
  missingInputs；不允许null混0、单位“不适用”或伪引文。该状态不产生补数字或
  数字连续性义务，修正不应为它改稿。
- 先前已知数字不能静默换成null；仍须原值原单位或原有带来源原句的显式修订。
  未知项不过滤重排历史数组，因此revision索引保持原语义。
- 算术矛盾、字段否定、整体否定和建议引文检查仍独立执行。trace保留null与
  missingInputs并复用实际验证器，不将运行失败记成评估通过。

实现：[review-receipts.ts](../../apps/core/src/proactive-discussion/review-receipts.ts)、
[model.ts](../../apps/core/src/proactive-discussion/model.ts)、
[评估脚本](../../scripts/pilot/proactive-discussion-eval.ts)。**missingInputs是否属实仍由
模型判断**；本地结构通过不证明适用性、事实或推断正确。原先可用[]漏列，本次也
不能声称杜绝把已知数字误标未知；必须保留已知预算及成本更新的实模正对照。

## 本地验证

新增首批10项回归在旧代码5失败；实现后通过。后补混合历史索引与未知状态不得
覆盖算术/语义拒绝，加trace回归，共新增13项。归档inference原稿以模拟的未知
审核回放真实render，可原样返回且不调用修正；这是接线证明，不是实模证明。

全量首轮因三项旧测试按单分支schema读取而失败，保留引文约束迁移到可计算分支
后再次运行：**263文件4824项通过，13文件469项条件跳过**；最终typecheck、build
及CLI7通过。未运行真实PG/Redis或CI，不挪用历史实模结果。独立代码审查无阻塞，
另跑92项通过；指出模型可计算性分类仍不可靠的风险，已保留为实模门禁。

## 实模计划及当前阻塞

已有私有运行器`unavailable-numbers-20260929.mts`和受保护启动器完成零网络preflight：
旧pair来源绑定有效，未知状态契约有效。预定冻结旧生成pair进入真实审核/原唯一
修正/终审，再跑原目录inference、arithmetic、material-update、qualified-risk、
paraphrase各一轮。原验收不变：未知数不编0，已知16万/6万和更新24万/+8万仍完整，
风险限定、建议有效、重复跳过。每例独立语义判定后继续，首败停，不重采或加变体。

仅既有合成key及精确qwen3.8-max，non-thinking/max_tokens2048；每请求60秒、
窗口20分钟、最多27次HTTP、80000 reported tokens发起下次前停止。每次实际HTTP
前核对实时免费quota≥100K、12月18日到期及用完即停，凭据绑定wire hash且60秒内。
无重试或付费回退；授权没有扩展。

**本轮实际0模型请求，0模型tokens。** 免费额度页当前显示未登录；已打开登录窗口
并请用户恢复登录。不能拿9月27日的历史读数代替实时核验，所以受限窗口尚未启动，
没有started/halted运行记录，不能把preflight称为实模通过。不需要重新批准同一key
或重建密钥；缺少的是可读取实时额度的登录会话。登录恢复后先核验再启动上述窗口。

**验收层级：代码已改／本地检查通过；实模尚未验证；真实飞书未验收／未部署。**
原审批代替事实、风险确定性和重复缺陷保留；本次不关闭整个主动能力问题。

## 四处文档处置

| 核对项 | disposition与理由 |
|---|---|
| 白皮书 | **updated**：[第6节](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)区分缺少输入与草稿缺少已知值；未知状态不是事实验证，修订及一次修正边界不变。 |
| 工程故障台账 | **updated**：[主动讨论条目](../operations/engineering-failure-ledger.md#proactive-collaboration-is-not-a-deadline-reminder)记录互斥状态、真实0/已知值正对照及未完成实模门禁。 |
| 核心需求覆盖基线 | **updated**：[本轮补记](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md#2026-09-29-不可核算数字状态)记4824/469、本轮零模型请求、登录与实时quota阻塞；IRIS-CORE-005仍部分实现。 |
| README / AGENTS / 当前交接 | **updated**：[README](../../README.md#current-product-state)与[交接](current-handoff.md#当前正在推进)指向88f7a169及当前缺少条件；**reviewed-unchanged**：[AGENTS](../../AGENTS.md)现有定位、授权及四处闭环要求继续适用。 |

文档闭环不等于语义缺陷关闭，应用提交不等于部署。
