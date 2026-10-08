# Iris 首个真实应沉默案例：有限通过，主动意见与发送仍待验收

日期2026-10-08。工作树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支
`codex/iris-daily-pilot-followup`，开始HEAD `f079d776`。生产应用仍为
`51937b954733020799e02f139abd32df74b3349c`，监督工具修复为
`749491868d5e6e422d5c26729511705176dc98ae`。没有新增应用修复、push或应用部署。
此前[连接中断的空窗口](iris-pd-window-20261008.md)已由 `f079d776` 归档，原事实保留。

用户再次明确就绪后，在原群开了独立新窗口，随后收到真实消息；沿用既有授权的精确
`qwen3.8-max`、免费限定、最多8次上游HTTP/15分钟及逐请求新鲜UI许可。
普通QA与知识草稿实际关闭，结束恢复global/desired/PD关闭；不复用旧窗口预算或任务。
[派生脚本](evidence/iris-pd-window-20261008b-stage.py)从policy6/disabled、14条事件和
原cancelled任务开始；[受保护启动器](evidence/iris-pd-window-20261008b-launch.ps1)
使用已确认的连接路径并保留原主机密钥严格校验。实际Core容器接线检查再次通过
60秒许可等待、30秒上游、120000ms专用客户端配置；未扩大模型权限或修改prompt。

## 实际请求与应用决定

以下时间均为2026-10-08 UTC。

| 时间 | 事实 |
| --- | --- |
| 05:25:08.224 | 原群窗口开启，policy version7。 |
| 05:26:36.421 | 真实请求生成pending。 |
| 05:26:50.499 | 刷新UI后确认精确型号余额533.62K/1M、2026-12-18到期、用完即停开启；随后写入绑定本请求的permit。 |
| 05:26:57.824 | 向供应商发送，距pending为21.403秒。 |
| 05:27:00.095 | HTTP200、reported tokens7217；本窗口实际上游调用共1次。 |
| 05:29:51.926 | 主动停止，门禁operator-stop、uncertain=false。 |
| 05:30:00.411 | 操作脚本完成恢复。 |
| 05:35:00.420 | 独立最终只读核验恢复状态通过。 |

本次许可与实际发送跨过旧20秒等待预算，修复后的60秒等待在真实链路完成。
这证明本次监督操作成功，不证明任何网络条件下都能及时许可，也不改变每次请求必须
重新观察免费额度的要求。UI余额观察不充当精确账单审计。

应用新增1个任务，最终`completed`、`attempts=1`；新增1次评估，`outcome=skipped`，
assessment为`decision=skip`、`reason=no_work_value`。observation/reasoning/suggestion
均为空，draft为null，没有创建issue或delivery，没有发送飞书意见。
HTTP成功与任务完成本身不足以证明沉默正确，语义判断另按下节独立来源比较。

## 独立来源判断与有限语义结论

独立审查代理仅看到来源资料，没有看到实际模型判断、文案或评估结果。
最初DB可恢复19/20条原文，缺失1条；该阶段的预期判断保留。随后通过绑定的精确消息ID
只读回取飞书原文，20条均成功且全部内容哈希匹配，再补齐来源资料。
审查代理在05:34:23 UTC冻结完整来源下的`should-skip`判断，主执行者随后才比较实际结果。
补齐前后的`should-skip`判断一致，旧预期没有被覆盖。这是运行后的独立盲审来源判定，
不冒称在模型调用前预注册了该预期。

来源显示该案例属于普通会议时间协调，没有需要新增主动工作意见的实质问题。
实际`skip/no_work_value`与冻结预期一致，没有编造观察、论证、建议或不必要的意见。
[脱敏语义证据](evidence/iris-pd-real-skip-20261008-semantic.json)记录冻结资料哈希与比较，
不提交私人原句、消息ID或人名。

结论仅为首个真实“应沉默”负例有限通过。已保存的来源绑定和事后回取原文不等于
当时精确模型wire或完整context重建；哈希匹配证明相应绑定原文一致，不能扩大为逐字请求复现。
始终沉默的系统也能通过单个负例，本次不证明主动发现、意见生成或发送能力已经可用。

## 恢复与证据边界

[最终核验脚本](evidence/iris-pd-window-20261008b-final.py)与
[脱敏最终证据](evidence/iris-pd-window-20261008b-final.json)确认05:35:00.420 UTC：
Core健康、应用与镜像保持；global=false、desired=false、PD enabled/running=false，
policy version8 disabled、revision3418。能力和live env恢复，`.env.pilot`及Compose
原字节相等，非Core容器ID/镜像不变，watchdog恢复失败记录0。
pending/permit/outcome/final各1、uncertain0；上游HTTP1、reported tokens7217、飞书意见0。

最终域表为policy1/group1/jobs2/evaluation1/issue0/delivery0/source21/events21；
两个任务分别是原cancelled任务与本窗口completed任务，历史记录未清除或重置。
普通QA能力恢复原值，但global关闭，实际QA仍关闭。主动提前停止及恢复已经验证，
不把本次结果写成15分钟自然超时的故障演练。最终运行证据将语义验收留给独立来源比较，
真实飞书意见发送层级仍为未执行。

## 下一步与有限出口

这次真实调用、应沉默判断与恢复记录构成本案例的有限出口，不重复同配置抽样凑通过，
不追加prompt或广泛审计。原群下一项仍需新的真实实质工作输入，检查是否主动发现
需要关注的问题、生成有依据的意见并实际发送；重复/已处理、新问题等验收也未完成。
@追问仍待另行启用QA范围后的验收，本窗口普通QA关闭。
本窗口已关闭，不自动续开。既有用途授权不重复询问，但新窗口仍需成员当时就绪。
原限定语义失败、历史文档前1200字等限制保留，IRIS-CORE-005仍部分实现，整体产品缺陷未关闭。

## 白皮书11.2四处处置

| 位置 | 处置 |
| --- | --- |
| 白皮书 | **reviewed-unchanged**：[§6、§8、§11.2](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md)的来源权限、主动发言边界、验收层级和有限出口仍适用；本次新增一个真实负例证据，没有改变稳定产品规则。 |
| 工程故障台账 | **updated**：[故障台账](../operations/engineering-failure-ledger.md)记录新时间预算首次完成真实许可、独立来源冻结与单个沉默负例的验收边界，保留原超时与连接中断事实。 |
| 核心需求覆盖基线 | **updated**：[核心需求覆盖基线](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)区分真实应沉默负例有限通过与主动意见/发送尚未验收，IRIS-CORE-005仍部分实现。 |
| README / AGENTS / current-handoff | **updated**：[当前交接](current-handoff.md)指向本案例、实际关闭状态及剩余正例门槛。**reviewed-unchanged**：[README](../../README.md)的应用51937b95及交接入口仍有效；[AGENTS](../../AGENTS.md)的工作树定位、授权和四处闭环要求没有变化。 |
