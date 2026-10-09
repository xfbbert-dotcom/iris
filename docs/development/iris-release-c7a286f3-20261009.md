# Iris c7a286f3 关闭状态生产发布

日期2026-10-09。用户在[候选与CI/镜像准备](iris-ci-readiness-20261008.md)可审阅后明确
批准：先核验现场并备份，仅更新Core至`c7a286f37a85afa5c023359135b1331fdc556e94`，
保持主动发言和普通QA关闭。本次不含重新开群窗口、模型切换、真实群新模型试验或飞书外发。
实现树`D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支
`codex/iris-daily-pilot-followup`，进入时HEAD3bf32612、工作树干净；默认工作树未改变。

## 精确候选与现场基线

现有[CI 37763096629](https://github.com/xfbbert-dotcom/iris/actions/runs/37763096629)的
精确来源f103ff6a全通过；与应用c7a286f3只差文档证据，后续3bf32612也仅文档证据。
导出镜像84,104,192字节、SHA256
`04616cc23732f064141f0f174fc0369c3d2ba4c285014836c415205efa2b4370`；
image ID`sha256:19cce91342a177a68bb5cb94efb86e69c011cf54829a118f40ef990974bbea4e`。
服务器导入后image ID、完整revision、Config和RootFS均与本机制品匹配，linux/amd64。
未在生产重新构建或拉取替代镜像。

[现场预检](evidence/iris-release-c7a286f3-20261009-preflight.json)重新确认Core为51937b95、
健康、global=false、desired=false、PD worker/policy关闭；运行控制revision3424。
53项迁移已存在。原PD计数policy1/group1/jobs3/evaluations2/issues1/deliveries1/
sources63/events42，保留2个completed和1个cancelled任务及1条sent错误意见；
无prepared/sending/outcome_unknown。普通回复计数sent72/permission_blocked16/
not_sent_reconciled1，不读取业务正文或重发旧记录。

普通QA当时因global=false实际关闭，但replyWhenMentioned保存值为true。本次按照
保持QA关闭的授权将其显式持久化为false，保留其他能力与模型配置；不能将其表述为所有
capabilities原封不动。14个禁用群的集合指纹保持。该调整不解决追问的产品验收问题。

## 发布脚本与保留的停止记录

[本次ops](evidence/iris-release-c7a286f3-20261009-ops.py)保存现场env、Compose、Caddy、
镜像/容器及数据库基线，env只改IRIS_IMAGE_TAG，Compose/Caddy保持原字节。无新迁移，
不调用migrate或restore；已有讨论、来源和回复记录须与基线一致。Core回退仅恢复旧源码、
镜像和env，不自动覆盖数据库。发布标记首次保存原字节/原不存在状态，重试不覆盖，
回退恢复原状态；实际helper在临时目录核对了重复快照和部分标记写入后的恢复。
Windows首次直接导入脚本因Linux fcntl不可用而未执行；后续只在内存排除该平台导入来
检查真实文件helper，未据此声称Linux文件锁经Windows测试。

首次[prepare停止](evidence/iris-release-c7a286f3-20261009-preparation-failure.json)发生于
服务/配置切换前：检查遗漏了继承Core镜像的一次性embedding-model-verify helper。
实际差异只有core、migrate、embedding-model-verify的image及共享alias；其余全相同。
修正仅允许这三个明确服务的image变化，继续要求所有其他字段/运行中非Core服务完全
一致；两个一次性helper均不执行。[修正后的prepare](evidence/iris-release-c7a286f3-20261009-prepared.json)
通过，未重跑未变配置碰运气，也没有新的应用修改或模型调用。

## 备份传输停止与有限恢复

[成对备份](evidence/iris-release-c7a286f3-20261009-backup.json)在07:18:21–07:20:55 UTC
完成，加密包759,491,816字节，旧Core恢复健康且Caddy仍停。
[传输失败记录](evidence/iris-release-c7a286f3-20261009-transfer-failure.json)保留三次停止：
16流4MiB片段、6流4MiB续传、6流1MiB有限续传均未完成；包括exit0但只收到778,232/
1,048,576字节，后续重连exit255。不能把SSH退出0、已有部分文件或备份生成成功当机外备份通过。
原parts/tails候选复用396,091,384字节，独立重建绝对范围未发现映射错误；保留原文件和错误。
日志存在MaxStartups/drop/reset，未逐次证明根因。单条无PTY探针1MiB/5.73秒、长度及SHA正确。
[单连接恢复](evidence/iris-release-c7a286f3-20261009-transfer-stream.py)冻结每段offset/size/hash，
先远端逐段校验，再以一个持久无PTY连接传三个缺口，15分钟、零自动重试；组装必须再匹配
原整包SHA。未更改SSH配置、主机身份校验、备份内容或生产数据库。

[实际单连接结果](evidence/iris-release-c7a286f3-20261009-transfer-verified.json)165.12秒完成，
保留段全部远端匹配，整包SHA为`d5b64b5efc19da5023d3df0cb10f8a3f5af8900c2af1cdfc976b38152f96362b`。
本地验证首次在解密前被[路径守卫](evidence/iris-release-c7a286f3-20261009-backup-verifier-path.json)
停止：Codex打包应用把LocalAppData映射到自身LocalCache。核对samefile及仅当前用户/SYSTEM
的受保护ACL后，只允许精确观测到的别名，保留规范化子路径检查，没有泛化放开任意路径。
07:45:39 UTC[机外验证](evidence/iris-release-c7a286f3-20261009-backup-verified.json)通过：既有age
身份本地解密、断网只读PG dump目录及Redis RDB校验全部成功；派生明文已精确清理，加密包
保留。本次只检查备份结构，未执行新的恢复演练，也未把密钥传至服务器。

## 实际发布与验收结果

07:46:32 UTC[Core切换](evidence/iris-release-c7a286f3-20261009-cutover.json)完成，精确应用
`c7a286f37a85afa5c023359135b1331fdc556e94`及上述image ID健康运行；未执行迁移、恢复或
重建非Core服务。随后[07:47:21验收](evidence/iris-release-c7a286f3-20261009-acceptance.json)
通过，恢复原Caddy入口，三个版本标记均指向c7a286f3。运行控制revision3427，global/desired/
replyWhenMentioned/proactiveSpeech全false，PD worker与policy关闭，readiness21/21。
Core live env与原值完全一致，env文件仅IRIS_IMAGE_TAG变化；Compose/Caddy原字节保留。
53项迁移及时间戳、权限、业务统计、任务、投递、回复与policy基线全等，旧错误意见和
全部失败事实保留，没有清表、重放或补发。

[07:48:19独立只读核验](evidence/iris-release-c7a286f3-20261009-independent.json)全部18项
通过，独立脚本不调用发布ops验收函数；确认源码/镜像/revision/标记一致、五个非Core容器
身份/镜像未变且运行、无未决回复/发送、能力和禁用群指纹符合预期。
服务器与[本机公网核验](evidence/iris-release-c7a286f3-20261009-public.json)均为health200、
两个internal端点404，未绕过TLS。既有免费CI和四例合成语义证据沿用原记录，本轮不重算
测试或模型结果，不把脚本的本地检查计入应用测试数量。

这次完成的是**修复代码已部署、关闭状态运行验收通过**。生产模型和opinion模式配置保持；
未启用source-plan主动群发、普通QA或新窗口。修复后的真实意见是否正确易懂，以及用户
回复/@Iris时能否承接解释，仍未完成真实验收；IRIS-CORE-005保持部分实现。本轮出口为
上述运行核验及文档闭环，不继续加固传输模块。下一产品验收须先落实普通QA的免费调用
保护、明确范围及用户在场，再进行真实讨论与追问；不能复用旧窗或将本次发布授权扩大。
本记录所属后续提交只归档发布/操作脚本与文档，不是新的应用版本。

## 白皮书11.2四处处置

| 位置 | 处置 |
| --- | --- |
| 白皮书 | **reviewed-unchanged**：[白皮书](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md)的source-plan合同与分层验收规则未变，关闭状态发布不增加模型语义证据或扩大主动权限。 |
| 工程故障台账 | **updated**：[台账](../operations/engineering-failure-ledger.md#2026-10-09备份短传不能凭ssh退出码判定成功)新增备份短传与固定范围恢复的门槛；真实误判、引用与建议缺陷记录继续保留，不把传输恢复写成应用语义修复。 |
| 核心需求覆盖基线 | **updated**：[基线](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md#2026-10-09c7a286f3已部署关闭状态验收通过)更新实际部署/运行验收层级；IRIS-CORE-005仍部分实现，真实意见与QA追问缺口不关闭。 |
| README / AGENTS / current-handoff | **updated**：[README](../../README.md#current-product-state)及[当前交接](current-handoff.md#2026-10-09-最新c7a286f3已部署主动讨论与普通qa关闭)记录精确应用、状态、证据与下一验收边界；**reviewed-unchanged**：[AGENTS](../../AGENTS.md)的工作树、授权与文档闭环要求仍适用。 |

本次真实飞书发送0、外部业务模型调用0；不是新的实模语义或真实群产品验收。
