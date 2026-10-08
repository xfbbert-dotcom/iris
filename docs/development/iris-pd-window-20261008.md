# Iris 受监督窗口：新时间配置接线通过，监督连接中断后提前关闭

日期2026-10-08。工作树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支
`codex/iris-daily-pilot-followup`，开始HEAD `553c5c8c`。生产应用仍为
`51937b954733020799e02f139abd32df74b3349c`；本次没有发布新应用或改变模型语义实现。
采用的监督工具修复为 `749491868d5e6e422d5c26729511705176dc98ae`，其原始失败、
本地回归及人工校准保留在[10月7日窗口与时间预算修复](iris-pd-window-20261007.md)。
本记录不将连接替代路径写成新的应用修复提交，也不宣称主动讨论整体缺陷已关闭。

## 范围与准备

用户就绪后沿用[原群一次有限窗口的既有授权](iris-pd-supervised-pilot-20261006.md)：
精确 `qwen3.8-max`、最多8次上游HTTP、15分钟、逐请求刷新UI后独立免费许可，
普通QA与知识草稿实际关闭；结束恢复global/desired/PD关闭。没有扩大群范围、
免费预算或其他能力，也没有授权无人值守续窗。

[新窗口派生脚本](evidence/iris-pd-window-20261008-stage.py)核对上一窗口私有脚本哈希，
独占新建目录，并从policy version4/disabled、既有1个cancelled任务及12条事件开始；
不清表、不重置或重放10月7日任务。门禁与接线检查替换为已核验的工具修复字节，
专用客户端设置120000ms；门禁许可等待60秒、上游30秒及8次/15分钟限制保持。
门禁启动前记录起点，看门狗从该起点计890秒开始收尾，不能从较晚的人工读取时间重新计窗。
[受保护启动器](evidence/iris-pd-window-20261008-launch.ps1)沿用既有凭据传递方式，
没有重新创建key、打印凭据或把凭据写入仓库。

只读[前检证据](evidence/iris-pd-window-20261008-preflight.json)于05:08:59.637 UTC确认
Core健康、应用51937b95、global/desired关闭、revision3406，原群未禁用；域表计数与
上一窗口结束一致。Wiki现场原true按既有范围临时关闭；其余非PD入口隔离保持。
05:09:12 UTC刷新百炼页面，精确型号免费余额533.62K/1M、2026-12-18到期、
用完即停已开启。该观察只供准备，不充当之后任一请求的许可或账单审计。

prepare成功，实际Core容器中的接线检查通过60秒许可/30秒上游/120秒客户端配置，
并核对真实容器env、门禁SHA256及时间配置。该检查使用假上游，不能记为真实模型语义通过。
独立本地只读复核以纯内存重建10月6日→7日→8日派生：7份源及历史派生哈希匹配，
2份Python AST、5份JS语法检查通过；该本地复核不执行生产stage主体或产生真实provider请求。

## 实际开启、中断与关闭

以下时间均为2026-10-08 UTC。

| 时间 | 实际观察 |
| --- | --- |
| 05:11:19.737 | 开启原群新窗口，policy version5。首次等待pending返回idle。 |
| 开启后 | 原SSH域名路径出现两次connection closed、一次timeout，无法继续可靠监督。没有写入permit；当时也未收到用户已发送消息的确认。 |
| 05:16:17.553 | 经保留主机身份校验的直连路径执行stop；门禁确认operator-stop、uncertain=false。 |
| 05:16:26.038 | 操作脚本报告恢复完成，global/desired/PD均关闭。 |
| 05:16:56 | 公共health检查HTTP200。该检查只证明公共健康端点可访问。 |
| 05:19:56.848 | 独立最终只读核验确认Core健康、global/desired/PD关闭、policy version6 disabled、revision3412。 |

本机DNS对既有SSH域名返回198.18.0.94，公开阿里DNS解析返回43.160.229.172。
本次通过覆盖SSH的HostName到公开地址，同时保留原域名HostKeyAlias并显式设置
`StrictHostKeyChecking=yes`，成功连接并完成关闭。没有跳过或关闭主机密钥校验。
证据只确认这次域名连接路径失败、替代直连路径成功；尚未确认DNS、代理内部机制、
网络链路或服务器中哪一层是根因，不能把其中任一猜测写成已修复故障。

