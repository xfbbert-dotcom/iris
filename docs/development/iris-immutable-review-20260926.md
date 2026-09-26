# 不可改写原文审核：手工对照改善，完整迁移失败

日期：2026-09-26。实现树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，
分支 `codex/iris-daily-pilot-followup`。本轮没有修改应用代码；应用 SHA 仍为
`04aa3a09f8548865b9178b001d575d7f800785b4`，两个运行的仓库 HEAD 均为
`1b80965c23be986f4031afabe48da8db5511e845`。当前文档/证据提交不是新的修复应用
或部署 SHA。没有 push、SSH/生产核验或配置变化、主动发言启用、真实群数据调用或飞书外发。

## 结论与未解决归因

**本轮没有修好主动讨论审核。** 已验证的问题是：复核会把待核对错误句解释成
一个更合理的意思，再批准原句。来源和候选的逐字绑定、完备覆盖与字段合取只能
阻止漏项/换项，不能保证模型对原句含义、算术方向或后果确定性的判断正确。

手工成对选项曾帮助识别负号，但完整输入迁移失败；不能把局部对照提升为产品
能力。长上下文、多任务相互干扰与模型能力各自贡献**尚未因果分离**，不称所有
模型都无能力，也不把失败归因于429、额度耗尽或等待用户权限。

本候选按预设退出，不再重采或尝试第三个prompt变体。后续方向是审议可执行
计算与事实/推断审核分工，先证明来源到表达式/断言的忠实绑定，不能仅靠把同一
模型判断再包装一层来宣称安全。该方向尚未设计实现；不据此切换生产或扩展授权。

## 1. 原句三分类关系 probe

在此前[固定模型对照](iris-qwen38-review-20260926.md)的同一应用下，先测试四组
固定、无语义提示ID的候选句，每组含三个手工对照。预期映射仅留本地，actual wire
只有来源和固定句子；模型输出 supported / contradicted / undetermined 及短理由。

- 窗口：14:05:01.784–14:05:11.499 UTC；qwen3.8-max、non-thinking、max_tokens2048。
- 预设最多4请求/5分钟，首错停止，无重试或修正。实际 **2次HTTP200，1409 reported tokens**。
- `set-71`：正确认可`10−16=−6`负余额、拒绝`16−10=−6`，认可`16−10=6`缺口。
- `set-24`：正确认可谨慎的“可能影响交付，需核实”；正确判定原始确定交付后果
  依据不足；但将“即使有阻塞也一定交付”判为 contradicted，而冻结预期是
  undetermined。来源没有证明该绝对句成立，也没有证明它必然为假。
- 因三分类不符严格失败，`set-53`、`set-86`未调用；不事后修改预期使它通过。

人工正确选项可能给出辨别线索，尚不能证明无选项审核能力。原报告SHA256：
`67ed4a9aab7d597d5c9814a3bc133d8cebfdc792e1b3fe25c2fd9f0e881b9cb1`。
[归档清单](evidence/iris-bailian-20260926-immutable-claims-manifest.json)、
[报告](evidence/iris-bailian-20260926-immutable-claims-report.json)、
[起始](evidence/iris-bailian-20260926-immutable-claims-started.json)、
[停止](evidence/iris-bailian-20260926-immutable-claims-halt.json)、
[harness](evidence/iris-bailian-20260926-immutable-claims-harness.txt)、
[launcher](evidence/iris-bailian-20260926-immutable-claims-launcher.txt)。

## 2. 无人工替代答案的完整片段迁移

调用前冻结[设计](../superpowers/specs/2026-09-26-iris-immutable-review-transfer.md)及
[执行计划](../superpowers/plans/2026-09-26-iris-immutable-review-transfer.md)。
保留五个既有初审候选、完整来源/讨论/身份与六字段审核，只追加机械切分的固定
原文片段：包含新问题描述、观察、理由、建议、实质变化说明、draft.text，保留
完整字段上下文与全部字符的连续UTF-16偏移/哈希。不提供手工正确答案。
本地要求原validator通过且每个ID恰好一次受支持，不能覆盖原有否定。

冻结的五例为 old-negative-arithmetic、qualified-risk、paraphrase、arithmetic、
material-update。局部目标提前指定：负算术对应句必须指出错误；风险两处过强
原句都须拒绝；重复须否定；正向算术和更新须通过，不准仅靠整体false或全拒绝。

- 窗口：14:34:30.200–14:34:52.121 UTC；qwen3.8-max、non-thinking、max_tokens4096。
- 预设最多5请求/5分钟/单请求60秒、6秒间隔、45000 reported tokens发起下一请求前
  停止阈值；该阈值不是绝对计费上限。首错停止、无修正或重试。
