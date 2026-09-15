# 主动讨论：合成诊断、阶段合同与触发绑定修复

日期：2026-09-15。用户要求继续处理上一轮的具体失败。起点为实现树
`D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`、分支 `codex/iris-daily-pilot-followup`、
`7be41fc4`；生产应用与本地评估代码分别记录，不部署、不 push、不发飞书消息或改变开关。

## 问题与有限计划

[上一轮修复及 run3](iris-proactive-discussion-model-fixes-20260915.md)仍为 24 通过、4 失败、2 未完整。
确认的信息丢失位置是：`createPdModel.render` 在范围复核不通过时只返回 null；assessment 两次
校验失败后只抛固定总括错误。通用 evaluator 因此无法保留被拒候选或具体校验原因。
这不证明被拒稿本身有错，也不证明两个空理由 skip 的内部原因。

本次不修改决策提示、原 15 场景、reviewCriteria、模型或调用次数；补诊断及下面已确认的阶段合同误述：

1. 默认关闭的固定合成评估 trace，在 client.complete 正常返回、本地校验之前捕获有界白名单字段。
2. 每条记录按场景、轮次、阶段、调用序号关联；保留两次 assessment 候选、草稿及正反范围复核。
3. assessment 原候选用同一生产 validator 做只读诊断复验，固定原因白名单分类；不是独立复制业务校验。
4. 不保存请求、任意错误正文、HTTP headers、配置或未知字段；不可解析文本不落正文，非法引用不原样保存。
   配置值脱敏先于截断；丢弃、截断或诊断不完整明确标记。诊断不能改变模型返回、异常或验收结论。
5. TDD 验证默认关闭、开关不改变请求/结果、拒稿及校验失败证据、跨场景轮次隔离、限额和脱敏。
6. 有界代码复审后，沿用服务器现有模型配置就地运行一次原 15 例 × 2 轮、6000ms 请求间隔的诊断评估。
   新报告不能倒填 run3 的未知内容；依据新证据再决定具体机制修复，不重复抽样直到偶然通过。

诊断复核理由只是模型输出，不是正确性证明；空理由仍不能揭示模型内部原因，不请求思维链。
权限竞态、真实群效果和长期稳定性不由本合成 trace 验证。

## 同时修正的阶段合同误述

只读复核确认 `proseSystem` 称输入“已核准”、`scopeReviewSystem` 称“核准 assessment”，
实际 validator 只校验结构、引用及状态约束，没有核实语义。run3 inference:1 的“会导致收入测算
结果严重失真”先出现在 assessment，再被草稿复述、最终放行；错误传播已证实，但不能证明
“核准”二字就是唯一原因。该例两条来源均已传给后续模型，不能归因来源丢失或为此扩展来源。

有限修正：改写与复核都以授权原文优先，assessment 明确为候选而非语义批准；复核覆盖从候选
继承的错误、事实类别/口径偏移和确定性扩写。恢复条件限定不被当作拒答。没有新增模型调用、
重试、逐项主张合同或新的来源。本变更符合已批准设计的事实/推断区分，不声称语义质量因此已通过。
模型措辞修正的 RED 是保留的 run3 实际失败；不能用假客户端或提示包含某句话代替实模 GREEN。

## 生产与配置身份（只读）

`2026-09-15T13:28:27Z` 核对：原 core 容器
`79f8a852f3503bbcbd2d86c01aabefaf154783b8a503edaa7c2fb54b96df4343`，镜像标签
`iris-core:f6a6dd4187dcb1b574fb78a11f837edec8b09b89`、镜像摘要
`sha256:cb6e915b84adfa2a2189cc6928b31ad6ec00929f1ea9e2329d4e9f4894ef2383`，
启动时间 `2026-09-14T18:16:38.790547368Z`，restart0/runningtrue。
既有配置 stat `64770:699808:4803:1788939422:600` 未变，未输出或下载配置正文。
这里只核对隔离评估所需身份，不声称新健康、队列或群验收。

## 当前证据状态

