# 独立反例检查与唯一修正（实模首例失败，候选停止）

本地候选提交`33f994ec`；应用基线a2b3c449，仓库基线422ff85c；2026-10-01。用户授权继续本地修复及免费合成测试。
保留此前[职责消融失败](iris-review-duty-ablation-20260929.md)，不改判其验收结果。

## 设计与执行顺序

原审核倾向于替候选补前提。本候选增加独立的反例构造任务：以完整授权来源和当前
候选为输入，找出与来源兼容、却使候选断言不成立的具体情形。结果必须绑定实际
字段原句；反例仅是待核对诊断，不是新事实。未找到反例不代表候选正确。

流程：生成→反例检查→无反例时原初审；任一语义拒绝仅一次updates修正→反例检查
→无反例时原终审。修正后仍有反例则null，不新增修正。原初审若已运行，其数字
连续性规则保持。反例拒绝单独标记，不制造未审核字段的true判定；原审核的数字、
建议及六字段要求不削弱。render阶段（含生成）的模型调用上限由4增至6；技术无效不自动重试。

先实现显式本地候选选项，默认流程不变；验证通过才考虑接入runtime默认。此选项
不构成生产模型/能力启用授权。先测试原句绑定、空反例不得批准、唯一修正、修正后
重新绑定、原审核拒绝和旧数字连续性；再运行下面的受限真实模型窗口。

## 冻结验收及退出

1. 注入9月29日原完整风险生成稿，真实运行反例检查、修正、反例检查和原终审。
   最终全部正文须同时移除无依据0/100%/全部工作量及必然后果，保留具体建议。
2. 已有正确条件风险完整稿必须通过，不能以“也可能按时交付”否定“可能延期”。
3. 新鲜风险、重复讨论、预算16/6及更新24/+8/14逐例验证，不能靠全部沉默通过。
4. 最多24 HTTP、100000 reported tokens发起下一请求前停、30分钟、单次60秒；
   首个执行/独立语义失败停止，无重采/追加措辞变体。每次精确免费额度≥150K、
   未过期、用完即停开启且观察≤60秒。qwen3.8-max non-thinking/max_tokens2048。

模型反例本身可能错误或漏报，字面引用不证明反例真实兼容来源。确定性程序只负责
绑定与控制流；独立语义验收检查反例是否偷改来源/误拒建议，以及最终发言是否正确。
失败即保留证据，不启用默认流程，不宣称模型能力或任务设计的唯一因果归属。

## 实际结果及四处处置

已实现`counterexamples.ts`及`createPdModel({counterexampleReview:true})`本地候选。
默认false，runtime与正式eval入口均未启用；不存在环境变量或生产开关变更。
counterexample_rejection携带原句与假设，不伪造六字段true或数字历史。
最终无效响应返回null，提供方技术错误仍抛出；上下文取消会阻止后续调用。

新测试旧实现下6失败/1通过，实现后相关14通过。Core267文件4860项通过、13文件
469项条件跳过；typecheck、build、CLI7通过。之后补充数字连续性、最终提供方故障
与上下文取消三项，相关17项及typecheck通过；没有将这3项说成又重跑了Core全量。
独立审查重跑新测试10项通过，未发现阻止既定实模窗口的重要问题。模拟响应只能
证明程序控制流，不证明模型能生成有效反例。

登录恢复前真实模型窗口尚未启动，**当时HTTP0、tokens0**。2026-10-01百炼现有标签页显示
“您当前处于未登录状态，登录后可使用完整服务”；刷新、点击常规登录入口未恢复。
已请用户恢复登录。缺失的是实时精确免费额度/用完即停核对条件，不是合成key权限，
不是429，也未证实额度耗尽。不可借用9月29日页面读数发起调用。
私有运行器及启动器已准备、preflight通过；登录恢复后重新核对即可启动原冻结窗口，
无需重新设计或重申请同模型合成权限。当时尚无.started文件，不属于失败窗口重跑。

