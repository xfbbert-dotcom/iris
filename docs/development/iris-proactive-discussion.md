# 主动工作讨论：有限验收与单群发布交接

记录日期：2026-09-15。依据[已批准设计](../superpowers/specs/2026-09-09-iris-proactive-discussion-design.md)和[8 项计划](../superpowers/plans/2026-09-14-iris-proactive-discussion.md)。本记录区分本地确定性、真实 PostgreSQL、真实模型、精确 SHA CI 和真实飞书验收，不把代码存在或合成回执写成整产品交付。

## 当前边界

已实现新的独立主动讨论链，默认关闭且名单为空；首轮只允许 `oc_637a9aca45f01943477f4e17f1fc5b9a`。触发来自本群非 @ 人类讨论，来源为本群及已授权文档，按问题和实质依据去重，无固定发言冷却或日额度。发送依据是 `authorizationKind=policy`，不伪造人工批准。

Task 8 应用/测试/CI 提交为 `89f299f5e00b0a4db4389a712d33a15700a8f466`；本记录为随后独立文档提交，不能用文档 SHA 替代应用 SHA。截至本次本地执行，真实模型配置路径未提供，`npm run pilot:proactive-eval -- --rounds 2` 实际退出 2，没有模型 assessment/draft 报告；没有 production/SSH/push/部署/真实飞书外发/单群开关操作。尚不能称“实现与内部验收完成”，更不能称“真实单群验收通过”。下一步是完成有限实模门禁和审查，之后按当次授权执行下文 runbook。

观察症状与已确认原因：旧 planner 只有沉寂线程和到期行动项的时间触发，已验收的人工提醒回路不能承担本群正在讨论的事实矛盾、推理缺口和限定风险判断。这是已批准的产品能力缺口，不是新诊断出的线上事故。Task 1–7 的发现、修复、失败和审查证据均保留在[执行记录](iris-proactive-discussion-execution.md)。本次补齐有限端到端门禁、无发送评估入口和发布边界，不重开已完成任务。

## 测试入口与结果

