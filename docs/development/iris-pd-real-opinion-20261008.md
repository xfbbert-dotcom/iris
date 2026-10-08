# Iris 首次真实意见投递：传输核验通过，介入判断与意见语义失败

日期2026-10-08。工作树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支
`codex/iris-daily-pilot-followup`，开始HEAD `193d0654`。生产应用仍为
`51937b954733020799e02f139abd32df74b3349c`，监督工具修复仍为
`749491868d5e6e422d5c26729511705176dc98ae`。本轮没有新应用修复、push或应用部署。

本次真实讨论被错误介入，生成的意见也未通过来源语义核查，不能记为主动协作能力验收通过。
4次精确`qwen3.8-max`请求均HTTP200，reported tokens合计25899；实际发送1条飞书意见，
回执、正文和父消息一致性核验通过。用户反馈判断不对或造成打扰，随后表示看不懂该意见。
整体缺陷保持未关闭，IRIS-CORE-005仍部分实现。

此前[普通协调应沉默案例](iris-pd-real-skip-20261008.md)的有限通过和
[监督连接中断窗口](iris-pd-window-20261008.md)均保留；本轮失败不覆盖旧证据，旧负例通过
也不能抵消这次已发生的错误外发。

## 授权、执行与恢复

用户明确回复可以开窗后，从policy8 disabled、原cancelled任务1与completed任务1开始新窗口。
沿用原群、免费模式、最多8次上游HTTP/15分钟和逐请求新鲜UI许可，没有重放或重置旧任务。
[派生脚本](evidence/iris-pd-window-20261008c-stage.py)与
[受保护启动器](evidence/iris-pd-window-20261008c-launch.ps1)保留上一轮脚本哈希核验、
严格主机身份校验与受保护stdin凭据传递。普通QA和知识草稿能力在窗口中实际关闭。

以下时间均为2026-10-08北京时间（UTC+8）。

| 时间 | 事实 |
| --- | --- |
| 16:20:08.910 | 原群新窗口开启。 |
| 16:21:48.897 | 首次真实请求生成pending。 |
| 16:22:11.760—16:24:10.416 | 四次上游请求先后完成，HTTP200；tokens分别为8057、5156、5634、7052。 |
| 16:24:44.072 | 门禁operator-stop，uncertain=false。 |
| 16:24:52.699 | 操作脚本完成关闭与恢复。 |
| 16:29:30.544 | 独立来源审查冻结insufficient-evidence，认为本例应skip。 |
| 16:31:07.664 | 独立最终运行核验通过。 |

四次请求分别于16:21:59.114、16:22:48.227、16:23:15.071、16:23:47.776刷新页面核对
精确型号，页面均显示剩余526.40K、2026-12-18到期、用完即停开启，再写入各自绑定
requestId/hash的许可。页面余额观察不是精确账单审计；实际用量由四份响应记录汇总。
门禁60秒许可等待、30秒上游、120000ms客户端的实际Core接线检查通过，未扩大预算或付费回退。

[最终核验脚本](evidence/iris-pd-window-20261008c-final.py)及
[脱敏最终证据](evidence/iris-pd-window-20261008c-final.json)确认：Core健康，应用与镜像
不变；global=false、desired=false、PD enabled/running=false，policy10 disabled、revision3424。
能力和live env恢复，`.env.pilot`与Compose原字节相等，非Core容器ID/镜像未变。
watchdog恢复失败0，pending/permit/outcome/final各4，uncertain0，没有sending或unknown投递。

最终域表为policy1/group1/jobs3/evaluation2/issue1/delivery1/source63/events42。
本窗口新增job1、evaluation1、issue1、delivery1，job为completed且attempts=1，delivery为sent。
旧cancelled任务1和completed任务1完整保留。已停止的窗口不自动续开，也不自动外发解释或更正。

## 独立来源判断与实际错误

独立来源审查未看到本轮模型决定、生成文案或投递结果，在16:29:30.544冻结
`insufficient-evidence`判断：当前材料不足以支持主动指出实质问题，本例应skip。
这是运行后的独立盲审来源判断，不是模型调用前预注册的预期。
[脱敏语义比较](evidence/iris-pd-real-opinion-20261008-semantic.json)保存来源与冻结判断的
哈希和比较结果，不提交私人原句、文档标题、人名或消息ID。

来源的抽象含义是阶段完成后再落实相关文档事项，已经明确保留了时间或条件。
实际评估却选择intervene，并把这一保留条件误作已被绕过的前提；据此生成的固定模板建议
没有成立的来源基础。已发意见的介入理由与建议均不能因审核通过或发送成功而视为正确。
用户关于判断不对、造成打扰以及看不懂的反馈与本次语义失败一并保留，不改预期使其通过。

精确消息回读执行1次认证、21次GET，取得20条人类消息和1条助手意见；40个消息来源绑定
内容哈希全匹配，触发消息登记哈希匹配，已发正文与落库正文逐字一致，父消息也与触发消息一致。
这些证据只使本次最高验收层级达到真实传输、回执和正文对应核验通过，意见语义仍然失败。
来源绑定与事后哈希匹配的原文不等于保存了当时逐次wire或完整context，不能声称逐字请求复现。

## 为什么截图中的@追问没有回复

本窗口`replyWhenMentioned=false`，普通QA实际关闭；16:24:52恢复后global仍为false。
用户截图中的@追问时间为16:25，处于全局关闭之后，按该配置不会进入正常问答。
本轮没有查询这条追问的精确消息流水，因此不把配置解释扩大为该消息逐步骤处理轨迹的确认，
也不能据此证明出现了新的QA模型故障。主动意见误判与追问入口未启用是两个不同事实。
用户未要求再次外发，本次不自动恢复普通QA或再开窗口。

## 有限修复方向与退出条件

当前代码诊断指向[source-plan流程](../../apps/core/src/proactive-discussion/model.ts)缺少
在后续核查发现介入依据不成立时撤销介入的出口，以及
[意见计划模板](../../apps/core/src/proactive-discussion/opinion-plan.ts)未充分核对原句条件
就生成前提或后果推断。该诊断尚不是已验证有效的新修复，也没有将问题直接归因于模型能力。

本轮到错误窗口关闭、原文及投递核验、独立语义失败归档为止；不追加同配置抽样或新广泛审计。
后续修复应先保留本例的条件语义并建立针对性回归，再验证能够撤销错误介入且仍能对真实
实质问题给出有依据的意见。新修复尚未实现、未通过实模检验、未部署；真实主动意见质量、
重复或已处理问题的抑制及启用QA后的追问体验仍未通过验收。

## 白皮书11.2四处处置

| 位置 | 处置 |
| --- | --- |
| 白皮书 | **reviewed-unchanged**：[§6、§8、§11.2](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md)的来源、主动发言边界、实际价值和分层验收规则仍适用；本次暴露实现未满足规则，没有改变稳定产品目标。 |
| 工程故障台账 | **updated**：[故障台账](../operations/engineering-failure-ledger.md)记录真实条件句被误判、错误意见已发送、用户反馈与尚未实现的有限修复方向，保留此前失败与负例通过证据。 |
| 核心需求覆盖基线 | **updated**：[核心需求覆盖基线](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)区分传输回执通过与介入、意见语义失败，IRIS-CORE-005仍部分实现，未提升为真实产品通过。 |
| README / AGENTS / current-handoff | **updated**：[当前交接](current-handoff.md)指向本次失败、已关闭状态与剩余修复门槛。**reviewed-unchanged**：[README](../../README.md)的应用51937b95与交接入口仍有效；[AGENTS](../../AGENTS.md)的工作树定位、授权和四处闭环要求未变。 |