[待运行脚本](evidence/iris-counterexample-review-20261001-runner.txt)、
[启动器](evidence/iris-counterexample-review-20261001-launcher.txt)、
[本地验证与未启动记录](evidence/iris-counterexample-review-20261001-local.json)。

| 核对项 | disposition与理由 |
|---|---|
| 白皮书 | **reviewed-unchanged**：[第6节](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)的完整审核、一次修正和默认调用边界未变；额外检查仅显式本地候选，启用默认前需实模验收并同步稳定架构。 |
| 工程故障台账 | **updated**：[主动讨论条目](../operations/engineering-failure-ledger.md#proactive-collaboration-is-not-a-deadline-reminder)记录反例是假设、不能充当公司事实或批准证据的边界，链接本候选而不声称有效。 |
| 核心需求覆盖基线 | **updated**：[本轮候选](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md#2026-10-01-counterexample-review-candidate)区分默认关闭、本地通过和实模首败，IRIS-CORE-005不提升覆盖等级。 |
| README / AGENTS / current-handoff | **updated**：[README](../../README.md#current-product-state)与[交接](current-handoff.md#当前正在推进)定位停止的候选、实模失败及已恢复登录；**reviewed-unchanged**：[AGENTS](../../AGENTS.md)已有定位、授权与闭环要求有效。 |

## 登录恢复后的实际窗口：执行成功，语义失败

用户恢复登录后，在同一候选`33f994ec`（运行HEAD`15853b63`）执行冻结窗口。
实际 **4次HTTP200 / 11011 reported tokens**，仅frozen-risk，首败停止。没有重采、
新增修正或追加提示词变体；positive-risk、新鲜风险、重复、算术、更新五例未调用。

1. 第一反例检查给出2项，识别无依据0/100%/全部工作量，未指出必然后果。
2. 唯一updates修正去掉伪数量，保留有效建议，没有把假设准备工作写成公司事实。
   但reasoning仍写“一旦后续联调发现问题或供应商侧出现延迟，将直接导致无法按期履约”。
3. 修正后的反例检查返回findings=[]。
4. 原完整终审六字段及整体均true，实际返回该pair。其理由把修正数量后的评估当成
   已恰当限定，没有忠实核对存续的必然后果。不是schema失败或只是整体false。

主代理和独立审查均判失败：来源没有说明问题无法及时解决或延迟必越过交付期限。
draft中的“可能”与qualified_inference标签不能使内部reasoning的必然断言成立。
本轮目标是正确最终pair，而不只是一条有效反例或成功调用，故不提升为语义通过。

[完整请求响应](evidence/iris-counterexample-review-20261001.json)、
[独立语义审查](evidence/iris-counterexample-review-20261001.independent-review.json)、
[执行审计](evidence/iris-counterexample-review-20261001.audit.json)、
[停止记录](evidence/iris-counterexample-review-20261001.halted.json)、
[18份证据清单](evidence/iris-counterexample-review-20261001-manifest.json)。
已核对全部wire/response哈希、raw与client内容、用量、冻结来源哈希与逐请求quota。
四次调用前精确qwen3.8-max页面均849.65K/1M、2026-12-18到期、用完即停开启；
结束页面同值，可能滞后，不作账单审计。本轮没有新代码修改，未重复跑Core测试。

四处处置沿用上表：README、交接、台账和基线已同步本次失败；白皮书仍
reviewed-unchanged，失败且默认关闭的候选没有修改稳定运行流程。
登录阻塞已解除，当前不等待权限或额度；真正未解决的是必然后果漏检。
这个反例检查候选已经停止，不启用默认、不重跑碰运气，也不从一次失败断言模型
能力是唯一原因。候选实现保留默认false及本地提交历史，不属于已接受产品能力。

代码候选已改但未默认启用／本地通过／实模语义失败／真实飞书未验收／未部署。
原语义缺陷未关闭。没有push、生产访问、模型切换或飞书消息。