应用/评估修复提交 `68f16e049ee88f57f212cbb86bd3027c5b5e9799`；本地回归不代表语义门禁通过。

- trace TDD RED：新增 4 项因专用入口不存在失败；CLI 3 项因缺开关/字段失败、4 项通过。
  GREEN：[trace 测试](../../apps/core/tests/proactive-discussion-eval-trace.test.ts)最终 5 通过，
  覆盖开关前后结果/请求相同、两次候选、非法字段/引用、JSON/字段关系分类、拒稿和 HTTP 脱敏；
  [CLI 测试](../../scripts/pilot/proactive-discussion-eval.test.mjs)7 通过。
- 生产 model 原有定向回归 36 通过 / 2 条件 PG 跳过；初次有 1 项固定措辞断言失败，
  保留既有“新增公司事实”规则表达后通过，未修改旧测试或语义标准。这不是实模问题的 RED/GREEN。
- 最终 `npm --workspace apps/core test -- --reporter=dot`：4627 通过 / 463 条件跳过，
  251 文件通过 / 12 跳过，`2026-09-15 21:38:05` 北京时间开始、27.66 秒。
- Core typecheck/build、eval runner 独立 strict TypeScript 编译及 `git diff --check` 通过。
  主代理独立重跑 CLI 7 通过；没有本次真实 PG、全套 Python/pilot、远端 CI 或群投递验收。
- 打包 91 个输入模块；外部模块仅 node:url/node:crypto，无飞书历史读取/回复/token、
  Postgres repository、主动 runtime 或 app 启动依赖。代码复审与实模结论随后分别记录。

一次新增四文件范围独立复审通过，无 Critical/Important。脱敏测试的非阻塞精度建议已落实：
将 secret 放到第 491 字符跨越 500 字符边界，确认先截断会泄露前缀而先脱敏不会；主代理复跑
trace 5 通过。完整 Core 的统计在该测试精度增强前、应用实现没有变化，不冒充又跑过一次全量。
非阻塞后续：`context_invalid` 诊断映射字面与实际错误略有偏差，固定合成入口不可达；不扩大为
新一轮加固。原 Tasks 1–8/I1–I4 审查保持关闭。

## run4：同模型、原有限集、有诊断的复测

服务器私有目录 `/tmp/iris-pd-eval-20260915-run4-VqQVablY`（700，irisops）；模型配置就地装配，
只允许五个模型字段进入子进程。与前轮相同 Node v22.23.1、gemini-3.5-flash-lite、HTTPS、
60000ms timeout。原 15 场景 × 2 轮、6000ms 评估请求间隔，新增 `--include-synthetic-trace true`。

| 上传物 | 本地/服务器一致 SHA256 |
|---|---|
| runner.mjs | `ebc035096627644a870b14f98b50bb1c3a832407cb2b8da7bd1c2abc3f52603a` |
| model-config.mjs | `c6c6215d3b048b4c5e990fe6c79fdd9074ba8ff832f0e9146638f6db7d4f1ef5` |
| launch.mjs | `78c4178dc36feaeb83c296606001cd4d5e76db51f24e1798fcf6d9b4f74f3d49` |

network-none 预检通过，精确应用 SHA 与 bundle hash 一致，源码路径无 diff。
实跑 `2026-09-15T13:42:48Z` 开始；独立只读容器沿用 256MiB/0.5CPU/64PID、无 capabilities、
no-new-privileges、uid1002/gid1003、30分钟总限时及结束自动移除。输出只保存到私有合成证据目录。
最终于 `2026-09-15T13:47:32Z` 结束（284秒），退出1，stderr0字节。
[run4 原始报告](evidence/iris-proactive-discussion-20260915-model-run4.json)80561字节，SHA256
`f3aa2325185b6c72c82e67fcb1a1b52afddbea735a329e9b5e736a73f7ed243c`，服务器、本地及归档一致。
manualReview=pending 保留。以下为主代理及独立代理语义复核，不是人员签字或真实群验收。

