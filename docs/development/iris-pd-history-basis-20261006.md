# Iris：恢复窗口外的已核验问题依据

2026-10-06，工作树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支
`codex/iris-daily-pilot-followup`。应用修复
`51937b954733020799e02f139abd32df74b3349c`。这是[两次未通过的发布门槛](iris-deploy-20261006.md)
之后的真实应用修复，不是给旧镜像换标签，也不是另一轮模型prompt实验。

## 症状、原因与有限修复

同一问题的新报价到来时，原预算依据可能已离开最近20条消息窗口。context builder
核验并保留了历史来源引用，却只放入当前窗口和本次检索的正文。模型随后按既定合同
合并问题上一次已接受的basisRefs，发现引用没有原文而报
`proactive discussion evidence text is unavailable`。因此不能形成新的已审意见。
CI与本地真实PG的original/uncited两例复现；新问题不合并旧basis，故other-issue通过。
这确认了上下文装配缺口，不能归结为模型能力，也不能删除来源完整性检查来通过。

修复只恢复已通过原有权限核验、但当前材料缺失的basis来源：

- 同群人工消息按精确ID每批最多8条读取，核对完整正文哈希、身份和返回数量；拒绝
  跨群、助手、派生摘要、重复/额外ID、正文变化和读取失败。
- 文档复用runtime已有snapshot repository，核对精确snapshot/source ID、成功状态和
  非空正文；在读取前的原有来源核验和读取后的完整来源复核之间取得正文。
- 只补必要basis，按ref去重，不把累计prose来源全量灌回，也不用旧AI说明代替原文。
  保持现有1000来源上限、消息/文档预算和最终policy/context/catalog复核；读取失败或
  权限变化返回不可用上下文，不发言。

生成和审核依然锁定新旧依据引用。真实PG测试改为明确断言该既有闭包，并把实际
`assess` 返回值送入持久化；原来的权限撤销、连续来源、去重和投递要求保留。
没有改动模型prompt、数字核算、schema、发送授权或普通QA路径。

## 回归与出口

- 新历史上下文25例先观察24失败/1通过，修复后25通过；其中一例走真实builder、
  assess、生成和审核，只注入模型响应，证明新旧原文进入事实材料且旧AI说明不替代。
- 实现者的context/history/review-context共48通过；独立审查另跑history/context/runtime
  共48通过，无新增阻断发现。两组有重叠，不能相加宣称96个独立用例。
- 原失败文件 `proactive-discussion-final-fixes.test.ts`：真实PG18通过、0跳过，37.07秒，
  包括原两例及撤销、租约、普通回复链路。保留既有pg并发query弃用警告。
- 完整Core：5082通过、471条件跳过，283文件通过/13跳过，33.08秒。
- 类型检查、构建和diff检查通过。其余四个受影响PD文件（repository43、concurrency39、
  e2e6、reviewed-pair6）以真实PG启用执行，94通过/0跳过，165.09秒；加前述18共112项。
  e2e内有两项不访问PG的合同测试，不能把112全部写成每项都执行SQL或真实飞书。
