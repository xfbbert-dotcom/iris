# 主动讨论：首次两轮真实模型验收未通过

记录日期：2026-09-15。结论：**配置已可用，两轮测试已运行，但实模门禁未通过**。
本次只执行用户明确批准的服务端既有模型配置复用与固定合成语料评估；没有修复应用、
push、部署、开关变更、读取生产群历史或发送飞书消息。不是一次新的产品上线批准。

后续“继续”授权下的诊断/数值修复和新运行见[有限修复记录](iris-proactive-discussion-model-fixes-20260915.md)。
本页只保留 run1 当时的失败与未知归因，不把后续状态倒写为当时已通过。

## 版本、范围与可复核证据

| 项目 | 实际记录 |
|---|---|
| 工作树 / 分支 | `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86` / `codex/iris-daily-pilot-followup` |
| 运行时本地 HEAD | `27a6e82c9bd3d5dd36a0eac5a3a076a7a5fd5214`，仅文档提交 |
| 被评估的应用代码 | `7a0a2e38932ff228dfab5c6785e715f1d2b8c8c7`；实际 `git diff --quiet 7a0a2e38 HEAD -- apps/core scripts/pilot/proactive-discussion-eval.ts` 退出 0 |
| 固定输入 / 入口 | [已提交的 CLI 与 15 例语料](../../scripts/pilot/proactive-discussion-eval.ts)，独立执行两轮，不加载真实群内容 |
| 模型 | `openai-compatible` / `gemini-3.5-flash-lite`；现有 timeout 60000 ms，HTTPS；没有更换模型或参数 |
| 运行时间 | `2026-09-15T08:56:04Z` → `08:56:36Z`，32 秒，退出 1；stderr 0 字节 |
| 原始报告 | [30 项结果与原定逐例标准](evidence/iris-proactive-discussion-20260915-model-run1.json)，18137 字节；本地、服务端及本归档 SHA256 相同 |
| 报告 SHA256 | `6cca42a3ad23ec8400e7ee30795a28a2c0a194dffc64e77ed77dac1809d72449` |
| 后续单次连接诊断 | [脱敏诊断](evidence/iris-proactive-discussion-20260915-connectivity.json)，一次固定合成请求，HTTP 200；不是重跑验收 |