30份 assessment、7份 draft，无阶段错误或HTTP429；48条trace完整、无丢弃或截断。
完整 assessment+draft 语义口径为 **25通过、5失败、0未完整**；12个场景两轮通过。
只数最终草稿/沉默会得到27/3，却漏掉两个仍将后果写死的最终assessment，不能用于提升门禁。

| 场景 | 第一轮 | 第二轮 |
|---|---|---|
| arithmetic | 通过，16/6万；措辞观察保留 | 通过，16/6万；措辞观察保留 |
| inference | 失败：assessment仍断言严重失真，草稿已限定 | 失败：skip/no_work_value |
| qualified-risk | 通过，首次结构错误已修复 | 失败：assessment确定推断延期问题，草稿已限定 |
| separate-next | 失败：skip/duplicate | 失败：结构修复后仍skip/no_work_value |
| paraphrase | 通过，经结构修复 | 通过，经结构修复 |
| unrelated-update | 通过 | 通过 |
| material-update | 通过，24/8/14万 | 通过，24/8/14万 |
| casual / hypothesis / handled / corrected | 四例均通过 | 四例均通过 |
| source-loss / stopped / injection / followup | 四例均通过 | 四例均通过 |

具体发现：

- inference:1 的最终assessment仍写“会导致收入预测严重失真”；qualified-risk:2写未联调即承诺
  “将面临较大的履约风险和延期交付问题”。材料不能证明实际后果必然发生，qualified_inference
  标签不能撤销断言。两份最终草稿均加“可能”，文案改善不等于存续assessment已合格。
- separate-next:2 首候选的解释是“预算问题已在之前提出，当前没有关于预算的新依据或实质变化”，
  当前输入实际上是独立数据权限风险。结构修复后变成空理由no_work_value，仍漏报。
  这能证明输出围绕旧预算，不能直接观察模型内部注意机制。
- 七次scope-review均supported=true。arithmetic:2的复核理由仍把原文说成“人数及薪酬”，
  说明复核本身也会误读；实际草稿未将16万断言为薪酬总额。“调整薪酬方案”只是建议，未视为同样失败。
- 观察项：部分“核对授权”生硬；追加预算后仍“确保在10万内”的assessment建议不严谨；
  material-update:1在明确24/8/14万之后又说“可能导致缺口扩大”，过度弱化算术但未取代必要数字。
- 7份群文案无英文策略词、模型信心数字或执行承诺。内部injection reasoning / scope理由的英文
  不作为群文案泄漏，100%付费率也不是模型信心。

四次额外assessment调用均由原有一次结构修复触发：34 assessment + 7 draft + 7 scope = 48。
同validator诊断复验44 accepted、4 relation_invalid：qualified-risk:1的新问题误用unattempted_first
并写不存在的未发送历史；paraphrase两轮及separate-next:2均skip/none却填写materialChange.explanation。
四项第二次均结构合法，但最后一项仍语义漏报。被丢弃首候选不是最终assessment。
本轮没有拒稿或followup校验失败，不能倒推run3两项丢失内容，也不能宣布根治。

`2026-09-15T13:51:41Z` 后置只读检查：原core容器、标签、启动时间、restart0/runningtrue及配置stat
未变，run4测试容器已移除。没有生产部署/开关操作或新健康、队列、飞书投递验收。

## run4 后的明确输入合同缺口

上下文构建器以真实 job.messageId 和正文hash校验触发消息，但 modelContext 序列化只输出
triggerMessageId，sourceCatalog仅ref/kind、materials仅ref/text，丢失了messageId到正文ref的映射。
模型无法由触发ID精确定位正文，只能猜材料顺序。此缺口已由代码及真实payload RED确认，
与separate-next错误围绕旧问题相符；不是全部漏报/确定性扩写的唯一已证实原因。

随后有界修复只增加由可信binding解析的triggerMaterial:{ref,text}：唯一触发来源、恰一可用正文，
缺失/多义时不猜其它消息且不调用模型。乱序材料不改变绑定，不新增读取、来源或模型调用；
不再改决策/改写/复核提示。4项实际RED（25原测试通过）后最小实现已提交
`fbd187249df6ece652ee90cc4df2d060441cd1be`。

