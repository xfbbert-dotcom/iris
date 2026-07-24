# Iris 核心需求覆盖基线

> 基线日期：2026-07-14
> 最高架构依据：`2026-06-30-iris-architecture-whitepaper.md`
> 判定规则：只有存在可运行代码路径和自动化/真实验收证据时才标记为“已实现”。仅有配置项、类型、接口或 capability 开关不算实现。

## 1. 版本边界

- 当前目标是公司内部 20-30 人使用的单公司版本，先保证核心体验和权限安全。
- “多人使用”指同一飞书群中的多人共享 Iris、上下文和结果，属于当前核心范围。
- 自助安装、多公司、多租户、计费和租户级隔离属于白皮书演进阶段 4，不属于当前内部 MVP；现有设计必须避免阻塞后续产品化。
- 当前生产版本已经具备安全聊天、文档和知识库检索、知识发布执行、默认关闭的主动信号链路和带文档源/知识草稿/发布队列/主动候选/审计摘要治理的最小 Admin Console，但不能称为完整 Iris。

## 2. 核心需求追踪

| ID | 核心需求 | 当前状态 | 现有证据 | 缺口与完成标准 |
|---|---|---|---|---|
| IRIS-CORE-001 | 同一飞书群中的多人可以共同与 Iris 协作，并从前一个人的上下文继续 | 部分实现 | 所有已启用群消息进入 `conversation_messages`；回答读取最近群聊、当前群 active 长时记忆及相关 open thread/action；普通非 @ 消息可异步形成同群共享状态；飞书回复所有群成员可见 | 当前群 thread/action 代码已实现，但真实飞书灰度仍待验收；主动协作不在本阶段 |
| IRIS-CORE-002 | Iris 被拉入群后持续接收群消息，即使未被 @ 也理解讨论 | 代码已实现（真实飞书灰度待验收） | Feishu Gateway ack-first；Raw Event Queue；消息事实持久化；普通非 @ 文本异步抽取；同群证据绑定；semantic thread 的 candidate/open/resolved/reopened/merged 生命周期；显式 commitment/action 生命周期；回答时当前群检索；本地端到端验收 | 尚未执行单群真实飞书灰度，不能称为已上线或完整 Iris |
| IRIS-CORE-003 | Iris 随时间学习，用户不必重复解释业务背景 | 代码已实现（真实飞书灰度待验收） | Postgres `group_memories`、`discussion_threads`、`action_items` 与 append-only events/evidence；置信度与候选隔离；幂等、重试、冷却、DLQ 与 projection repair；版本化纠错；当前群 bounded retrieval；真实 Postgres/Redis/Python 自动化测试；本地可执行端到端验收 | 尚未执行单群真实飞书灰度；本阶段不包含主动提醒或沉寂跟进 |
| IRIS-CORE-004 | 在授权后跨群和跨数据源学习 | 部分实现 | 当前群文档、授权知识库、用户手动提交文档已接入统一文档源和权限策略 | 没有跨群授权关系、跨群记忆共享策略和跨群检索审计；默认必须保持群隔离 |
| IRIS-CORE-005 | Iris 主动发现需要关注的信息并更新群成员 | 代码已实现（真实飞书灰度待验收，默认关闭） | Phase 6A `proactive_signal_candidates`、candidate evidence/events、preview/scan/govern/dismiss/approve API、delivery outbox、bounded Feishu card renderer、dispatcher loop、双重 `canProactivelySpeak(groupId)` 门禁、发送记录、重试/永久失败/outcome_unknown 分类、状态页组件和 CI/pilot contract 检查 | 仍需在一个明确 allowlist 小群完成真实 Feishu 主动卡片验收、误报率观察、人工反馈闭环和运营阈值校准；生产默认保持关闭 |
| IRIS-CORE-006 | Iris 跟进沉寂但未解决的讨论或任务 | 代码已实现（真实飞书灰度待验收，默认关闭） | 主动扫描可读取当前群 `discussion_threads` 与 `action_items`，生成 quiet open thread / overdue action 候选；候选具备幂等 key、版本、证据计数、去重、治理状态、delivery outbox 和不泄露原文的群卡片；Admin Console 可对一个显式 group id 执行 scan、查看 pending candidates、dismiss 或 approve delivery，且不直接发送飞书消息 | 仍需真实小群验证沉寂阈值、重复抑制、打扰频率、撤销/暂停语义和用户反馈闭环；未经人工配置不得主动发言 |
| IRIS-CORE-007 | Iris 将讨论整理成内容，先发群里让用户确认 | 已实现 | Phase 5A Postgres 知识草稿事实层；5B-1 版本绑定群确认/修改/拒绝卡片；5B-2A `ActionProposal`、风险矩阵、目标策略、角色 grant、负责人/管理员审批卡片、实时授权、治理 API、幂等 callback 与 readiness；5B-2B 飞书 OAuth + PKCE、完整正文/哈希审阅、append-only attestation 与批准前精确门禁；真实 Feishu pilot 已覆盖群确认、请求修改、负责人/管理员批准、撤销和私聊审批卡；Admin Console 已具备知识草稿状态/列表摘要、安全请求修改/拒绝入口，以及发布/action proposal 队列治理入口 | 批量审批、复杂协作编辑和更细的 reviewer 映射进入 backlog |
| IRIS-CORE-008 | 用户确认后同步到飞书知识库 | 已实现 | 5B-3 飞书知识库发布执行器、授权 wiki root、幂等 publication execution、失败恢复/对账、回群结果和真实 Feishu pilot；未经确认、审阅和所需批准不会写入 | 后续补充批量发布、冲突检测、发布模板和更友好的发布历史页面；核心写入闭环已成立 |
| IRIS-CORE-009 | Iris 回答时读取授权飞书知识库 | 已实现 | 授权 Wiki 注册、解析、同步、向量检索、实时权限二次校验、引用和真实飞书验收 | 后续补充知识冲突识别和知识更新草稿，不影响当前已实现判定 |
| IRIS-CORE-010 | Iris 读取所在群中出现过的可读文档正文 | 已实现 | 群文档链接发现、正文抓取、来源证据、同步、索引、群可见检索和真实飞书验收 | 后续扩展更多文件类型和解析质量 |
| IRIS-CORE-011 | Iris 读取用户手动提供的文档 | 内部运营入口已实现 | 手动文档注册、同步、来源策略和回答检索；Admin Console 可提交用户提供的飞书文档链接、填写提交人、入队同步并刷新来源状态 | 仍需要面向普通员工的飞书内自助提交入口和更友好的同步状态反馈；底层能力与内部运营入口已存在 |
| IRIS-CORE-012 | 文档/知识库权限撤销后不得继续泄露内容 | 已实现核心边界 | 答前实时 Feishu Permission Guard；拒绝审计；fail closed；权限回收真实验收 | 后续增加权限变更主动失效和批量回收，但答前安全边界已成立 |
| IRIS-CORE-013 | 高影响行动执行前必须询问并获得确认 | 首个通用审批闭环已通过真实 pilot；完整正文审阅代码候选完成 | 5B-2A 为 `publish_knowledge_draft` 建立 proposal -> requirements -> approval 事实层、风险矩阵、实时角色复验、版本失效和共享飞书回调；5B-2B 要求批准前存在当前精确审阅事实；内部 API 不能伪造人工批准 | 5B-2B 仍需真实 OAuth pilot；本阶段尚无 execution/result，5B-3 才接入首个执行器；后续建任务、跨群通知复用同一契约而非复制审批逻辑 |
| IRIS-CORE-014 | 管理员可以全局/按群开启关闭 Iris 和能力 | 最小 Admin Console 已实现 | Postgres 持久化 runtime control；全局、群和 capability API；紧急停用真实验收；`/admin` 浏览器控制台可读取系统状态、readiness、runtime control，并可操作全局、群和 capability 开关；同一控制台可查看文档源摘要、同步健康、权限状态，并可按源切换回答/知识草稿策略与触发手动同步；知识草稿队列可查看状态计数和摘要并执行请求修改/拒绝；发布队列可查看 pending/approved/executing/failed/reconciliation action proposals 并执行安全请求修改/拒绝；主动候选治理可扫描单个显式群、查看候选并执行 dismiss / approve delivery；审计摘要视图可按事件类型/文档过滤查看 retained/dropped/inspected/matching 与聚合事件窗口；Caddy 仅放行精确静态 console 路由，`/internal/*` 仍保持 404 | 仍需增加持久化审计仓库和正式管理员身份模型；当前版本先满足 20-30 人内部运行控制 |
| IRIS-CORE-015 | 多人安装和多公司使用 | 按白皮书延期 | 白皮书演进阶段 4 明确 multi-company / multi-tenant productization | 内部 MVP 稳定后增加 tenant ID、安装流程、租户密钥/数据隔离、租户管理员和计费 |

