# Iris 首次受监督生产窗口：接线通过，未出现真实讨论输入

日期2026-10-06。工作树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支
`codex/iris-daily-pilot-followup`。开始HEAD `57689a3b`且干净；操作/验证脚本提交
`a2d5f412`。生产应用始终是 `51937b954733020799e02f139abd32df74b3349c`，镜像未变。
本记录不是新的应用修复、push或应用版本发布，主动讨论能力缺陷没有关闭。

## 授权与实际执行

用户对[首窗具体提案](iris-pd-supervised-pilot-20261006.md#待授权的首个产品窗口)明确回复
“确认”：原固定群获准来源交给精确qwen3.8-max；现有受保护凭据扩展到本次范围；
接入专用配置和免费门禁；有界开启global、原群PD及真实意见。上限8次HTTP、15分钟，
每次请求须新鲜UI免费许可；首窗普通QA和知识草稿实际关闭；结束恢复global/desired/PD关闭。
没有取得无限窗口、付费回退、其他群模型材料或恢复普通QA运行的授权。

只读前检确认Core健康、global/desired=false、原群未禁用、PD八表均空、事件队列无待处理。
文档embedding为既有本地服务。旧planner/delivery/memory/conflict/task均关闭，但现场
`IRIS_WIKI_SPACE_SYNC_ENABLED=true`，与初始前检假设不同，原前检如实失败。
本窗口临时把Wiki设false，并在结束恢复原true；不把失败前检写成通过。

[操作脚本](evidence/iris-pd-window-20261006-ops.py)先在global关闭时通过受保护API持久
关闭replyWhenMentioned/generateKnowledgeDrafts，再Core-only重建到同一应用/镜像的临时配置：
source-plan、dedicated、qwen3.8-max、json_object、4096、thinking=false、60000ms、batch=1。
实际容器env逐字段验证；QA模型配置保持，普通QA受能力及global闸门控制。
非Core容器、Compose及Caddy未变更，没有重跑迁移。

门禁在Core同一网络空间只监听127.0.0.1:8765；凭据从本机既有DPAPI存储经受保护SSH stdin
提供，不打印、写入仓库或放在命令参数中。原[门禁工具](../../scripts/pilot/proactive-discussion-free-gate.mjs)
保持`7c135772`版本和原限制。准备时百炼精确型号页面刷新显示533.62K/1M、2026-12-18到期、
用完即停已开启；这是准备观察，不是任何HTTP的许可或账单审计。本轮没有真实pending或permit。

07:13:43.055 UTC启动，policy version=1，global/desired=true、revision3397。
独立host watchdog按窗口期限或门禁停止收尾，恢复失败会继续尝试持久关闭并留失败记录。
07:19:40 UTC通过应用现有只读Feishu checker确认原群可访问，没有发送消息。
等待约8分半仍无真实触发，07:22:17.693 UTC主动提前收窗，未消耗完15分钟。
门禁`stopped.json`确认为operator-stop、uncertain=false；07:22:26.179 UTC恢复完成，
07:23:49 UTC独立最终只读核验通过。

## 证据与验收层级

[脱敏最终证据](evidence/iris-pd-window-20261006-final.json)由
[最终核验脚本](evidence/iris-pd-window-20261006-final.py)生成，含生产执行脚本及编译产物SHA256。
完整受保护配置、控制快照和只读取证留在生产操作者私有目录，不提交业务正文或密钥。
最终JS语法/Python AST检查、diff检查通过，五份相关记录291个相对文件链接有效。
独立收尾审查确认本记录与脱敏证据一致，8个现场脚本SHA256与本地文件相同；没有遗留文档阻断。

| 层级 | 本轮观察 |
| --- | --- |
| 应用代码 | 没有修改；生产应用仍51937b95。仅新增一次性操作证据、接线验证与取证脚本。 |
| 本地接线验证 | 实际编译配置解析器/客户端 → loopback门禁：缺许可422且不重试，模拟新鲜许可后完整wire原样传递。2次本机HTTP、1次假上游、0次真实provider HTTP；主代理复跑通过。 |
| 生产接线验证 | 相同两场景在实际Core容器通过；编译客户端/config hash与本地相同。独立确认实际生产env指向门禁。假上游不算模型语义验收。 |
| 控制与收尾 | 实际policy开启/关闭、global持久开启/关闭、能力隔离及Core-only恢复通过。watchdog恢复失败记录0。人工提前停止成功不等于已经演练15分钟自动超时或故障重试。 |
| 真实模型语义 | 未执行：真实触发0、pending/permit/outcome/final/uncertain文件均0，供应商HTTP0、reported tokens0。 |
| 真实飞书意见 | 未执行：jobs/evaluations/issues/deliveries/sources均0。群可访问检查不等于意见发送或质量通过。 |
| 最终生产 | Core健康；global=false、desired=false、PD enabled/running=false，policy version2 disabled，control revision3400。能力与原基线相同；live env等价、`.env.pilot`及Compose原字节相等，非Core容器ID/镜像不变。 |

保留policy/group各1行及3条事件作为真实操作事实，没有清表或伪造未发送结论。
不存在sending/unknown待对账。普通QA的能力字段恢复原值true，但global=false，因此普通QA
实际仍关闭。临时gate进程和专用凭据注入已随Core恢复移除，不能把当前生产说成仍用Qwen。

[只读取证脚本](evidence/iris-pd-window-20261006-capture.mjs)在实际DB通过；本轮未使用其
可选逐消息Feishu回读分支（没有消息ID）。现有DB不保存完整模型context.items及逐次wire正文，
只能读取关联事实、绑定原文与版本；事后上下文不冒充当时原始请求。未新增产品日志架构。

## 保留的操作失败与修正

- 初始前检因现场Wiki=true拒绝，没有因此启用global。后续按已批准的隔离范围临时关闭，
  并核对实际容器false → 最终原true。
- 两次prepare在凭据格式断言处失败，未写生产env或能力。确认原凭据含合法`.`字符，
  放宽该字符后通过；不是密钥无效或429，也没有打印凭据。未重新创建密钥。
- 初版status分支误用未加引号的Python字典键，产生NameError；修正后真实status及最终
  核验通过。一次临时只读shell查询发生转义语法错误，改用固定stdin脚本后通过。
- 独立操作审查发现私有脚本docker cp后的node读取权限、停止ack、失败收尾、watchdog单次
  失败退出及重入恢复问题；执行前修正对应流程。未伪称这些故障分支都做过生产故障演练。

有限出口已达到的是生产接线、受控开关与恢复验证。没有新实模语义案例，故不重跑旧八例、
不追加prompt变体、不修改预期或宣布产品缺陷关闭。

## 缺少的条件与下一步

首个真实意见验收缺少一条由真实成员在受控窗口发起的真实工作讨论。本次已发就绪提示，
未收到成员触发，也未得到就绪问题的回复；不会伪造成员、消息、回调或把空闲当作合理沉默通过。
下一次先约定成员准备好发送，再开新的有限窗口；不无人值守自动重开，也无需重做已通过接线。
届时先依据来源冻结“应介入/应沉默”的判定，再核对实际判断、文本、引用、限定、建议和回执。
首条通过后仍需有限的重复/已处理/新问题、@追问、成员停止/恢复验收。原限定语义失败与
历史文档1200字范围等未解决限制继续有效，IRIS-CORE-005仍部分实现。

## 白皮书11.2四处处置

| 位置 | 处置 |
| --- | --- |
| 白皮书 | **reviewed-unchanged**：[§6、§8、§11.2](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md)的来源授权、主动发言/控制分层与证据层级适用；本轮只执行受监督窗口，未改变产品策略或关闭语义缺陷。 |
| 工程故障台账 | **updated**：[真实接线与空窗口边界](../operations/engineering-failure-ledger.md)记录Wiki现场差异、操作失败修正、实际退出与不把0触发当通过。 |
| 核心需求覆盖基线 | **updated**：[首窗事实](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)保留IRIS-CORE-005部分实现，区分生产接线/控制已验与真实语义未执行。 |
| README / AGENTS / current-handoff | **updated**：[当前交接](current-handoff.md)与[准备记录后续指针](iris-pd-supervised-pilot-20261006.md)记录授权已经取得和实际收窗。**reviewed-unchanged**：[README](../../README.md)的生产应用、关闭状态和交接入口仍有效；[AGENTS](../../AGENTS.md)的工作树、授权、有限出口和四处闭环规则无变化。 |
