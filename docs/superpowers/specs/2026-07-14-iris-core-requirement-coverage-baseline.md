# Iris 核心需求覆盖基线

## 2026-10-08 后续：依赖建议须明确当前决定如何调整

dd091d9f的[来源位置实模](../../development/iris-source-selection-20261008.md)4HTTP200/
11385tokens：首负例正确，正例引用完整但被审核接受的建议仍重复核实已知状态，独立
语义失败。该候选未通过产品门槛。[后续固定建议修正](../../development/iris-decision-gate-20261008.md)
去掉无用角色，明确条件性调整当前决定；c7a286f3本地Core5118通过/471条件跳过、
类型/构建/CLI11通过，同四例8HTTP200/22280tokens，2个正确初判沉默和2个有依据的
条件调整意见获独立语义通过。没有修正/撤回分支采用，不能推广为完整能力通过。
IRIS-CORE-005仍**部分实现**，真实错误发言及QA追问缺口不因此关闭；没有生产部署或重新开窗。

## 2026-10-08 后续：将引用复制改为来源范围选择

[位置选择候选](../../development/iris-source-selection-20261008.md)只移除模型重新抄写引文
的职责，保留完整来源、关系审核、撤回和一次修正。代码/本地/实模/真实群/部署层级按该
记录分别核对，不能因位置合法提升语义结论。IRIS-CORE-005仍**部分实现**；真实意见误判、
重复意见抑制及主动发言后接住追问的完整体验继续开放。此次不启用QA或生产窗口。

## 2026-10-08 最新：撤回出口本地通过，实模正例未产生合格意见

[source-plan撤回候选](../../development/iris-opinion-withdrawal-20261008.md)允许来源生成
推翻初判，严格无自由正文且不发送；现有持久化仍为blocked而非初判skip。
Core5098通过/471条件跳过、类型/构建/CLI及69项定向通过。43b8bb3e的受限四例实模仅
完成首负例与第二正例：4HTTP200/9651tokens，首例正确初判skip，正例因引文重复漏字
且修正无效而执行失败，后两例未调用；新撤回分支未获实模使用证据。真实错误发言仍为
失败，新候选未通过完整合成或真实群验收、未部署，IRIS-CORE-005仍**部分实现**。

## 2026-10-08：真实主动意见出现误判，不能升级产品通过层级

[真实发言失败](../../development/iris-pd-real-opinion-20261008.md)走完模型→评估→审核→
飞书sent及原文回读，4次HTTP200/25899tokens。独立来源判断应沉默，实际把明确的时间
条件误作尚未验证却直接推进，用户认为错误或打扰，故**真实意见语义验收失败**。
上一应沉默负例的有限通过保留，不能抵消该失败。@追问因本窗QA关闭且随后global关闭
未接通；完整主动协作与后续交流仍未验。IRIS-CORE-005仍**部分实现**。
生产仍51937b95，窗口恢复global/desired/PD关闭、policy10/revision3424，无新应用部署。

## 2026-10-08：一个真实群应沉默负例通过，主动意见质量仍未验

[实际新窗口](../../development/iris-pd-real-skip-20261008.md)完成真实成员输入→逐次免费
许可→qwen3.8-max HTTP200/7217tokens→持久skip/no_work_value→无投递→关闭恢复。
独立仅看来源的应沉默预期与实际决定一致；20条消息来源回读哈希匹配。本例是普通会议
时间协调，属于**首个真实应沉默负例有限通过**，不能证明实质问题发现、意见生成/审核、
真实发言及回执、重复/已处理/新依据或@追问的质量。IRIS-CORE-005仍**部分实现**。
生产应用51937b95、工具74949186临时接入，最后global/desired/PD关闭、policy8/revision3418，
未发布新应用或push。后取来源不能还原精确原始上下文，旧失败和限制保持。

## 2026-10-08：修复后的门禁生产接线通过，连接故障窗口无真实触发

[实际新窗口](../../development/iris-pd-window-20261008.md)在Core51937b95中验证60秒许可/
30秒上游/120000ms专用客户端与原样wire传递；均是假上游接线检查，不是语义通过。
域名SSH路径中断后，通过保留原主机身份校验的直连完成关闭恢复；policy6 disabled、
global/desired/PD关闭，旧取消任务保留，新触发/真实HTTP/意见均0。
工具临时接入已验证，应用未换版；IRIS-CORE-005仍**部分实现**。实际判断、意见文本和
回执质量仍待新有限窗口的真实输入，不能因多次受控收尾而升级验收层级。

## 2026-10-08：收到真实触发，监督等待在模型调用前超时

[实际窗口与有限修复](../../development/iris-pd-window-20261007.md)记录10月7日原群1条
真实触发，但20秒许可截止先发生，provider HTTP/tokens/飞书意见均0；这不算模型沉默
通过。自动关闭恢复已验，生产应用51937b95，global/desired/PD关闭，任务cancelled保留。
本地调整许可60秒及配套专用客户端120秒，回归、编译接线与人工完整流程通过；新工具
未用于生产，未新增真实模型或飞书语义证据。IRIS-CORE-005仍**部分实现**，下一门槛是
成员就绪后新有限窗口的真实判断/意见验收，不能用更多工具测试替代。

## 2026-10-06：首窗生产接线与恢复通过，真实语义尚未执行

[实际首窗](../../development/iris-pd-window-20261006.md)已获具体授权并执行；应用51937b95，
同容器免费门禁、专用配置和非PD入口隔离现场验证通过，原群可读。窗口内无真实讨论触发，
provider HTTP0、飞书意见0，不能更新为实模语义或真实群通过。结束global/desired/PD关闭，
能力及env恢复，非Core不变。IRIS-CORE-005仍**部分实现**；下一步需真实成员就绪后的一次
有界讨论输入，而非再批准相同用途、重复本地接线测试或无人值守自动重开窗口。

## 2026-10-06：真实单群准备发现启用范围与逐次免费许可差异

[有限试点准备](../../development/iris-pd-supervised-pilot-20261006.md)区分PD原群名单与global
所恢复的其他入口、专用模型配置与每次HTTP免费核对。新增试点工具和本地验证不改变
产品介入判断，不新增实模语义或真实飞书证据。生产最后状态仍51937b95、global/PD关闭，
IRIS-CORE-005仍部分实现；真实群材料、专用凭据用途、开关/外发尚未获得本阶段授权。

## 2026-10-06：51937b95生产发布与关闭状态验收通过

[发布记录](../../development/iris-release-51937b95-20261006.md)：已实际部署Core51937b95，
0059/0060迁移完成，备份机外解密/PG-RDB校验、live21项、新表权限、队列、公网边界
通过。普通QA配置保持，global/desired/PD关闭，mode=legacy/source=shared。
代码与迁移已到生产，不等于启用主动讨论；未新增模型测试或真实飞书质量验收，
IRIS-CORE-005仍部分实现，原限定语义及历史文档1200字等局限保留。

## 2026-10-06：窗口外历史basis原文恢复的有限修复

[应用51937b95](../../development/iris-pd-history-basis-20261006.md)补齐已核验basis引用到
原文的读取，精确ID/哈希/快照及读取后权限复核保持。原PG18、其余PD链路94、新历史25、
Core5082/471条件跳过、类型/构建和独立审查通过，精确CI37411237495全通过，含完整PG、
服务启动、权限、备份恢复和Redis故障演练。保留历史
文档1200字截断的局限；没有新增实模语义、真实飞书或部署通过，IRIS-CORE-005仍部分实现。

## 2026-10-06：授权发布与CI测试合同修复，尚未部署

