# Iris 2026-10-06 发布执行记录

工作树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支
`codex/iris-daily-pilot-followup`。本轮用户明确同意此前具体提案中的push、免费CI以及
CI/备份门槛通过后的Core发布、0059/0060迁移与维护重启；保持PD关闭和普通QA配置。
不包含更换模型、真实群数据的新模型测试、启用主动发言或飞书测试消息。

应用实现仍为 `2116ff70451499f5b1bb1ac35319851fa7f5c855`。首次CI发现测试合同遗漏后，
仅测试修复提交 `341f7c8ac08d47f7316af47685be75c7d98ba693` 曾作为新的发布来源，
但第二次CI仍失败，因此未进入维护/发布；需要先完成下述真实应用缺陷的有限修复。
不能将2116的失败CI写成通过，也不能给旧镜像换标签冒充新提交构建。

## 首次CI失败与测试修复

[首次CI 37408896531](https://github.com/xfbbert-dotcom/iris/actions/runs/37408896531)
精确运行2116ff70：AI Worker通过；Core类型、构建、普通测试和pilot脚本通过，
PostgreSQL集成阶段在 `postgres-proactive-discussion-concurrency.test.ts` 失败6项，
同文件33项通过，后续阶段未执行。[结构化失败记录](evidence/iris-deploy-20261006-ci-first.json)。

确认根因是测试HTTP响应格式过期：真实runtime生成阶段要求仅含 `prose` 的响应，测试
仍返回旧 `{assessment,draft}`。应用在生成校验时正确拒绝，因此尚未创建投递行，也未
到达原本应验证的 `incomplete_catalog` 分支；worker记录 `evaluation_failed`。
停止用例恰在生成调用后关闭runtime，因而没有暴露该遗漏。其他旧fixture经专用适配器
迁移，这个真实runtime的fetch替身没有经过适配。不是依赖更新或数据库故障的证据。

在本机隔离pgvector/PG16数据库先复现相同6失败/1通过（只筛选7个factory用例），
再仅将第二响应的七个正文值按现有prose格式编码。所有发送、权限撤回、停止、回执和
目录不完整预期不变；不放宽生产解析器，不添加重试。独立审查确认语义值未变。

- 修复后完整并发文件：39通过、0跳过/失败，119.37秒；使用真实PG、模拟模型/飞书HTTP。
- `npm test`：5057通过、471条件跳过，282文件通过/13跳过，35.24秒；不是全部PG通过。
- `npm run typecheck`、`git diff --check`通过。
- 已有prose合同单测继续拒绝旧完整pair，并检查程序绑定身份/引用；不为mock本身增加重复测试。
- 新提交的[完整CI 37409771376](https://github.com/xfbbert-dotcom/iris/actions/runs/37409771376)
  通过并发39项与e2e6项，但在后续final-fixes的18项中2项失败；详见下节。

## 第二次CI确认真实应用缺陷，停止旧候选发布

[第二次CI结构化证据](evidence/iris-deploy-20261006-ci-second.json)保留
`proactive discussion evidence text is unavailable`，发生在既有问题的original/uncited
历史依据用例。这次不能归因于mock：context builder把核验过的历史依据引用放进目录，
却没有把窗口外原文放进items；模型更新同一问题时会闭合其旧basisRefs，正确拒绝
无原文的引用。新问题不闭合旧basis，因此other-issue用例通过。

本地一次跑完CI该处及后续9个PG文件：121项中119通过/2失败，同样只有上述两例；
不是跳过后续门槛。修复正在进行：仅按精确消息/快照恢复已核验的历史basis原文，
保留权限、哈希、文本预算和失效关闭，不复制旧AI说明或移除模型的来源完整性检查。
这是应用变化；341f7c8a及2116均不能继续部署。新提交、回归、CI及实际发布状态必须
另有证据，不以已上传的旧候选镜像代替。

本轮push到当前分支，并分别创建固定来源分支 `codex/iris-release-2116ff70` 和
`codex/iris-release-341f7c8a` 供workflow_dispatch。没有更改master或创建PR。
仓库在本次查询为public，现有workflow使用标准ubuntu-latest，无larger runner；
依[GitHub计费规则](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
此标准runner运行免费，未购买额度、启用付费回退或修改计费设置。

## 精确镜像与应用等价

从341f7c8a的Git归档正常执行既有Dockerfile构建，Node22基础镜像保持固定摘要；缓存
复用了相同输入。根manifest/lock/dockerignore、Core源码/manifest/tsconfig/迁移、
deploy/pilot、AI worker、CI工作流对比2116均无差异。Dockerfile不复制测试，生产编译
也排除测试。[镜像证据](evidence/iris-deploy-20261006-release-image.json)还确认两镜像的
全部RootFS层一致，新镜像revision为341f7c8a；本地image ID为
`sha256:b8c6948a64ed6c273db426b3fcbbb10cedda19398f4b614eb3a56028d31d4eda`。

[断网只读镜像检查](evidence/iris-deploy-20261006-offline-image.json)通过：普通QA请求
不变、PD独立配置/传输选项、PD关闭不创建资源、运行依赖版本、迁移文件存在与9个开发
告警包路径不在runtime。仅2次注入fetch调用，真实provider0，未启动应用或执行迁移。
同来源CI、备份和生产健康门槛均不能由此离线检查替代。镜像已导入服务器私有预备
区域，[准备脚本](evidence/iris-deploy-20261006-prepare.py)及[结果](evidence/iris-deploy-20261006-prepared.json)
确认传输hash一致、普通QA有效配置相同、六项非Core服务配置相同；只生成受限权限的
候选配置和旧配置副本，没有替换运行配置。第二次CI失败后这些材料仅保留为停止记录。

## 生产预检与当前维护边界

2026-10-06 03:25–03:30 UTC通过既有SSH连接重新核验，无密钥输出或群正文读取：

- [版本元数据](evidence/iris-deploy-20261006-preflight.json)：仍为f6a6dd41，Core healthy；
  普通QA仍Gemini 3.5 Flash Lite，新PD变量/模块不存在。
- [服务与文件元数据](evidence/iris-deploy-20261006-services.json)：记录原有各服务
  容器/镜像ID和Caddyfile哈希；既有Caddy修改保留。磁盘约25GB、可用内存约2.76GB。
- [数据库探针](evidence/iris-deploy-20261006-initial-database.json)：只读事务，迁移到
  0058；PD策略/jobs/deliveries表不存在，不能写成0。原固定群普通回复未决、安全通知
  和待核对均0。该复用探针中的liveRuntime未核验只描述此探针，不能覆盖下项新证据。
- [受保护状态探针](evidence/iris-deploy-20261006-status.mjs)及[结果](evidence/iris-deploy-20261006-initial-status.json)：
  已在本轮部署授权下调用GET status（可能同步durable策略到内存）。实际live global=false，
  desired=true，activationRequired=true，revision3392；persistence健康，三个基础worker
  enabled/running且队列/死信均0，proactiveSpeech=false。禁用群集合仅保存数量/指纹。

实际live关闭优先于持久化开启意向。后续发布应保留关闭，不凭desired=true恢复普通
问答或主动发言。维护若开始，需要显式durable关闭并记录意向变化；不得误报维护前
live为true。此记录截至当前尚未POST、停服务、备份、迁移或切换镜像。

最初只找到服务器备份公钥，询问过既有age身份路径；随后按运维手册的具体路径在
操作员本机找到原有身份文件。03:40 UTC已确认其ACL仅当前用户、既有age工具可用、
从身份导出的接收方与服务器公钥一致，见[备份前置证据](evidence/iris-deploy-20261006-backup-prerequisite.json)。
无需用户再查路径，未生成替代密钥或传输私钥；这仍不是实际新备份的解密验证。

候选临时容器调用默认readiness CLI得到[18通过/3失败](evidence/iris-deploy-20261006-env-only-readiness.json)：
已启用的知识卡/审批/review缺少运行状态。确认该CLI默认只读env，无法代表运行服务，
不是关闭原能力或降低门槛的理由。随后[运行Core的受保护readiness](evidence/iris-deploy-20261006-initial-readiness.json)
实际21通过/0警告/0失败。重启后仍须对新Core执行live检查，旧版本通过不能覆盖它。
恢复预案还需注意：既有restore helper在PG/Redis交换后也调用默认CLI，保留上述能力时
可能在启动Core前同样停止；此时不能假定尚未交换或盲重跑，应先核验阶段并在关闭入口
下使用匹配镜像完成Core启动和live门槛。该脚本便利性缺口记录后续，不在本轮盲改恢复流程。

后续发布仅Core/migrate；现有AI worker需在服务器Compose中固定原镜像，避免共用
IRIS_IMAGE_TAG导致维护脚本间接更新它。该一行部署覆盖及旧Caddy修改均须记录哈希。
切换前后在内存中比较QA配置（含key/URL），只输出相等布尔值；PD始终关闭。备份应
使用旧应用/配置并复制至机外私有目录，解密后检查manifest、PG目录及Redis RDB，
不输出业务内容；迁移不允许drop/down/盲目恢复。最终公开health及internal边界验证
不包含飞书外发，不能调用会制造回调和开启runtime的生产pilot:smoke。

## 四处文档处置

| 位置 | 处置 |
| --- | --- |
| 白皮书 | **reviewed-unchanged**：[§11.1–11.2](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#112-mandatory-bug-fix-documentation-closure)要求修复失败门槛、分层验收和四处闭环；本次测试合同同步不改变产品行为或权限。 |
| 工程故障台账 | **updated**：[测试wire遗漏条目](../operations/engineering-failure-ledger.md)记录条件跳过不能证明真实runtime合同，修复fixture而不降低应用校验。 |
| 核心需求覆盖基线 | **updated**：[本轮状态](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)区分首次CI失败、局部PG修复和未部署/未真实群验收。 |
| README / AGENTS / current-handoff | **updated**：[README](../../README.md)与[交接](current-handoff.md)链接本轮新授权、失败证据和发布来源。**reviewed-unchanged**：[AGENTS](../../AGENTS.md)的工作树、保留失败及授权规则仍有效。 |

整体主动讨论缺陷与真实单群验收仍开放。本文记录已停止的两次候选发布，未开始备份、
停服、迁移或切换运行镜像。下一步是历史basis原文缺口修复，不是重跑同配置CI或部署红灯候选。
