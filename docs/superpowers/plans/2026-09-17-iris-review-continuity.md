# Iris 数字复核连续性修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 阻止一次修正后的最终审核悄悄丢弃首次已提出的数字核对项，同时允许基于原文纠正错误初审。

**Architecture:** 继续现有 render → review → 单次 pair repair → final review，不增加调用。首次数字列表随最终请求传递；最终列表必须保留同值同单位的有效当前草稿凭据，或通过显式、有授权原句依据的 numberRevisions 更正/撤回。该检查只证明条目连续性、引用存在和映射有效，不声称自动证明算术或撤回理由正确。

**Tech Stack:** TypeScript、Zod、Vitest；无新依赖。

**Spec:** [主动讨论设计](../specs/2026-09-09-iris-proactive-discussion-design.md)、[白皮书第6节](../specs/2026-06-30-iris-architecture-whitepaper.md#6-permission-safety-and-proactive-behavior)。具体缺陷是[归档 edit 实验](../../development/iris-json-mode-compatibility-20260917.md#继续修复的两项私有实验均未推广)的四响应在真实 render 内离线重放仍接受错误 pair；不是新的模型推理结果。

## Global Constraints

- 原成功路径2次调用；进入修正总计最多4次 render/review调用，不新增修正循环。
- 初审数字是待核对诊断，不是事实；不能硬编码合成样例的6/16或要求写入错误数字60。
- 不增加来源、跨群权限、工具、部署或生产开关；不调用付费模型、不密集重试免费云端。
- 严格响应键、最大8个数字、当前原样引文、32 KiB response-format上限保持。
- evaluator诊断使用同一helper及实际当次完整输入，不从500字截断trace推断通过。

## Task 1: 一次修正内保留可纠错的数字复核项

**Files:**
- Modify: `apps/core/src/proactive-discussion/review-receipts.ts`、`model.ts`
- Modify: `scripts/pilot/proactive-discussion-eval.ts`
- Test: `apps/core/tests/proactive-discussion-review-continuity.test.ts`、既有pair/receipt/eval-trace测试
- Docs: `docs/development/iris-review-continuity-20260917.md`及四处闭环入口

**Interfaces:**

```ts
type PdScopeReviewHistory = {
  previousNumbers: PdScopeReview["requiredNumbers"];
  evidence: readonly { ref: string; text: string }[];
};
// validatePdScopeReview(value, draftText, history?)
// createPdScopeReviewJsonSchema(draftText, history?)
// history.previousNumbers 非空时最终输出额外必填：
type NumberRevision = {
  previousIndex: number;           // 初审列表的0-based位置，唯一且存在
  replacementIndex: number | null;// 当前requiredNumbers位置；null表示撤回
  reason: string;                 // 非空，有界；模型负责解释原文如何纠正初审
  sourceRef: string;              // 仅本次pair的授权evidence
  sourceQuote: string;            // 未规范化/未补写的对应source原句
};
// numberRevisions: NumberRevision[]，最大8项；无更正用[]。
```

- [x] Step 1: 新增归档四响应的真实render回放，断言原错误pair不再返回，并运行得到真实RED（当前返回pair）。补三组对照：正确补齐数字返回；初审60更正为6返回；不适用的数字有原文依据显式撤回返回。

```ts
const result = await createPdModel({ client: replay(saved.calls) }).render({ context, assessment });
expect(result).toBeNull(); // 当前42dedd68实测返回saved.finalPair
```

- [x] Step 2: 在helper内严格校验修订列表。每个旧项按原索引匹配至有效修订，或在当前数字列表找到同expectedValue/unit；缺失、重复/越界索引、未知来源、跨来源/伪造/空引文以及不存在的替代项均拒绝。不能通过少返回条目消除待核对诊断。原semantic false仍终止，不升级为true。

```ts
for (const [index, prior] of history.previousNumbers.entries()) {
  const revision = revisions.find(item => item.previousIndex === index);
  if (revision) { /* 核对独立来源原句、唯一索引及替代项存在；不代算或改写文本 */ }
  else if (!review.requiredNumbers.some(item => item.expectedValue === prior.expectedValue && item.unit === prior.unit)) {
    return { ...review, supported: false, reason: "最终复核未完整处理此前数字核对项。" };
  }
}
```

- [x] Step 3: 最终请求新增previousReview（数据、不可信），用同一history生成schema与校验；首次请求及初审无数字路径保持原输出形状。pair repair仍读原review；保留来源优先、错误初审可纠正的系统规则。
- [x] Step 4: trace从实际request解析previousReview/evidence，调用同一helper；新增字段按现有长度/数量/脱敏与引用范围过滤，记录raw verdict与本地失败分开。测试真实runtime与trace同判、正向、显式纠错/撤回、当前引用和schema尺寸；不能只测试prompt文字。
- [x] Step 5: 运行聚焦回归、Core完整回归、类型/构建及CLI；一次独立修复范围审查。若执行本地真实模型，只在新合同下做预先有界的正负对照并保留失败，不原样抽样直到绿色。
- [x] Step 6: 提交代码；记录SHA、RED/GREEN、真实验证层级及剩余生成/语义问题，完成白皮书/台账/基线/README-AGENTS-handoff四行处置；不push或部署。

## 执行边界与自检

本计划只有一个紧耦合任务，由主代理实现，独立代理已完成只读复现；范围审查独立执行。两处调用和evaluator共享同一helper，避免另起一套判定规则。历史实验不修改，不能把修复后的重放当作真实模型重新生成。保留被错误初审拒绝的正向用例，以免防漏项变成冻结错误数字。

基线：实现树42dedd68，干净；已有pair-review/receipts/eval-trace共63项通过。工作树已验证为linked worktree、非submodule，不另建或切换分支。没有本轮生产探针。

完成记录：[数字复核连续性修复](../../development/iris-review-continuity-20260917.md)，应用`d699761e`，
聚焦81通过、Core4734通过/469条件跳过、类型/构建通过、Compose+CLI40通过/1条件跳过及独立范围审查。
正负本地实模对照和失败的原文重建实验均原样保留。勾选只表示本计划的局部程序缺陷已闭环，
不是完整主动语义、部署或真实飞书投递通过；9月18日归档并确认本地模型已停止。
