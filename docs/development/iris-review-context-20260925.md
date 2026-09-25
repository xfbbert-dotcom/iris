# 主动讨论：当前讨论复核与旧基准原文闭合

日期：2026-09-25。实现树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支
`codex/iris-daily-pilot-followup`。应用修复提交
**`a0a7f2a0b6ddaad91b5937c1da84d8993304f02c`**；前一项诊断修复是
`45fe89683c7272cce3394da5bdd9a5df20ade75f`，文档检查点为`cb431b95`。
本次没有 push、部署、启用主动发言或飞书外发，不是生产核验或真实群验收。

## 症状、确认边界与实现

[先前完整15例×2轮](iris-source-first-generation-20260920.md#32-9月25日完整15例两轮)
在应用`dcaa2995`上独立语义仅22/30通过：`handled`已有最新处理正文仍重复介入，
`paraphrase`第一轮把同事实换说法当新依据，`material-update`第一轮虽有24/16/8，
却把旧10万预算基准误写成缺失；另有审核理由过长与条件后果过度确定等失败。
这些是旧应用的原始结果，不能被本次本地回归追溯改写。

确认的代码边界是：首次判断能看见完整当前材料和问题目录，后续生成只带选中的原文引用，
而初审、唯一修正和最终复核没有只读的当前讨论/已提醒状态；已有问题的上次有效
`basisSources`若未被本轮判断选中，会在生成与审核之间丢失原基准正文。
这能解释输入投影缺口，但不能单独证明模型会识别重复、避免过度断言或修正全部旧失败。

应用`a0a7f2a0`的有限改变：

- 初审与最终复核及唯一组合修正接收只读`discussion`，包含当前触发正文、授权材料和
  已提供问题的状态/前次意见；用于判断现在是否还值得发言、是否换说法重提。
  `discussion`不能扩大锁定的事实引用范围，前次模型意见不是事实权威；首次来源优先
  生成仍不把旧意见正文当改写模板。
- 对已有问题，在首次判断返回及render入口把**上次有效基准**的引用并入本轮选中
  `evidenceRefs`，生成与审核都能看到可用的当前授权原文；`materialChange.evidenceRefs`
  仍锁定本轮变化引用。只取上次有效基准，不把所有历史意见/引用无界并入。
- 绑定存在不等于正文存在。若本轮选中来源或旧基准没有当前授权文本，在生成前明确失败，
  不从旧模型观察/建议补造事实。相同来源引用下的多个当前授权文档片段按序合并，
  不丢失较早片段；这是独立审查指出的P1后修复。
- 判断提示补充已处理事项、语义重复和条件后果的边界；复核提示要求核对新增价值，
  且整体理由简短。提示只是模型任务说明，本地引用、结构、权限与调用次数门禁仍在。

`closeIssueBasisEvidence`仍仅使用本次上下文已给出的当前正文；历史基准若在当前
`items`之外尚无正文加载路径，本次选择明确失败。这是已知有限边界，不能写成
所有历史基准都已自动补齐或完整语义已修好。

## 本地验证、实模待定与原件保留

- 五项新回归分阶段RED→GREEN，覆盖旧基准并入、正文缺失前置失败、同引用多片段、
  初/终审与唯一修正的讨论输入，以及未选为事实引用的最新处理正文仍可供复核。
- 独立审查发现新增正文检查把同一来源的多个文档片段误判为缺失的P1；按序合并同时
  修复了原Map只保留最后片段的问题。随后独立实际context
  builder输入探针及五项回归复审未见该范围新增阻塞。最终聚焦66项通过。
- 应用修复后的完整Core（提交前验证）：261文件/4779项通过，13文件/469项条件跳过，exit0，
  耗时42.68秒；类型检查与build均exit0。评估CLI7项在最后片段修正**之前**通过，
  不把它写成最后改动后的重新验收；真实PG/Redis等条件门禁不冒称已运行。
- 六个原始场景各一轮的免费保护实模诊断已于12:49:58.874–12:52:47.279 UTC结束：
  18次HTTP200、65185 reported usage tokens，无429或重放。独立逐例判定为
  **4通过/2未完整**：`inference`、`qualified-risk`、`paraphrase`、`handled`通过；
  `arithmetic`与`material-update`均为`draft_rejected`。两项原始review虽返回true，
  数字/单位字面凭据仍不匹配，不能把它们写成最终组合通过。`material-update`中间稿
  还缺明确“较16万增加8万”，中间assessment又声称原文没有的审批/权限信息；
  即使字面门禁将来通过，这些内容问题也必须独立核对。原报告保留
  `independentSemanticReview=pending`运行器字段，独立结论只记在此记录，
  不改写原件。该有限诊断不替代完整15×2、精确SHA CI或真实单群投递/停止/恢复。
  旧66次HTTP200/195739 usage tokens及22/30语义结果仍绑定`dcaa2995`。

下一项是通用数字/单位字面凭据合同的有限澄清和回归，而非放宽单位门禁或按固定题目
写答案；该项尚未成为本次应用或实模成功结论。私有原始诊断报告及停止标记未改写；
[脱敏归档清单](evidence/iris-bailian-20260925-review-context-diagnostic-manifest.json)、
[诊断报告](evidence/iris-bailian-20260925-review-context-diagnostic-report.json)、
[停止标记](evidence/iris-bailian-20260925-review-context-diagnostic-halt.json)、
[起始标记](evidence/iris-bailian-20260925-review-context-diagnostic-started.json)、
[harness](evidence/iris-bailian-20260925-review-context-diagnostic-harness.txt)和
[launcher](evidence/iris-bailian-20260925-review-context-diagnostic-launcher.txt)已按原件哈希和18次
请求/响应连结校验，精确脱敏私有workspace及本地用户名；若有provider reasoning则省略原响应并保留哈希，
不公开凭据。归档保留原报告`independentSemanticReview=pending`，独立4/2判定只在本记录。

先前[文档检查点](iris-review-diagnostics-20260925.md)保留的三份原样文本证据
`iris-bailian-20260920-joint-generation-launcher.txt`、
`iris-bailian-20260920-source-first-generation-harness.txt`、
`iris-bailian-20260920-source-first-generation-launcher.txt`在`git show --check cb431b95`
中有EOF空行警告；为保留原件字节与归档哈希，没有改写这三份副本。
这不表示检查点的全部空白检查为零，也不影响本次应用代码的测试结果。

## 四处文档处置

| 核对项 | disposition与理由 |
|---|---|
| 白皮书 | **updated**：[第6节](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)明确讨论只读必要性核查、基准原文闭合、缺文前置失败与引用边界。 |
| 工程故障台账 | **updated**：[主动讨论条目](../operations/engineering-failure-ledger.md#proactive-collaboration-is-not-a-deadline-reminder)记录阶段间信息丢失、同引用片段P1及有限回归。 |
| 核心需求覆盖基线 | **updated**：[IRIS-CORE-005补记](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md#2026-09-25-当前讨论复核与旧基准原文)区分本地实现、六例4通过/2未完整、原22/30失败及未部署状态。 |
| README / AGENTS / 当前交接 | **updated**：[README](../../README.md#current-product-state)和[当前接手入口](current-handoff.md#当前正在推进)记录新应用、门禁和有限下一项。**reviewed-unchanged**：[AGENTS](../../AGENTS.md)的工作树定位、授权和四处闭环要求仍适用。 |

实模报告、独立语义结论与后续部署状态仅在实际产生后续记；文档提交和本地单测
不能替代应用`a0a7f2a0`的精确SHA发布与真实群验收。