- 实际 **1次HTTP200，6605 reported tokens**；首个old-negative-arithmetic的16个
  片段全部被判true。
- 错误原句`16万元减10万元，差额为-6万元`仍被判true，理由称“表述为-6万元缺口”，
  实际替错误表达找了解释，并未按原句的运算方向核对。
- “若不纠正将导致承诺无法履行或违规超支”也被当成合理、非确定推断而批准。
- raw/local/conjunction整体false只因uncertainty标签为fact；
  fixedOracleBooleanMatched=true但targetedProbeMatched=false，故执行与独立语义均失败。
- 后四例未调用；不是五例全部失败，更不是五例验收。缺完整正确条件风险正控、
  修正后终审、端到端生成、15×2、真实群及部署验收。

原报告SHA256：`890d48abfe3ce8bfa1698a23813022e13ccc9f39cd6965f498e73d8e7063c08c`。
[归档清单](evidence/iris-bailian-20260926-immutable-transfer-manifest.json)、
[报告](evidence/iris-bailian-20260926-immutable-transfer-report.json)、
[起始](evidence/iris-bailian-20260926-immutable-transfer-started.json)、
[停止](evidence/iris-bailian-20260926-immutable-transfer-halt.json)、
[harness](evidence/iris-bailian-20260926-immutable-transfer-harness.txt)、
[launcher](evidence/iris-bailian-20260926-immutable-transfer-launcher.txt)。

## 3. 核验、费用边界与接受级别

主代理全文阅读运行器/启动器及两个离线归档脚本后执行；独立审查实际wire没有
预期答案、来源未改、16个片段完整、旧本地否定不能提升。迁移运行器的`--preflight`
经实现者和独立审查者运行exit0：ID缺失/重复/未知拒绝、整体false不提升、空串、
CRLF、逗号条件句、新问题描述覆盖，以及五份纯内存Core传输哈希均核对。
实现者严格TypeScript/PowerShell AST检查exit0；这是可丢弃运行器的离线preflight，
**不声称产品TDD红绿证据**。应用没有变化，未重跑Core全套测试，不把9月25日测试
或旧完整集22/30冒充本轮精确SHA验证。

两份原报告`independentSemanticReview=pending`保留原样；独立审查的结论记在本文件：
第一份三分类失败；第二份仍把负号和确定后果合理化，完整迁移失败。原响应正文未
保存，decoded final content保留；原响应hash/字节数仅为线索，不能从脱敏报告重算。
两份manifest保存私有原件与脱敏副本哈希，归档执行核对来源SHA及CRLF/LF映射，
私有原件未改，归档不读取凭据。证据使用`-text`属性保留字节。

本次复用已授权的同一独立合成key及Qwen3.8-Max权限，没有改权限或创建密钥。
每次启动前精确quota行分别为992.88K、991.47K/1M，结束刷新为984.86K/1M，
2026-12-18到期、用完即停始终开启；两个窗口合计 **3次HTTP200 / 8014 tokens**，
余额变化在页面取整精度下相符，不是账单审计。没有付费回退，没有429，也不需要
等到明天才能继续工程工作。主代理关闭本次临时quota标签，用户原标签保留。

## 四处文档处置

| 核对项 | disposition与理由 |
|---|---|
| 白皮书 | **reviewed-unchanged**：[来源/推断与主动发言约束](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)和[闭环规则](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#112-mandatory-bug-fix-documentation-closure)仍适用；失败的私有实验不修改稳定产品架构。新设计明确标记可丢弃、未推广。 |
| 工程故障台账 | **updated**：[主动讨论条目](../operations/engineering-failure-ledger.md#proactive-collaboration-is-not-a-deadline-reminder)新增“手工正控改善不能替代无提示迁移、整体拒绝不等于拒对错误原句”的复用规则，指向本记录。 |
| 核心需求覆盖基线 | **reviewed-unchanged**：[IRIS-CORE-005现状](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md#2026-09-25-本轮评估身份与真实历史分离)仍为部分实现，完整语义/真实群/部署未验收；本轮没有应用修复或新的覆盖提升。 |
| README / AGENTS / 当前交接 | **updated**：[README](../../README.md#current-product-state)与[交接](current-handoff.md#当前正在推进)指向本轮失败和已结束的候选，避免重复申请权限或重采。**reviewed-unchanged**：[AGENTS](../../AGENTS.md)工作树、授权、文档闭环和避免无限加固规则仍有效。 |

文档检查完成不等于bug关闭；真正未解决项仍是可靠的语义与算术审核、重复判断及
完整端到端接受，不能因这些诊断文件已提交而标记产品已交付。
