# Iris 发布准备：修复运行依赖告警，固定候选与授权范围

2026-10-06，工作树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支
`codex/iris-daily-pilot-followup`，进入时HEAD `13b770b2`、工作树干净。用户继续本地工作，
原先“不从继续推定push/部署/真实群授权”的限制仍适用。本轮未push、执行远端CI、SSH、
部署、迁移、读取群正文、调用真实模型或飞书外发。
新的应用候选：`2116ff70451499f5b1bb1ac35319851fa7f5c855`，包含上一轮模型隔离修复
8c120f7b及本轮运行依赖更新。文档提交不替代该应用标识，旧8c镜像不作为最终发布目标。

## 实际发现与有界修复

从Git归档精确应用 `8c120f7b84787a521fcb0c52fad13a0d40643fe7` 的构建输入，在本机
Docker Desktop使用既有固定Node 22 Dockerfile构建成功。镜像ID为
`sha256:e0c37203903c15c6d82964d8ff19d686cc31f108948ea407d9f233d7cc614004`，revision
标签为该SHA。然而 `npm prune --omit=dev` 报告2项高危；因此该镜像只证明构建通过，
不作为最终发布候选。没有因警告退出0而忽略结果，也没有修改此前配置隔离通过的结论。

`npm audit --omit=dev --json` 实际退出1：锁定的Fastify 5.9.0及fast-uri 3.1.6存在已公开
的运行依赖公告。最小修复采用Fastify 5.12.5和根级fast-uri 3.1.8，前者更新声明最低
范围为 `^5.12.5`；不使用force、overrides或Fastify 6。必要的间接变化仅有
process-warning 5.1.0、新增Fastify嵌套fast-json-stringify 7.0.1及其fast-uri 4.2.1。
这是安装版本问题，未确认当前Iris存在公告的实际可利用路径或线上受攻击事件。

