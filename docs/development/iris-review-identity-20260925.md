# 主动讨论：本轮评估身份与真实历史分离

日期：2026-09-25。实现树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，
分支 `codex/iris-daily-pilot-followup`。应用修复提交
**`04aa3a09f8548865b9178b001d575d7f800785b4`**；前一应用为`bdef93c0`，
文档/旧实模证据检查点为`56206684`。无push、部署、主动发言启用、飞书外发或真实群验收。

## 症状、归因与有限修复

[前一六例诊断](iris-literal-receipts-20260925.md)中，`inference`两次review把
本轮尚未发送的`originalAssessment`当成历史上已提醒的意见，错误拒绝当前草稿；
独立语义只通过4/6。`qualified-risk`最终assessment又把条件后果写得过度确定，
但review全true漏检。这两项失败仍属于`bdef93c0`的原始事实，不能因本次代码存在
便改写为通过。

应用`04aa3a09`在初审、唯一修正、终审的模型输入中，以`identityTarget`取代完整
`originalAssessment`。它只携带本轮问题身份与锁定结构（decision、reason、
issueRef、选中引用以及materialChange的kind/引用），不传旧观察、理由、建议和变化
说明正文；同时标明这是`not_sent`的同一次评估。当前assessment/draft仍完整受审，
真实讨论与已提供问题状态继续单独提供，不能把本轮候选当成真实历史意见。
若新问题的身份描述需要修正，仍须受来源和同一问题核查，不能把身份描述当事实依据。

内部运行时的原assessment仍用于锁定decision、reason、问题身份、引用和变化类别；
严格响应schema、数字/单位字面门禁、初审数字连续性及**最多一次组合修正**未变。
本次确认消除了旧评估正文作为历史意见的输入路径；是否同时使模型稳定识别
条件后果确定性，仅是待实模检验的假设，不能写成已修好。

## 验证层级与待完成验收

- 新增时间角色/原文隔离回归在修复前有11项失败，修复后相关范围90项通过。
  独立只读review核对三个后续模型调用的输入、内部身份/引用锁、真实讨论、
  当前候选和数字连续性，另跑四文件58项通过，未见该范围可操作回归。
- 对应代码在提交前运行完整Core：261文件/4781项通过，13文件/469项条件跳过，
  38.04秒（21:15:15本地），exit0；类型检查与build exit0；评估CLI7项通过、0跳过。
  这些是本地代码门禁，不是模型语义或真实群验收。
- 七例各一轮的受限实模诊断于13:17:36.996–13:20:15.638 UTC结束：17次HTTP200、
  55396 reported usage tokens，无自动重放；`executionPassed=false`且有停止标记。
  `inference`在`scope_review_validation`后`render_failed`，`paraphrase`执行层误介入。
  独立逐例语义为**4通过/3失败**：`arithmetic`、`material-update`、`handled`、
  `hypothesis`通过；`inference`的generated pair自行加入无依据的行业1%–5%转化率，
  review又要求原文无法核算的绝对收入，并在`requiredNumbers.expectedValue`给出null，
  导致schema失败；`qualified-risk`把条件后果写成
  “将直接导致”和“极高违约风险”，缺概率依据，六项review却全true；`paraphrase`
  将同义复述当新证据，忽略真实历史lastObservation已载16/10/6及相同建议。
  原报告`independentSemanticReview=pending`仅是运行器字段，不回写原件；独立结论记在此处。
  输入投影虽关闭旧评估正文冒充历史的路径，统一消锚语义假设并未通过。
  该失败窗口不进入完整15×2，也不重复运行。
  私有原件未改写；[脱敏归档清单](evidence/iris-bailian-20260925-identity-target-diagnostic-manifest.json)、
  [报告](evidence/iris-bailian-20260925-identity-target-diagnostic-report.json)、
  [起始标记](evidence/iris-bailian-20260925-identity-target-diagnostic-started.json)、
  [停止标记](evidence/iris-bailian-20260925-identity-target-diagnostic-halt.json)、
  [harness](evidence/iris-bailian-20260925-identity-target-diagnostic-harness.txt)和
  [launcher](evidence/iris-bailian-20260925-identity-target-diagnostic-launcher.txt)已归档。
  清单绑定原报告SHA256 `f13a5354df8d37965d8950b0599886ff0b785f90a8922499e0b85f2fd385c215`，
  核对17次请求/响应与completion/case/stage连结、41464原响应字节及应用来源哈希；
  精确脱敏私有workspace和本地用户名，未发现需省略的provider reasoning，也未读取凭据/DPAPI。
  `dcaa2995`完整15×2仅22/30、`a0a7f2a0`六例4/2、`bdef93c0`六例
  4/2的分层失败及其原件均保留。完整语义、精确SHA CI和真实单群投递/停止/恢复
  尚未验收。
