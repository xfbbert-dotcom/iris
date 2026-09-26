# Qwen3.8-Max固定review输入对照：第二例停止

日期：2026-09-26。实现树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，
分支 `codex/iris-daily-pilot-followup`。本次是私有合成诊断，**没有应用代码修改**：
被测应用仍为`04aa3a09f8548865b9178b001d575d7f800785b4`，运行时仓库HEAD为
`e4cf978b9eb7a30382c06dd16f76a617d16e2973`文档检查点。没有push、生产模型切换、
部署、主动发言启用或飞书外发。

## 授权、控制与原始结果

9月25日的[交接](current-handoff.md)记录了等待用户对现有测试key新增精确
`Qwen3.8-Max`合成测试权限。用户9月26日已明确允许该范围；操作者保存并重开核对
自定义选择只有`Qwen3.7-Plus`和`Qwen3.8-Max`两项，其他模型权限和IP设置不变，
描述同步标明free-only/no production。12:39 UTC精确`qwen3.8-max`免费quota行显示
1M/1M剩余、到期2026-12-18、用完即停已开启。该授权已用于本次私有诊断；
测试后刷新同一精确行显示992.88K/1M剩余、到期和用完即停状态不变，
与报告7125 usage tokens在页面取整精度下近似相符，**不是账单审计**。
编辑页已取消退出并关闭临时标签；本轮外部变更仅此现有测试key的两项自定义选择和
free-only/no-production描述，无业务产品代码更改。
后续同一现有key、同一已准许的合成范围不需要再次请求**同一权限**，但不授权扩大
权限、付费回退、生产配置或真实群调用。

本次只对五个固定归档的首次review输入作模型对照，实际产品
`originalMessages`与严格responseFormat、JSON-object传输、non-thinking、
max_tokens2048、timeout60s及既有本地`validatePdScopeReview`不变；唯一预定
变化为模型`qwen3.7-plus → qwen3.8-max`。没有生成、修正、完整15×2或生产模型
切换。私有harness和launcher经主代理全文审读及独立范围核对后，唯一窗口于
12:40:39.794–12:40:58.452 UTC结束：

- `old-negative-arithmetic`：首例HTTP200，raw/model及本地`supported=false`；
  但review的reasoning仍把候选里的`16−10=−6`描述为正确的`16−10=6`，
  否定原因落在uncertainty等后果限定。**布尔否定正确不等于识别了负号算术错误**。
- `qualified-risk`：第二例HTTP200，模型六字段与整体true，本地也true，
  仍误通过无概率依据的过度确定履约后果；触发`executionPassed=false`和停止标记。
- `paraphrase`、`arithmetic`、`material-update`三项未调用，不能说五例均失败、
  所有候选能力无效或完成了模型对比验收。

总计**2次HTTP200、7125 reported usage tokens**；原报告SHA256
`7a6e3d31d90288d8d60b60a0f36be272d1544ec3d4d61d40f4a8a56145213f0a`
和失败停止标记保留。运行器`independentSemanticReview=pending`原样不回写；
独立复核已重算两次请求哈希、逐项比较固定基线、复用本地校验器，确认只变更
model，且两个provider响应的model均为`qwen3.8-max`。逐例结论是首例虽因
uncertainty拒绝但漏算术符号，第二例仍误批准；没有五例通过或修复成功的结论。
原报告不保存provider reasoning
正文，只保留相应元数据（本次两次响应均无该字段）；raw provider响应未存，因此其
SHA/字节数是保留的线索，不能从脱敏报告重新计算。
[归档清单](evidence/iris-bailian-20260926-qwen38-fixed-review-manifest.json)、
[报告](evidence/iris-bailian-20260926-qwen38-fixed-review-report.json)、
[起始标记](evidence/iris-bailian-20260926-qwen38-fixed-review-started.json)、
[停止标记](evidence/iris-bailian-20260926-qwen38-fixed-review-halt.json)、
[harness](evidence/iris-bailian-20260926-qwen38-fixed-review-harness.txt)及
[launcher](evidence/iris-bailian-20260926-qwen38-fixed-review-launcher.txt)已脱敏保存。
主代理全文阅读离线归档脚本后执行并回读，核对原报告、两个冻结基线、实际wire
仅model变化、应用来源及harness/launcher哈希；私有原件未改，未读取密钥，未新增调用。

本次有限换模型对照在第二例已未通过，不能进入完整集，也不能以同配置密集采样、
继续堆prompt或盲换模型来称已修好。下一步需要有边界的能力候选或重新审议审核
架构，不能因候选失败降低既有事实正确性及安全验收标准。
无需等到明天或等待免费额度耗尽；无新授权不得切换生产或调用真实群。
原`dcaa2995`完整集22/30、`04aa3a09`七例4/3及两个9月25日负向probe的
结论和原件均不变。

## 四处文档处置

| 核对项 | disposition与理由 |
|---|---|
| 白皮书 | **reviewed-unchanged**：[主动发言与权限规则](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)已要求来源可核对、避免过度确定及发布前验证；本次仅是未通过的私有模型对照，不改变产品规则。 |
| 工程故障台账 | **reviewed-unchanged**：[主动讨论故障条目](../operations/engineering-failure-ledger.md#proactive-collaboration-is-not-a-deadline-reminder)仍有效，已记录过度确定review漏检及9月25日负向probe；本次同故障在另一模型第二例重现，详细原件留在本记录，不机械复制事件。 |
| 核心需求覆盖基线 | **reviewed-unchanged**：[IRIS-CORE-005状态](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md#2026-09-25-本轮评估身份与真实历史分离)仍为部分实现、完整语义/真实群/部署未验收；两次HTTP与失败停止不改变覆盖状态。 |
| README / AGENTS / 当前交接 | **updated**：[README](../../README.md#current-product-state)与[当前接手入口](current-handoff.md#当前正在推进)说明9月26日授权、第二例失败和后续边界。**reviewed-unchanged**：[AGENTS](../../AGENTS.md)的工作树定位、授权与四处闭环规则仍适用。 |

文档记录、测试key的合成权限和HTTP200都不是应用精确SHA CI或真实单群验收。