## 3. 当前真实结论

当前 Iris 不是“只有一句话问答”的空壳：安全接收群聊、共享最近上下文、读取群文档、读取授权知识库、实时权限防泄露、回答与引用、运行时停用和恢复、知识草稿确认审批与知识库发布都已经工作；主动信号发现和投递链路也已完成默认关闭代码路径，最小 Admin Console 已经可以承担基础运行控制、文档源治理、知识草稿队列观察、发布队列治理、主动候选治理和审计摘要查看。

但当前仍然不能称为完整 Iris。以下白皮书核心仍未形成稳定日常产品闭环：

1. 自动群级记忆、semantic thread/action 聚合与持续状态更新已经形成代码链路，但仍需经过真实飞书单群灰度；
2. 主动信号发现、未解决讨论跟进和默认关闭投递链路已经形成代码链路并通过 CI，但仍需真实小群灰度、误报率观察和反馈闭环；
3. 知识草稿确认、审批、完整正文审阅和飞书知识库发布已通过真实 Feishu pilot；轻量 Admin Console 已提供知识草稿与发布/action proposal 队列摘要和请求修改/拒绝入口，后续要补批量治理；
4. 面向非工程管理员的轻量控制台已有运行控制、文档源治理、知识草稿队列、发布队列、主动候选治理和审计摘要版，但持久化审计仓库和正式管理员身份模型仍需进入后续；
5. 多公司自助安装和租户产品化。