[发布执行记录](../../development/iris-deploy-20261006.md)：已获准push/免费CI及有门槛的
Core/0059–0060发布；2116首次CI暴露过期HTTP mock，测试修复341f7c8a保留原验收要求，
本地真实PG并发39通过、Core5057/471条件跳过及类型通过。应用输入与2116完全一致，
第二次CI通过39并发/6e2e后发现历史basis原文缺失的2个真实应用失败，旧候选停止发布，
有限修复进行中。已找到本机既有备份身份并核对接收方，维护未开始。生产仍f6a6dd41/0058、
PD表不存在，重新核验live global=false、desired=true；不据此擅自启用。IRIS-CORE-005
仍部分实现，限定合成结论保持，没有新增实模语义或真实飞书通过。

## 2026-10-06：本地发布候选依赖修复与镜像准备

[发布准备记录](../../development/iris-release-readiness-20261006.md)处理真实构建暴露的
Fastify/fast-uri运行依赖告警，保留精确镜像、audit及本地回归层级。没有改变主动讨论
语义合同，不新增真实模型、真实飞书或部署验收；IRIS-CORE-005仍部分实现。生产仍以
10月4日只读快照为最后观察，不将本地新版本当成上线。

## 2026-10-06：主动讨论独立模型配置的本地接入

[配置隔离记录](../../development/iris-pd-model-isolation-20261006.md)增加显式shared/dedicated
选择，覆盖runtime、CLI、Compose与可选传输参数；普通问答仍用原通用配置。专用配置
缺失不回退，选择模型不启用发言。验证详情以该记录为准，无新增实模、真实飞书或部署
验收；IRIS-CORE-005仍部分实现。10月4日的生产快照和有限Qwen证据保留各自时点/范围。

## 2026-10-04：生产只读差异已核验

[快照](../../development/iris-production-preflight-20261004.md)确认生产Core f6a6dd4、
Gemini3.5FlashLite、迁移0058，无新PD模块/表；原群持久化主动发言关闭。新版本未部署，
Qwen的有限合成语义证据不能迁移为Gemini通过；内存global状态未核验。IRIS-CORE-005
仍部分实现，本次只读授权不包含模型切换、迁移或真实群发送。

## 2026-10-04：补齐来源计划pilot环境配置

[Compose修复](../../development/iris-opinion-pilot-config-20261004.md)解决显式source-plan
未进入Core容器的问题；真实Compose36项、Core相关10项通过，默认legacy及关闭状态保留。
这是部署配置本地验收；IRIS-CORE-005仍部分实现，生产版本/模型、真实群和部署未核验。

## 2026-10-04：来源计划真实PG到模拟发送通过

[本地跨模块验收](../../development/iris-opinion-postgres-20261004.md)补齐实际source-plan
模型到PG评估/待发任务/回执：正确预算意见模拟发送一次，假设讨论无计划和投递。
归档响应离线驱动，完整e2e文件6通过/0跳过，typecheck通过；应用仍1ea3ae7e，无新增
模型调用。IRIS-CORE-005仍部分实现，真实飞书、生产精确版本和部署均未验收。

## 2026-10-04：主动讨论通过限定合成语义门槛

[来源计划接入记录](../../development/iris-opinion-runtime-20261004.md)：应用397fedbf的
八业务例最终结果及两项数值角色/新旧时序负控通过（跨保留与恢复窗口24HTTP200/
89408tokens）。两负控首次完整模型审核均具体识错，唯一修正后返回正确pair；不是
全拒通过或本地字面检查代替语义。初判及审核解释缺陷仍记录，泛化未证明。
本地runtime/eval增加共用`legacy | source-plan`可选合同，默认legacy；实际本地验证
以同记录为准。IRIS-CORE-005仍部分实现，真实单群投递、生产精确版本和部署均未核验；
不扩建旧逾期提醒链路。以下保留既往实验状态，旧“未通过”不覆盖本段限定结论。

Direct-opinion continuation failed: 6HTTP200/23814tokens, arithmetic passed narrowly but
qualified risk retained an unsupported necessary consequence approved by scope review. Three
cases uncalled; candidate off. No increase to complete IRIS-CORE-005 coverage.


Direct-opinion follow-up: 4HTTP200/20416tokens, final cost-update semantics passed but original
execution failed on a clause-comma count receipt. Corrected deterministic four-response replay
passed; five fresh cases remain. No whole-window or production acceptance claimed.


## 2026-10-01: Direct initial-opinion candidate

[Assessment projection](../../development/iris-assessment-opinion-20261001.md) removes the second
free generation. Core4906/469 skipped, type/build/CLI7 passed; default off pending semantics.
Predecessor continuation failed unsupported supplier premise despite correct 24/+8/14 arithmetic
(3HTTP200/10272tokens); two silence cases uncalled. IRIS-CORE-005 remains partial.


## 2026-10-01: Source focus and Chinese count receipt

[Bounded continuation](../../development/iris-source-focus-20261001.md): source-bound candidate
11HTTP200/36632 tokens passed inference and risk semantics; arithmetic final semantics passed
but original execution failed on 两人/2人 receipt. Fixed unchanged-response replay passed; three
cases remain uncalled. IRIS-CORE-005 remains partial, candidate off, no deployment/Feishu claim.


## 2026-10-01: Canonical opinion candidate

[Single-body projection](../../development/iris-canonical-opinion-20261001.md) removes separate
internal prose generation, with complete original review and one correction retained. Explicit
local option defaults off. Core4872 passed/469 skipped; later focused11 includes two added tests.
Six HTTP200/17924 tokens: risk passed narrowly, inference failed on an unsupported severe sample
bias assertion that original review approved. Four cases uncalled; candidate stopped and off.
IRIS-CORE-005 remains partial, no full semantic, deployment or Feishu acceptance.

## 2026-10-01: Counterexample review candidate

[Explicit local candidate](../../development/iris-counterexample-review-20261001.md) binds
hypothetical counterexamples to current candidate quotes and preserves one correction plus full
final review. Default false; runtime not enabled. Core4860 passed/469 skipped, type/build/CLI7
passed; final focused17 includes three added cases. After login recovery, four HTTP200/11011 tokens
returned a pair still containing an unsupported necessary consequence: the second challenge was
empty and final scope review approved it. First-case semantic failure, five controls uncalled;
candidate stopped, default off. IRIS-CORE-005 remains partial; no semantic or Feishu acceptance.

## 2026-09-29: Program-bound proactive prose

Follow-up [explicit correction updates](../../development/iris-repair-updates-20260929.md) retains
unmodified current candidate prose instead of requiring a full rewrite. Complete final review and
the one-correction bound remain; no acceptance upgrade without the bounded real-model results.

Application `a2b3c449`: Core4853 passed/469 conditional skips, type/build and CLI7 passed.
Five HTTP200/16794 tokens: frozen correction and final review passed narrowly; fresh risk initial
review approved unsupported quantities and certain consequences, then failed schema on an empty
unit. No correction/final review for that case; four later cases uncalled. IRIS-CORE-005 remains
partial, with no real Feishu acceptance or deployment.

The [generation/correction contract](../../development/iris-bound-prose-20260929.md) separates
editable prose from program-held identity and references. The preceding six-HTTP recovery
window still failed at a malformed hash in risk generation. Contract correctness does not upgrade
IRIS-CORE-005 from partial implementation; real semantic and Feishu acceptance remain distinct.

Application `3e7636b8`: Core4845 passed/469 skipped; final focused43, type/build and CLI7 passed.
The new 4HTTP/11706-token window failed at the sole repair after review correctly rejected
unsupported numeric claims. New issue description was null; change explanation confused the
internal edit with business change. No final review; four remaining cases uncalled. No upgrade
to semantic acceptance, production deployment or real Feishu completion.

> 基线日期：2026-07-14
> 最高架构依据：`2026-06-30-iris-architecture-whitepaper.md`
> 判定规则：只有存在可运行代码路径和自动化/真实验收证据时才标记为“已实现”。仅有配置项、类型、接口或 capability 开关不算实现。

