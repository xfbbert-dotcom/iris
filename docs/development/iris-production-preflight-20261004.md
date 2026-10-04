# Iris 生产只读预检：确认版本、模型及数据库差异

2026-10-04 09:12–09:16 UTC（北京时间17:12–17:16）。用户明确同意上一轮提出的只读
预检；该授权仅覆盖现有服务器的版本、模型、原群策略与队列，不含push、部署、迁移、
模型/开关变更、群正文读取、模型请求或飞书发送。以下是此次快照，不是持续监测。

本地实现工作树/分支未变：`D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，
`codex/iris-daily-pilot-followup`。进入时HEAD `783f7c8a`；Core实现1ea3ae7e，
部署配置修复9bfbf0eb。本轮只增加只读诊断与记录，不改变应用实现。

## 现场结果

| 项目 | 实际只读结果 |
| --- | --- |
| 生产代码标识 | `/opt/iris/repository` HEAD、运行Core镜像tag及revision label均为 `f6a6dd4187dcb1b574fb78a11f837edec8b09b89`。 |
| 运行镜像 | `iris-core:f6a6dd4187dcb1b574fb78a11f837edec8b09b89`，image ID `sha256:cb6e915b84adfa2a2189cc6928b31ad6ec00929f1ea9e2329d4e9f4894ef2383`，running/healthy。健康不是完整产品验收。 |
| 现场路径 | Compose标签为 `/opt/iris/repository/deploy/pilot/docker-compose.yml`；env-file为 `/opt/iris/repository/.env.pilot`。未读取完整env文件。 |
| 模型 | Core实际环境 `openai-compatible` / `gemini-3.5-flash-lite`；结构化输出mode变量缺失。未向模型发请求。 |
| 新主动讨论 | opinion-mode模块不存在，mode/enabled/groupIds三个env变量均缺失。新能力未出现在该运行容器中。 |
| 数据库 | 同一repeatable-read只读事务确认schema为public、read_only=on；迁移止于 `0058_shared_working_chat.sql`。 |
| 新PD策略/队列 | policy/jobs/deliveries表均不存在，因此是schema_missing，不能记成policy=false或队列0。0059/0060均未应用。 |
| 原群持久化控制 | revision3392，desired_global_enabled=true，原群未列入disabled，readGroupContext=true、replyWhenMentioned=true、proactiveSpeech=false。只代表持久化状态。 |
| 原群普通回复 | sent39、permission_blocked10、not_sent_reconciled1；prepared/sending未决0、待发安全告知0、reconciliation_required0。未读任何回复正文或消息ID。 |
| 内存运行状态 | 未核验live globalEnabled/activationRequired；不能从环境false或durable desired=true推断。 |
| 服务端工作区 | `deploy/pilot/Caddyfile`有已存在修改，另有版本指针、backups和evidence未跟踪项；仅记录路径，未读取内容、重置或覆盖。 |

本地Git确认生产标识f6a6dd4是配置修复9bfbf0eb的祖先。该范围只新增0059/0060两份
迁移，未修改旧迁移；Caddyfile在这两个提交间无Git差异。现场已有的Caddy修改必须保留，
不能以同步仓库为由覆盖。未核验备份有效性、精确候选远端CI或候选镜像构建，不冒称可直接发布。

## 只读方法与证据

- [元数据探针](evidence/iris-production-readonly-20261004-metadata.py)经既有SSH连接执行，
  只输出白名单环境字段、镜像与Compose标签、Git标识和路径状态；[结果](evidence/iris-production-readonly-20261004-metadata.json)。
- [数据库探针](evidence/iris-production-readonly-20261004.mjs)经stdin直接在现有Core容器内
  启动临时Node进程，使用容器已有DATABASE_URL，凭据不输出/下载/另存；[结果](evidence/iris-production-readonly-20261004-database.json)。
  先设置连接default_transaction_read_only=on，再BEGIN REPEATABLE READ READ ONLY，
  statement_timeout=5s、lock_timeout=1s。先核对catalog，再对存在且列齐全的表做SELECT，
  最后ROLLBACK结束快照。未导入应用启动入口，不执行迁移或数据库写入。
- [SHA256清单](evidence/iris-production-readonly-20261004-manifest.json)覆盖两个探针和两个
  捕获JSON；JSON为PowerShell接收后存储的文本，不声称SSH原始传输字节。Git保留归档字节。

主代理逐一核对4份暂存Git证据的长度/哈希；独立审查再次核对清单、只读范围、字段脱敏
和报告解释，未发现越权、秘密泄露或验收夸大。`node --check`、文档链接及`git diff --check`
通过；没有重跑应用或模型测试。

没有调用 `/internal/status` 或 `/internal/runtime-control/status`：本地核对与生产标识
对应的旧源码确认 `getStatus()` 会将较新持久化快照安装到内存controller。即使是GET也
可能改变内存capabilities/disabled groups，不符合本次严格观察边界；它不会自行开启live
global，但仍不适合用来证明本次没有策略变化。未为此新开接口或修改生产代码，内存状态
保留未知。这一限制是读取方法的选择，不作为新的无界加固任务。

## 下一步的具体差异与边界

1. **代码与数据库**：发布候选应包含9bfbf0eb（Core源码1ea3ae7e）及0059/0060。需要
   获准的push/精确SHA CI、现状备份、唯一Core切换与现场验证；本轮未执行这些操作。
2. **模型**：已通过的有限语义窗口使用精确qwen3.8-max，线上则是Gemini。当前PD共用
   通用IRIS_MODEL配置，直接切换会同时影响普通问答。不能把Qwen结果当成Gemini通过，
   也不能把仅合成授权的Qwen key直接用于真实群。
3. **建议的最小发布范围**：先保持主动讨论关闭、保留普通问答现有模型；需要单独决定
   主动讨论是否采用独立的已验收Qwen配置。若选择独立配置，先做本地配置隔离和回归，
   再确定精确发布SHA；不要先全局换模型或开启群发。真实群数据范围及免费用完即停条件
   仍需明确，不能从本次只读同意中扩展。

本次完成的是生产差异核验，未关闭整体主动协作缺陷。下一步不是重新跑已通过的八例，
也不是只打开开关；必须解决上述发布与模型适用范围。线上状态保持此次操作前状态，
不把系统自身并发活动或健康检查算成本次应用写入。

## 文档处置

本轮没有bug修复提交，仍记录四处处置以保持验收层级可追溯。

| 位置 | 处置 |
| --- | --- |
| 白皮书 | **reviewed-unchanged**：[§6/§11.2](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md)的模型证据、发送权限和分层验收不变；这次只是取得现场事实。 |
| 工程故障台账 | **reviewed-unchanged**：[配置遗漏条目](../operations/engineering-failure-ledger.md)已记录本地修复与尚未部署；现场旧版本不构成该修复回归，状态GET的既有同步语义也未新判成bug。 |
| 核心需求覆盖基线 | **updated**：[基线](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)加入已核验生产f6a6dd4/Gemini/0058，真实群和新版本部署仍未完成。 |
| README / AGENTS / current-handoff | **updated**：[README](../../README.md)、[交接](current-handoff.md)记录只读授权已执行及模型/部署差异。**reviewed-unchanged**：[AGENTS](../../AGENTS.md)的工作树、边界与闭环规则仍适用。 |
