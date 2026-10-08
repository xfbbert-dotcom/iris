# Iris 真实触发窗口：许可等待超时与本地时间预算修复

实际窗口日期2026-10-07；本地修复与最终人工复核日期2026-10-08。
工作树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支
`codex/iris-daily-pilot-followup`，开始HEAD `f388b1f9`且干净。
本轮仅修复监督工具；应用始终为 `51937b954733020799e02f139abd32df74b3349c`。
工具修复提交 `749491868d5e6e422d5c26729511705176dc98ae`；没有push、新应用部署或新的
实模语义通过结论。后续文档提交不代表应用换版。

## 实际发生了什么

沿用用户已明确批准的[原群有限范围](iris-pd-supervised-pilot-20261006.md)，用户就绪并完成
百炼登录后启动新窗口：最多8次上游HTTP、15分钟、逐次精确型号免费许可，普通QA与知识
草稿实际关闭。没有扩大到其他群、付费回退、无限窗口或恢复普通QA。

[新目录派生脚本](evidence/iris-pd-window-20261007-stage.py)先核对上一窗口脚本哈希，
新建独占私有目录；保留已有policy/group/events，不清表、不复用旧窗口预算。
前检改为精确比较上一窗口结束计数和policy version2/disabled，并核对Wiki原true；
准备过程临时隔离Wiki，结束恢复。凭据仍经[受保护启动器](evidence/iris-pd-window-20261007-launch.ps1)
传入，没有打印、提交或重新创建key。

| 时间（UTC，2026-10-07） | 证据 |
| --- | --- |
| 09:45:22.998 | 原群窗口开启，policy version3。 |
| 09:47:17.885 | 收到真实成员的会议安排消息；正文只保留在私有证据。 |
| 09:47:28.512 | 首条模型请求生成pending，开始20秒许可等待。 |
| 09:47:48.522 | 门禁超时停止，uncertain=false。 |
| 09:47:48.624 | 刷新页面后完成观察：精确qwen3.8-max剩533.62K/1M，2026-12-18到期、用完即停已开启。已经超时，没有补写许可。 |
| 09:47:58.394 | watchdog完成关闭及恢复。 |
| 09:53:32.738 | 独立最终只读核验Core健康、global/desired/PD关闭、policy version4 disabled、revision3406。 |

[最终脱敏证据](evidence/iris-pd-window-20261007-final.json)由
[最终核验脚本](evidence/iris-pd-window-20261007-final.py)生成。实际1个pending，
permit/outcome/final/uncertain均0；门禁在调用fetch前必须写outcome，因此本次供应商
HTTP=0、reported model tokens=0。没有模型评估或飞书意见发送，不能把没有回复判成合理沉默。
任务最终cancelled，attempts=2：先发生许可失败，随后任务因policy关闭失效；不是2次模型HTTP。

env、Compose原字节相等，live env和能力字段恢复，非Core容器ID/镜像不变，watchdog恢复
失败记录0。业务表保留policy1/group1/job1/events12，其余评估/问题/发送/来源均0。
无sending/unknown待对账；普通QA能力虽恢复原值，global=false仍使实际QA关闭。
生产状态证据是上述10月7日快照，10月8日本地修复阶段没有再次访问或更改生产。

## 已确认的根因与有限修复

这次失败发生在模型调用之前，不能归因于429、模型语义、群内容或额度不足。
原20秒只覆盖程序等待，没有实测人工观察、浏览器及命令工具往返需要的时间。
同日09:55:28.504启动的[原版本地人工校准](evidence/iris-pd-operator-calibration-20261007-before.mjs.txt)
使用占位key与注入假上游；09:55:53.513才完成页面观察，约25秒，仍超时422、假上游0次。
[失败报告](evidence/iris-pd-operator-calibration-20261007-failed.json)原样保留；其中旧字段
`windowLimitMs=20000`表示许可等待期限，不是整个15分钟窗口。

选择一次有界修复，不重开旧任务、不修改语义验收、不增加prompt：

| 时间约束 | 修复后 |
| --- | --- |
| 每条请求等待人工许可 | 60秒，仍受15分钟窗口余量及客户端断开限制。 |
| 上游模型请求 | 30秒，保持原值。 |
| 使用门禁的专用客户端 | `IRIS_PROACTIVE_DISCUSSION_MODEL_TIMEOUT_MS=120000`，覆盖许可、上游与传输；不修改普通QA或应用默认值。 |
| 许可的新鲜度 | 观察发生在该请求之后、非未来且不足60秒；仍绑定requestId/hash、免费余额至少200000、未到期、用完即停。 |

