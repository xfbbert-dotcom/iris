# Iris 来源计划：修复 pilot Compose 配置遗漏

日期2026-10-04，工作树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支
`codex/iris-daily-pilot-followup`，修复前HEAD `6a54b2d1`。Core实现仍为
`1ea3ae7e528ae5f7ceb38686d6853fea9e0e6877`；本轮改变部署配置及其回归测试，未部署。
部署配置修复提交：`9bfbf0ebc49fa34dee367d1c4d4ca0111322241b`；随后文档提交不代表上线。

## 已确认问题与修复

上一轮[PG到模拟发送验收](iris-opinion-postgres-20261004.md)通过后，检查实际发布路径
发现 `deploy/pilot/docker-compose.yml` 的Core环境映射遗漏
`IRIS_PROACTIVE_DISCUSSION_OPINION_MODE`。本地使用已提交的合成 `deploy/pilot/ci.env`
渲染，并显式设置进程mode为`source-plan`，输出的Core mode仍缺失；运行时会因此
选择默认`legacy`。这是配置传递故障，不能用直接进程运行或PG回放通过来证明部署路径通过。

补充 `${IRIS_PROACTIVE_DISCUSSION_OPINION_MODE-legacy}` 并在 `.env.pilot.example`
列明默认`legacy`。使用无冒号的缺省语法，显式空值不会被转换成legacy，继续由现有
runtime parser拒绝；非法值也原样传递。回归比较Core完整环境差异，只允许该字段变化，
并验证其他服务不获得该字段。选择来源计划不启用发言、不改变模型或目标群。

[有界修复计划](../superpowers/plans/2026-10-04-iris-opinion-pilot-config.md)只覆盖该遗漏，
没有新增prompt、模型采样、来源权限或发送能力。

## 实际验证

| 验证 | 结果 |
| --- | --- |
| 修复前 `node --test --test-name-pattern="opinion" scripts/pilot-compose.test.mjs` | 新增2例均失败，exit1；实际字段undefined，分别不等于legacy/显式空值。 |
| 修复后 `node --test scripts/pilot-compose.test.mjs` | 完整36通过、0失败/跳过，exit0，9.31秒。含既有本地临时Caddy边界测试，非生产部署。 |
| `npm --workspace apps/core test -- proactive-discussion-runtime-opinion-mode.test.ts proactive-discussion-opinion-mode.test.ts --no-cache` | 10通过、0跳过，exit0；包含默认、显式选择和非法/空值拒绝。 |
| 实际 `docker compose --env-file deploy/pilot/ci.env --file deploy/pilot/docker-compose.yml config --format json` | 显式source-plan到Core，ENABLED仍false，GROUP_IDS仍空；仅输出这些非秘密字段。 |
| 同一Compose的 `config --quiet` | exit0。 |

`git diff --check`通过；独立范围审查确认配置/测试符合既有合同，无可操作问题。修复的
验收出口已达到，不以同配置反复抽样或通用审核扩大本轮范围。

未重复模型、PG、Core全量或build；本轮没有修改TypeScript源码。新回归调用真实Compose
渲染器，已有完整脚本中的Caddy测试只在本地临时运行；没有启动pilot stack、访问生产
或使用真实飞书/模型。此前八例两负控、Core5012/469条件跳过及PG6/6仍属于各自日期的证据。

## 下一步可审阅的操作范围

当前授权不含生产访问。本轮未执行下面的只读预检；提出它是为了先得到具体现场事实，
再确定可部署的精确版本及最小变更。只读预检本身不授权后续部署/群发。

1. 使用既有运维连接，在既有Iris服务器核对当前Core镜像/应用SHA、Compose路径及迁移版本；
   不拉取或构建镜像，不push代码，不运行迁移，不重启服务。
2. 只输出运行容器的非秘密字段：模型provider/name、结构化输出mode、意见mode、PD enabled/
   groupIds，以及运行控制开关。密钥、token、完整env和群消息正文不输出、不复制。
3. 通过现有受保护只读状态接口与只读SQL，核对原固定试点群的policy版本/enabled、
   pending/sending/unknown计数和健康状态。runtime关闭时status的空计数不能当成数据库为空；
   policy读取不能以旧记录代替。不调用任何PUT/PATCH/POST，不读取真实群正文。
4. 输出现场差异、拟部署精确SHA/镜像、是否涉及通用模型改变、停止/恢复步骤与仍缺的授权。
   如果现场信息不可核验，保留未知，不猜测、不直接扩大操作。

当前代码只允许 `PD_PILOT_CHAT` 中的原群（末尾 `f1fc5b9a`），[常量](../../apps/core/src/proactive-discussion/contracts.ts)
和[配置检查](../../apps/core/src/config/runtime-config.ts)均限制为该唯一群；不需要用户重新查找
已有群ID，也不把旧群授权延续到本次开启。PD使用通用 `IRIS_MODEL_*` 配置，source-plan不是
独立模型开关；精确qwen3.8-max的有限合成通过不能证明尚未核验的线上模型同样通过。
现有合成key仅授权合成范围，不能直接改作真实群模型凭据。

后续如获准部署，按[单群运行手册](iris-proactive-discussion.md#单群发布-runbook)先保持
policy/发言关闭；env改变需重建Core容器，单纯restart不应用新环境。重新核对运行时mode/
模型、policy和live global gate后，才按另行批准范围开启原群。Core重启后live global
默认关闭，不能根据durable desired值擅自恢复Q&A或发言。停止顺序为关proactiveSpeech、
关policy，再关新runtime；unknown保留核对，不盲重发。成员真实回复暂停/恢复不能由
operator resume接口冒充。精确发布SHA的远端CI仍未取得；当前来源计划的模型门槛以
[已冻结的八例两负控及其局限](iris-opinion-runtime-20261004.md)为准，不重新启用历史
“两轮全量”实验要求，不把旧失败报告改判通过。现场模型/合同如不一致，应先报告差异，
不能将已有合成通过迁移为另一模型的通过。

## 四处文档处置与验收层级

| 位置 | 处置 |
| --- | --- |
| 白皮书 | **reviewed-unchanged**：[§6与§11.2](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md)的默认关闭、显式合同、权限和分层验收不变；本修复让部署配置履行已存在合同。 |
| 工程故障台账 | **updated**：[配置遗漏条目](../operations/engineering-failure-ledger.md)记录直接入口通过不能代替部署环境传递验证，以及真实Compose回归。 |
| 核心需求覆盖基线 | **updated**：[基线](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md)增加部署配置本地通过，IRIS-CORE-005仍部分实现。 |
| README / AGENTS / current-handoff | **updated**：[README](../../README.md)和[交接](current-handoff.md)链接配置修复和只读预检提案。**reviewed-unchanged**：[AGENTS](../../AGENTS.md)已有工作树、授权边界及文档闭环规则足够。 |

本轮只关闭已确认的本地Compose遗漏；整体主动协作缺陷仍开放。生产精确版本、真实飞书、
部署和新增真实模型语义均没有本轮通过证据。不能将本记录或配置提交称作上线。