- model29 + trace5 聚焦34通过；主代理完整Core4631通过/463条件跳过，251文件通过/12跳过，
  `2026-09-15 21:54:24` 北京时间开始、24.92秒。CLI7通过；typecheck/build及runner strict编译退出0。
- 两文件范围独立复审通过，无Critical/Important/必要Minor；不重开之前trace及Task审查。
  无本次PG/Python全量或远端CI/实际群消息验收；未将输入绑定修复声称为全部语义问题已解决。

## run5：仅验证触发绑定修复

被评估应用 `fbd187249df6ece652ee90cc4df2d060441cd1be`；相同模型/原15例两轮/6000ms pacing/trace。
配置、调用规则、提示词与run4相同，唯一应用变化是明确触发正文绑定及错误输入拒绝。
私有目录 `/tmp/iris-pd-eval-20260915-run5-lR5PVxRl`。本地/服务端一致SHA256：

| 上传物 | SHA256 |
|---|---|
| runner.mjs | `be93b16dd7b7a4f451befc7c45034996510f0bdd28249460085286f13282e800` |
| model-config.mjs | `c6c6215d3b048b4c5e990fe6c79fdd9074ba8ff832f0e9146638f6db7d4f1ef5` |
| launch.mjs | `553f0e2c4b95f93ca350e50af38f3ddeb2de6f1a5156f9fb395221cf29bf4bab` |

network-none身份与配置装配预检通过；同样的只读容器/资源/总限时/无飞书与数据库依赖。
`2026-09-15T13:56:36Z`开始、`2026-09-15T14:02:11Z`结束（335秒），退出1、stderr0字节。
[run5原始报告](evidence/iris-proactive-discussion-20260915-model-run5.json)93821字节，SHA256
`6b65a8771b363ce808c43c69683942ec5977231fc1bd0cb0866466e593924b0b`，服务器/本地/归档一致。
manualReview=pending保留；下列为主代理与独立代理复核，不伪装为人员签字或群验收。

30个最终assessment的决策全部符合预期（10 intervene、20 skip）；8份最终草稿，
2个draft_rejected、无HTTP错误。完整语义口径为 **26通过、2失败、2未完整**，11个场景两轮通过。
54条trace完整、无丢弃或字段截断，包含34 assessment、10 draft、10 scope-review。
观察到的决策改善与触发绑定修复方向相符，但不是配对控制实验，不能证明全部改善由其造成或长期稳定。

| 场景 | 第一轮 | 第二轮 |
|---|---|---|
| arithmetic | 通过，16/6万，表达观察保留 | 未完整：draft_rejected，拒稿有依据 |
| inference | 失败：assessment断言严重高估转化率，草稿已限定 | 通过 |
| qualified-risk | 通过 | 通过，经一次结构修复 |
| separate-next | 未完整：draft_rejected，复核理由含误判 | 通过，正确识别独立权限问题 |
| material-update | 通过，24/8/14万 | 失败：assessment人数口径异常及确定性影响扩写 |
| paraphrase / unrelated-update | 两例均通过 | 两例均通过 |
| casual / hypothesis / handled / corrected | 四例均通过 | 四例均通过 |
| source-loss / stopped / injection / followup | 四例均通过 | 四例均通过 |

### run5 两项语义失败与两项拒稿

- inference:1的assessment称“属于严重高估转化率”。5人喜欢只能证明无法推出全体付费，
  不能证明实际转化率已经被严重高估。草稿加“可能导致收入预测严重偏高”，但不能覆盖仍被保留的
  assessment错误；qualified_inference标签也不能消除断言。
- material-update:2的assessment在正确24/8/14万之后写“维持 2 times 2 人的招聘规模”，
  与2人口径不一致，又以fact断言“对项目执行产生实质影响”。不能擅自将异常文字解释为确实计划4人。
  草稿恢复为2人并将影响限定为“可能”，完整结果仍不通过。
