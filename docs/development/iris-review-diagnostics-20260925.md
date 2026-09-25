# 主动讨论：复核诊断汇总与唯一修正输入

日期：2026-09-25。实现树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支
`codex/iris-daily-pilot-followup`。本次诊断修复应用提交
**`45fe89683c7272cce3394da5bdd9a5df20ade75f`**；
先前完整实模运行绑定的应用仍是 `dcaa29956956172566f155f4cf1cb1f21fbebc6e`。
本记录不是部署或真实群验收；没有 push、部署、启用主动发言或飞书外发。

## 症状、归因与有限修复

[9月25日原15例×2轮完整报告](evidence/iris-bailian-20260925-source-first-full-report.json)中，
`material-update`第二轮初审已因 uncertainty 返回 `supported=false`，同时
`requiredNumbers[2]`要求招聘人数 `2 人`，却以草稿中的“人数还是 2 个”作为凭据。
原 `validatePdScopeReview` 在 `supported=false` 时提前返回，没有汇报这项字面单位不符；
唯一一次 pair repair 只改了 uncertainty，最终仍因同一数字凭据错误被拒，未得到最终组合。
这是已确认的本地诊断汇总缺口；模型为何给出该凭据或是否能按完整反馈修好，尚无新实模证明。

本次修复让本地校验在模型已有否定结论时仍收集六字段、当前草稿的数字与建议引文、
以及最终审核的既有数字连续性错误。反馈列出失败数字的索引、标签、期望值和单位，
保留模型否定结论与各字段判定；原否定理由在合并后超限时明确标记截断，
使最终理由仍满足现有2000字符合同。
模型的 `false` 不被提升为 `true`；仍只允许原有一次组合修正和一次最终复核，
最终草稿仍须满足当前引文和连续性门禁。该修复提高了修正输入的可见性，
不证明模型能发现全部必要数字、修正语义、避免重复介入或通过完整15×2集。

## 验证层级与保留失败

- 针对此缺口的4项测试先 RED 后 GREEN；覆盖归档报文的同时失败、字段与凭据合并、
  有界理由，以及唯一修正收到完整诊断且最终凭据门禁仍生效。
- 相关5文件共90项本地测试通过。诊断修复完成后、下一项上下文修复开始前，完整 Core
  260文件/4774项通过，13文件/469项条件跳过，exit0，耗时35.91秒（20:36本地时间）；
  `tsc --noEmit`及build均exit0。未运行的真实PG/Redis等条件门禁不冒称通过。
- 独立范围审查另跑69项通过，并核对合并理由最大2000字符、8项本地诊断与历史连续性
  均保留；这是代码审查和本地回归，不是人工批准或真实模型语义验收。
- 本次没有重跑模型。原完整窗口仍是66次HTTP200、195739 reported usage tokens、
  30项全部尝试但独立语义仅22通过/8未通过，执行报告另有6项失败并保留停止标记。
  [归档清单](evidence/iris-bailian-20260925-source-first-full-manifest.json)保留原件/脱敏副本哈希；
  原报告 `independentSemanticReview=pending` 未被改写成通过。

其余错误介入、已处理话题重提、旧预算基准未投影、过度确定断言和初审/最终审核长度失败
仍是独立未关闭项。此次只处理已确认的诊断遮蔽，不扩大调用、权限或使用付费回退。
下一项上下文修复仍在工作树中、尚未提交；它不属于`45fe8968`，也不能继承本次
完整本地回归或被写成已获语义验收。
IRIS-CORE-005继续部分实现；精确SHA CI、真实单群投递/停止/恢复尚未验收。

## 四处文档处置

| 核对项 | disposition与理由 |
|---|---|
| 白皮书 | **updated**：[第6节](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)明确模型已否定时也须汇总本地可证实的凭据失败，并保持理由有界与原修正次数。 |
| 工程故障台账 | **updated**：[诊断遮蔽条目](../operations/engineering-failure-ledger.md#proactive-collaboration-is-not-a-deadline-reminder)记录提前返回、归档回归和不可把诊断修复当作语义成功。 |
| 核心需求覆盖基线 | **updated**：[IRIS-CORE-005补记](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md#2026-09-25-复核诊断汇总)记录聚焦验证和未变的部分实现/部署状态。 |
| README / AGENTS / 当前交接 | **updated**：[README](../../README.md#current-product-state)及[当前接手入口](current-handoff.md#当前正在推进)给出应用提交、实际本地门禁与下一项。**reviewed-unchanged**：[AGENTS](../../AGENTS.md)的工作树定位、授权边界和四处闭环规则仍适用。 |

后续实模/真实群验收只在实际产生后回填；文档核对不替代这些门禁，
也不把后续文档提交或未提交的上下文修复误写成`45fe8968`应用内容。
