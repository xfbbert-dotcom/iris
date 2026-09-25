# 主动讨论：数字字面凭据澄清与六例诊断

日期：2026-09-25。实现树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支
`codex/iris-daily-pilot-followup`。本次应用提交
**`bdef93c045903146e009d624799264b4cae300a0`**；前一上下文修复为`a0a7f2a0`。
无push、部署、主动发言启用、飞书外发或真实群验收。

## 症状、有限改动与验证层级

前一[a0六例诊断](iris-review-context-20260925.md)中，`arithmetic`和`material-update`
虽有模型审核true仍因数字/单位的草稿字面凭据不符被拒；`material-update`中间稿也未明确
说出较16万增加8万，并出现无原文支持的审批/权限断言。本次仅澄清通用提示合同：金额比较
需把总额、基准差额、更新增量写明；审核数字`expectedValue`及`unit`必须对应草稿原样字词，
不能补不存在的单位、替换中文数量字词或用换算后的形式冒充原文；修正要解决本轮字面冲突。
未放松确定性门禁，未按单一题目硬编码答案，也未改变授权来源范围或调用轮数。

`bdef93c0`新增第六项提示合同回归，先RED后GREEN；聚焦5文件75项和另3文件41项通过。
修复后、提交前针对同一代码运行完整Core：261文件/4780项通过，13文件/469项条件跳过，
耗时38.72秒、exit0（20:58:17本地）；类型检查和build均exit0。未重跑CLI，也不继承
`a0a7f2a0`的门禁。六个原始场景各一轮的受限实模诊断在
13:00:44.812–13:03:26.166 UTC结束：16次HTTP200、55390 reported usage tokens，无自动重放。
原报告`executionPassed=false`并有停止标记：`inference`为`draft_rejected`，其余五例
执行成功。独立语义逐例判定则是**4通过、2失败**：`arithmetic`、`material-update`、
`paraphrase`、`handled`通过；`inference`误拒、未形成完整草稿；`qualified-risk`虽然
执行成功，最终assessment把条件风险写成过度确定的“将导致无法兑现”，审核全true却漏检。
`inference`的两次review把本轮`originalAssessment`误当历史已处理意见，是已观察到的
失败路径；尚未把它概括成全部失效原因。原报告中的`independentSemanticReview=pending`
是运行器字段，独立判定只记录于此，不回写原件。[脱敏归档清单](evidence/iris-bailian-20260925-literal-receipt-diagnostic-manifest.json)、
[报告](evidence/iris-bailian-20260925-literal-receipt-diagnostic-report.json)、
[起始标记](evidence/iris-bailian-20260925-literal-receipt-diagnostic-started.json)、
[停止标记](evidence/iris-bailian-20260925-literal-receipt-diagnostic-halt.json)、
[harness](evidence/iris-bailian-20260925-literal-receipt-diagnostic-harness.txt)和
[launcher](evidence/iris-bailian-20260925-literal-receipt-diagnostic-launcher.txt)已归档；
清单绑定原报告SHA、16次请求/响应哈希及40002原响应字节，并精确脱敏私有workspace和本地用户名。
私有原件不改，未读取凭据/DPAPI。旧`dcaa2995`完整15×2的22/30结果与`a0a7f2a0`
六例4/2结果均保持原样。

下一步须针对本轮assessment与历史已处理状态的时间角色区分，以及条件后果确定性，
另作有限修复和回归；本次4/6不是完整语义验收。精确SHA CI及真实单群投递/停止/恢复
仍未验收。

## 四处文档处置

| 核对项 | disposition与理由 |
|---|---|
| 白皮书 | **reviewed-unchanged**：[第6节](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)已有来源字面凭据、适度条件后果及已处理事项门禁；本次提示澄清未证明新产品行为，待后续修复/验收后再决定是否修订。 |
| 工程故障台账 | **updated**：[主动讨论条目](../operations/engineering-failure-ledger.md#proactive-collaboration-is-not-a-deadline-reminder)保留字面凭据与时间角色/条件后果漏检的分层失败。 |
| 核心需求覆盖基线 | **updated**：[IRIS-CORE-005补记](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md#2026-09-25-数字字面凭据澄清)记录六例执行和独立语义的不同结果、未验收状态。 |
| README / AGENTS / 当前交接 | **updated**：[README](../../README.md#current-product-state)及[当前接手入口](current-handoff.md#当前正在推进)指向本次提交和未关闭项。**reviewed-unchanged**：[AGENTS](../../AGENTS.md)的工作树、授权与闭环规则仍适用。 |

本记录是本地故障调查和有限诊断，不是部署申请、群验收或自动CI通过凭证。