- 本地Docker Desktop Linux Engine命名管道不可用（`docker version`的Server为null），
  且`psql`命令未安装；本轮未运行真实PG/Redis集成，也未触发仓库现有CI的真实PG步骤。
  这是后续发布验证边界，不是当前模型语义诊断的等待条件。

### 同应用、独立thinking profile对照（负向）

文档检查点`76edbb68`之后，保持应用`04aa3a09`和原首次review的Core
messages/schema/body不变，仅把同一`qwen3.7-plus`调用切换为thinking开启、
budget4096（因此是**profile**对照，不能归因为单个参数）。原计划五例三负两正，
于13:29:03.760–13:29:31.805 UTC在首例`qualified-risk`即触发停止：
**仅1次HTTP200、5486 reported usage tokens，其中1614 reasoning tokens**。
新review的六字段全部true、模型`supported=true`、本地凭据校验也true，
却仍把缺概率依据的“将直接导致/极高违约风险”视为合格；首例的预期为false。
其余`paraphrase`、`inference`、`arithmetic`、`material-update`四例
**未调用**，不能写成五例均失败或thinking已全面比较。本次不改变应用、合同、
完整15×2或生产状态；thinking profile未获提升。

私有原报告SHA256 `bcbd32630005d4f0712300333adc703a37f9cb2bda40c7498b75e0b0388da1bd`
已冻结。原报告不保存provider reasoning正文，只留该字段路径、7504字节与哈希；
1614是供应商计的reasoning tokens，不等于7504字节。运行器原
`independentSemanticReview=pending`不回写；以上负向判定记录于此。
[脱敏归档清单](evidence/iris-bailian-20260925-identity-review-thinking-manifest.json)、
[报告](evidence/iris-bailian-20260925-identity-review-thinking-report.json)、
[起始标记](evidence/iris-bailian-20260925-identity-review-thinking-started.json)、
[停止标记](evidence/iris-bailian-20260925-identity-review-thinking-halt.json)、
[harness](evidence/iris-bailian-20260925-identity-review-thinking-harness.txt)和
[launcher](evidence/iris-bailian-20260925-identity-review-thinking-launcher.txt)已归档。
归档校验固定原报告SHA、唯一请求体哈希、与non-thinking基线相同的Core body、
脱敏后decoded response和结果的连结；原响应9857字节/哈希仅保留元数据，
因原件没有raw response而**不能独立重算**。reasoning正文未公开，
只留7504字节/哈希元数据；私有原件未改、凭据/DPAPI未读取。

## 四处文档处置

| 核对项 | disposition与理由 |
|---|---|
| 白皮书 | **reviewed-unchanged**：[第6节](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)已经要求区分当前讨论与先前意见、只按授权原文核对、避免重复及过度确定后果；本次是有限输入投影及独立profile诊断，七例仍有三项语义失败，thinking首例又误通过，不新增产品行为规则。 |
| 工程故障台账 | **updated**：[主动讨论条目](../operations/engineering-failure-ledger.md#proactive-collaboration-is-not-a-deadline-reminder)记录投影修复后七例仍失败及thinking首例误通过。 |
| 核心需求覆盖基线 | **updated**：[IRIS-CORE-005补记](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md#2026-09-25-本轮评估身份与真实历史分离)区分本地门禁、七例4/3语义与独立thinking负向对照。 |
| README / AGENTS / 当前交接 | **updated**：[README](../../README.md#current-product-state)及[当前接手入口](current-handoff.md#当前正在推进)列出应用SHA、七例4/3和thinking首例结果。**reviewed-unchanged**：[AGENTS](../../AGENTS.md)的工作树定位、授权边界与四处闭环要求仍有效。 |

本记录不把文档提交、本地回归或已结束但失败的模型窗口当作发布批准。