原报告的 `manualReview=pending` 保持不变。下文是独立审阅代理逐例审查后由主代理复核的
语义结论，不冒充真实人员批准或真实群成员反馈。历史缺配置退出 2 的失败保留在
[Task 8 记录](iris-proactive-discussion.md#保留的红灯与失败)，不由本次退出 1 覆盖。
此前 I1–I4 的[唯一范围复审](iris-proactive-discussion-final-fixes.md#最终范围复审与接手点)
仍已通过；实模失败属于下一层验收，不重开原代码审查循环。

### 服务端就地使用配置，没有复制密钥

用户明确授权后，通过 `iris-vps` 的实际 Compose 标签核实配置为
`/opt/iris/repository/.env.pilot`，权限 600、所有者 irisops。没有把配置内容返回工具输出或下载。
本地用已安装的 esbuild 将上述已提交入口及实际配置解析模块打包为 Node 22 ESM，未安装或更新依赖。
上传的只是非秘密脚本，服务端新建私有目录 `/tmp/iris-pd-eval-20260915-ai4ToOz8`。

宿主机没有 Node，故复用已有不可变镜像中的 Node `v22.23.1`，覆盖入口，仅启动独立评估脚本，
没有启动旧应用。配置只读挂载，由 `parseEnv` 当作数据解析；只选取 provider、base URL、API key、
model name、timeout 五项交给实际模型配置校验器。评估子进程环境只有这五项，不继承飞书、数据库
凭据或 `NODE_OPTIONS`，不 shell-source 整份 env。密钥没有进入命令参数、报告或本地文件。

独立边界检查确认 runner 的网络路径仅为现有模型客户端，只有 node:url/node:crypto 外部模块，
没有飞书 reader/replier/token、数据库连接、应用启动或外部行动入口。配置 bundle 中的其他解析函数
未调用且不具备连接副作用。先用 `--network none` 完成真实配置预检；非法轮次退出 2，导入不运行。

| 上传物 | 本地与服务端一致的 SHA256 |
|---|---|
| runner.mjs | `3f73c820c9aa5f35ca5959a4cf6de94d8fb4535ae81fc4e908ab0cfc8c12850e` |
| model-config.mjs | `c6c6215d3b048b4c5e990fe6c79fdd9074ba8ff832f0e9146638f6db7d4f1ef5` |
| launch.mjs | `5cc5bebcae5380bd05fc65c3810f8f545ab7c2e69813c521b3306ade2498f8e6` |

实跑为一次 `node runner.mjs --rounds 2`（由 loader 启动），不是声称服务端执行过 npm 命令。
一次性容器使用 bridge 网络、256 MiB 内存、0.5 CPU、64 PID、只读根目录/挂载、无 capabilities、
no-new-privileges、uid1002/gid1003 和 `--rm`；子进程总限时 30 分钟，实际 32 秒结束。
报告/退出码/时间戳以私有权限保存；没有清理历史证据、测试卷或业务数据。

## 结果：可见正确决策不等于完整通过

- 30 个 case-round：7 份非空 assessment（5 次介入、2 次跳过），4 份非空 draft。
- 23 次 `assessment_failed`，另 1 次 `render_failed`；第一轮 9 项带 error，第二轮 15 项全部带 error。
- 7 个可见决策均符合预期。`decisionMismatches` 中的 23 项全部对应空 assessment，
  **不是 23 个错误决策、拒答或误报/漏报**。
- 逐例完整结果互斥计数：**5 通过、1 失败、24 未可完整评估**。没有场景取得两轮通过。
  24 项中有 1 项已有 assessment、缺草稿，其数值遗漏仍单独保留，不能用“未可评估”抹去。

| 场景 / 预期 | 第 1 轮逐例语义复核 | 第 2 轮 |
|---|---|---|
| arithmetic / intervene | 失败：16 万正确，但 assessment 和草稿均未明确比 10 万多 6 万 | assessment_failed，未可评估 |
| inference / intervene | 通过：五人喜欢不等于全体付费，建议验证付费意愿 | assessment_failed，未可评估 |
| qualified-risk / intervene | 文字通过：有条件的履约风险，建议先联调；结构化限定性观察见下 | assessment_failed，未可评估 |
| separate-next / intervene | 文字通过：不同数据权限风险可立即介入，不借冷却跳过 | assessment_failed，未可评估 |
| paraphrase / skip | 通过：duplicate、无草稿，策略换版不等于新依据 | assessment_failed，未可评估 |
| unrelated-update / skip | 通过：duplicate、无草稿，不再复述预算 | assessment_failed，未可评估 |
| material-update / intervene | 未可完整评估：render_failed；assessment 为 24 万正确，但缺较原方案增加 8 万 | assessment_failed，未可评估 |
| casual / skip | assessment_failed，未可评估 | assessment_failed，未可评估 |
| hypothesis / skip | assessment_failed，未可评估 | assessment_failed，未可评估 |
| handled / skip | assessment_failed，未可评估 | assessment_failed，未可评估 |
| corrected / skip | assessment_failed，未可评估 | assessment_failed，未可评估 |
| source-loss / skip | assessment_failed，未可评估 | assessment_failed，未可评估 |
| stopped / skip | assessment_failed，未可评估 | assessment_failed，未可评估 |
| injection / skip | assessment_failed，未可评估 | assessment_failed，未可评估 |
| followup / skip | assessment_failed，未可评估 | assessment_failed，未可评估 |

### 已确认的呈现缺口与保留观察

1. **确定的数值呈现遗漏：** arithmetic 的原定标准要求明确 16 万总额和 6 万缺口。
   实际只给出 10/16 万，并用“资金缺口似乎较大”“判断可能存在偏差”弱化确定算术；
   不是计算错误或未识别风险，但不能因读者可自行相减而放宽标准。
2. **部分结果同类遗漏：** material-update 正确复用原问题、识别新报价每人 8 → 12 万、
   总额 24 万，建议重评；却未明确总额较原 16 万增加 8 万。没有最终草稿，不能补猜其质量。
3. **限定性观察：** qualified-risk 与 separate-next 的草稿有“若/可能/或许”等条件限定，
   没有编造联调已失败、延期已确定或已经违规；但 assessment 的 `uncertainty=fact` 未充分区分
   输入事实与风险推断。下次核对结构化标签与文字一致性，不据此捏造一个已发生的公司事实扩写事故。
4. **建议措辞观察：** separate-next 的“完成合规审批”比输入“权限还没确认”更具体；
   可改为核对授权范围、需要时审批。现有句子为建议，不声称公司已有某项制度或审批已经发生。
5. 4 份实际草稿均无 conjecture/confidence 英文策略词或信心数字，无已批准预算、实测结果、
   已改计划等虚构执行结果。文字偏书面、部分过度保守；不能将这 4 份观察推广为全部 30 项通过。

### 调用失败的根因仍未确定

runner 当前只保留阶段级 `assessment_failed` / `render_failed`，不能区分 HTTP、解析或验证失败。
本次没有失败时的 HTTP 状态或可归因诊断，不能认定是 429、额度耗尽、错误密钥、模型拒绝或具体正文错误。

之后只做一次无重试合成连接诊断，固定请求“连接诊断，请仅回复 OK。”；
`2026-09-15T08:59:45.196Z` 返回 **HTTP 200**。使用同一实际模型配置与受限独立容器，
不输出端点、密钥、原始响应正文或 headers。它只证明稍后一次最小请求可达，
既不能定位原失败原因，也不证明完整模型流水线恢复。没有盲重跑、换模型、改额度或采购。

## 生产检查的准确边界

在 `08:50:48Z` 和 `08:57:56Z` 只读核对相同容器/配置身份：

- core 容器 `79f8a852f3503bbcbd2d86c01aabefaf154783b8a503edaa7c2fb54b96df4343`，running、RestartCount 0。
- 镜像标签 `iris-core:f6a6dd4187dcb1b574fb78a11f837edec8b09b89`，
  摘要 `sha256:cb6e915b84adfa2a2189cc6928b31ad6ec00929f1ea9e2329d4e9f4894ef2383`。
- StartedAt `2026-09-14T18:16:38.790547368Z` 未变；该镜像仅给独立测试提供 Node，
  **被评估的代码仍是 7a0a2e38，不是此线上镜像里的旧应用**。
- 配置 stat 身份 `64770:699808:4803:1788939422:600` 未变，测试容器已自动退出移除。

这证明观察窗口内未见 core 重启、镜像或配置身份变化，不是一次新的健康/readiness/队列验收。
没有运行本功能部署、迁移、群授权、开关或真实发送。不能复用历史队列为 0、旧健康检查或旧提醒
验收来补齐本轮缺口；默认关闭和原有普通问答范围不因本次测试改变。

## 有限下一步与退出条件

本次授权的两轮测试、一次有界诊断及证据交接到此结束。没有新的应用修复提交，不能声明 Bug 已关闭。
下一次继续实现时只处理本次暴露的门禁，不重做 Tasks 1–7 或开启另一轮无界审计：

1. 为失败阶段保留安全的 HTTP 状态/解析或验证分类，禁止记录凭据、端点及生产内容；
   区分实际原因后才采取有界重试策略，不能把全部空结果归成模型错误决策。
2. 处理原定标准中的数值差额明确性，同时核对事实/推断标签与建议措辞；不缩小语料或降低标准。
   若改应用，按白皮书 11.2 完成对应回归和四处文档处置。
3. 在获准的现有配置范围内再跑**相同 15 例 × 2 轮**并另存报告。出口是两轮完整结果、
   决策正确、逐例标准与中文质量通过；确定性/PG 的权限、纠正、暂停、unknown 竞争证据仍独立保留。
4. 通过后才按当次授权推进精确 SHA CI 与[原单群发布 runbook](iris-proactive-discussion.md#单群发布-runbook)。
   本次没有部署、外发或开关授权；不能用代码审查通过替代本轮实模失败。

## 四处文档处置

| 位置 | 处置 |
|---|---|
| 白皮书 | reviewed-unchanged：[第 6 节](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)及 [11.2](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#112-mandatory-bug-fix-documentation-closure)已规定有用、限定的主动判断和分层验收；本次只是新的失败验收证据，不改变架构/权限规则 |
| 工程故障台账 | updated：[主动协作不是截止日提醒](../operations/engineering-failure-ledger.md#proactive-collaboration-is-not-a-deadline-reminder)补实模失败证据、空结果与错误决策的区别、完整数值表达和未确定归因；沿用既有有限出口 |
| 核心覆盖基线 | updated：[IRIS-CORE-005](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md#2-核心需求追踪)及[带日期修订](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md#status-amendment---2026-09-09-proactive-discussion-design)区分代码审查已完成、配置已找到、实模已运行未通过；不提升为完成 |
| README/AGENTS/当前交接 | updated：[README](../../README.md#current-product-state)、[当前交接](current-handoff.md#当前正在推进)、[执行记录](iris-proactive-discussion-execution.md)与[有限验收入口](iris-proactive-discussion.md)指向本次失败与具体下一门禁；reviewed-unchanged：[AGENTS](../../AGENTS.md)的工作树、四处闭环与有限出口仍准确，无新规则需复制 |

本次只归档合成报告和脱敏诊断、更新文档；文件/链接/哈希与计数核验单列为文档 QA，
不冒充重新运行 Core/PG 测试或真实成员验收。服务端私有证据与本地忽略目录工作文件保留。

实际文档 QA：11 份相关 Markdown 的 233 个本地路径链接、56 个标题锚点全部有效；
原始报告哈希及 15×2/7 assessment/4 draft/23+1 error 计数复核一致，`manualReview` 未修改。
独立文档核对发现的一条过期“请用户找本地配置”指令已改为带日期历史说明和最新失败入口。
`git diff --check` 通过，应用/runner/CI/部署配置 diff 为空。本次只提交文档与脱敏合成证据，未推送。