恢复脚本报告域表为policy1/group1/job1/events14，evaluation/issue/delivery/source均0；
仅有原cancelled任务，没有新任务或投递。两条新增事件是本窗口控制事实的一部分，
旧任务与历史事件保留。这证明当次未注册新的主动讨论任务，不等于证明成员绝未发送消息，
也不能把没有回复判成模型合理沉默。

## 证据与验收层级

本窗口pending/permit/outcome/final/uncertain文件均0，上游HTTP0、reported tokens0、
飞书意见0。独立只读取证没有本窗口新任务、评估或投递；真实模型语义与飞书意见验收均未执行。
生产接线、实际开启及主动提前关闭已经发生；这不是15分钟自然到期恢复的故障演练。

[最终核验脚本](evidence/iris-pd-window-20261008-final.py)生成的
[脱敏最终证据](evidence/iris-pd-window-20261008-final.json)记录05:19:56.848 UTC独立检查：
Core健康、应用及镜像保持；global=false、desired=false、PD enabled/running=false，
policy version6 disabled、revision3412。live env和能力与开窗前相同，`.env.pilot`及
Compose原字节相等，非Core容器ID/镜像不变，watchdog恢复失败记录0；门禁停止为
operator-stop、uncertain=false，没有sending/unknown待对账。
普通QA能力恢复原值，但global=false，实际QA仍关闭。私有取证仅用于确认本窗口绑定事实，
不提交真实业务正文或凭据，不据事后数据声称重现了不存在的模型请求。

没有新应用部署、模型语义通过或真实飞书意见通过结论。IRIS-CORE-005仍部分实现；
原有限语义失败、历史文档前1200字及未保存逐请求完整wire等证据限制仍然有效。
此次监督连接故障的归因保持未确定，不以重试旧窗口或进一步无界加固替代产品验收。

## 下一步与有限出口

本窗口已停止，目录、预算和旧任务均不复用。主执行者已询问用户是否仍在场；只有收到
明确仍就绪并可继续的回复，才考虑同范围的新有限窗口。既有用途授权无需重复询问，
用户随后明确回复“现在方便，等你通知”；后续新窗口另行记录，不改写本次失败。
先前就绪不能被解释成无限等待或自动连续开启。
下一次连接路径已确认一次可用，
仍须现场核对；不得把替代路径一次成功写成以后每次连接都可靠。

下一产品门槛仍是新的真实成员输入与实际判断/意见：逐请求确认新鲜免费许可，
依据来源检查应介入或应沉默，再核对文本、引用、限定、建议与回执。
本次安全关闭与独立恢复核验已完成，记录交接后不继续扩大连接审计或工具建设。

## 白皮书11.2四处处置

| 位置 | 处置 |
| --- | --- |
| 白皮书 | **reviewed-unchanged**：[§6、§8、§11.2](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md)的来源授权、控制分层、有限出口及验收层级仍适用；本次执行有界窗口并在监督中断后关闭，没有改变产品语义或权限规则。 |
| 工程故障台账 | **updated**：[故障台账](../operations/engineering-failure-ledger.md)记录监督连接中断、保留主机校验的替代路径、未确定归因与先停止再确认就绪的出口，不宣称代理或DNS根因已修复。 |
| 核心需求覆盖基线 | **updated**：[核心需求覆盖基线](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)区分新时间配置已用于生产接线、提前关闭恢复与真实语义尚未执行，IRIS-CORE-005仍部分实现。 |
| README / AGENTS / current-handoff | **updated**：[当前交接](current-handoff.md)保留工作树/分支、已停止窗口和下一次就绪条件。**reviewed-unchanged**：[README](../../README.md)的应用51937b95、关闭状态及交接链接仍有效；[AGENTS](../../AGENTS.md)的定位、授权、有限出口和四处闭环规则未变化。 |