> 阅读规则：这里记录能力及带日期的验收，不是实时运行开关。先读[当前接手入口](../../development/current-handoff.md)，再核对对应发布记录；历史修订不能覆盖较新的同范围证据。
> 每次 Bug 修复必须按[白皮书四处同步门禁](2026-06-30-iris-architecture-whitepaper.md#112-mandatory-bug-fix-documentation-closure)核对此基线；状态不变也需在修复记录说明原因并链接本节。

## 1. 版本边界

- 当前目标是公司内部 20-30 人使用的单公司版本，先保证核心体验和权限安全。
- “多人使用”指同一飞书群中的多人共享 Iris、上下文和结果，属于当前核心范围。
- 自助安装、多公司、多租户、计费和租户级隔离属于白皮书演进阶段 4，不属于当前内部 MVP；现有设计必须避免阻塞后续产品化。
- 当前生产版本已经具备安全聊天、文档和知识库检索、知识发布执行、默认关闭的主动信号链路和带文档源/知识草稿/发布队列/主动候选/审计摘要治理的最小 Admin Console，但不能称为完整 Iris。

## 2. 核心需求追踪

| ID | 核心需求 | 当前状态 | 现有证据 | 缺口与完成标准 |
|---|---|---|---|---|
| IRIS-CORE-001 | 同一飞书群中的多人可以共同与 Iris 协作，并从前一个人的上下文继续 | 内部 MVP 已实现 | 所有已启用群消息进入 `conversation_messages`；回答读取最近群聊、当前群 active 长时记忆及相关 open thread/action；普通非 @ 消息可异步形成同群共享状态；飞书回复所有群成员可见；真实六步语义灰度验证了同群共享状态与 control-group 隔离 | 先在 3-5 人单群日常 pilot 观察真实协作质量；跨群共享不属于首版内部 MVP |
| IRIS-CORE-002 | Iris 被拉入群后持续接收群消息，即使未被 @ 也理解讨论 | 内部 MVP 已实现 | Feishu Gateway ack-first；Raw Event Queue；消息事实持久化；普通非 @ 文本异步抽取；同群证据绑定；semantic thread 的 candidate/open/resolved/reopened/merged 生命周期；显式 commitment/action 生命周期；回答时当前群检索；真实六步非 @ 消息灰度形成唯一 thread/action 且无主动发言 | 在受控日常 pilot 中观察业务语言覆盖；失败进入可重试/DLQ，不扩大到未启用群 |
| IRIS-CORE-003 | Iris 随时间学习，用户不必重复解释业务背景 | 内部 MVP 已实现 | Postgres `group_memories`、`discussion_threads`、`action_items` 与 append-only events/evidence；置信度与候选隔离；幂等、重试、冷却、DLQ 与 projection repair；版本化纠错；当前群 bounded retrieval；真实六步灰度验证 create/promote/resolve/reopen 与 action create/complete | 先通过真实日常使用校准抽取质量；广泛跨群记忆共享仍保持关闭 |
| IRIS-CORE-004 | 在授权后跨群和跨数据源学习 | 首个跨群文档回答闭环已实现（默认拒绝） | 精确 SHA CI（含真实 PostgreSQL 迁移/并发）通过；真实三群验收验证授权前隔离、精确授权后受权群回答、对照群隔离、撤销后立即拒绝、重新授权与幂等重放，并完成默认拒绝回滚；当前群文档、授权知识库、用户手动提交文档继续使用统一文档源和权限策略 | 跨群记忆和跨群知识草稿仍缺失；主动跨群使用、任务/知识库写入、通配授权和广泛发布仍未实现，后续必须分别设计、验收且继续默认隔离 |
| IRIS-CORE-005 | Iris 主动发现需要关注的信息并更新群成员 | 部分实现：旧人工提醒已验收；主动讨论限定八例与两负控实模通过，本地接入见最新记录，真实单群未验收 | Phase 6A 旧时间触发提醒的真实验收保留。[主动讨论设计](2026-09-09-iris-proactive-discussion-design.md)与[实施计划](../plans/2026-09-14-iris-proactive-discussion.md)已批准；Task 1–7 基础/上下文/模型边界/状态/发送/连续追问/实际装配通过局部真实 PG 与独立审查，见[执行记录](../../development/iris-proactive-discussion-execution.md)。Task 8 `89f299f5` 端到端/runner/CI 配置通过 Core 4607 项、逐文件门禁 86 项（83 真实 PG）、Python 181、pilot 脚本 182 及类型/构建/Compose，后续 `7a0a2e38` 修复和唯一范围复审通过，见[专项记录](../../development/iris-proactive-discussion.md) | 配置已找到；run1–5及失败保留。已确认的[2026-09-16联合复核修复](../../development/iris-proactive-discussion-joint-review-20260916.md)让判断/文案共享最终组合并限制一次修正；拒绝重排及同refs换题的回归、最终提交和模型结果以该记录为准，不再等待同一设计批准。精确SHA CI与当次授权的真实单群投递/停止/恢复仍待；生产未启用，不设固定冷却阻挡新问题 |
| IRIS-CORE-006 | Iris 跟进沉寂但未解决的讨论或任务 | 旧提醒链路已实现（默认关闭）；非本轮产品目标 | 现有同群 thread/action 时间扫描、版本绑定、幂等候选、人工批准和一次真实反馈/暂停验收仍保留 | 2026-09-09 用户明确不以重复催办作为主动参与；飞书任务负责原生提醒。不扩建或启用该旧链路，也不以它替代 IRIS-CORE-005 的新验收 |
| IRIS-CORE-007 | Iris 将讨论整理成内容，先发群里让用户确认 | 已实现 | Phase 5A Postgres 知识草稿事实层；5B-1 版本绑定群确认/修改/拒绝卡片；5B-2A `ActionProposal`、风险矩阵、目标策略、角色 grant、负责人/管理员审批卡片、实时授权、治理 API、幂等 callback 与 readiness；5B-2B 飞书 OAuth + PKCE、完整正文/哈希审阅、append-only attestation 与批准前精确门禁；真实 Feishu pilot 已覆盖群确认、请求修改、负责人/管理员批准、撤销和私聊审批卡；Admin Console 已具备知识草稿状态/列表摘要、安全请求修改/拒绝入口，以及发布/action proposal 队列治理入口 | 批量审批、复杂协作编辑和更细的 reviewer 映射进入 backlog |
| IRIS-CORE-008 | 用户确认后同步到飞书知识库 | 已实现 | 5B-3 飞书知识库发布执行器、授权 wiki root、幂等 publication execution、失败恢复/对账、回群结果和真实 Feishu pilot；未经确认、审阅和所需批准不会写入 | 后续补充批量发布、冲突检测、发布模板和更友好的发布历史页面；核心写入闭环已成立 |
| IRIS-CORE-009 | Iris 回答时读取授权飞书知识库 | 已实现 | 授权 Wiki 注册、解析、同步、向量检索、实时权限二次校验、引用和真实飞书验收 | 后续补充知识冲突识别和知识更新草稿，不影响当前已实现判定 |
| IRIS-CORE-010 | Iris 读取所在群中出现过的可读文档正文 | 已实现 | 群文档链接发现、正文抓取、来源证据、同步、索引、群可见检索和真实飞书验收 | 后续扩展更多文件类型和解析质量 |
| IRIS-CORE-011 | Iris 读取用户手动提供的文档 | 内部 MVP 已实现 | 手动文档注册、同步、来源策略和回答检索；Admin Console 与飞书群内显式提交命令均可登记 `user_submitted_document` 并入队同步；真实飞书验收验证全新文档提交、双 evidence 幂等、同步/索引、实时权限校验、后续普通问题命中目标文档且未误入提交命令路径 | 更细的用户级文档治理和更多文件类型进入 backlog；日常 pilot 观察员工提示语与引用质量 |
| IRIS-CORE-012 | 文档/知识库权限撤销后不得继续泄露内容 | 已实现核心边界 | 答前实时 Feishu Permission Guard；拒绝审计；fail closed；权限回收真实验收 | 后续增加权限变更主动失效和批量回收，但答前安全边界已成立 |
| IRIS-CORE-013 | 高影响行动执行前必须询问并获得确认 | 通用审批、完整正文审阅、知识发布与受治理建任务均已通过真实 pilot | 5B-2A 为 `publish_knowledge_draft` 建立 proposal -> requirements -> approval 事实层、风险矩阵、实时角色复验、版本失效和共享飞书回调；5B-2B 要求批准前存在当前精确审阅事实，并已通过真实 Feishu OAuth review pilot；5B-3 已把首个批准后的 `publish_knowledge_draft` proposal 幂等发布到授权 Feishu wiki root；`create_feishu_task` 真实单群 pilot 复用了同一 proposal/review/approval 契约，并验证精确 assignee、task-spec hash、Task v2 client token、唯一远端任务、官方回读、唯一结果卡和最终安全关闭；内部 API 不能伪造人工批准 | 跨群通知、批量审批、复杂协作编辑和更细 reviewer 映射进入 backlog；日常 pilot 继续观察可读性与业务语言质量 |
| IRIS-CORE-014 | 管理员可以全局/按群开启关闭 Iris 和能力 | 最小 Admin Console 已实现 | Postgres 持久化 runtime control；全局、群和 capability API；紧急停用真实验收；`/admin` 浏览器控制台可读取系统状态、readiness、runtime control，并可操作全局、群和 capability 开关；同一控制台可查看文档源摘要、同步健康、权限状态，并可按源切换回答/知识草稿策略与触发手动同步；知识草稿和正式任务草稿/执行仅暴露内容无关摘要，并提供安全请求修改/拒绝/回查入口；action proposal 队列可查看 pending/approved/executing/failed/reconciliation work 并执行安全请求修改/拒绝；主动候选治理可扫描单个显式群、查看候选并执行 dismiss / approve delivery；审计摘要视图可按事件类型/文档过滤查看 retained/dropped/inspected/matching 与聚合事件窗口；Caddy 仅放行精确静态 console 路由，`/internal/*` 仍保持 404 | 仍需增加持久化审计仓库和正式管理员身份模型；当前版本先满足 20-30 人内部运行控制 |
| IRIS-CORE-015 | 多人安装和多公司使用 | 按白皮书延期 | 白皮书演进阶段 4 明确 multi-company / multi-tenant productization | 内部 MVP 稳定后增加 tenant ID、安装流程、租户密钥/数据隔离、租户管理员和计费 |

## Status Amendment - 2026-09-09 Proactive Discussion Design

- 用户已确认 Iris 应主动发现工作讨论中的明显问题并表达理由、专业判断和建议；有依据但未证实的风险可明确表述为怀疑，不要求知识库已有答案。
- 固定每日两条、同事项 24 小时冷却及重复飞书逾期提醒的提案已被否定；新问题不被固定间隔挡住，同一问题按实质新依据、已回应/已解决状态和用户反馈去重。
- [专项设计](2026-09-09-iris-proactive-discussion-design.md)限定原试点单群，采用独立消息事件评估和真实策略授权，不伪造逐条人工审批；不扩大跨群主动来源或高影响执行权限。
- 2026-09-14 书面设计确认并编写[实施计划](../plans/2026-09-14-iris-proactive-discussion.md)时，尚无新实现或验收；之后开始实施，2026-09-15 更新到 Task 1–7 局部门禁通过（含 Task 4 审查修复、Task 5 发送边界、Task 6 两次来源延续及 Task 7 实际运行装配），见[执行记录](../../development/iris-proactive-discussion-execution.md)。尚无真实模型验收或部署证据，IRIS-CORE-005 不提升为完成；原三群问答的已记录发布不变。
- Task 8 已补非 @ 真实 ingress/PG/worker/回执/普通追问端到端、同问题停止与新问题连续发送，CLI 默认对固定合成集逐例执行两个独立轮次，CI 显式接入 PG 三文件及 CLI 测试。实际结果、保留失败和[下一层验收](../../development/iris-proactive-discussion.md)分别记录；模型配置缺失使实际命令退出 2，不能提升为实模内部验收或真实群交付。
- 2026-09-15 最终审查后的 I1–I4 [合并修复](../../development/iris-proactive-discussion-final-fixes.md)补齐
  issue 文字全来源、从未尝试 stale 首次意见恢复、所有者续租和启动登记重试；Core 4613 通过 /
  463 条件跳过，真实 PG 及实际 model payload/普通 Q&A 去重证据单列。应用提交、保留失败、0060
  迁移/旧未知来源限制、四处处置和一次范围复审边界见该记录。IRIS-CORE-005 不提升为完成，
  实模、exact-SHA CI 与真实单群投递/停止/恢复仍未验收。
- 本修订澄清 IRIS-CORE-005 的实际缺口，不抹去旧 IRIS-CORE-006 和历史 P1 灰度成果，也不将“旧提醒卡能发送”写成语义主动协作已完成。

### 2026-09-15 首次两轮实模未通过

- 用户明确授权后在服务器独立进程中就地复用既有模型配置，未下载密钥或读取生产群历史。
  被评估应用 `7a0a2e38`、模型 gemini-3.5-flash-lite，固定 15 例两轮退出 1；
  [原始报告、逐例语义复核和边界](../../development/iris-proactive-discussion-model-eval-20260915.md)受版本控制保存。
- 7 个可见决策均正确，但 23 次 assessment_failed、1 次 render_failed；1 个完整结果缺明确 6 万差额，
  另 1 个不完整结果的 assessment 缺总成本增量 8 万。5 项通过、1 项失败、24 项未可完整评估，
  没有场景两轮通过。空 assessment 不能写成模型错误决策；稍后一次 HTTP 200 不能归因原失败。
- 本地审查已经完成、配置不再缺失，但实模门禁仍未通过，IRIS-CORE-005 不提升为交付。
  无部署、外发、开关变更或新健康/队列验收；只读容器/配置身份未变不替代生产验收。
  下次仅处理失败分类和数值表达后复跑原有限集，不重开既有 I1–I4 范围审查或无限加固。

### 2026-09-15 有限模型修复与 run3 仍未通过

- `d9200703` 补安全诊断、空结果不误算决策及完整数值表达；`d2db25be` 补正面介入边界、
  推断限定及 eval-only HTTP pacing。完整 Core 4622 通过 / 463 条件跳过、CLI6、类型/构建/
  独立runner编译及有界复审通过，见[修复、四处处置和原始证据](../../development/iris-proactive-discussion-model-fixes-20260915.md)。
- run2 的21个HTTP429、两个真实漏报另存，不倒推run1未知归因；run3同模型同15例两轮、
  6000ms评估请求间隔，无429但仅24通过/4失败/2未完整。两次漏报、两处事实或推断扩写、
  一项assessment_validation与一项draft_rejected仍阻塞；不能把缺失输出当成安全通过。
- IRIS-CORE-005仍部分实现、未部署/未启用。下一步先补合成评估中被拒稿/复核/固定校验原因的
  安全证据，据真实机制形成有限修复方案；不继续盲加提示或反复抽样。不重开Tasks1–8/I1–I4已闭合审查。
- 新脚本节奏只用于评估容量处理，不是Iris发言冷却；未改生产权限、写库/任务执行或问答范围。
  精确SHA CI与原单群真实投递/停止/恢复仍需当次授权与独立证据。

### 2026-09-15 合成诊断与阶段合同修复

2026-09-15 最新主动讨论修复：`68f16e04`增加固定合成trace、纠正结构校验被表述为语义核准；
`fbd18724`补齐triggerMessageId到唯一授权正文的绑定。Core4631通过/463条件跳过、CLI7及有界复审通过。
[本次记录](../../development/iris-proactive-discussion-model-trace-20260915.md)分别保存run4的25通过/5失败/0未完整、
run5的26通过/2失败/2未完整。run5全部30个决策正确不等于完整assessment/draft语义合格，
拒稿中有正确拦截也有误判。下一步先确认有限联合复核设计，不原样抽样。
IRIS-CORE-005仍未通过实模、未部署/未启用；不因诊断可用或局部改善提升完成度。

### 2026-09-16 判断文案联合复核

用户已确认最多一次成对修正、一次最终复核的有限方案，见[本次实现与门禁记录](../../development/iris-proactive-discussion-joint-review-20260916.md)。
worker/evaluator共同消费最终assessment/draft；拒绝不得被上下文重排恢复为语义重试，
新问题改写必须与原问题比较，不能仅凭refs相同视为同题。成功路径不增加调用、来源或权限。
最终应用ee9a8ae2通过Core4649/469条件跳过、独立PG门禁110项（107真实PG）、CLI7及有限复审；
run6虽然30个决策正确、无执行错误，完整语义仍26通过/4失败/0未完整：数字遗漏、内部断言仍被模型复核放行。
首次Core4648/465条件跳过及PG超时、RED等结果保留；下一步是模型/校验方案决策，不重批同一设计。
IRIS-CORE-005仍部分实现，代码/PG/真实模型/CI/真实飞书分别验收，不等于已部署或启用。
此前run1–5及未通过事实保留，不原样重跑直到绿色。

### 2026-09-17 同模型合同诊断

用户批准先查自身集成后，[分层诊断与修复](../../development/iris-prompt-contract-diagnostic-20260917.md)
应用`01ee7c31`补齐模型输入字段关系、复核/修正的授权算术与数值保真规则，未放宽validator、
未增加调用。Core4651通过/469条件跳过，CLI7、类型/构建和有限审查通过；没有重跑真实PG或远端CI。
固定本地Qwen/同题/seed1709，修复前后都能直接识别预算问题；修复后原始决策改善，但issueRef仍null，
两次原完整链仍未完整，隔离手工assessment后的文案通过不可替代。只10次本地合成请求，模型服务已停止。
IRIS-CORE-005仍部分实现、未通过完整实模和真实单群投递门禁，未部署/启用；下一步明确结构化输出与
程序状态边界，不将合同回归或单次原始判断提升为交付，不盲换模型或反复抽样。历史失败保留。

### 2026-09-17 主动判断输出适配

[本轮修复与验收记录](../../development/iris-assessment-wire-fix-20260917.md)把独立字段生成改成合法分支，
严格解包后仍使用原validator；不改变外部PdAssessment、权限、沉默判断或调用上限。
同一本地免费模型在最终提交的有限推理配置下已走通原arithmetic完整链，但仍漏6万差额且被复核误放行；
原60秒配置的最终两条复测超时，结构修复不代表语义或生产时延通过。
尺寸优化前候选的原15例两轮为19通过/8失败/3未完整，证据与剩余门禁见专项记录。
IRIS-CORE-005仍部分实现；未部署、启用主动发言或重跑云端。

### 2026-09-17 JSON 模式兼容

[本轮兼容修复与原始证据](../../development/iris-json-mode-compatibility-20260917.md)增加Core显式json_object传输，
默认仍原生json_schema，完整schema进system、原本地领域校验及调用上限不变，memory worker不受影响。
第四免费窗口的原生请求HTTP200却缺必填字段并带Markdown，不能视为格式通过；修复后最小JSON模式请求
HTTP429且无输出，尚不能评价真实云端兼容性，更没有完成新版原算术/15例两轮。应用`a5e5e2e4`已通过
Core4673/469条件跳过、类型/构建；Compose+CLI40通过/1因Docker不可用跳过，其中CLI7通过。
实际Coreclient的新JSON模式在同一本地模型最小格式1次HTTP200通过，不能替代Zhipu或主动语义验收。
未获得新真实PG或云端语义验收，精确SHA和全部结果见专项记录。
两个本地review/focus实验未解决目标缺陷且未推广；原数字/事实类别、漏报及重复介入失败继续保留。
随后3例固定稿引用核验原型均HTTP200：缺差额算术为supported=true/receiptValid=false，
正确算术为true/true，错误事实类别inference为false/true；逐字引用存在不代表事实正确或检查完整。
第二项狭窄引用门禁已接入既有一次pair repair；旧正确稿因引用借用其他字段而误拒，失败保留。
引文候选收窄为当次draft原样句段/全文或null后，正确稿1次HTTP200返回原pair，缺差额稿3次HTTP200、
两次raw true被完整数字凭据检查拦截、唯一一次修正后最终null，但仍漏6万元且保留过度断言。
这是局部正向返回和负向拦截，不是生成或完整语义通过；详见[实际对照](../../development/iris-json-mode-compatibility-20260917.md#当次草稿引文枚举缺差额稿仍失败并被拦截)。
第二项应用`42db6b6c3678802acaf0c2936c67c8640e5f540c`已通过最终Core4716/469条件跳过、类型/构建，
Compose+CLI40通过/1条件跳过（Docker不可用，CLI7通过）；本地模型已停止。
只关闭两项有限实现与文档闭环，不沿用局部引文结果宣称完整主动语义通过。
合成expectedCoverage不进产品，原未改善spike不撤回；不宣称所有provider/JSON模式会强制执行enum。
随后[两项私有修正实验](../../development/iris-json-mode-compatibility-20260917.md#继续修复的两项私有实验均未推广)各2次HTTP200，均未推广、未改应用：
edit仍漏差额/过度断言却因final review只列10/16而实际返回错误pair；diagnostic仍原稿、最终假数字凭据被拒。
必要数字列表完整性仍未解决，不以字面引用通过或返回pair升级完成度。
随后[免费云端有限复测](../../development/iris-json-mode-compatibility-20260917.md#后续免费云端格式通过与算术失败或未完整分开)中，
250414与4.7第五窗口各一次最小JSON格式通过；前者原算术合法skip为语义失败，后者算术首请求429、无判断结果为未完整。
两者均未进render/full、未采用新型号；最小格式已验证但完整兼容/主动语义未通过，当前云端请求已停止。
IRIS-CORE-005仍部分实现，未部署、未启用主动发言、未真实飞书投递；不以传输适配或模型自评升级完成度。

### 2026-09-17 数字复核连续性

应用`d699761e7e0c9855a2bbcfb6e500a80375470706`修复最终审核遗忘初审数字项的程序缺口，见
[本次实现与验证](../../development/iris-review-continuity-20260917.md)。真实render离线重放已复现旧误放行；
现在必须保留当前有效凭据，或明确引用授权原文纠正/撤回初审，不强行保留错误数字。
Core4734通过/469条件跳过、类型/构建及Compose+CLI40通过/1跳过，独立范围审查通过。
这些结果不是必要数字发现、事实类别、推断限定、漏报/重复介入等完整语义通过；
本地实模正负对照各2次HTTP200：正确稿返回原pair，错误稿仍未修好、假数字凭据被拒，
原始记录单列；IRIS-CORE-005仍部分实现，未部署、未启用、未真实飞书投递。

### 2026-09-25 来源优先生成与完整实模复测

应用`dcaa2995`从授权原文共同重建判断与文案，保留原问题和权限结构，去掉旧推理改写模板。
前三阶段真实组合通过，不能替代完整集；[9月25日完整15例两轮](../../development/iris-source-first-generation-20260920.md#32-9月25日完整15例两轮)
66次HTTP200、195739usage tokens，独立结果22通过/3错误介入/3未完整/2内容错误。
重复或已处理事项仍介入、审核合同/数字凭据拒绝、基准原文投影缺失和过度断言均保留为实际失败。
本地新Core4770通过/469条件跳过、类型/构建和CLI7通过不提高IRIS-CORE-005交付状态；
完整语义、精确SHA CI和真实单群投递/停止/恢复仍待，无部署、启用或飞书外发。

### 2026-09-25 复核诊断汇总

[有界修复记录](../../development/iris-review-diagnostics-20260925.md)定位完整实模
`material-update`第二轮的本地缺口：初审 `supported=false` 提前返回，遮蔽同时存在的
`requiredNumbers[2]` 招聘人数 `2 人` 与草稿引用 `2 个` 不符，唯一组合修正未收到数字失败。
应用`45fe8968`汇总各项已知本地失败、保留模型否定并限制反馈长度，不改变单次修正或最终门禁。
4项测试先失败后通过，相关5文件90项通过；诊断修复后的完整Core260文件/4774项通过、
13文件/469项条件跳过，类型/构建exit0，独立范围审查69项通过并核对全部8项诊断与历史连续性。
后续上下文修复已另行提交为`a0a7f2a0`，不得把它追溯计入`45fe8968`的上述门禁；
本次诊断修复本身未做独立修复后的真实模型或群验收。
此前15×2的22通过/8未通过为旧应用实测，仍保留。
IRIS-CORE-005继续**部分实现**；精确SHA CI、完整语义和真实单群投递/停止/恢复未验收，
未部署、启用或飞书外发。

### 2026-09-25 当前讨论复核与旧基准原文

应用`a0a7f2a0`把只读当前讨论/已提醒状态传给初审、唯一修正及终审，并把已有问题
上次有效基准的当前授权原文引用并入生成/复核事实引用；变化引用保持锁定，
所需正文缺失时先失败，同引用文档片段全部保留。见[专项记录](../../development/iris-review-context-20260925.md)。
五项测试分阶段RED→GREEN，独立P1片段丢失已修，聚焦66、完整Core261文件/4779项通过、
13文件/469项条件跳过，类型/构建exit0；CLI7在最后片段修正前通过。
六个原始场景的一轮实模诊断18次HTTP200/65185 reported usage tokens，独立4通过/2未完整；
`arithmetic`与`material-update`均在数字/单位字面凭据处拒稿，后者中间内容另有缺+8
及无原文支持的审批/权限断言。旧`dcaa2995`完整15×2的22/30仍是不变历史。
历史基准若不在当前items内，仍缺正文加载路径，本次明确失败而非伪造证据。
IRIS-CORE-005继续**部分实现**；精确SHA CI、完整语义、真实单群投递/停止/恢复均未验收，
未部署、启用或飞书外发。

### 2026-09-25 数字字面凭据澄清

应用`bdef93c0`澄清通用数字/单位字面凭据和金额比较的完整表达，见
[专项记录](../../development/iris-literal-receipts-20260925.md)。六原始场景各一轮共
16次HTTP200/55390 reported usage tokens；执行层5成功、`inference`拒稿，独立语义
4通过/2失败。`inference`两次review误把本轮assessment视为历史已处理意见；
`qualified-risk`虽完成，却在最终assessment作过度确定的条件后果，review漏检。
原`a0a7f2a0`六例4/2及`dcaa2995`完整集22/30仍分别保留，不互相替代。
IRIS-CORE-005继续**部分实现**；本次无完整语义、精确SHA CI、真实单群或部署验收。

### 2026-09-25 本轮评估身份与真实历史分离

应用`04aa3a09`在初审、唯一修正和终审中仅传本轮问题的锁定身份/引用结构，
不再传旧assessment观察、理由、建议及变化说明正文；当前候选和真实讨论状态
仍独立提供，内部schema/运行时身份锁、数字连续性和最多一次修正未变。见
[专项记录](../../development/iris-review-identity-20260925.md)。修复前11项RED，
相关90项GREEN，独立四文件58项通过；提交前Core261文件/4781项通过、
13文件/469项条件跳过，类型/build exit0，CLI7项通过。
七例各一轮实模窗口已结束：17次HTTP200/55396 reported usage tokens，
`inference`因scope review validation失败、`paraphrase`误介入，执行未通过；
独立语义4通过/3失败（`inference`生成无依据的行业1%–5%转化率且review要求无法核算的绝对收入、`qualified-risk`过度确定而
review漏检、`paraphrase`无视真实历史同义复述）。原报告semantic字段pending
不回写。不能据输入路径修复推断条件后果确定性已修好。
前序完整集22/30及两次六例4/2失败均保留。
同应用thinking开启/budget4096的独立profile对照仅跑`qualified-risk`首例：
1次HTTP200/5486 reported usage tokens（含1614 reasoning tokens），审核六字段
与整体true、本地也true，仍误通过；其余四例未调用。不得把它写成五例结果或
把thinking当默认修复。IRIS-CORE-005状态不变。
另一次同应用的私有claims/draft物理隔离probe，先行preflight零HTTP退出；
最终首个`old-negative-arithmetic` claims控制1次HTTP200/1934 reported usage tokens，
实际wire无draft正文/凭据/schema仍漏`16−10=−6`及无依据确定风险，六字段和整体
true、本地true；其余五控制未调用。仅说明这个私有候选首例失败，不构成
全部六例结果、新产品方案或完整验收。
IRIS-CORE-005仍**部分实现**；完整语义、精确SHA CI、真实单群和部署未验收。

### 2026-09-29 不可核算数字状态

应用`88f7a169`将缺少计算输入与草稿缺少已知数值分开，未知状态不强制补0；
已知值、真实0、显式算术及连续性检查保留。[本轮记录](../../development/iris-unavailable-numbers-20260929.md)。
Core4824通过/469条件跳过，typecheck/build与CLI7通过（本次续接未重跑）。登录
恢复后6HTTP200/19517tokens：冻结pair及新鲜inference有限通过；预算生成返回
合法JSON但半句draft、无evidenceRefs，审核前被拒。窗口失败、后三项未调用，
预算/成本更新分类正对照尚未完成，风险与重复缺陷仍未关闭；不再等待登录或额度。
IRIS-CORE-005仍部分实现，未生产访问、部署或真实飞书验收。

### 2026-09-27 移除通用授权建议

应用`1f00cc0e`仅删除生成提示中无条件要求核对授权的指令，合理权限建议仍允许。
[有界记录](../../development/iris-advice-ablation-20260927.md)：82项相关测试及
typecheck/build通过；7HTTP200/28440tokens，冻结inference一次render有限通过，
全新inference因虚构必要0值而被终审拒绝，后3项未调用。语义审核可靠性未成立，
数值适用性、风险限定和重复问题仍待解决。IRIS-CORE-005仍部分实现，未部署或
真实飞书验收；不把此前全Core/CLI结果归入当前提交。

### 2026-09-26 明确算式程序核算

应用`60a8c2ac`在初审/终审直接核算候选中有限语法的明确算式，保留原句、位置、
符号和操作数，矛盾进入原有唯一修正；模型批准不能覆盖本地矛盾。见
[修复及验收记录](../../development/iris-executable-arithmetic-20260926.md)。Core4811通过/
469条件跳过，类型/构建及CLI7通过；算式解析和trace回归含先失败后通过及独立复核。
受限实模9次HTTP200/33717tokens：旧错误pair修正及新鲜算术各一例通过，inference
最终建议却让审批许可替代付费意愿证据，模型审核批准，独立语义失败后停止。
qualified-risk及paraphrase未调用，原失败保留；未知语法和正确算式均不证明事实
支持、建议有用或非重复。IRIS-CORE-005仍**部分实现**，没有完整15×2、真实飞书
或部署验收，没有push、生产核验或能力启用。

## Status Amendment - 2026-08-22 Managed Existing-Page Updates

- Managed existing-page update code is implemented and locally verified behind the independent
  default-off deployment contract `IRIS_MANAGED_KNOWLEDGE_UPDATE_ENABLED=false` and an empty group
  allowlist. It is limited to fresh Iris-created pages with one captured managed plain-text block;
  legacy adoption, arbitrary documents, multi-block/rich-content edits, and title/delete changes are
  out of scope.
- This is **not** a new passed Feishu write loop. Controlled Feishu acceptance is pending until one
  authorized allowlisted group completes the runbook with a fresh target, managed/unmanaged control
  pages, exact one-block/revision evidence, barrier/resync/retrieval evidence, drained queues/DLQs,
  and real immutable image/tag/SHA, timestamps, and operator records.
- The existing real publication-pilot facts for IRIS-CORE-008 remain true. Local verification of
  `update_knowledge_publication` does not upgrade existing-page update acceptance to delivered or
  deployed status.

## Status Amendment - 2026-08-23 Governed Feishu Task Creation

- The `create_feishu_task` code candidate implements explicit-request drafting, exact group
  confirmation, exact-assignee OAuth review and approval, deterministic Task v2 creation,
  bounded reconciliation, a source-group result card, lifecycle composition, readiness, and
  content-free operator recovery.
- Deployment remains fail closed through `IRIS_FEISHU_TASK_CREATION_ENABLED=false`, an empty
  one-group allowlist, and durable `readGroupContext`, `replyWhenMentioned`,
  `generateTaskDrafts`, `createFeishuTasks`, and `callExternalTools` capabilities. No model output
  or internal operator endpoint can manufacture a confirmation, review attestation, approval, or
  new remote task.
- The production-safe runbook subsequently recorded immutable SHA/image identity, one real
  requester, real group confirmation, the real assignee's OAuth review/approval, one fresh task
  with exact readback, one result card, zero unknown/recovery counts, and final safe-off rollback.

## Status Amendment - 2026-08-24 Governed Task Real Pilot

- Commit `1eb86c2b10d27becfdc3aa4f99d0bfbd32844ecf` is deployed as the exact Core and AI Worker candidate after
  fixing the result-dispatcher's unscoped runtime gate. Typecheck, build, all 3,921 Core tests and
  both focused result-delivery suites passed. The unrelated Windows restore-behavior suite reported
  177/178 because one simulated restart cleanup took 11.68 seconds against its 11.5-second bound;
  no pilot operations file changed in this fix.
- One real requester produced one formal-task draft and proposal. The real assignee completed OAuth
  review and approval. Exactly one execution, remote task, creation fact, result presentation and
  successful result-card event were recorded; a later worker cycle kept all counts at one.
- Official Feishu Task v2 readback matched remote identity, title, description, the unique assignee,
  due and reminder without recording any private content or identifiers in acceptance output.
- Final rollback disabled all five temporary capabilities, the pilot group, global runtime and the
  target policy; restored the task/review/card deployment environment to default-off; rebuilt Core;
  kept Caddy stopped; retained append-only facts; and verified formal-task, approval, card and
  platform in-flight/DLQ/unknown/reconciliation counts at zero. Core, Postgres, Redis and AI Worker
  remained healthy.

## Status Amendment - 2026-09-09 Conversation Repair

本修订补充 IRIS-CORE-001/002/009/010 的回答体验与证据选择边界，不新增跨群或外部行动权限。
截至 2026-09-09 00:17（北京时间）的[发布记录](../../development/iris-continuous-dialogue.md)，运行应用为
`748b8404c56330df9941a008f8f8343312949aa6`；后续文档提交不是新部署，本轮同步未查询或修改生产。

| 验收项 | 已验证范围 | 仍然不代表 |
|---|---|---|
| 同群历史与问卷原文 | 权威飞书补读、原文/回复标签绑定、有界日期召回；撤回/拒绝优先于较早正文 | 全量回调补录、无限归档搜索、其他群原始消息可读 |
| 两版比较与连续追问 | 两组原文保留及后段文本预算；实际部署内部草稿能比较真实问卷并给出两轮具体或条件建议 | 已通过用户 A/B 实测、作者或公司已作决定 |
| 普通交流 | 当前问题语义路由先于资料加载；饥饿和语气反馈重复样本、疲惫表达、普通知识与创作无资料引用 | 每种表达均已测试、依靠有限问候词表即可覆盖日常聊天 |
| 草稿连续改写 | 真实模型实际上轮文案的内存对话改写通过；自身发送回执、身份及来源权限链有自动/真实 Postgres 集成覆盖 | 本轮发送过飞书验收消息，或完成了新的真实飞书回执改写验收 |
| 中文与安全控制 | 中文 `none`/`partial` 策略词显示及 URL/代码保护回归；跨群原文隔离、停用群403、精确输出、原能力不变 | 缺失第三版标签混淆已彻底修复、知识写入/任务/主动发言已放开 |

最终 SHA 的 CI、加密配对备份、不可变镜像、就绪21/21及实际部署 HTTP 验收均有记录；全程无自动飞书群测试发送。
此前被拒绝的候选和回滚、验收脚本对“暂无授权证据”的误判及同镜像续跑均保留，不改写为一次全部成功。
P2 版本身份/引用标签混淆、来源标签措辞、无主题无限历史等仍见[非阻塞后续](../../development/iris-continuous-dialogue.md#非阻塞后续)。
每项提交与回归文件可从[修复索引](../../development/current-handoff.md#修复证据索引)追溯；这不重新宣布整个 MVP 完成。

## 3. 当前真实结论

### 2026-09-09 新增批准范围：试点共享工作群聊（已受控开放）

用户已确认现有三个试点群为同一共享受众：普通文字消息无需先保存知识库，另一参与群
可以询问、比较与讨论。对应 IRIS-CORE-001/002/003/004 的新扩展采用
[共享工作群聊设计](2026-09-09-iris-shared-working-chat-design.md)，并不改变表格中的历史
验收事实。当前状态为**最终f6a6dd41通过精确SHA CI与九项内部实模/人工语义验收，
07:43:52 UTC恢复公开入口；scope active/version5、runtime3387，精确三群普通讨论共享已开放**。
保留两个先前候选的中文置信度门禁失败及撤销记录；本轮未向飞书发送测试消息。

这是独立于既有单文档授权的原始讨论只读路径，不能把旧的跨群文档验收当作本次已经通过。
实际代码、撤销/删除/改写来源链回归、模型验收和部署状态以
[专项记录](../../development/iris-shared-working-chat.md)为准。范围外仍隔离，Wiki 写入、
主动发言、任务执行和跨群语义记忆/线程/行动项投影不随之开放。

验收必须包括真实数据库的双群互引并发、来源及 incoming 消息删除、撤销与发送竞争，
以及外层事务失败后的重试；来源归属元数据的传输预算不能扩大原文24k上限。
共享验证器接线后会保守跳过缺来源版本的旧 Iris contextual 回复，属于已记录的迁移
影响而非消息删除；新回复来源链和普通闲聊需分别验证。
第二轮配对内容正确但部分日期措辞沿用原帖“今天/昨天”，未说明参照日，记为P2后续；
不以此抹去两版内容验收，也不声称相对日期表达完全正确。

当前 Iris 不是“只有一句话问答”的空壳：安全接收群聊、共享最近上下文、读取群文档、读取授权知识库、实时权限防泄露、回答与引用、运行时停用和恢复、知识草稿确认审批与知识库发布都已经工作；主动信号发现和投递链路也已完成默认关闭代码路径，最小 Admin Console 已经可以承担基础运行控制、文档源治理、知识草稿队列观察、发布队列治理、主动候选治理和审计摘要查看。

当前白皮书为首个 20-30 人内部版本定义的 P1 核心闭环已经各通过一次受控真实
Feishu 验收。下一阶段不是继续做无边界硬化，而是先启动 3-5 人单群日常 pilot，用
真实工作验证回答质量、语义抽取质量、主动提醒阈值和运营流程；只有 pilot 暴露的
P0/P1 问题才阻塞扩展。

仍未完成、但不阻塞首个单群日常 pilot 的内容包括：

1. 广泛跨群记忆共享与其授权/审计模型；
2. 持久化合规审计仓库、正式管理员身份和更丰富的运营分析；
3. 批量审批、复杂协作编辑、更多文件类型和高级知识治理；
4. 多公司自助安装、租户隔离、租户管理员和计费产品化。

## 4. 实施顺序

| 阶段 | 交付物 | 为什么先做 |
|---|---|---|
| 3A | 长时群记忆事实层、纠错/删除和回答时检索 | 主动参与和知识草稿都依赖可信记忆；先建立可治理的数据基础 |
| 3B | 异步记忆抽取、主题/thread 聚合和证据绑定 | 让 Iris 真正随群聊学习，而不是只保留原始聊天记录 |
| 4A | 主动信号候选、未解决讨论检测、限频和解释 | 代码与真实小群灰度已完成；日常 pilot 继续保持显式 allowlist |
| 4B | 群内主动建议、暂停/恢复和反馈闭环 | 受控投递与 helpful/irrelevant 反馈已通过；继续用真实反馈校准质量和打扰边界 |
| 5A | 知识草稿事实层、风险等级、证据和状态机 | 建立讨论到知识的可审查中间层 |
| 5B | 群内确认、管理员复核、飞书知识库幂等发布 | 完成“先确认、后行动”的核心闭环 |
| 6 | 轻量 Admin Console | 让 20-30 人内部版本可由业务管理员日常运营 |
| 7 | 多公司安装与租户化 | 内部核心闭环稳定后再增加租户复杂度 |

## 5. 质量门禁

- 任何长时记忆必须能追溯到原始消息或授权文档证据。
- 默认只在当前群可见；跨群使用必须有显式授权和审计。
- 删除、纠错和权限撤销必须在下一次回答前生效。
- 主动候选、知识草稿和高影响行动必须有独立状态，不允许模型输出直接触发外部写操作。
- 所有新增异步队列必须具备幂等、重试、DLQ、状态观测和停用语义。
- capability 名称不得被当作功能完成证据；每项完成必须有自动化测试和真实飞书验收脚本。

## Status Amendment - 2026-07-24

- Phase 5B-2B real Feishu OAuth review acceptance is complete: the current proposal's full-draft review page recorded an append-only review attestation for the exact proposal version, subject revision, subject version, and content hash; the same Feishu approval card then satisfied the designated-owner approval requirement.
- Phase 5B-3 real Feishu publication acceptance is complete for the first internal pilot write loop: one approved `publish_knowledge_draft` proposal produced a succeeded `feishu_wiki` execution and one `knowledge_publications` fact with Feishu wiki/docx remote identifiers.
- The production runtime was rechecked in fail-closed state after these gates: `globalEnabled=false`, `desiredGlobalEnabled=false`, all known pilot groups disabled, `writeKnowledgeBase=false`, `proactiveSpeech=false`, and all event/document/reindex/knowledge-card/action-approval pending and DLQ counts at zero.
- The next core product gap is not more Phase 5B hardening. It is real Feishu gray acceptance for the group semantic memory/thread/action loop and then the proactive signal loop, both still default-off unless explicitly allowlisted.

## Status Amendment - 2026-07-24 Semantic Gray Gate

- A single minimal Gemini V2 JSON Schema probe for semantic memory/thread/action gray acceptance returned `503 provider_unavailable`; the AI Worker safe log recorded `upstream_status=503 classification=provider_unavailable`.
- No semantic DLQ replay was performed after that failed probe, and no additional model requests were made in the same window.
- Production remained fail-closed after the probe: `globalEnabled=false`, `desiredGlobalEnabled=false`, pilot/control/historical groups disabled, Caddy stopped, event/document/reindex queues and DLQs at zero, and the six semantic DLQ entries preserved for ordered replay after provider recovery.
- Non-model proactive candidate governance was reverified locally while waiting for provider recovery: focused proactive/admin tests, full Core test suite, typecheck, build, pilot compose contract checks, and `git diff --check` all passed.

## Status Amendment - 2026-07-26 Proactive Planner Runtime

- Phase 6A proactive signal planning no longer depends only on manual Admin Console scans. Commit `9abf977463b2fad43ce1aed488d5d58f0090b9a0` adds a default-off planner runtime that periodically scans explicitly allowlisted groups for quiet open threads and overdue actions, then records proactive candidates without sending Feishu messages.
- The planner remains fail-closed: it requires `IRIS_PROACTIVE_SIGNAL_PLANNER_ENABLED=true`, a non-empty planner group allowlist, started runtime lifecycle, and `runtimeController.canProactivelySpeak(groupId)` before reading conversation state or recording candidates.
- Proactive delivery is still separate and independently gated. This amendment does not mark real Feishu proactive delivery complete; the next product gate remains semantic memory/thread/action gray acceptance, followed by one controlled proactive candidate and delivery gray pass.
- Verification for this amendment: `git diff --check`, `npm run pilot:config`, `apps/core npm run typecheck`, `apps/core npm run build`, focused proactive/startup/status suites, and full `apps/core npm test -- --reporter=dot` with 140 files passed, 2 skipped, 2328 tests passed, and 165 skipped.

## Status Amendment - 2026-07-27 Proactive Feedback Loop

- Migration `0040_proactive_signal_feedback.sql` adds append-only proactive feedback events and the bounded, mutable suppression projection. One actor can record at most one result for one sent delivery; an `irrelevant` result suppresses only the same `(groupId, kind, entityId)` through its configured expiry. The default is `IRIS_PROACTIVE_IRRELEVANT_SUPPRESSION_DAYS=30`; accepted values are whole days from `1` through `365`.
- Real Feishu feedback callbacks are bound to the exact sent delivery, candidate, group, and entity version, require a current group member, and are gated before membership I/O and immediately before mutation. The card exposes only `helpful` and `irrelevant` actions; it does not carry actor identity, message identifiers, evidence text, or message bodies.
- Operators can inspect only group-scoped aggregate effectiveness: total feedback, helpful count, irrelevant count, helpful rate, active suppression count, and last feedback time. Feedback tables and aggregate APIs do not expose raw actor identities, message bodies, evidence text, prompts, or answers; persisted actor attribution is a SHA-256 fingerprint, not a Feishu open ID.
- Production remains disabled for this loop. Do not enable proactive speech, planning, or delivery based on local tests or aggregate UI alone. One real Feishu feedback-card gray pass in an explicitly approved small group is still required before controller review can consider any rollout change.

## Status Amendment - 2026-07-28 Real Proactive Feedback Gray

- The bounded pilot completed two independently bound real Feishu feedback cards: one `helpful`
  result without suppression and one `irrelevant` result with exactly one 30-day suppression for
  the same group, signal kind, and thread.
- A repeated repository scan after the irrelevant result returned zero new candidates and one
  suppressed candidate. Both deliveries remained single-attempt sent facts, and all interaction
  queue and DLQ counts returned to zero.
- A Feishu `200080` observed on the first click was traced to the 30-minute fail-closed window
  having already stopped Caddy. Reopening a bounded window and reusing the same card succeeded;
  no card schema or callback parser change was needed.
- Cleanup restored global and desired-global runtime disabled, all 14 known groups disabled,
  proactive speech and proactive environment flags disabled, Caddy stopped, and healthy
  Core/Postgres/Redis/AI Worker services with empty event/document/reindex queues and DLQs.
- Phase 4B now has a working real positive feedback loop, but production remains default-off.
  Negative actor, membership-loss, stale-binding, disabled-runtime, and duplicate-callback
  external cases plus operating-threshold calibration remain explicit rollout gates, not reasons
  to block work on the next missing whitepaper capability.