维护者依据：[Fastify 5.12.5与HTTP/2修复](https://github.com/fastify/fastify/security/advisories/GHSA-4mh8-r7rc-xpvc)、
[Fastify畸形URL处理修复](https://github.com/fastify/fastify/security/advisories/GHSA-p68q-wchp-6fh7)、
[fast-uri端口检查](https://github.com/fastify/fast-uri/security/advisories/GHSA-qw65-cvwx-89v3)、
[fast-uri大小写修复](https://github.com/fastify/fast-uri/security/advisories/GHSA-hrr3-gc8f-f4qj)。
当前应用没有启用HTTP/2、trustProxy、相关请求schema或返回受保护数据的自定义not-found
handler。不得将全局鉴权hook写成畸形URL公告的充分缓解条件，也不声称这些检查证明整个
产品不存在其他安全问题。[Fastify 5.10记录](https://github.com/fastify/fastify/releases/tag/v5.10.0)
解释serializer升至7的依赖变化；现有网关/鉴权/正文解析回归覆盖本轮兼容性验证。

退出条件固定为：生产依赖audit为0、Core与pilot完整现有回归、类型/构建、独立依赖审查、
最终精确提交的Node22镜像及断网检查通过，然后完成文档闭环。不新增公告演示路由、
审核prompt、模型抽样或开发工具依赖大升级来延长本轮。

## 本地验证

- `npm ci --ignore-scripts --no-audit --no-fund` 成功安装锁文件。
- [生产依赖audit结果](evidence/iris-runtime-dependencies-20261006-audit.json)：退出0，已知告警0。
  这是2026-10-06 registry审计快照，非永久安全保证，不包含开发工具依赖。
- 完整依赖audit仍退出1：开发工具链9项告警（3 moderate、4 high、2 critical）；critical
  为vitest/tinypool，其他为@vitest/mocker、vite、vite-node、vite内的esbuild、nanoid、
  postcss、source-map-js。本轮不将“运行依赖0”写成全部依赖0；工具链升级列后续，
  最终镜像检查已验证这9个告警安装路径均未进入runtime，开发环境适用性另行处理。
- `npm test`：5057通过、471条件跳过、0失败，282文件通过/13跳过，39.99秒。既有
  JSON解析/原始正文验签/401/400/413、通配路由和鉴权、session/CSRF及启动清理均保留。
- `npm run typecheck`、`npm run build`通过；`npm run test:pilot`完整195通过、0失败/跳过，
  389.81秒，含CLI、实际Compose渲染、本地Caddy边界和备份/恢复故障注入；未接触生产。
- 独立依赖审查确认manifest/lock一致，变更仅上述5个包条目和声明，`npm ls --omit=dev --all`
  退出0；Node22支持及运行依赖engine检查无冲突，未发现可操作问题。
- 最终精确应用2116ff70的既有Dockerfile构建exit0，镜像为linux/amd64，revision label
  等于完整应用SHA，`docker image inspect`的本地ID为
  `sha256:8a8d4d1e686847c087e492ab76b626594ad274ad5e1d09973636ef9421977a57`。
  构建中的prune再次报告生产依赖0告警；没有发布到镜像仓库。

[镜像离线检查脚本](evidence/iris-pd-release-image-20261006.mjs)仅导入编译后的模块，核对
运行依赖版本、0059/0060迁移文件存在、source-plan选项、专用配置/真实客户端请求构造、
普通QA请求体不变及PD关闭不创建资源。它使用注入fetch，不启动服务、不连接数据库，
在 `--network none --read-only` 临时容器中执行；不声称模型语义或真实飞书通过。
[实际结果](evidence/iris-pd-release-image-20261006-result.json)为ok=true：2次模拟complete，
真实provider请求0、服务未启动，9个开发工具告警安装路径均不存在。迁移仅验证文件
存在，没有在此步骤执行迁移。`node --check`、`git diff --check`通过；本轮文档相对路径
目标已核验存在。

## 发布范围及尚未执行的步骤

远端只读查询 `gh run list --commit 8c120f7b...` 和当前分支PR列表均为空。本地
[CI文件](../../.github/workflows/ci.yml)仅接受master push、PR和workflow_dispatch；仅push
当前分支不能获得精确SHA通过记录。对最终2116ff70再查运行记录亦为空；最终候选仍需
获准push及精确CI，CI不通过不部署。只执行现有预算允许的CI，不购买额度或启用付费回退。

相对[10月4日生产快照](iris-production-preflight-20261004.md)的最小范围：

1. 更新完整Core镜像、同镜像migrate及pilot Compose配置，增加0059/0060；旧迁移、
   Dockerfile、Caddyfile、备份/恢复脚本、AI worker源码均未改变。保留现场已有Caddy修改。
2. 首阶段保持PD runtime/policy/主动发言关闭，普通问答保留Gemini和原群范围。不要把
   同一个 `IRIS_IMAGE_TAG` 传递给全栈启动后误重建AI worker或模型依赖；明确只切换Core。
3. 依[计划重启手册](../../deploy/pilot/README.md#planned-restart-and-reactivation)先durable
   global关闭、停Caddy、验证队列/死信、成对PG/Redis备份，再迁移和Core切换。授权必须
   包含维护窗口及必要的普通QA停止/恢复；durable desired=true不能自动恢复live global。
4. 任一备份/迁移/状态门槛失败即停止，保持关闭，保留事实。没有down migration；恢复
   helper会用当前migrate镜像升级staging数据库，所以旧schema回退必须先使用匹配的旧
   镜像/配置，不能在新候选配置下盲跑恢复。unknown不清空、不重发，按真实远端证据对账。
5. 第二阶段的原固定单群验收仍需独立模型处理真实群材料、可用凭据和发送授权。拟选
   source-plan/dedicated/qwen3.8-max/json_object/4096/thinking=false/60000ms，但没有
   修改任何真实配置。仅合成授权的key不能自动改作群材料用途，免费额度与用完即停仍需
   实时核对；配置透传不等于新增自动免费保护。限定取得真实主动意见、@追问、停止/恢复
   反馈和消息回执，按[单群runbook](iris-proactive-discussion.md#单群发布-runbook)执行。

以上为可审阅操作范围，没有运行这些生产步骤。只读GitHub查询和公共npm依赖下载
属于本轮已执行的外部读取；不是生产访问、模型调用、付费回退或发消息。

## 四处文档处置

| 位置 | 处置 |
| --- | --- |
| 白皮书 | **reviewed-unchanged**：[§11.1–11.2](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#112-mandatory-bug-fix-documentation-closure)已有有限出口、优先处理安全问题及分层验收规则；本轮依赖版本修复不改变产品架构、模型合同或权限。 |
| 工程故障台账 | **updated**：[发布依赖条目](../operations/engineering-failure-ledger.md)记录构建成功不能忽略运行依赖告警、最小修复及有限验证，不将扫描等同实际攻击证明。 |
| 核心需求覆盖基线 | **updated**：[基线](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)记录本地发布准备，不提升IRIS-CORE-005或真实飞书/部署状态。 |
| README / AGENTS / current-handoff | **updated**：[README](../../README.md)、[交接](current-handoff.md)和[前轮候选补注](iris-pd-model-isolation-20261006.md)指向本记录。**reviewed-unchanged**：[AGENTS](../../AGENTS.md)的工作树、禁止扩大授权、先处理安全问题及四处闭环规则仍有效。 |

整体主动讨论缺陷仍开放；已通过的限定合成窗口及其初判/审核解释局限保持，未重跑。
当前生产只保留10月4日最后快照，未重新核验；本地镜像和文档提交都不是部署。
