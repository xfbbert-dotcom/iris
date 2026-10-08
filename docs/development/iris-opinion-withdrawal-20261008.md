# Iris 来源计划撤回出口：本地候选，语义效果待验证

日期2026-10-08。实现树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支
`codex/iris-daily-pilot-followup`。真实错误发言与恢复已在 `ac4499a4` 的
[失败记录](iris-pd-real-opinion-20261008.md)归档，本记录不覆盖或改变该失败。
生产应用仍为51937b95；本轮候选只在本地修改，不push、部署、开启QA或重新外发。

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
- 当前仅本地合同/接线验证。真实模型、真实飞书修复效果和部署均未通过本轮验收。

## 冻结合成出口

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
| 白皮书 | **updated**：[source-plan合同](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md)写明来源复核允许撤回、条件句边界及blocked不等于初判skip。 |
| 工程故障台账 | **updated**：[台账](../operations/engineering-failure-ledger.md)链接真实误判、退出路径修复和未证实的语义效果；不关闭原产品缺陷。 |
| 核心需求覆盖基线 | **updated**：[覆盖基线](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)记录本地合同已补、模型语义仍待检验，IRIS-CORE-005保持部分实现。 |
| README / AGENTS / current-handoff | **updated**：[交接](current-handoff.md)指向本地候选与实际关闭状态。**reviewed-unchanged**：[README](../../README.md)的应用51937b95及交接入口仍有效；[AGENTS](../../AGENTS.md)的工作树、权限、有限出口及四处闭环要求未变。 |