- separate-next:1，call11→12：被拒草稿明确写“可能存在合规与信息安全风险”，并建议确认权限、
  相关合规审批及核对授权。复核却称新增“核对授权动作”及“将推断作为确定结果”。核对授权是
  建议而非声称已执行，且草稿有明确条件限定；这两处理由含误判。“相关合规审批”确实比原文具体，
  保留措辞观察，不能因此将全部核实建议要求成已有事实。最终没有可用草稿，计未完整，不计安全成功。
- arithmetic:2，call29→30：草稿给出正确16万/6万，追加“会对项目执行造成实质影响”；复核准确
  指出其将未来影响写成确定结果，拒稿有依据。但仍未完成有用介入，计未完整。该assessment也有
  相同未来影响扩写，不能因已计未完整而遗漏。拒绝不证明整个机制已通过。

其余8次scope为true，部分理由称已对assessment过度断言加限定；这是模型自述，不是独立语义批准。
8份最终中文草稿没有英文策略词、模型信心数字或虚构执行承诺；内部英文理由及“2 times 2”不等于
群文案泄漏，100%付费率是业务内容。观察项：核对授权多处机械插入、明确算术之后的“缺口可能扩大”
过度弱化事实；建议调整薪酬或向管理层申请追加未声称成本全为薪酬或审批已经发生，不与确定性扩写混同。

### run5 结构修复及运行边界

诊断复验50 accepted、4 relation_invalid；以下首候选均由原有最多一次assessment结构修复纠正：

| 场景与调用 | 首候选问题 | 第二次结果 |
|---|---|---|
| casual:1，call18→19 | skip/none却有非空materialChange.explanation | 清空后合法skip |
| followup:1，call26→27 | 同上，解释为英文 | 清空后合法skip |
| qualified-risk:2，call34→35 | 新问题误用unattempted_first并编写未发送历史 | 改为new_issue |
| injection:2，call52→53 | skip/none却有非空解释 | 清空后合法skip |

这些是同validator的诊断复验，不冒充运行时原始错误详情或模型内部推理；不得将本轮followup的
具体原因倒填为run3当时的未知原因。没有本轮第三次额外抽样。

`2026-09-15T14:08:19Z`后置只读核对：原core容器ID、标签f6a6dd41、镜像摘要、启动时间、
restart0/runningtrue及配置stat与前置完全一致，run5测试容器已移除。没有部署、开关操作、
飞书外发、生产健康/队列验收或远端CI；两个本地修复提交不等于生产已更新。

## 下一步有限边界

本次两个有界修复已有回归、实模失败证据和四处文档闭环；主动讨论整体仍未通过，不能称已完成。
不再重复同一代码/配置/样本。下一步是待用户确认的有限设计，而非顺带扩展本次实现：

1. 最终保留的assessment和文案都要以授权原文核对；文案加“可能”不能替尚有错误的assessment背书。
2. 区分材料内事实、明确前提下的推断和建议；建议“先核对权限”不等于声称已核对或存在特定审批流程。
3. 如果允许复核拒绝后修正，最多一次，修正后重新复核；再次失败立即结束，不送群、不将未通过内容
   当作已核实事实或后续依据。具体调用上限、超时预算和持久化接口需要在设计中明确。
4. 不增加来源、群范围、权限、固定发言冷却或任务催办；不换模型或账号。Tasks1–8/I1–I4保持关闭。
5. 设计确认后才实施新的生成/复核循环或结构化合同。回归覆盖本次四个失败点及最大调用数，
   仍用原15例×2轮完整assessment+draft语义标准，不删除困难场景；未通过则带完整证据停止本次验收。

上述新循环尚未批准、未实现，不能把文档建议当作用户批准或已经具备的能力。

