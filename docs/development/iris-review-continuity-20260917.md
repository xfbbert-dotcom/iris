# 主动讨论：修正前后数字复核连续性

日期：2026-09-17。用户要求直接继续修复，不等待免费云端容量恢复。
实现树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支 `codex/iris-daily-pilot-followup`，
干净起点 `42dedd68`。应用提交 **`d699761e7e0c9855a2bbcfb6e500a80375470706`**。
这是数字核对项不可静默遗忘的狭窄修复，不是完整主动语义、真实飞书投递或部署通过。

## 确认的缺陷与实现

将[历史 edit 实验](evidence/iris-semantic-spike-20260917-pair-edit.json)的四个完整响应直接放回实际
`createPdModel.render`，不运行其私有适配器、也不调用模型，仍返回与归档相同的错误pair：
初审列出10/16/6万元，实际草稿没有6；修正稿仍没有6、保留“计划不可行”的过度断言；
最终复核仅列10/16，两项引文有效，应用误放行。
根因已确认：最终请求没有先前review，程序只验证最后返回的数字列表，没有对已提出核对项的连续处理要求。
这不是HTTP429、每日额度或“必须明天才能编码”的问题。

按[有限计划](../superpowers/plans/2026-09-17-iris-review-continuity.md)修复：

- 最终复核携带真实首次 `previousReview`；同一授权evidence生成schema并用于本地核验。
- 初审数字非空时，最终响应须有 `numberRevisions`，无更正用空列表。原数字须在当前requiredNumbers保留同值同单位且有有效当前草稿引文，不能静默删项。
- 初审可以错误：通过唯一 `previousIndex` 显式更正至当前有效 `replacementIndex`，或null撤回；均须非空理由和对应授权 `sourceRef` 的原样 `sourceQuote`。重复/越界索引、未知源、伪造/跨源引用和不存在的替代项拒绝。
- 数字不适用/币种不可比可基于原文撤回；不能为了迎合初审把60写进本来应为6的草稿。引用存在仍不是理由正确的证明。
- 初审无数字及普通成功路径形状不变；render成功2次调用，进入修正最多4次，最终拒绝后不追加修正。权限、问题身份、来源、生产开关均不变。
- [runtime](../../apps/core/src/proactive-discussion/model.ts)与[evaluator](../../scripts/pilot/proactive-discussion-eval.ts)使用[同一helper](../../apps/core/src/proactive-discussion/review-receipts.ts)。诊断从当次完整请求读取先前review和原文，脱敏/截断只影响报告，不影响判定。

这不是完整“必要数字发现器”：首次和最终都没有发现的数字、同值不同含义、事实类别错误、错误算术、虚假的撤回理由和过度断言仍依赖语义判断及独立验收。不能将本地连续性通过等同模型真正理解。

## 本轮实际回归与审查

| 验证层级 | 结果 |
|---|---|
| 开工定向基线 | 原pair-review/receipts/eval-trace共63通过。 |
| TDD RED | 18:42:55 Asia/Shanghai新增14例均失败；第一例真实render返回历史错误pair，而测试要求null。其他失败表明新修订合同尚未实现，未冒充14个独立生产缺陷。 |
| 首次实现 | 新14例通过，旧pair-review一例因未提供新必填numberRevisions而失败；仅更新对应fake响应，没有放宽生产校验。 |
| trace RED/GREEN | 新3例先失败（不识别最终历史合同、未保留修订诊断），接入同一helper后通过。 |
| 最终聚焦 | 18:47:40，4文件81项通过：连续性15、pair-review16、receipts34、trace16。包含旧响应/显式空修订两种历史误放行负向、正确保留、错误初审更正、不可比数字撤回、伪造引文及原输入不丢失。 |
| 完整Core | 18:48:46启动，22.34秒；257文件通过/13跳过，**4734通过/469条件跳过**。 |
| 类型/构建 | `npm run typecheck --workspace apps/core`、`npm run build --workspace apps/core`均退出0。 |
| Compose/CLI | `node --test --test-concurrency=1 scripts/pilot-compose.test.mjs scripts/pilot/proactive-discussion-eval.test.mjs`：40通过/1跳过，9329.7608ms，其中CLI7通过。Docker不可用的真实Caddy探针跳过，未修Docker。 |
| 独立修复范围审查 | 未发现阻塞项；32来源/8旧数字的四种1200字符schema为11099–23899字节，小于32768。审查不证明撤回理由或完整模型语义正确。 |

入口：[连续性回归](../../apps/core/tests/proactive-discussion-review-continuity.test.ts)、
[成对修正](../../apps/core/tests/proactive-discussion-pair-review.test.ts)、
[引用核验](../../apps/core/tests/proactive-discussion-review-receipts.test.ts)、
[诊断一致性](../../apps/core/tests/proactive-discussion-eval-trace.test.ts)。
没有本轮真实PG、远端exact-SHA CI或飞书投递验收。原条件跳过不能算通过。

## 本地真实模型对照

只复用已下载的Qwen3-4B-Q4_K_M、原CPU配置与seed1709；初次assessment/draft/review重放既有真实输出，
仅现有pair repair和最终review各最多1次新请求，每组最多2次、180秒单请求、420秒总预算，无自动重试。
错误稿与正确稿分别运行一次，保持原生成/语义标准，不用null代替正确完整结果。

