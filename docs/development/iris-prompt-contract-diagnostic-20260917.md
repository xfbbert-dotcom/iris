# 同模型诊断：确有集成合同缺口，整体问题尚未修完

日期：2026-09-17。用户提出“可能不是模型的问题，是我们的问题”后批准继续解决。
本轮按[有限计划](../superpowers/plans/2026-09-17-iris-prompt-contract-diagnostic.md)执行，
不把“继续”当成新的云端容量探测、付费升级、生产切换或主动发言授权。

工作树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支
`codex/iris-daily-pilot-followup`；开工干净 `2bfc4955`，当时应用 `ee9a8ae2`。
本次应用修复提交 **`01ee7c31efccbd1552ee9b5f60197de8d2e1cbfc`**。
默认目录仍是另一工作树 `e4cd964a`，没有切换、重置或合并。

## 已确认与尚未确认的归因

1. **模型输入合同缺口已确认。** 原 JSON Schema 分别列 decision/reason/issue/materialChange
   的类型，却不表达它们的条件关系；原 prompt 只说 skip 使用 none、允许空文本，未明确禁止
   skip/material_issue、非空变化说明或 new issue。运行时 validator 会拒绝这些组合。
   本轮补齐发给模型的关系合同，**没有将 JSON Schema 改成条件联合，也没有放宽 validator**。
   因而不能宣称所有 schema/validator 差异都已被机制消除。
2. **复核/修正合同不一致已确认。** 判断与初次文案要求保留必要数字，成对修正提示却缺少这一
   要求，也未区分错误复核诊断与事实裁决。现已让首次/最终复核和修正共享授权算术规则：
   同口径直接可算的总额、差额、变化量、业务比率无需原文逐字写出；不能删关键数值迎合误判，
   未来影响仍须限定。修正复用 uncertainty 规则，区分业务百分比和模型信心评分。
