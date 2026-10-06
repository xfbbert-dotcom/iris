# Iris 主动讨论模型配置隔离

日期2026-10-06。工作树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支
`codex/iris-daily-pilot-followup`，修复前HEAD `b30d1ba0`。本轮只做本地实现、离线验证
和文档；未push、访问生产、部署、调用真实模型或发送飞书消息。
应用修复提交：`8c120f7b84787a521fcb0c52fad13a0d40643fe7`；随后文档提交不代表上线。

## 已确认问题与有界修复

[10月4日生产只读快照](iris-production-preflight-20261004.md)确认线上普通问答使用
`gemini-3.5-flash-lite`，来源计划的限定合成语义证据则来自精确 `qwen3.8-max`。
原PD runtime和合成CLI均直接读取通用 `IRIS_MODEL_*`，因此无法单独配置主动讨论，
改变模型会同时影响普通问答。独立选择能力是发布准备条件，不是新模型语义通过证据。

另一个确定差异是[归档runner](evidence/iris-opinion-decision-resumed-20261004-runner.txt)
实际请求带 `enable_thinking:false` 和 `max_tokens:4096`，通用运行客户端以前没有这两个
字段。此次使这些显式设置可表达；没有推测供应商默认值，也没有把模型名写死在应用里。

合同和退出条件在实现前固定：

- `IRIS_PROACTIVE_DISCUSSION_MODEL_SOURCE` 仅接受 `shared|dedicated`，缺省为shared，
  显式空值或未知值拒绝。shared完整沿用通用读取器，预先填写的专用字段不会自动生效。
- dedicated独立读取 `IRIS_PROACTIVE_DISCUSSION_MODEL_` 前缀下的 `PROVIDER`、
  `BASE_URL`、`API_KEY`、`NAME` 四项必填配置；缺项即停止PD启动或使CLI退出2，
  不借用通用地址、密钥、型号或可选值。配置检查先于数据库创建和HTTP。
- 专用可选项为 `TIMEOUT_MS`、`STRUCTURED_OUTPUT_MODE`、`MAX_TOKENS`、
  `ENABLE_THINKING`。空/缺省超时为30000ms，其余空/缺省省略；显式false保留。
  客户端仅对显式提供值发送 `max_tokens` / `enable_thinking`，普通问答原请求体不变。
- runtime、CLI与实际pilot Compose使用同一合同。独立选择与意见mode、目标群、权限、
  policy及发言开关分别配置；默认仍shared/legacy/主动关闭。关闭PD不要求专用凭据。
- 完成配置、实际请求、runtime、CLI与Compose回归、Core全量、类型检查、构建及独立
  审查后结束本轮，不追加模型抽样、审核prompt或新的生产操作。

此前合成设置还包含60000ms超时、逐请求免费额度核对及禁止自动重试。可配置上述
字段不代表完整runner策略与运行环境等价；现有客户端技术重试逻辑未改变，不自动重试429。
若继续受限免费合成，仍使用既有受保护启动器和逐次额度门禁。本轮不读取或迁移凭据。

## 验证记录

新增runtime回归先出现3个预期失败：实际请求到了QA地址、两种坏专用配置仍创建数据库。
CLI新增2例先失败：15个请求到了共享测试服务、坏配置未退出2。Compose新增3例先失败：
source与全部专用字段未传入容器。配置和客户端回归先失败，确认新选择器和显式字段尚不存在。
这些请求仅发往本机模拟服务或注入fetch，未使用真实模型。