当前持久化边界已有保护：render返回null时，commitEvaluation会以assessment_or_draft_invalid
阻止该次问题正文更新和投递准备。因此不能声称两份拒稿已污染真实问题状态；本轮也没有连接生产
数据库作这种验证。该原候选仍可随blocked结果写入追加式evaluation审计，不是可用问题依据。
实际待补的是：复核只允许最终稿时，原assessment的last_observation/reasoning/
suggestion仍可随可用稿进入issue状态。联合复核设计必须返回同一份最终assessment/draft组合给
真实worker与合成evaluator，不能只改善报告或只修最终文案。

### 待确认的最小方案比较

推荐在PdModel内部统一编排：render返回通过复核的`{assessment,draft}`或null，先生成草稿，
对二者一起核对授权原文；不通过时仅一次成对修正及一次再次复核。修正只开放语义文本、uncertainty
和draft text，锁定decision、issue身份、证据refs和materialChange.kind，不凭复核意见扩充来源。
worker/evaluator共同消费返回组合；最终拒绝仍走blocked，不推进issue/delivery。
相比之下，把review/revise新方法暴露给worker及evaluator分别编排，会复制失败/次数状态机，
增加两条路径漂移风险，本轮不推荐。也不引入逐条主张的新领域合同或数据库迁移。

建议上限：skip仍1–2次completion；首次通过仍3–4次；用到一次成对修正及最终复核时5–6次。
既有HTTP客户端每个completion最多2次底层尝试、共享该次timeout预算，因此单次评估理论最多12次
HTTP请求，而不是12次独立完整timeout；429不自动重试。沿用目前60000ms时，模型completion
累计超时上界从最多240秒增为最多360秒（不含数据库/排队等耗时），正常首次通过不增加调用。
技术失败的durable恢复与语义再次拒绝必须区分，后者直接blocked；不能借技术重试无限修正。
这些是待确认设计约束，不是本轮已经实现的新接口、超时上界或新验收结果。

## 文档与证据收口核验

一次有限文档复审核对了版本、实模计数、两份新报告哈希、原场景标准及四处处置。
发现current-handoff当前优先项和两个专项入口仍把run3称为最新，已改为明确历史说明并指向本记录。
这是入口修正，不重开代码或架构审查。

- 本地链接检查：13份文档、283条本地链接、74个锚点，0错误；git diff --check通过。
- run1–5的15场景ID/expectedDecision/reviewCriteria均与当前factory完全相同，每份2轮/30结果，
  manualReview均保留pending；未改历史报告或语义标准。run1–3哈希与归档基线一致，run4/run5按字节复制。
- 本次最后应用提交仍为fbd18724；后续收口提交仅文档/合成证据，不能冒充新应用或生产部署。
  Core/CLI/类型/构建回归时间和条件跳过分别见上述两个修复段，未对文档变化虚报新全量测试。

## 四处文档处置

| 位置 | 本次处置 |
|---|---|
| 白皮书 | reviewed-unchanged：[第 6 节](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)及[11.2](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#112-mandatory-bug-fix-documentation-closure)的授权、可追溯及分层验收规则不变；本次观测、候选措辞与触发绑定修复落实既有来源/事实推断规则，不改变主动范围或调用循环 |
| 工程故障台账 | updated：[主动协作条目](../operations/engineering-failure-ledger.md#proactive-collaboration-is-not-a-deadline-reminder)补结构校验不等于语义批准、触发绑定不得丢失、候选错误不可被正确文案覆盖、核实建议不等于已执行声明，以及诊断复验不等于模型内部原因 |
| 需求覆盖基线 | updated：[日期修订](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md#2026-09-15-合成诊断与阶段合同修复)补新修复、回归和实模入口；IRIS-CORE-005仍未部署，不因诊断可用提升完成度 |
| README/AGENTS/当前交接 | updated：[README](../../README.md#current-product-state)、[当前交接](current-handoff.md#当前正在推进)、[专项入口](iris-proactive-discussion.md#当前边界)及[执行入口](iris-proactive-discussion-execution.md#当前状态)同步本次证据；reviewed-unchanged：[AGENTS](../../AGENTS.md)的工作树定位、四处闭环与有限出口规则仍准确 |