## 4. 实施顺序

| 阶段 | 交付物 | 为什么先做 |
|---|---|---|
| 3A | 长时群记忆事实层、纠错/删除和回答时检索 | 主动参与和知识草稿都依赖可信记忆；先建立可治理的数据基础 |
| 3B | 异步记忆抽取、主题/thread 聚合和证据绑定 | 让 Iris 真正随群聊学习，而不是只保留原始聊天记录 |
| 4A | 主动信号候选、未解决讨论检测、限频和解释 | 代码链路已完成；真实小群灰度前仍保持默认关闭 |
| 4B | 群内主动建议、暂停/恢复和反馈闭环 | 投递 worker 已完成默认关闭代码路径；下一步通过 allowlist 小群验证质量和打扰边界 |
| 5A | 知识草稿事实层、风险等级、证据和状态机 | 建立讨论到知识的可审查中间层 |
| 5B | 群内确认、管理员复核、飞书知识库幂等发布 | 完成“先确认、后行动”的核心闭环 |
| 6 | 轻量 Admin Console | 让 20-30 人内部版本可由业务管理员日常运营 |
| 7 | 多公司安装与租户化 | 内部核心闭环稳定后再增加租户复杂度 |

## 5. 质量门禁

- 任何长时记忆必须能追溯到原始消息或授权文档证据。
- 默认只在当前群可见；跨群使用必须有显式授权和审计。
- 删除、纠错和权限撤销必须在下一次回答前生效。
- 主动候选、知识草稿和高影响行动必须有独立状态，不允许模型输出直接触发外部写操作。
- 所有新增异步队列必须具备幂等、重试、DLQ、状态观测和停用语义。
- capability 名称不得被当作功能完成证据；每项完成必须有自动化测试和真实飞书验收脚本。
