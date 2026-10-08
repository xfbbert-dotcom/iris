# Iris 来源计划撤回出口：本地已补，合成端到端验收未通过

日期2026-10-08。实现树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支
`codex/iris-daily-pilot-followup`。真实错误发言与恢复已在 `ac4499a4` 的
[失败记录](iris-pd-real-opinion-20261008.md)归档，本记录不覆盖或改变该失败。
生产应用仍为51937b95；本轮候选只在本地修改，不push、部署、开启QA或重新外发。

候选应用提交：`43b8bb3e3dae036538c5746774b20665717037d6`。在该精确HEAD冻结并运行的
[四例合成窗口摘要](evidence/iris-opinion-withdrawal-20261008-summary.json)结果为失败：
4次HTTP200/9651tokens，第一负例正确初判skip；第二正例识别问题后，生成及唯一绑定修正
均漏抄引文中的一个字，不能通过逐字连续绑定，未产生合格意见。后两例没有调用。
新增撤回分支没有在这次实模中被采用，不能从首例初判skip推断它改善了真实误判。
这条候选没有达到产品放行条件；不再追加同配置、修改预期、放宽绑定或部署。

## 实际合成请求与停止

[runner](evidence/iris-opinion-withdrawal-20261008-runner.txt)及
[受保护启动器](evidence/iris-opinion-withdrawal-20261008-launcher.txt)只用合成消息，
应用、运行清单、脚本与四例输入的哈希由[preflight](evidence/iris-opinion-withdrawal-20261008.preflight.json)
冻结。逐次人工刷新精确型号免费额度，观察早于该次pending的许可不接受；最低额度
200000、未来有效期、用完即停、不自动HTTP重试或付费回退均保留。

| 案例 | 实际过程及结果 |
| --- | --- |
| order-wait | 1次assessment，1948tokens；skip/no_work_value，无草稿，独立按冻结标准确认正确。未用新撤回分支。 |
| order-bypass | assessment→plan generation→唯一plan repair，2313+2434+2956tokens。两次decision.quote都把合成来源“现在就向”写成“现在向”，修正只补了句末标点并错误自述已逐字绑定。程序再次拒绝，technical_error，未到scope review。 |
| permission-wait / permission-bypass | 首次失败后停止，0次请求。 |

[原始合成报告](evidence/iris-opinion-withdrawal-20261008.json)保存逐次wire与响应及哈希，
[停止记录](evidence/iris-opinion-withdrawal-20261008.halted.json)为北京时间16:49:14.393，
`proactive discussion draft was invalid`。主执行者核对4组请求/响应哈希、调用阶段、用量
和结果文件一致。首例[独立语义许可](evidence/iris-opinion-withdrawal-20261008.semantic-order-wait.json)
绑定结果原字节哈希；第二例为执行失败，没有把空稿算成语义通过。
独立审查另行重算case/context、请求/响应/completion哈希均匹配，确认实际阶段为
assessment两次、plan一次、binding repair一次、scope review零次，no_intervention采用零次。

这里新暴露的是引文复制及唯一修正未能忠实保留来源，不能把它归因于撤回分支本身，
也不能把未通过的正例绕过以完成后两例。现有严格绑定正确阻止了无效候选；下一步若
改变引用表示或定位职责，必须另立可验证合同，不能靠模糊匹配补回原字或换种prompt重采。
本轮不再开展该新方向。真实群当前仍关闭，真实错误意见及未启用追问的缺口保持开放。

## 确认的缺口与修复范围

完整来源仍会进入生成阶段，但旧source-plan只允许dependency/inference/calculation。
初判误介入之后，生成无法表达“重新看来源后没有实质问题”；合法的两个引文片段又会
被编译为固定的缺验证判断。引用真实不证明关系真实，把已保留的未来条件拆成两个角色
也不证明成员在绕过它。该结构缺口已从源码与合成编译复现确认；真实窗口未保存中间
计划/原始wire，不能断言每次真实调用的完整因果轨迹已经复现。

新增严格计划 `{kind:"no_intervention",reason:...}`，原因仅允许no_material_issue、
insufficient_basis、already_handled，不附自由正文、事实或引用。初次生成、绑定错误修正、
审核后修正都可以选择这一分支：编译为null、终止render，不再生成草稿、送审或回退为
其他问题类别。仍只有既有一次总修正预算，原dependency/inference/calculation正例和legacy
行为保持。生成指令要求保留条件、时序、否定及已处理关系，未新增关键词拦截器。

沿用现有持久化合同：原始intervene不会被改写成skip，空草稿仍记为
`blocked / assessment_or_draft_invalid`，synthetic eval为draft_rejected。trace只在实际
运行合法撤回后记录withdrawalObserved，acceptedDraft=false，不把schema通过当语义通过。
这修复了退出路径，不证明模型一定会使用它或不会漏掉真问题。

## 本地验证

- TDD首轮定向69项中9项按预期失败、60项通过；最小实现后同69项全部通过，主执行者
  随后独立复跑3个相关测试文件仍为69/69。
- 完整Core：5098通过、471条件跳过；类型检查、构建通过；eval CLI 11/11通过。
- 最初类型检查发现4处旧测试对编译结果必非空的假设，按nullable合同修正后通过。
- PostgreSQL归档回放因本机未配置数据库条件跳过。测试显式核对新增schema分支，
  保留历史三个业务分支、请求业务内容和响应原件，未改历史证据或预期凑通过。
- 本地合同/接线验证通过；上述实模窗口未通过完整产品出口，真实飞书修复效果和部署均未验。

## 调用前冻结的合成出口（保留，未完成）

只执行两组完整端到端对照，每例从实际assess开始，不给模型人工正确选项或预期。
组一比较明确在阶段完成后执行，与尚未验收却立即作出确定承诺；组二比较等待授权确认
后再开放，与授权未确认却今天直接开放。负例无实质问题时应无意见，正例必须仍能给出
有依据、具体、有用且不夸大后果的意见。技术异常或单纯审核拒绝不计为负例语义通过。
若初判已skip，只证明该完整案例正确，不能宣称实模使用了新撤回出口。
首个语义失败停止，不重采同配置、不更改预期、不追加prompt变体。
实际应用SHA、runner、输入、每次请求及响应哈希由运行前冻结记录绑定。

## 白皮书11.2四处处置

| 位置 | 处置 |
| --- | --- |
| 白皮书 | **updated**：[source-plan合同](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md)写明来源复核允许撤回、条件句边界及blocked不等于初判skip；实模结束后**reviewed-unchanged**，它已明确代码出口不证明模型选择正确，失败没有改变稳定合同。 |
| 工程故障台账 | **updated**：[台账](../operations/engineering-failure-ledger.md)链接真实误判、退出路径修复和受限正例引文失败；不关闭原产品缺陷。 |
| 核心需求覆盖基线 | **updated**：[覆盖基线](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)记录本地合同已补、四例实模出口未通过，IRIS-CORE-005保持部分实现。 |
| README / AGENTS / current-handoff | **updated**：[交接](current-handoff.md)指向本地候选与实际关闭状态。**reviewed-unchanged**：[README](../../README.md)的应用51937b95及交接入口仍有效；[AGENTS](../../AGENTS.md)的工作树、权限、有限出口及四处闭环要求未变。 |