3. [历史 run6](iris-proactive-discussion-joint-review-20260916.md#run6联合复核后的固定合成集)
   的 arithmetic call4 把可算的60%称为“未经授权”，call5删掉必要6万，call6错误放行。
   这条退化路径已证实；不过原判断也有 fact/未来风险混用，不能称原 pair 整体无条件正确。
   最终 reviewer 当时已有数字遗漏检查要求，因此也存在模型不遵循已有指令，不能全归于漏接规则。
4. **未发现丢失本题输入或丢失首条校验错误。** before/after 的两段授权材料都完整传入；
   两次判断均收到原文，修正提示包含固定 validator 原因。原失败输出不回显，是现有隐私保护，
   不是本轮要取消的功能。未读取隐藏推理，不把量化、硬件、runtime 或所有免费模型当作已证实根因。

## 固定本地分层对照

只复用[上轮已校验的本地程序与模型](iris-local-free-model-eval-20260917.md#下载与隔离运行)：
llama.cpp b11011、Qwen3-4B-Q4_K_M、CPU4线程、reasoning off、ctx16384、单槽、最大输出2048，
temperature0.7/top-p0.8/top-k20/min-p0。此次每个请求新增固定 **seed1709**，前后相同；
不与上轮未固定seed的输出混为同一受控实验，也不宣称跨runtime硬件完全确定。

[诊断封装](evidence/iris-prompt-contract-20260917-harness.txt)只允许
`http://127.0.0.1:18089/v1/chat/completions` 和固定模型、禁工具/流式/重定向，
每组最多14底层请求/600秒，单次timeout60000ms、评估间隔6000ms，结果文件存在即拒绝覆盖。
复用原 client、case factory、createPdModel 和 evaluator，不修改真实群数据或原验收标准。
记录全部实际合成请求及输出，未包含密钥或真实群原文；没有连接免费云端。

三层分别是：同题普通问答；原 arithmetic 的完整链；当判断失败时，以**明确标记的手工合法
assessment**单独测 render/review。第三层是隔离诊断，不是把人工答案注入完整链来冒充通过。
局部 prompt 修改前进程已载入旧模块，修改后使用新进程；源码哈希和完整请求均被留存。

| 层级 | before：07:21:38–07:23:36 UTC | after：07:24:52–07:26:42 UTC |
|---|---|---|
| 直接问同一预算题 | 识别两人各8万合计16万，大于10万；未明确写6万差额 | 输出逐字相同；仅证明能识别基本算术，不算原完整标准通过 |
| 原完整链 | 两个候选都是 skip/material_issue；第二个还有 new issue 和非空 none，校验拒绝 | 两个候选已是 intervene/material_issue，但 issueRef仍null、变化类型仍none，校验拒绝；首次含16/6万，修正又漏6万 |
| 手工合法判断后的隔离文案/复核 | 16/6/60%保留，review=true | 文案逐字相同，review=true；这两次未调用 pair repair |
| 真正最终结果 | assessment=null、draft=null，assessment_validation，退出1 | 相同失败分类，退出1 |

每组实际 **5次HTTP200**：direct1、assessment2、隔离draft1、隔离review1。
总共10次本地请求，0云端请求、0模型API费用；CPU/内存/电力仍有消耗。
两个原完整链均为 **1未完整、0有效最终判断、0文案**，不可用空 decisionMismatches 声称正确。
after的原始决策改善是单题/单seed观察，不代表稳定性、模型能力全面合格或修复了历史复核误拒。
两组均未触发真实 pair repair，关于修正数字保真的实模有效性仍待后续验收。
原15例两轮没有启动；未重抽、改温度或切换模型来获得绿色结果。
离线将四个保存的候选重新送入现有validator（0网络/模型调用），before两次首错误均为
`skip cannot use material_issue`，after两次均为`intervene requires an issue reference`。

## 回归与审查

- 基线 `npm test -- proactive-discussion-model.test.ts`：15:18:40北京时间，29通过。
- 新增两个真实 client 请求边界合同回归，15:23:21：**2失败/39通过**，失败分别是模型输入
  缺完整skip关系、review缺授权算术规则，不是编译或网络错误。
- 最小实现后15:24:24：model30 + pair-review11 = **41通过**。既有私有输出不回显、
  一次修正上限、同问题/refs锁定、最终拒绝等测试继续通过。fake completion只测输入/编排，
  不证明模型理解了规则。
- `npm test`：15:27:46开始，32.96秒；**4651通过/469条件跳过**，253文件通过/13跳过。
  跳过的PG不是本轮数据库验收；没有数据库或迁移变更，没有冒称重跑真实PG。
- `npm run typecheck`、`npm run build`：退出0。
- `node --test scripts/pilot/proactive-discussion-eval.test.mjs`：7通过，退出0；使用合成边界，
  不是7次真实模型测试。`git diff --check`通过，仅既有Windows换行提示。
- 一次独立修复范围审查：规格/质量通过，无Critical/Important；其41项重复测试不重复计数。
  Minor保留：已有问题/new_evidence句式可更清楚限定“新来源”条件；下文明确的
  observing/canReassessUnattempted例外与validator未变，本轮不扩展此已测候选。
- 本轮没有远端CI、Python/完整pilot回归、生产健康/队列核验、SSH、push、部署、飞书消息或能力变更。

## 证据身份和清理

| 文件 | SHA256 |
|---|---|
| [before](evidence/iris-prompt-contract-20260917-before.json) | `fbba9cd8efb995cab77b9680cf851508d7f78e84805e139e296df8463c321b43` |
| [after](evidence/iris-prompt-contract-20260917-after.json) | `23f02d72e498c2137596fff9fa8cb7d65f8c32feb93d4f6faa67ccd06ad53a61` |
| [封装快照](evidence/iris-prompt-contract-20260917-harness.txt) | `952514a3617be4da604b886045f2cac95ccae9a2bf4707a5f432dd342eb9fec6` |

报告commit字段均为当时尚未提交修复的2bfc4955；after不因此被误标为旧应用。
实际model.ts文件SHA256：before `16c0dddfa93ad92599abe28bce595a92959473039a0a9b273b308bd5b24f296e`，
after `f7f98d9e00499fec0b5a34821f70d84a322bf4787596f4a4a5a07e11eff06168`，后者对应01ee7c31修复文件。
原始报告manualReview=pending保持不变，本记录是代理对结果的审查，不伪造人工签字。

归档核验：before/after与本机报告逐字段相同，封装快照内容相同，after源码哈希与修复文件相符。
7份文档的本地链接/锚点核验通过；上轮本地算术与run6报告哈希保持不变。
本次文档核验不冒充再次运行应用或真实模型。
一次独立文档/证据闭环审查通过，无阻塞不一致；确认四行处置、失败归因、应用/实验SHA区别及当前继续点。

本轮本机模型PID57056仅在核验exe完整路径后停止；监督进程结束，后置18089监听0、
llama-server进程0。模型/程序继续保留，无新后台服务或自动重试，无删除用户文件。
强制停止子进程的返回码4294967295是有意清理结果，不是推理失败；监督进程退出0。

## 尚未完成与有限下一步

已经修正的是我们发给模型的合同缺口，不是“主动功能全部修好了”。最新实模仍不能产出合法
完整判断；最直接的剩余障碍是**正确识别问题后仍输出互相矛盾的结构字段**。JSON Schema仍只约束
字段形状，复杂关系由文字提示和后置validator承担；继续盲加提示或只换模型不能证明问题解决。

下一项应是明确设计并测试模型输出与程序状态的边界：让结构约束在生成端与validator一致，
或把可确定的生命周期字段从模型职责中分离。必须保留skip真实性、同群issue/来源绑定、未知发送/
暂停/新依据约束和现有拒绝边界；不能把无效结果自动升格为介入。任何这类结构调整先给出有限
设计与兼容性测试，再运行同题及原15例两轮，不把本记录当作已批准任意校验架构重做。
这是当前具体继续点，不是新的云端可用性探测窗口，也不是重开Tasks1–8/I1–I4审计。

## 四处文档处置

| 位置 | 本次处置 |
|---|---|
| 白皮书 | updated：[第6节](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)澄清模型字段合同、授权算术和修正保真；[11.2](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#112-mandatory-bug-fix-documentation-closure) reviewed-unchanged，四处同步与分层验收继续适用 |
| 工程故障台账 | updated：[主动协作条目](../operations/engineering-failure-ledger.md#proactive-collaboration-is-not-a-deadline-reminder)增加先分层诊断、模型合同与validator关系对齐、复核不高于原文的教训与本轮失败边界 |
| 需求覆盖基线 | updated：[2026-09-17修订](../superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md#2026-09-17-同模型合同诊断)记录本地修复和仍未完整的实模，不提升IRIS-CORE-005为交付 |
| README/AGENTS/当前交接 | updated：[README](../../README.md#current-product-state)、[当前接手入口](current-handoff.md#当前正在推进)指向本次及剩余结构问题；[AGENTS](../../AGENTS.md) reviewed-unchanged，已核实工作树/分支和四处规则仍准确 |
