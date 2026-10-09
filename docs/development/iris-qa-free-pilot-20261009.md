# Iris 普通问答免费门禁与限定群接线

日期2026-10-09。基线4eeadd9f，实现树
`D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支`codex/iris-daily-pilot-followup`。
用户要求持续解决“主动意见不明白，回复/@Iris没有回应”的产品闭环。上次
[关闭状态发布](iris-release-c7a286f3-20261009.md)已完成，生产最后核验为c7a286f3、
global/desired/普通QA/PD关闭。本轮只进行本地修复和模拟接线，不把上次发布许可扩成新开窗。

## 仓库事实与修改范围

截图中未回复发生在QA关闭的窗口边界，不能认定问答模型执行失败。继续启用QA前发现：

- QA的router、planner、renderer和直接回答共用`IRIS_MODEL_*`客户端；旧PD门禁只接受
  json_object，直接回答不带response_format；共享配置读取器和Compose没有传递
  max_tokens/enable_thinking。直接指向旧门禁会被拒绝，30秒默认超时也不足以覆盖人工许可。
- Runtime只有禁用群黑名单；开启global+reply会同时开放未禁用群和无群草稿入口。
  新增可选`IRIS_ANSWER_ALLOWED_GROUP_IDS`仅限制QA，两类QA入口及发送前共用同一controller。
  非空CSV逐项trim、去重并拒绝空项；缺省/全空保持原兼容行为，不能当作仅单群配置。
  已有global/能力/禁用群仍须通过，enableGroup或持久策略更新不能扩大部署白名单。
  真实启动工厂必须传入该env同时保留启动global=false；单测实例配置正确不足以证明装配正确。
- QA deferred生成及receipt投递此前没有统一能力复查，来源权限检查不能代替QA开关。
  补齐生成前、receipt准备/发送准入、普通回复/安全提示/模型回退的关闭检查。
  独立审查进一步用实际Feishu replier的假令牌/假HTTP复现：等待令牌期间关闭后仍启动回复
  HTTP，原检查早于该await。本轮将同一同步检查带到取令牌后、实际发送前，避免把这一间隙
  错称为已发出的网络请求。

共享配置新增可选`IRIS_MODEL_MAX_TOKENS`和`IRIS_MODEL_ENABLE_THINKING`，空值不增添默认
请求字段；显式值严格校验。Compose只透传到Core，不改变AI worker的独立模型配置。
既有客户端及各阶段重试继续经过同一base URL；没有备用模型或直接供应商回退。

## 同一个受监督预算

[门禁](../../scripts/pilot/proactive-discussion-free-gate.mjs)默认`profile=pd`及旧许可保持兼容。
显式`IRIS_PD_FREE_GATE_PROFILE=pd-and-qa`额外允许完全省略response_format的文本请求；
不接受null、json_schema或流式请求。精确模型仍为qwen3.8-max、max_tokens4096、
enable_thinking=false。请求正文原字节转发，不加业务提示或改变语义审核职责。

联合pending/结果标明profile和responseMode（json_object/text）；每份许可除原随机
requestId、wire SHA、精确型号、新鲜额度观察、用完即停外，还必须匹配这两个字段。
门禁区分实际请求格式，不声称能从JSON请求识别其业务来源。一次联合会话共用8次实际
上游HTTP、15分钟、reported tokens达到60000后停止下一次请求；不按QA另开预算。
最后一次可越过60000，仍依赖供应商免费用完即停，不把软阈值写成严格总token上限。
人工观察免费余额至少200000、未到期、用完即停，观察时间不得早于对应pending且不足60秒；
没有实时账单查询接口。本轮没有观察新额度或调用模型，历史页面余额不作当前事实。

许可等待60秒、上游30秒，两个客户端目标超时均120000ms。任何模型/许可/额度异常停止
整个联合窗口，不开新窗口凑通过。QA各阶段纠正和技术重试可能增加HTTP次数；8次是合并的
硬边界，不承诺一次完整QA总能在余量内成功。

## 本地验证与仍未验收的部分

[compiled接线](../../scripts/pilot/qa-free-gate-wiring-smoke.mjs)使用真实编译后的mention
responder、QA orchestrator、router、planner、文本model provider及grounded renderer，
实际loopback HTTP经过同一个门禁；context/provider响应/delivery均为合成替身。
无许可路径为0上游、0模拟发送；成功路径为1个PD形状的结构请求+两次不同QA路径，合计
7次模拟上游、2次模拟交付，逐请求独立许可、原始wire一致。其他群0调用，关QA后0新调用。
这证明组件接线兼容性，不是生产app或PD runtime实跑；启动工厂/运行时装配由对应测试验证。
没有真实embedding、Feishu、供应商或真实业务材料，也没有模型语义通过结论。

已发起的HTTP不能靠随后关闭开关撤回，成功回执仍必须落sent。关闭发生在receipt发送准入
已写入之后时，保留现有sending/safe_notice_sending记录供对账，不能谎写sent、删除记录或
盲重发。此限制属于现有对账流程，不在本轮新增状态机。
普通QA仍依赖近期助手意见上下文；定向获取任意历史父消息不在本次实现范围。
一次模拟“我没听懂”能返回文本，不证明实际模型会正确承认/纠正上一条误判。

## 待批准的具体联合验收范围

本地门槛通过后可提出一次新窗口，当前**未启用**：

1. 推送本次精确修复并通过免费CI，再仅更新生产Core；保持global/QA/PD关闭并核对备份、
   配置、业务记录及入口边界。新CI不通过则不发布，不改用付费runner。
2. 窗口仅原`PD_PILOT_CHAT`群，QA部署白名单精确绑定该群，拒绝其他群及无群草稿；PD仍用
   既有原群名单。生产QA与PD临时共同指向同一loopback门禁，qwen3.8-max/4096/thinkingfalse/
   120秒，PD使用source-plan。这会临时改变原普通问答模型配置，必须在开窗许可中明确。
3. 扩展现有受保护凭据用途到这一轮原群真实QA；逐请求核对免费额度和用完即停。知识草稿、
   memory、旧主动planner/工具等门禁外模型路径须关闭，embedding只准核验过的本地服务。
   不把QA白名单当全局消息处理白名单；必须核对global启用影响的其他入口仍无模型/外发。
4. 用户在场后最多15分钟、合计8次HTTP：一个真实议题，若产生意见，成员直接回复并@Iris
   追问含义；独立核对意见依据、解释是否接住原话、有错是否纠正。合理沉默保留原判据，
   不为得到意见另造题或重采。请求额度不足、额外触发、发送未知或语义失败立即停止。
5. 结束先停门禁，再关闭global、QA和PD/policy并核持久化，恢复本窗口配置；检查sent/unknown
   与原事件，不重放。没有成员在场不提前开窗；准备完成时暂不要求用户发群消息。

这份方案使下一次授权对应明确可审阅范围；本轮“继续”没有自动启用新模型配置或群发。

## 白皮书11.2四处闭环

| 位置 | 处置 |
| --- | --- |
| 白皮书 | **updated**：[第8节](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#8-admin-console-and-runtime-control)记录QA部署范围和发送前关闭检查，不把试点预算变成产品发言频率。 |
| 工程故障台账 | **updated**：[台账](../operations/engineering-failure-ledger.md)记录共享客户端/文本格式/启动装配及token-await检查遗漏，保留真实失败和未解决语义问题。 |
| 核心需求覆盖基线 | **updated**：[基线](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)区分本地保护、有限模拟接线及未完成的真实意见/追问验收；IRIS-CORE-005仍部分实现。 |
| README / AGENTS / current-handoff | **updated**：[README](../../README.md#current-product-state)及[交接](current-handoff.md)补本地候选/待验范围；**reviewed-unchanged**：[AGENTS](../../AGENTS.md)的工作树、授权和四处闭环规则不变。 |

## 精确候选与验证结果

应用本地提交`aff258f7fa0a1560cdbe51d305bf97bb88c5a0b5`；本记录及证据另作文档提交，
不能当作新应用版本。候选尚未push、运行新CI或部署，生产最后实测仍为c7a286f3。

| 验证 | 结果及边界 |
| --- | --- |
| 最终完整Core | 5165通过、471条件跳过；285文件通过、13文件跳过。跳过不算实库验收。 |
| 完整pilot | 230/230通过；运行在最后token-await修复前，受影响的编译QA接线在修复后重建并重跑通过。 |
| 最终类型检查 / 构建 | 均exit0。 |
| 最终发送边界四组测试 | 265/265通过，包含令牌等待后关闭及禁止重新开启时重放。 |
| 联合门禁 | 32/32通过；RED阶段25通过/7失败，未调用真实供应商。 |
| 最终编译QA接线 | 1/1通过；7次模拟上游、2次模拟交付，真实模型/飞书均0。 |
| 精确提交本地镜像 | linux/amd64、USER node，revision=aff258f7；构建通过，生产依赖审计total0。 |
| 镜像内断网QA接线 | 通过；仅容器loopback及合成替身，未启动应用服务器。 |

镜像`iris-core:aff258f7-local-20261009`，ID
`sha256:9be24803b0a63b12b29dd2fe158f0c7e3506b803ba013b25db7335fc24866f6c`。
镜像从精确提交的git archive构建，未上传或部署。可审计结果与本地日志哈希见
[本地验证证据](evidence/iris-qa-free-pilot-20261009-local.json)及
[镜像证据](evidence/iris-qa-free-pilot-20261009-image.json)。独立审查发现的token-await间隙
已修正并复现为关闭后0次回复HTTP；不扩大为对已经发出的HTTP可撤回的承诺。

本轮生产访问、外部模型HTTP、飞书外发均为0。代码和本地门槛通过，新的实模语义、
真实飞书意见及追问验收仍未通过；产品缺陷没有关闭。