| 对照与原始报告 | 实际结果和独立判读 |
|---|---|
| [错误稿](evidence/iris-review-continuity-20260917-negative.json)，10:50:51–10:52:49 UTC，2次HTTP200 | 修正仍遗漏6万元，materialChange.explanation仍“预算不足导致招聘计划不可行”。final review这次列回10/16/6、numberRevisions=[]，但声称含6的原句仍只有10/16；既有完整数字引用检查拒绝，最终null。只证明局部拦截和本次未遗忘数字；不是修正/完整语义通过，不能说本次实模由连续性缺项检查直接拒绝。 |
| [正确稿](evidence/iris-review-continuity-20260917-positive.json)，10:55:10–10:57:11 UTC，2次HTTP200 | 修正保留既有正确pair；final review列出10/16/6、numberRevisions=[]，原稿原句完整包含相关数量和建议，本地校验通过、返回原pair。证明这一个正确稿的可用性，不是fresh生成或错误初审更正/撤回的实模验收。 |

[实际脚本](evidence/iris-review-continuity-20260917-harness.txt)和报告均原样归档，未改写已有失败。
归档与私有原件SHA256一致：negative `2b4688ca166635d4aef892c7a25eaf9757c5baac560d9a792d48e53634fc4416`、
positive `89142db3d769260b6c0722f3d06768c416a49e4ebb88778a4f3183cb77587551`、
harness `b491bc45ddee3318f2c52a1ca894c6d10c7096ae20592a3d64f058533966c104`。
负向启动时HEAD尚为42dedd68、代码已修改，正向HEAD为d699761e；两份sourceHashes记录实际源码身份，
不能将文档HEAD或归档回放当作新的完整生成证据。没有云端请求、付费回退或飞书发送。

既有局部程序门禁已完成回归及正负实模对照；必要数字生成、事实类别、过度断言、漏报/重复介入仍未解决。
随后完成下列有限原文重建实验；未重复七字段edit或diagnostic变体，不据模型布尔或最终null宣布交付。

## 原文重建私有实验：目标仍未通过，未推广

同一免费本地模型、配置及seed，10:58:12–11:02:49 UTC实际2次HTTP200。
[完整原始报告](evidence/iris-source-rebuild-20260917-negative.json)与[私有脚本](evidence/iris-source-rebuild-20260917-harness.txt)
保留原始请求和响应。仅pair repair输入不再传入旧候选的观察、理由、建议和草稿字段，改为从同一授权原文重建；
问题身份、不可变状态、首次可错review仍保留，所以不能说旧稿的全部文字已被移除（review仍含诊断引句）。
输出schema、产品校验和最终复核未改；初始assessment/draft/review仍是回放，不是新的完整生成。

实际修正补出了6万元，去掉“招聘计划不可行”，改为有条件的风险建议；但draft长达1200字符，
“预算缺口为6万元”重复13次，以“若按计划执行，预算可能无法覆”结尾，无法作为自然简短的主动发言。
最终review仍返回raw supported=true；其中6万元的draftQuote却指向仅含10/16的首句，
既有数字引文检查拒绝，finalPair=null。此处不是连续性缺项拒绝，也不是整体修正成功。
目标失败即结束，未运行正向变体、未再次抽样，私有输入重建不进入产品。

归档与原件SHA256一致：report `6843ad716c5b94cd3e1155b1bf30ba3acef12f6247ade472e2d7daf8d39d3eab`，
harness `2efacf94542a5f910c7b4803efa18418e7d70aec66add1d37fa9dfdee4978376`。
报告中的manualReview=pending是原始运行时标记，人工结果为本节的失败判读；不改写原件。
9月18日续接只归档和核验结果，未新增模型调用；校验PID17380的精确可执行文件路径后停止本次本地模型，
2026-09-18T14:06:26+08:00复核18089监听数与llama-server进程数均0，launcher已退出。
同日14:09:56重新运行上述4文件，81项仍通过；应用源码与三个本地报告的sourceHashes一致。
185个文档链接/锚点校验无错，归档哈希一致，`git diff --check`通过。
新增实验记录经独立只读审查无阻塞；默认checkout保持干净，未切换、重置或合并。

本轮闭环的是可离线复现的复核连续性程序缺陷。完整主动讨论仍有必要数字生成、事实类别、过度断言、
漏报/重复介入及本次重建重复输出等未通过项；继续工作须针对具体失败提出新的可证伪假设，
不能把同一失败实验换名重跑，或通过放宽原验收标准宣称完成。

## 四处文档处置

| 核对项 | disposition与理由 |
|---|---|
| 白皮书 | **updated**：[第6节](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)，明确修正不得静默遗忘先前数字诊断，允许有来源依据的显式纠错，不把初审数字固化成事实。 |
| 故障台账 | **updated**：[主动协作条目](../operations/engineering-failure-ledger.md#proactive-collaboration-is-not-a-deadline-reminder)，记录真实render离线复现、连续性保护及不能证明完整语义的边界。 |
| 需求覆盖基线 | **updated**：[本次修订](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md#2026-09-17-数字复核连续性)，区分程序缺陷修复、确定性测试与模型生成门禁；IRIS-CORE-005不提升为完成。 |
| README / AGENTS / 当前交接 | **updated**：[README](../../README.md#current-product-state)、[当前交接](current-handoff.md#当前正在推进)指向本记录；**reviewed-unchanged**：[AGENTS](../../AGENTS.md)，工作树、分支、四处闭环规则及发现最新入口的链接仍有效，无需重复改规则。 |

未push、部署、启用能力或外发；没有付费API或云端重试。最近生产版本仍只是[此前交接记录](current-handoff.md)中的f6a6dd41，本轮未作生产实时探针。