- 已推送当前分支，并建立固定发布来源分支 `codex/iris-release-51937b95`。
  [精确CI 37411237495](https://github.com/xfbbert-dotcom/iris/actions/runs/37411237495)
  全部通过，2026-10-06 04:05:18 UTC完成；Core job耗时10分6秒，AI Worker耗时13秒。
  使用本轮既有免费标准runner范围，保留前两次失败，不重跑旧候选。
- [CI结构化结果与日志哈希](evidence/iris-pd-history-basis-20261006-ci.json)：Core5082通过/
  471条件跳过，pilot195通过，AI Worker181通过/1条既有警告。另行启用PG的23文件530项
  全通过，包含非SQL合同用例且与Core有重叠，不相加冒充独立总数。Compose/readiness、
  完整服务启动、数据库角色权限、成对备份恢复、Redis故障回调拒绝/恢复和清理均通过。
- [精确Node22镜像](evidence/iris-pd-history-basis-20261006-image.json)正常构建通过，prune
  运行依赖已知告警0；revision为51937b95，linux/amd64，image ID
  `sha256:d1d4e7f732efbfe205bed9ece9bbce37f4531c21e5b52042c21d8029f06446f9`。
- [既有断网镜像检查](evidence/iris-pd-history-basis-20261006-offline.json)通过，只做2次
  注入fetch，真实provider0，不启动服务/执行迁移；该检查不能替代历史依据回归或CI。

有限出口为：原失败PG、上下文安全回归、受影响完整PD链路、Core/类型/构建、独立审查、
精确来源完整CI和四处文档处置通过。上述本地及CI门槛已通过；提交精确候选供确认。实际发布与真实
单群验收分别依当次明确授权执行。不扩展本模块为任意长历史或任意长文档阅读系统，
不追加相同配置的实模抽样碰运气。

## 明确保留的范围

历史消息仍受单条8000字和总24000字预算约束；文档仍只提供精确已授权快照正文的前
1200字。basis合同只有snapshot binding，没有此前命中fragment的定位；如果旧依据在
文档后部，仍不能保证该段进入本轮材料。完整历史文档片段恢复是后续项，不冒称已完成。

此次没有新增实模语义验收或飞书外发；之前限定Qwen合成窗口和整体审核缺陷分别保留。
最新生产核验仍f6a6dd41、迁移0058、live global=false、proactiveSpeech=false；没有为
这次修复停服或改生产配置。先前用户批准的2116内容在CI被拒绝，新修复改变应用内容；
应在候选和门槛具体可审阅后确认新的实际发布提交，不能把旧批准写成新版本已部署。

## 门槛通过后的具体发布候选

候选固定为应用51937b95及上文精确镜像；本机受限目录已导出84,102,144字节镜像归档，
SHA-256为 `8b374d8a665d7fd9d79b5ee328bbf511814f8a85fc0518dd0b42244283a0c2af`，
尚未上传服务器。与原提案相比，新增内容只有历史basis原文读取修复及回归，生产依赖
修复和PD模型配置隔离仍包含其中。实际发布范围仍是Core与0059/0060迁移，普通QA模型
和有效配置保留，AI worker固定原镜像，现有Caddyfile修改保留；global和PD均保持关闭。

执行应复用[已核验的维护边界](iris-deploy-20261006.md#生产预检与当前维护边界)，先在旧
应用下产生并验证成对PG/Redis备份及机外解密检查，再迁移和切换；新Core必须通过live
readiness21项、迁移/角色权限、队列和入口边界检查。不得把旧候选的服务器预备文件直接
当成本候选配置，不调用生产pilot:smoke。任一门槛失败保持关闭并记录阶段。这个候选
不包含切换模型、用真实群材料测试新模型、启用主动发言或飞书测试消息。

## 白皮书11.2四处处置

| 位置 | 处置 |
| --- | --- |
| 白皮书 | **reviewed-unchanged**：[主动讨论依据规则](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md)已要求在原文可用时闭合上次basis、引用不等于正文、不可用时停止且不能用旧AI意见填补；本修复补齐读取接线，未改变该规则、权限或产品目标。 |
| 工程故障台账 | **updated**：[历史basis正文遗漏](../operations/engineering-failure-ledger.md)记录实际根因、修复和禁止用缓存AI正文补洞的预防规则。 |
| 核心需求覆盖基线 | **updated**：[本轮条目](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)区分已改代码、本地PG/模拟模型、CI、实模和真实飞书，IRIS-CORE-005仍部分实现。 |
| README / AGENTS / current-handoff | **updated**：[README](../../README.md)、[交接](current-handoff.md)和[停止发布记录](iris-deploy-20261006.md)指向此修复。**reviewed-unchanged**：[AGENTS](../../AGENTS.md)的工作树定位、授权边界、有限出口与闭环要求仍适用。 |