[门禁模块](../../scripts/pilot/proactive-discussion-free-gate.mjs)导出同一时间配置供
[编译客户端接线检查](../../scripts/pilot/proactive-discussion-free-gate-wiring-smoke.mjs)与
[人工校准](../../scripts/pilot/proactive-discussion-operator-calibration.mjs)使用。
8次HTTP、15分钟、reported tokens达到60000后阻止下一次、默认拒绝及失败停窗均不变。
最后一次仍可能超过token阈值，不能写成严格总token上限。

[评估worker](../../apps/core/src/proactive-discussion/evaluation-worker.ts)原有每20秒续租，
不能把60秒lease误当成整个评估只能持续60秒；本轮未改worker，也不宣称长等待已做生产验收。
未来新窗口必须同时采用新门禁与120000ms专用配置，并核对实际容器值。
10月6日/7日执行脚本与其20秒/60000ms记录是历史证据，不能原样用来启动新预算。

## 验证与明确退出条件

先增加默认预算下的真实loopback回归：让测试时钟经过25秒再提交该请求的新鲜许可。
旧代码返回422而期望200，明确见RED；修改默认预算后通过。另一例确认一分钟之后即便
许可新鲜仍拒绝，且零上游。没有使用测试专用放宽参数来冒充默认配置通过。

首次完整门禁检查21/22：旧在途取消用例通过outcome文件推断已发出请求，但该文件实际
是dispatch-prepared；取消可能正确发生在fetch之前。两处在途测试现在等待假上游实际
进入，再验证停止/取消，不改变应用行为或删除断言。随后22/22通过。

编译配置解析器/客户端到真实loopback门禁两例通过：缺许可拒绝且不重试；假许可放行
完整wire，实际客户端定时器120000ms。编译客户端/config哈希与10月7日生产接线检查相同。
所有上游均为注入假响应，没有生产配置、真实key或业务材料。

10月8日04:40:07.093–04:40:47.639 UTC的[完整人工复核](evidence/iris-pd-operator-calibration-20261008-passed.json)
使用实际编译客户端，04:40:21.467刷新并读取页面后写入仅对该模拟请求有效的许可。
总等待40.546秒，HTTP200，loopback1次/假上游1次/真实provider0次；模型语义与飞书验收
均false。这证明本次人工操作能完成，不证明任意网络延迟或今后每一窗口都能完成。

[本地验证摘要](evidence/iris-pd-timing-20261008-local.json)保留RED、首次21/22失败、最终
22/22、编译接线结果及被测文件字节SHA256。完整 `npm run test:pilot`：217项中216通过、
0失败、1条件跳过，305.904秒；跳过是本机Docker daemon不可用的既有Caddy边界探测，
不能记为217通过。本次未改Caddy或应用源码，不扩大到无关Docker启动或重跑Core全套。
Python AST两文件、受保护PowerShell启动器解析、校准JS语法及diff检查通过。
五份相关文档的302个相对文件链接、11份证据/工具文件SHA256核对有效。
本轮的有限出口是原失败回归、既有门禁边界、编译客户端接线、一次人工完整流程及四处
文档闭环；通过后不继续扩建门禁。整体主动讨论能力缺陷与IRIS-CORE-005部分实现状态保持。

## 下一次真实验收的条件

本次已发送消息不重放，取消任务不重置，旧窗口不恢复；用户无需为本地修复再次发消息。
下一次需要成员仍就绪并在新的有限窗口产生真实讨论；原群、模型、免费预算与隔离范围
授权不重复询问，但不能把过去的就绪理解为用户始终在场或授权无限重开。
新窗口从policy version4/disabled及保留任务记录核对现场事实，采用上述新时间配置，
按来源判定应介入或应沉默，再检查实际决定、文本、引用、建议与回执。
当前没有真实模型或飞书意见验收；该产品门槛仍须实际输入与实际结果，不能被更多工具测试替代。
原限定语义失败、历史文档前1200字及未保存逐次完整wire的证据局限继续保留。

## 白皮书11.2四处处置

| 位置 | 处置 |
| --- | --- |
| 白皮书 | **reviewed-unchanged**：[§6、§8、§11.2](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md)的权限/控制分层、有限出口及验收层级仍适用；只修监督工具时间预算，不改变主动讨论策略或语义合同。 |
| 工程故障台账 | **updated**：[人工监督耗时缺乏端到端验证](../operations/engineering-failure-ledger.md)记录实际超时、根因、回归和停止条件。 |
| 核心需求覆盖基线 | **updated**：[真实触发尚未进入模型](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)区分工具修复、真实模型未调用与飞书未验收，IRIS-CORE-005仍部分实现。 |
| README / AGENTS / current-handoff | **updated**：[交接入口](current-handoff.md)及[原准备记录的后续指针](iris-pd-supervised-pilot-20261006.md)。**reviewed-unchanged**：[README](../../README.md)的应用51937b95、关闭状态及交接链接仍有效；[AGENTS](../../AGENTS.md)的定位、授权、有限出口及四处闭环规则未变化。 |