从[当前工作树入口](current-handoff.md#先确认从哪里继续)重新核对分支。生产仍只引用带日期的历史发布记录，不把本地 HEAD 当在线 SHA。

| 门禁 | 当次实测与边界 |
|---|---|
| 新增端到端 | `npm --workspace apps/core test -- proactive-discussion-e2e.test.ts`，设置独立测试库 URL：最终 4 通过 / 0 跳过，其中 2 项真实 PG、2 项 runner；7.36 秒。真实 processor → 入库 → registrar → PG job → context/verifier → evaluation/delivery worker → 一次 fake replier → PG sent 回执 → 普通 @ responder/service/trace；停止同问题和立即出现独立新问题分别有实际断言 |
| CLI 行为 | `node --test scripts/pilot/proactive-discussion-eval.test.mjs`：4 通过 / 0 跳过；本地 HTTP 假 provider 实际收到两个独立轮次的 30 次 assessment 请求，保留 30 结果；默认两轮、skip 不 render、导入不执行、禁止加载飞书发送依赖、失败退出和脱敏均验证 |
| 完整 Core | `npm test`：4607 通过 / 445 条件跳过，248 文件通过 / 11 跳过，40.43 秒。该命令没有 PG URL，条件跳过不算 PG 通过；既有事件/OAuth 负向日志保留 |
| 类型与构建 | `npm run typecheck`、`npm run build` 均退出 0；runner 另以 `npm exec --workspace apps/core -- tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --esModuleInterop --skipLibCheck ../../scripts/pilot/proactive-discussion-eval.ts` 实际严格编译通过 |
| Python | `npm run test:python`：181 通过，11.55 秒 |
| Pilot 脚本 | `npm run test:pilot`：182 通过 / 0 跳过，328.76 秒，包含新增 4 项 CLI 测试；备份/恢复/发送边界均为现有脚本的合成测试替身，没有操作生产 |
| PG 仓储顺序复跑 | 设置专用 `IRIS_TEST_DATABASE_URL` 后 `npm --workspace apps/core test -- postgres-proactive-discussion-repository.test.ts`：43 通过 / 0 跳过，79.36 秒，覆盖此前超时的全部 11 项；没有放宽 5 秒阈值 |
| PG 竞争顺序复跑 | 相同隔离测试库运行 `npm --workspace apps/core test -- postgres-proactive-discussion-concurrency.test.ts`：39 通过 / 0 跳过，66.57 秒；随后新 e2e 4 项通过。三文件共 86 项不同测试，其中 83 项真实 PG、3 项非 PG；分别执行与 CI 一致，不能把全量里的条件跳过计入通过 |
| Compose | 根目录与 `--env-file deploy/pilot/ci.env --file deploy/pilot/docker-compose.yml` 的 `config --quiet` 均退出 0，不输出合并配置/密钥 |
| 实模 | 精确 `npm run pilot:proactive-eval -- --rounds 2` 退出 2，缺现有安全模型配置；尚无实际模型质量结论 |

新增代码入口：[e2e](../../apps/core/tests/proactive-discussion-e2e.test.ts)、[eval CLI/固定语料](../../scripts/pilot/proactive-discussion-eval.ts)、[CLI 测试](../../scripts/pilot/proactive-discussion-eval.test.mjs)、[CI](../../.github/workflows/ci.yml)。CI 为三个 PD 文件显式提供 `IRIS_TEST_DATABASE_URL`，在所有逐文件 schema 迁移前初始化 public vector；新增 CLI 测试进入根 `test:pilot` 显式清单。此次修改 CI 配置不等于远端精确 SHA CI 已运行通过。

本地 PG 为专用 PostgreSQL 16.14 / pgvector 0.8.5，`iris-pd-test-20260914-b` 使用独立磁盘卷、仅绑定 localhost:55439。每例只迁移和清理自身随机隔离 schema，不修改已有业务数据、容器或 0059；先在 public 初始化 vector，不采用曾耗尽的 1 GiB tmpfs。

### 八项任务的实际证据对照

| 任务 | 已存在应用提交 | 实际证据与剩余边界 |
|---|---|---|
| 1 基础/迁移 | `24c090fc` | 设置 PG URL 的 64 项门禁、类型通过，含实际 SQL 缺表 RED；基础独立审查通过 |
| 2 登记/上下文 | `9f9f51a0` → `4ec806d6` | 初版长消息 hash 缺陷保留，最终实际归一化/登记/实时读取 55 通过 / 3 条件跳过、类型及范围复审通过 |
| 3 模型边界 | `23c08ba5` | 208 聚焦、完整 Core 4541 / 357 条件跳过、类型及独立审查通过；真实模型和零源 P2 分别保留 |
| 4 问题/反馈状态 | `12d1280b` → `b1c6564f` | 跨依据历史遗忘/history-only 初审缺陷保留；最终 60 聚焦（42 真实 PG）和类型/复审通过 |
| 5 最终发送/未知 | `30f75a98` | 82 项不同聚焦（81 真实 PG＋1 单测）、旧被动撤销竞争另 1 项，完整 Core/类型/独立审查通过；真实外发仍未做 |
| 6 连续追问 | `1071dfc3` | 297 聚焦及 42 真实 PG、完整 Core 4585 / 435 跳过、类型和独立审查通过；两次普通改写保持本群来源 |
| 7 装配/控制面 | `ab0f7dfe` | 实际工厂含精确授权/新快照/同步资格的 RED/GREEN，最终 Core 4605 / 443 跳过、96 真实 PG、类型/构建/Compose、独立审查通过 |
| 8 有限门禁 | `89f299f5` | 本节逐项实际命令全部本地有限回归通过；独立审查尚待控制代理执行，不把缺配置的模型/未执行的 CI/真实群验收提前勾选 |

Tasks 1–7 的完整失败、候选与审查范围见[执行记录](iris-proactive-discussion-execution.md)；上述数字不可相加为互不重叠测试总数。Task 8 基线为 `b733abdf9d080e6ce2689c8486196c178534131f`（Task 7 文档提交）；它的应用提交是 `ab0f7dfe`。应用与文档分开提交，任何文档 SHA 都不是部署证明。

### 保留的红灯与失败

- 新 runner 未创建时，两项 Vitest 和四项 CLI 测试因模块不存在失败。它只是缺入口的红灯；不把缺模块冒充实际数据库行为失败。
- e2e 初稿误将 worker 的 `processed` 返回值写成 `sent`，两项失败；按实际合同修正后检查真实 delivery 行和外部回复次数。该失败归于测试预期，不归于产品。
- 明确变异验证：临时禁用实际 processor 的登记分支并把 runner 限为一轮，4 项均失败；PG worker 实际得到 `idle`，runner 实际仅调用一次、缺第二轮结果。恢复后 4 项通过；变异未提交。
- CLI 500 假响应触发现有底层客户端有限重试，30 个 case-round 对应 59 次实际 HTTP 请求，原“应为 30 次”断言失败。失败模式改用不重试的 401，最终 30 次/30 结果通过；没有修改客户端重试策略或隐藏失败。
- runner 首次单独编译的路径按根目录书写，npm workspace 实际切换目录后 TS6053；改用 `../../scripts/pilot/...` 后严格编译通过。
- 首次把三份 PG 文件与全量 Core/类型/构建/Python/pilot 同时执行：75 通过 / 11 失败 / 0 跳过，164.89 秒。11 项均为既有 foundation 用例的 5 秒测试超时；39 项 concurrency 与新增 4 项 e2e 均通过。没有出现产品断言失败；负载归因只是可能因素，后续逐文件结果单列，不抹去这次失败。
- 早期 Task 1 vector 扩展位置、Task 4 的 1 GiB tmpfs 耗尽、Task 5 fixture 超时及 Task 7 初始测试失败仍见[执行记录](iris-proactive-discussion-execution.md#已取得的测试证据)，不被本次结果覆盖。

## 两轮真实模型门禁

CLI 仅接受现有 `IRIS_MODEL_PROVIDER=openai-compatible`、`IRIS_MODEL_BASE_URL`、`IRIS_MODEL_API_KEY`、`IRIS_MODEL_NAME` 和可选 timeout，默认运行固定合成集、两轮；没有飞书 reader/replier/token provider import，不加载生产群历史，不接受从消息里指定来源/工具/目标群。配置应通过用户指出的现有本地配置安全加载到进程，或用 Node 的 `--env-file` 指向该确切路径，再执行脚本。不要把密钥写到命令参数、报告或聊天，不搜索凭据库或从生产取钥匙。

```text
npm run pilot:proactive-eval -- --rounds 2
```

输出 JSON 到 stdout，含每个 case/round 的 assessment、draft、error 与具体人工审阅标准。退出 2 表示参数/配置不可用；退出 1 表示模型调用/草稿拒绝或预期决策不符；退出 0 仅表示自动检查未失败。`manualReview=pending` 必须经审阅者逐例确认，不因退出 0 自动提升为质量通过。为每次运行保存独立报告和模型/日期/应用 SHA 元数据；人工审阅结论另存，不覆盖失败报告，也不缓存第一轮输出作第二轮。

| 固定场景 | 人工核对重点 |
|---|---|
| arithmetic、inference、qualified-risk | 10 万与 16 万矛盾；5 人喜欢不能推出所有人付费；未验证依赖需限定风险，不能造批准、测试或实际失败 |
| separate-next、material-update | 不同权限问题可连续介入；报价每人 8 → 12 万后说明变化与影响，不照抄旧意见 |
| paraphrase、unrelated-update、casual、hypothesis、handled | 换说法/策略版本不产生新依据；午饭闲聊不触发；合理假设不被挑错；人已处理时不重复 |
| corrected、source-loss、stopped | 最新纠正不沿用旧稿；撤销材料未输入模型；明确停止不自动到期。真实竞态/失权/暂停效果以 PG 和确定性门禁为主证 |
| injection、followup | 不扩权、不广播、不承诺建任务；@ 追问由普通回答承接并保持来源撤销规则 |

每轮审阅所有结果的该说/不该说、事实依据、推断限定、建议价值与自然中文；英文策略词和信心数字不能进入群文案。核心误报、明显漏报、事实扩写或不受支持的执行承诺均阻塞，修复后重复整个有限集并保留前次结果。`corrected/source-loss/unknown/锁竞争` 不能用模型承诺“我会检查”证明通过。

评估入口拒绝没有绑定来源/触发消息的上下文，实际负向用例保证拒绝发生在调用模型之前。这是 runner 的输入边界；Task 3 模型域对手工零源上下文生成 `enum:[]` 的原 P2 并未被修改或宣称解决。

## 单群发布 runbook

本节是下一次单独获准发布时执行的步骤，本次未执行。文档确认、历史提醒成功或旧共享群聊脚本均不构成本次部署、外发或开关授权。

1. 重新取得并记录当前部署和单群启用授权、操作者、精确目标群及预定应用 SHA；核对该 SHA 的远端 CI 和两轮实模人工审阅均通过。模型/CI 任一未完成则不启动部署。核对现场生产应用 SHA、镜像标签/摘要、迁移位置、备份和恢复验证、健康、队列/死信/未决回复/unknown 及原 Q&A 控制状态；保存时间戳，不沿用本页历史值。
2. 使用该版本的 [pilot Compose](../../deploy/pilot/docker-compose.yml) 和现有[发布运行手册](../operations/internal-rollout-runbook.md)，记录明确 env-file 路径、compose 文件和不可变镜像。先用 `config --quiet` 校验。生成成对数据库/队列备份并记录校验信息；旧共享群聊脚本不作为本功能部署器。依现场维护步骤控制入口和旧 worker 的切换，防止两个版本并发消费。
3. 用 Compose 的 `migrate` 服务、迁移角色执行该精确镜像的迁移器，验证 `0059_proactive_discussion.sql` 仅应用一次，未改旧迁移、未清事实表。首次启动保持 `IRIS_PROACTIVE_DISCUSSION_ENABLED=false`、`IRIS_PROACTIVE_DISCUSSION_GROUP_IDS=`；确认新策略缺失/关闭，普通问答仍工作，PD status 为 disabled/不运行、无外发。
4. 经本次授权后，配置新 runtime 开启且名单只含原群，设置服务端 `IRIS_INTERNAL_API_AUDIT_ACTOR` 凭据角色；保留现有认证。此时 policy 仍关闭，先确认受保护 `GET /internal/proactive-discussion/status` 健康、原群读取可用。核对旧 planner、旧主动 delivery、memory extraction、task/Wiki 写入开关未被打开，不把原三群 Q&A scope 当主动授权。
5. 从实际 `proactive_discussion_policies` 读取当前版本（不存在则 expectedVersion=0），以受保护 `PUT /internal/proactive-discussion/policy` 提交且只提交 `{chatId, expectedVersion, enabled:true}`，核对返回版本和真实 `internal-api:` 操作者。通过既有控制面核对全局/原群/readGroupContext 和 `proactiveSpeech` 必须同时允许；只变更本次授权的必要开关，不能顺带扩群、开旧能力或伪造 human_approved。
6. 在该群由真实成员自然发送一组有用的普通讨论，观察一条真实主动意见、实际 provider message ID、trigger ID、delivery ID、issue/basis/policy/context 版本及 sent 回执。随后真实成员 @ 追问理由/改口语，记录普通回答回执和完整来源延续。不能注入伪造 @、回调或成员 ID 作验收。
7. 真实成员直接回复该意见“不再跟进这件事”，记录反馈消息/成员/回复目标/issue 版本，检查同问题新依据也未发送；不同真实问题仍可介入。成员再明确“恢复跟进这件事”时另记真实反馈 ID，验证回到 observing 且不重发旧稿。操作者 `/issues/:id/resume` 的记录应明确是 operator，不能代替真实成员恢复验收。
8. 汇总有限样本的正确性、误报/漏报、两次真实反馈、普通 Q&A、状态/队列与真实消息 ID。没有 P0/P1 才进入原单群日常试用；本页补记当次实际应用 SHA/镜像/CI/模型报告/真实回执，不声称全公司或整产品完成，不开启无限新审计。

### 关闭和对账

出现来源权限失败、不可控重复、严重误报或核心崩溃，先通过受保护控制面将 `proactiveSpeech=false` 并关闭新 policy，再关闭新 runtime。保留普通 @ Q&A、已批准共享和领域事实；不删除/截断表、不恢复未决发送为 prepared、不伪称撤回远端消息。关闭仅有界等待，已开始远端 I/O 可能仍结算；`drainPending` 和 sending/unknown 必须留给操作者处理。

对 unknown，先读取 `GET /internal/proactive-discussion/deliveries/:id` 和真实远端消息/回复目标。只有实际核实后才用受保护 `POST /internal/proactive-discussion/reconcile` 加 `deliveryId/expectedVersion/outcome`；sent 另需真实 `replyMessageId`，API 会重读 Iris 身份、原群、正文与目标。`not_sent` 是具名操作者判断，不是系统自动证明未发送。记录证据与时间；不盲重试、不清表重跑。同一问题所有版本在未知时被阻止，独立新问题没有人为冷却。

## 有限后续与四处处置

P2：Task 3 手工零源 JSON Schema 的域边缘问题；已有 pg 同 client 并发 query deprecation（本次真实普通 followup 亦出现，未抑制）；目录容量 100/后续生命周期。只在具体用户反馈或失败门禁暴露产品影响时推进，不建设无限历史、跨群主动、更多附件、自动解除暂停或新提醒器。未完成的模型/真实群门禁是验收边界，不是用 P2 掩盖的完成声明。

| 位置 | 本次处置 |
|---|---|
| 白皮书 | reviewed-unchanged：[第 6 节](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)和[11.2](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#112-mandatory-bug-fix-documentation-closure)已规定内容触发、完整来源、最终门禁、未知不重发和分层验收，本次只补测试/runner/交接，不改变产品或权限不变量 |
| 工程故障台账 | updated：[主动协作不是截止日提醒](../operations/engineering-failure-ledger.md#proactive-collaboration-is-not-a-deadline-reminder)链接本轮有限门禁与真实模型/群验收边界，保持已确认根因和有限出口 |
| 核心覆盖基线 | updated：[IRIS-CORE-005](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md#2-核心需求追踪)与[本轮修订](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md#status-amendment---2026-09-09-proactive-discussion-design)补本地门禁/runner/CI配置，保留模型和生产缺口，不提升为全功能完成 |
| 仓库入口 | updated：[README](../../README.md#current-product-state)、[当前交接](current-handoff.md#当前正在推进)及[执行记录](iris-proactive-discussion-execution.md)保持最新状态/分支/本 runbook 可发现；reviewed-unchanged：[AGENTS](../../AGENTS.md)的工作树核验、有限出口、四处闭环仍正确，无新规则需复制 |

文档 QA：本次 6 份 Markdown 共 143 个本地路径链接、27 个标题锚点实际校验通过；`git diff --check` 通过。上文 8 项任务逐行对照已有提交与实际证据；既有失败、零源 P2、pg warning 和未完成模型/CI/真实群门禁均保留。本轮无新的模型或生产授权，后续只能从这些明确门禁继续。
