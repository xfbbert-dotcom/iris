# Iris 同模型合同诊断与有限修复

> **For agentic workers:** Use the executing-plans workflow for this tightly coupled diagnostic/fix; independent read-only review may run in parallel. Track the steps below; do not expand this into a new provider or review architecture.

**Goal:** 用同一个本地免费模型区分直接问答、Iris 判断和后续复核的失效，并修正已证实的模型输入合同缺口。

**Architecture:** 保留现有 `createPdModel` 的 assess → render → joint review → 至多一次 pair repair → final review。只补齐字段关系和授权算术/修正保真合同；不以 schema 结构通过冒充语义正确，不回显被拒的私有输出，不增加调用。

**Tech Stack:** TypeScript、Vitest、现有 OpenAI-compatible client；本机 llama.cpp b11011 / Qwen3-4B-Q4_K_M。

**Spec:** [白皮书第6节](../specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)与[联合复核设计](../../development/iris-proactive-discussion-joint-review-20260916.md#症状原因与批准边界)。本轮用户在提出“可能是我们的问题”后批准继续按同模型分层对照解决；这是现有行为的有限修复，不是新架构。

## Global Constraints

- 工作树 `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`，分支 `codex/iris-daily-pilot-followup`，基线 `2bfc4955` / 应用 `ee9a8ae2`。
- 仅固定合成材料、本机 `127.0.0.1:18089` 和已有模型，无付费/云端请求、生产修改、外发、push、审批或能力启用。
- 不回显未通过引用校验的模型原输出；不扩大 sources、issue、群、调用预算；不删失败记录或降低原15例标准。
- 固定 seed=1709 作为本次新的受控实验参数，其他 runtime 参数沿用上轮；前后各一次，不与之前随机seed抽样混同。
- 诊断预算每组最多14底层请求/10分钟。先 direct 同题，再原 arithmetic 完整链；若 assess 阻断，另以明确标记的人工合成合法 assessment 测 render/review，不冒充端到端通过。

## Task 1: 诊断并补齐同一个模型模块的合同

**Files:**
- Modify: `apps/core/src/proactive-discussion/model.ts`
- Test: `apps/core/tests/proactive-discussion-model.test.ts`、`apps/core/tests/proactive-discussion-pair-review.test.ts`
- Diagnostic: 独立本地 `C:/Users/59912/AppData/Local/Iris/local-eval-20260917/contract-diagnostic.mts`；脱敏合成快照与结果归档 `docs/development/evidence/`。

**Interfaces:** `createPdModel({client}).assess(context)` 与 `.render({context,assessment})` 不变；所有传输和最终 validator 保持原约束。

- [x] 运行现有 model 测试作基线，然后运行本次 before 诊断。direct 题仍为“本季度预算10万元，两人各8万元，声称够用”；不把16写成schema强制答案。
- [x] 写出失败测试，使用真实 createPdModel 在 client 边界捕获 payload：首判断及仅一次修正均包含完整 skip/materialChange/issue 关系；既有私有输出不能进入重试消息。

```ts
const client = sequenceClient([invalidAssessment, JSON.stringify(pdSkipAssessment())]);
await createPdModel({ client }).assess(pdContext());
const requests = client.complete.mock.calls;
expect(requests).toHaveLength(2);
// 对发给模型的关系合同和禁止回显断言，而不是 grep 源码或把 fake 当语义验收。
expect(JSON.stringify(requests[1]?.[0])).not.toContain("private-foreign-ref");
```

- [x] 为 render / 两次 review / pair repair 的实际输出请求添加合同回归：直接算术与比例有可比前提即可；确定算术与不确定后果分开；review reason 不高于原文；修正不能删掉必要总额/差额/变化来迎合误判。先观察预期 RED，再修改提示。
- [x] 最小实现只更新模型提示：skip 禁用 material_issue、none 的 explanation 必须空字符串且 refs空、新issue对应new_issue、已有issue对应new_evidence/有限unattempted_first；共享数字保留与原文优先规则供复核和修正。不要把无效 skip 自动转为 intervene，也不要绕过复核。
- [x] 聚焦 GREEN、Core typecheck/build、完整Core与现有evaluator/CLI回归；本轮无数据库实现改动，历史PG不得写作重跑。
- [x] 同一seed/模型/材料运行 after 诊断。若 arithmetic 完整链仍不合格，不启动15×2、不中途调参重抽；将归因和下一项有限行动记录清楚。
- [x] 独立一次修复范围审查；仅修审查阻塞。分开记录提示合同回归和真实模型语义。
- [x] 本地提交应用修复，完成四处文档处置与证据/链接核验，再提交记录；不推送、不部署。停止并核对本次本地模型进程/监听。

## Exit

已证实的合同缺口有回归和修复，前后诊断原样保留、语义成败明确、文档四行闭环且本地服务停止即结束本轮。单例成功只能授权有限完整集评估，不等于新主动功能可上线；单例失败保留门禁，不通过更换模型或放宽标准掩盖。

## 执行结果

应用`01ee7c31`，两个新增合同测试RED后GREEN41；完整Core4651通过/469条件跳过，CLI7、类型/构建通过。
前后各5次本地HTTP200，原完整链仍失败；改后原始decision已为intervene，但issueRef仍null。
本轮有限合同修复完成不等于整体问题修完。[完整记录与下一项有限设计](../../development/iris-prompt-contract-diagnostic-20260917.md)。