| 验证 | 实际结果 |
| --- | --- |
| 配置/客户端回归RED | 2文件40失败/13通过；缺专用读取器及显式传输字段，失败后才实现。 |
| 配置/客户端及原env测试 | 168通过，0失败/跳过。 |
| `npm --workspace apps/core test -- proactive-discussion-runtime-opinion-mode.test.ts --no-cache` | 7通过；真实客户端经注入fetch核验PD地址/凭据/请求体，QA请求体逐字不变；坏配置零pool/HTTP。 |
| `node --test scripts/pilot/proactive-discussion-eval.test.mjs` | 11通过，0失败/跳过；本机两个HTTP服务验证专用15次、通用0次，错误配置零请求，包含无敏感输出与既有CLI门槛。 |
| `node --test scripts/pilot-compose.test.mjs` | 39通过，0失败/跳过；实际Compose渲染保持false和全部专用值，普通问答、AI worker及其他服务环境不变。 |
| `docker compose --env-file deploy/pilot/ci.env --file deploy/pilot/docker-compose.yml config --quiet` | exit0；仅合成配置，没有启动pilot stack。 |
| `npm test` | Core 5057通过、471条件跳过、0失败；282文件通过/13跳过，50.03秒。未把条件跳过的PG等测试写成新通过。 |
| `npm run typecheck`、`npm run build` | 均exit0。 |
| 文档本地路径核验 | 本轮7份文档356个相对路径目标存在；不等于重新审计每个历史结论。 |

独立代码审查未发现可操作问题，另行运行配置/客户端/runtime三文件60/60通过。
`git diff --check`通过。此次没有改动数据库/发送逻辑，未重复
10月4日的PG回放或已通过模型窗口；测试结果仅证明配置隔离和既有本地回归。

## 四处文档处置

| 位置 | 处置 |
| --- | --- |
| 白皮书 | **updated**：[主动讨论模型边界](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md)补显式共享/独立选择、完整配置与不回退合同，发送权限和审核要求保持。 |
| 工程故障台账 | **updated**：[配置耦合条目](../operations/engineering-failure-ledger.md)记录通用读取器耦合与归档/运行传输差异，保留此前语义失败。 |
| 核心需求覆盖基线 | **updated**：[基线](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)记录本地配置隔离，IRIS-CORE-005仍部分实现，未提升为真实群或部署通过。 |
| README / AGENTS / current-handoff | **updated**：[README](../../README.md)、[交接](current-handoff.md)与[运行记录补注](iris-proactive-discussion.md)链接本合同和当前层级。**reviewed-unchanged**：[AGENTS](../../AGENTS.md)已有授权、工作树、验收层级和文档闭环规则足够，无需重复。 |

## 实际层级与下一步

本修复只解除本地PD模型选择与普通问答的配置耦合，不关闭整体主动讨论缺陷。
此前[八业务例与两负控](iris-opinion-runtime-20261004.md)仍是限定模型/合同下的语义证据；
初判过强断言、审核解释不准确和泛化限制仍开放。本次新增真实模型语义、真实飞书和部署
验收均为零。最后核验生产仍是10月4日的f6a6dd4快照，未在今天重新核验。

下一项有意义的产品门槛是批准范围内的发布及原固定单群验收。现有授权缺少push/部署/
迁移/模型配置变更/真实群发送，以及把真实群材料交给独立模型的范围和可用凭据授权。
现有合成key不能自动用于真实群。发布前还需精确目标SHA的CI、现况和备份恢复核验；
保持普通问答模型不变、先保持PD关闭，按[单群runbook](iris-proactive-discussion.md#单群发布-runbook)
逐项执行。配置能力本身不授权这些操作，也不要求为此重跑已通过的合成窗口。

可审阅的后续发布目标为上述应用提交8c120f7b；相对最后生产快照将包含既有0059/0060
迁移和source-plan应用代码。若选择沿用已验收的独立模型，拟配置为source-plan、dedicated、
精确qwen3.8-max、json_object、4096、thinking=false、60000ms，普通问答保持Gemini。
这些是待授权的目标值，尚未写入任何生产环境；实际URL/凭据应来自获准的受保护配置，
不能复制合成凭据来填空。发布先保持PD和主动发言关闭；启用仍需另行完成原群policy/live
gate、停止/恢复、重复抑制及真实消息回执验收。没有精确CI/免费与停止条件/真实群授权
就不执行相应阶段，不能通过放宽验收来绕过缺少的条件。
