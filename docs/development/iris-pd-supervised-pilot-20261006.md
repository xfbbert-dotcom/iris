# Iris 主动讨论：逐请求免费门禁与一次真实触发准备

日期2026-10-06。工作树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支
`codex/iris-daily-pilot-followup`；开始时HEAD为`be306b96`，干净。
本轮继续已授权的本地修复、验证和交接；没有生产访问、模型请求、群正文读取或飞书外发。
生产最后一次实际证据仍为[51937b95发布](iris-release-51937b95-20261006.md)：
global/desired/PD关闭，mode=legacy、model source=shared。本记录与工具不构成新的应用部署。

## 已确认的启用缺口

本轮直接核对源码与发布证据，没有重跑已经通过的合成窗口或发布测试。

1. PD的[固定单群名单](../../apps/core/src/config/runtime-config.ts)只限制PD。
   [全局控制](../../apps/core/src/admin/runtime-controller.ts)按“global开启且群未禁用”
   放行，并能恢复无群入口。现有14个禁用群指纹不证明“只开原群”；global关闭时普通
   问答也关闭。旧[单群runbook](iris-proactive-discussion.md#单群发布-runbook)的
   “普通问答仍工作”必须按实际global状态表述，不能作为关闭状态验收预期。
2. [专用配置](iris-pd-model-isolation-20261006.md)没有免费额度门禁。
   [客户端](../../apps/core/src/model/openai-compatible-chat-completions-client.ts)每次
   complete可有两次技术HTTP；[评估worker](../../apps/core/src/proactive-discussion/evaluation-worker.ts)
   和[仓储](../../apps/core/src/proactive-discussion/postgres-repository.ts)还可能重试任务或
   因上下文变化重评。配置poll/batch不能当成总请求上限或免费保证。
3. [旧合成runner](evidence/iris-opinion-decision-resumed-20261004-runner.txt)逐HTTP核对
   request hash、精确型号、新鲜免费额度和用完即停，但它绑定旧合成输入/HEAD。
   受保护启动器与合成key的已有授权不能自动转作真实群凭据。

上述是确定的运行合同差异，不是新的模型语义失败，不能归因于“模型不行”。

## 本地修复合同与出口

新增[试点门禁](../../scripts/pilot/proactive-discussion-free-gate.mjs)，手动启动，仅监听
127.0.0.1。它处于PD专用请求的必经路径，以受保护env取得已授权凭据和固定HTTPS上游；
没有自动找密钥、付费回退、重定向或修改QA配置。生产接入仍须另行批准与验证。

- 精确接受qwen3.8-max、json_object、max_tokens=4096、enable_thinking=false；请求体原样
  转发。每次HTTP独立生成请求身份/哈希，技术重试或重评不能重用一次许可。
- 操作者在百炼页面核对该次请求的精确型号、免费余额至少200000 tokens、未到期、用完
  即停后，在私有目录写入匹配许可。观察须非未来且不足60秒；它是操作员观察记录，
  不是自动额度查询或账单审计。没有许可、错误许可、过期、取消或停止时不发上游请求。
- 窗口最多8次上游HTTP、15分钟；reported tokens达到60000后禁止下一次请求。
  最后一次可能越过60000，所以这不是严格总token上限；供应商的免费用完即停仍必需。
  同时只准一个请求；上游HTTP/响应封装错误或额度不可核实即结束，不自动启动新窗口。
  门禁不代替应用schema、语义审核或发送前权限检查。
- 许可等待最多20秒，上游最多30秒，受窗口期限与客户端断开约束。应用的60秒总时限
  不增加；来不及核对就停止，不补发已经过期的请求。已开始的远端I/O可能结算，取消
  不能作为没有消耗或没有执行的证明。
- 写`stop.json`是停止请求，须以`stopped.json`确认门禁已观察并生效；文件写入到门禁
  观察之间存在传播窗口，不能承诺已发起请求被撤回。实际转发前仍须复核许可和取消状态。
- 只记录请求身份、哈希、时间、状态及usage；不写授权头、群正文或模型响应原文。
  使用新建、独占的私有目录，停止后不得重用目录重置预算。真实业务证据另存操作者私有
  目录，仓库只存脱敏结论；Windows父目录ACL必须由操作者保证。

这是人工监督试点的调用工具，不是产品的发言间隔、每日配额或人工审核代替语义判断。
有限出口：实际本地HTTP链路证明逐请求阻断、原样放行、重试不复用、客户端取消不迟发、
错误停窗及预算边界；接入既有pilot测试清单并通过一次范围审查。通过后不继续扩建计费系统。

操作入口为`node scripts/pilot/proactive-discussion-free-gate.mjs`，`--help`只显示字段说明。
启动所需env由已授权的受保护配置提供，不能把实际值写到命令、报告或仓库：

| 字段 | 合同 |
| --- | --- |
| `IRIS_PD_FREE_GATE_API_KEY` | 显式提供已授权凭据；不自动读取私有存储。入站Bearer与上游认证均使用它。 |
| `IRIS_PD_FREE_GATE_UPSTREAM_URL` | 固定完整HTTPS chat/completions端点，允许百炼compatible-mode前缀；拒绝URL凭据/query/hash。 |
| `IRIS_PD_FREE_GATE_SESSION_PARENT` | 现有操作者私有目录；启动后产生新的独占session目录。 |
| `IRIS_PD_FREE_GATE_PORT` | 可选，默认8765，只监听127.0.0.1；不发布到公网或其他容器。 |

每次从`pending-<requestId>.json`取真实`requestId/requestHash/model`，观察时间不得早于
该pending的`at`。新鲜核对后原子写入`permit-<requestId>.json`，正文还需
`remainingTokens/observedAt/expiresAt/freeExhaustionStop`；禁止从旧许可复制额度观察。
未完成写入、错配或超时会停止，不能先写占位许可再填值。状态文件只证明门禁操作与
provider响应封装；`accepted`不表示语义正确或飞书已发送，`uncertain`保留实际调用的不确定性。

## 待授权的首个产品窗口

先做原固定群的一次真实讨论触发。目标配置为source-plan、dedicated、qwen3.8-max、
json_object、4096、thinking=false、60000ms；QA模型配置保持，首窗不恢复普通问答。
在global仍关闭时暂置`replyWhenMentioned=false`及`generateKnowledgeDrafts=false`，避免
Qwen门禁外的普通QA/知识草稿模型调用；[普通QA闸门](../../apps/core/src/admin/runtime-controller.ts)
与[知识卡闸门](../../apps/core/src/runtime/knowledge-card-runtime.ts)须现场核对。
精确群取
[PD_PILOT_CHAT](../../apps/core/src/proactive-discussion/contracts.ts)，无需用户重新查ID。
上述门禁限制8次真实HTTP；任何停止原因都保留，不换窗口重采以求通过。

执行前需要明确授权：在生产安装/接入试点工具与专用配置；将原群获准来源交给Qwen并把
现有受保护合成凭据扩展到此次真实群范围；按上述能力限制暂时开启global所影响的入口；开启原群PD与
真实发言。当前授权仍缺这些范围。还须现场核对当前未禁用群及无群入口影响，不能把
PD名单承诺成全局名单；如果仅允许原群，则必须保持global关闭直到范围隔离得到解决。
文档检索embedding也须确认使用既有本地服务，不能将Qwen门禁当作所有模型费用保证。

获准后的顺序：

1. 只读核对实际应用/镜像、私有控制状态与真实DB队列；当前应为51937b95与0059/0060已
   应用，若不同先解释差异，不盲重跑迁移。核对原群、其他入口范围、私有凭据与免费条件。
2. 在Core同一网络命名空间运行门禁、仅绑定loopback；专用BASE_URL指向它，真实上游与
   凭据只通过受保护配置提供。新工具退出即没有可用PD模型入口。先用无业务正文的本地
   假上游验证实际接线路径，确认没有绕过门禁；不能只改env就宣称逐请求保护生效。
3. 原群名单启动PD runtime，保持policy关闭；确认专用配置、审计角色、running/status，
   旧planner/delivery/memory/task/Wiki能力仍关闭。global关闭时先通过受保护capabilities
   接口临时关闭replyWhenMentioned和generateKnowledgeDrafts并核持久状态；其他模型入口
   若无法证明关闭或仅本地免费运行则停止。依本次授权开启global与原群读取、
   proactiveSpeech；最后从DB读取当前policy版本，调用受保护
   `PUT /internal/proactive-discussion/policy {chatId,expectedVersion,enabled:true}`。
   不存在用0；409重新读，不强写或伪造批准。
4. 由真实群成员发起一个真实、可核验的问题讨论，不伪造成员、消息或飞书回调。
   每个模型HTTP分别核对额度、写一次许可。额外触发、不符范围或额度无法及时核对就停窗。
   不用本地脚本代替成员发言，也不把“假设这是一道题”当作必须介入的工作错误。
5. 有意见时核实实际provider message ID、trigger、delivery、issue/basis/policy/context
   版本和sent回执；独立核对算式及数字角色、推断限定、建议是否有用、是否重复。
   HTTP200、supported=true或sent都不能单独证明语义通过。合理沉默需对应实际来源与状态；
   不应沉默却没有发言同样是失败，不能改预期。
6. 窗口结束先拒绝门禁新请求，再关闭proactiveSpeech和PD policy，最后停PD runtime。
   保留sending/unknown并按[对账流程](iris-proactive-discussion.md#关闭和对账)核实，不清表
   或盲重发。本轮提案默认恢复当前false/desired=false，必须另行执行受保护
   `POST /internal/runtime-control/global {enabled:false}`，核对响应持久化成功、live=false和
   desired=false；`503 disable_not_persisted`不算恢复完成。关闭PD不会代替全局关闭。
   仅恢复本窗口变更的受保护env/能力字段、移除临时门禁进程及其凭据注入，复核实际关闭
   状态；发现并发修改先核对，不覆盖其他操作者变更。
   不默认把原本关闭的机器人留为开启，也不删除领域事实或未知发送证据。

首窗若成功，只证明一次真实意见链路；还须后续有限验收“换说法不重复、已经处理不再说、
独立新问题仍可介入、真实@追问、同问题停止/恢复”，不能以首窗代替完整产品验收。
停止/恢复必须由真实成员直接回复已有sent回执的PD意见，短句分别为“**不再跟进这件事**”
和“**恢复跟进这件事**”；恢复后只观察后续新依据，不自动重发旧稿。回复自己的反馈或
普通QA答案、操作员恢复API都不能代替这项成员验收。

## 验证与实际层级

工具提交`7c1357729c4a734747f8caf962c0b8d71f22b524`，仅新增脚本/测试和pilot测试清单；
未改apps/core应用代码、提示词、生产Compose或模型配置。后续文档提交不是应用部署。
[本地验证摘要及提交原字节SHA256](evidence/iris-pd-free-gate-20261006-local.json)区分各次范围；
它是结果摘要，不冒充原始模型请求/响应或生产记录。

| 验证 | 结果与边界 |
| --- | --- |
| `npm run test:pilot` | 214通过、0失败/跳过，296.394秒；包含原195项和当时19项新门禁测试。 |
| 最终`node --test scripts/pilot/proactive-discussion-free-gate.test.mjs` | 20通过、0失败/跳过，2.728秒；在全套之后完成入口断连原因回归并由主代理重跑，未把全套写成215项。 |
| `node --check`及CLI `--help` | 均exit0；没有传入真实凭据或启动生产门禁。 |
| 独立范围审查 | 初审发现dispatch前异步竞争和缺content响应未停窗，修复后的18项复跑通过；随后最终写入与入口断连回归由主代理验证，最终共20项。控制流程审查指出结束步骤缺明确global关闭调用，已补。 |
| 文档路径与diff | 本轮所改5份记录311个相对文件链接有效，`git diff --check`通过；Git提示LF/CRLF归一化，不是测试失败。 |

新测试的入站是实际本机HTTP，出站为注入的模拟fetch，不连接真实供应商。
保留实际RED：初版在途停止等到30秒超时、并发产生两个pending、复用旧观察获200；
范围审查回归在许可读取跨截止时间、outcome写入时停止、缺正文响应时旧版均返回200。
这些失败先复现后修复。入口断连的旧顺序回放仍然没有pending或上游发送，实际RED是
停止原因错记为permit-or-upstream-failure；不将该回归夸大成已复现取消后外发。
最初模块缺失只算脚手架失败，不作为行为RED。所有上述失败都不是新实模语义实验。

本地有限出口已达到，停止扩建此工具。未改应用，因此没有重跑已通过的Core、PG、
精确发布CI或既有合成模型窗口，也不将它们的历史通过写为本轮新验证。
新增真实模型HTTP为0、真实群材料读取为0、真实飞书发送为0；生产未变更。
整体主动讨论缺陷仍开放，IRIS-CORE-005仍部分实现。

## 白皮书11.2四处处置

| 位置 | 处置 |
| --- | --- |
| 白皮书 | **reviewed-unchanged**：[§6、§8与§11.2](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md)已分别定义模型/权限/发言控制、全局与群控制和分层验收。本轮操作工具执行既有免费约束，不新增产品发言策略。 |
| 工程故障台账 | **updated**：[试点合同差异](../operations/engineering-failure-ledger.md)记录单群配置不限制global、专用模型不自带免费门禁，及本地有限出口。 |
| 核心需求覆盖基线 | **updated**：[试点准备](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)链接实际运行差异与新工具验证，IRIS-CORE-005不升级为真实群通过。 |
| README / AGENTS / current-handoff | **updated**：[交接](current-handoff.md)和[旧runbook修正](iris-proactive-discussion.md#单群发布-runbook)链接本轮有界路径。**reviewed-unchanged**：[README](../../README.md)的已部署/关闭状态及交接入口仍有效；[AGENTS](../../AGENTS.md)的工作树、授权、失败保留、有限出口规则不变。 |
