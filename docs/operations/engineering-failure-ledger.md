# Iris Engineering Failure Ledger

## 2026-10-01：行动建议标签不能隐藏内嵌断言

[含义转换v2](../development/iris-claim-meaning-20261001.md#关系合同v2结果完整转换仍未通过)
2HTTP200/6988tokens：坏风险含义有限通过；健康建议既有重复锚点执行拒绝，也把“说明
交付时间取决于联调结果”整体归为proposal/not_asserted，遗漏其中仍需依据的依赖断言。
原文字面完整、建议标签或格式修好，都不能证明事实前提已被忠实暴露。窗口FAIL，
供应商例未调用；不扩建NLP图v3。下一[受控意见计划](../development/iris-opinion-plan-20261001.md)
从生成约束验证端到端价值，正例必须有用，仍不可把结构合法当作关系真实。

## 2026-10-01：含义转换不能把因果压成时间先后

[原句转换诊断](../development/iris-claim-meaning-20261001.md)1HTTP200/2863tokens，模态
主目标正确但整图新增父句先于子句、以precedes替代因果的关系，完整忠实性FAIL。合同
未提供causes是表达缺口；错误父子端点不是被合同强制，归因分开。原文字符覆盖不能
证明含义忠实。下一步先本地验证合同可表达性和端点约束，不能加schema即声称已修复。


## 2026-10-01：内部介入价值被强制变成群聊业务正文

[修复记录](../development/iris-intervention-value-20261001.md)。canonical候选把reasoning
同时作为业务论证、why-now和materialChange.explanation，程序又将它拼入draft，导致
“首次介入/工作价值”内部说明外露。显式新合同独立必填说明并保留完整审核，生成收到
只读真实discussion。旧合同保留用于历史回放，新合同缺字段拒绝，不偷偷回填旧评估。
本地4925通过/469跳过，实模未验证；这个边界修复不等于条件下必然后果错批已解决。


## 2026-10-01：完整句来源支持检查误拒合理建议（未关闭）

[记录及四处闭环](../development/iris-claim-support-20261001.md#完整句迁移结果失败候选停止)。
639ab1c2候选6HTTP200/1973tokens，必要后果识别通过但建议被要求在来源中预先出现，
导致实际许可误拒；第五句理由仍无依据夸大概率。完整迁移FAIL，good未调用，helper
未接入。已确认本次拒绝理由混淆建议与既成事实；模型能力/提示职责等整体因果归因
仍未完成。统一支持门禁候选停止，不降验收标准、不按suggestion角色免检、不把人工
逐条审批当自动主动讨论修复。下一自动方案所需的自然语言事实预设识别忠实性仍未证明。


The complete-field transfer also failed: correct core facts were used to approve an entire
paragraph containing an unsupported necessary consequence. An isolated successful sentence
must not be promoted to a successful paragraph. The next mechanical sentence boundary preserves
all text and quotes; cross-sentence meaning remains an explicit acceptance risk, not an assumed fix.


[A conservative support-permission candidate](../development/iris-claim-support-20261001.md)
does not promote a provider's contradicted verdict into a company fact or opposite conclusion.
Both rejection categories only withhold permission. This changes the consumer obligation, not
the failed three-way classification verdict; positive controls and full-candidate transfer remain
mandatory before any runtime integration.


[The isolated-claim control](../development/iris-minimal-claim-20261001.md) still approved the
necessary consequence with only two source texts and one complete claim (1HTTP/298tokens).
Long context is not required for this observed failure. Do not generalize this single result
into universal model incapacity; preserve inputs when comparing the model factor.


Removing the second author did not prevent the original conditional-consequence error:
the direct initial opinion asserted inevitable non-delivery and full review approved it.
Keep that failed semantic window; a source-only single-claim diagnostic is a bounded attribution
control, not evidence that full-context review is now reliable.


The first direct-opinion window ended in a lexical false negative: a Chinese count tokenizer
consumed a normal clause comma in “12万，两人”. Token hardening needs ordinary punctuation
positive controls as well as malformed numeric negatives. Preserve the failed run and replay
its unchanged four responses after the boundary correction; do not resample the cost update.


## 2026-10-01: Advice can hide an unsupported premise

A cost-update opinion had correct 24/+8/14 calculations but invented a supplier relationship
inside a recommendation. Scope review approved it as advice. Recommendations do not exempt
their business premises from source grounding. The [next bounded candidate](../development/iris-assessment-opinion-20261001.md)
removes a redundant author stage, not the semantic requirement; success is still unproven.


## 2026-10-01: Separate receipt false negatives from semantic failures

[Source-focus window and count-word correction](../development/iris-source-focus-20261001.md)
produced a correct repaired arithmetic pair, but its literal receipt rejected 两人 as 2 人.
Preserve the original execution failure; repair the bounded lexical check and replay unchanged
responses before continuing uncalled cases. A successful replay is not a new live-model sample.
Count aliases must retain complete-token, sign, quote and unit boundaries; do not match a decimal
or fraction tail. Initial inferred issue descriptions also must not become evidence downstream.


## 2026-09-29: Do not ask generation to recopy locked references

A valid source hash was shortened by the model during proactive generation even though the
same reference was correct elsewhere in its response. Local rejection was correct. Once
assessment has selected and validated identity and sources, the program should retain those
immutable fields; generation and correction output editable prose only. Reject extra fields
instead of overwriting conflicting model identity. Source binding still does not prove semantic
support. [Implementation, failed predecessor and bounded acceptance](../development/iris-bound-prose-20260929.md).

The first live prose-contract window reached review, which correctly rejected invented 0/1
interface arithmetic. Its sole repair then returned a null new-issue description and described
editing the candidate as the business change. It was rejected before final review (4HTTP/11706
tokens). Removing copy obligations does not resolve semantic role confusion; do not patch the
missing description and call this a pass. Preserve this counterexample for the next bounded design.

The correction contract unnecessarily required all seven prose fields again even when review
identified one defective field. [Explicit field updates](../development/iris-repair-updates-20260929.md)
preserve unspecified text from the current generation, with complete validation and final review.
This removes compulsory rewriting; it does not prove the retained or edited content is supported.

Application a2b3c449 passed the frozen targeted correction and final review. Its fresh risk case
still had unsupported progress quantities and a deterministic conditional consequence approved
by initial review, then rejected locally for an empty number unit (5HTTP/16794 tokens total).
That failure occurred before updates. A format rejection is not semantic detection; do not relax
the unit contract or count the narrower correction success as complete proactive acceptance.

This ledger records failures that changed how Iris should be designed, tested, or released. It is
not an incident timeline. Add an entry only when it produces a reusable prevention rule or an
automated guard.

The architecture whitepaper remains authoritative. This ledger explains how to avoid repeating
delivery mistakes while implementing it.

Every bug fix must review this ledger alongside the whitepaper, requirement baseline and repository
entry, following [the four-place closure gate](../superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#112-mandatory-bug-fix-documentation-closure).
Amend an existing entry when its lesson already applies; record `reviewed-unchanged` with a reason
in the fix record when no new reusable rule is needed. Latest evidence and worktree entry:
[current handoff](../development/current-handoff.md).

## Product Delivery

### Proactive collaboration is not a deadline reminder

- **Independent prose can drift (2026-10-01 candidate):** A qualified public draft can coexist
  with an unjustified necessary consequence in separately generated internal reasoning. The
  [canonical opinion candidate](../development/iris-canonical-opinion-20261001.md) projects both
  from one body; this removes independent expansion, not the need for semantic validation.
  Six HTTP200/17924 tokens passed risk narrowly, then failed on an unsupported severe sample
  bias assertion copied into all projections and approved by review. Four controls uncalled;
  candidate stopped and default off. Consistency is not truth; bug remains open.
- **Counterexamples are hypotheses (2026-10-01 candidate):** A compatible alternative can expose
  an unsupported necessary consequence, but is not an observed company fact. Bind diagnostics
  to current original quotes, never invent positive field verdicts when scope review was skipped,
  and retain full review after the sole correction. An empty counterexample list is not approval.
  The [local candidate](../development/iris-counterexample-review-20261001.md) is default off and
  not semantically accepted; literal binding does not prove hypothetical compatibility.
  Its frozen end-to-end window (4HTTP/11011 tokens) removed invented numbers but retained an
  unsupported necessary consequence. The second counterexample list was empty and final scope
  review approved the pair. Two model checks are not independent proof of truth; preserve the
  failed complete pair and keep the candidate off instead of counting numeric repair as acceptance.

- **Receipt-duty ablation boundary (2026-09-29):** Removing numeric/advice receipt tasks while
  retaining the complete candidate and semantic requirements identified unsupported quantities,
  but missed the conditional certain consequence in that same candidate. The [one-request probe](../development/iris-review-duty-ablation-20260929.md)
  failed its frozen targets. Do not convert one correctly rejected defect or overall false into
  full semantic acceptance, or interpret duty/length/schema changes as proven causal attribution.
  Keep an unsuccessful split out of the product; do not compensate with repeated prompt variants.

- **Observed design failure (2026-09-09):** The next proactive pilot was proposed as quiet-thread
  and overdue-task reminders with a two-per-day budget and a 24-hour cooldown. The user rejected
  this: Iris should notice material problems in ongoing work and explain its own assessment;
  Feishu tasks already own deadline reminders.
- **Confirmed cause:** The existing planner has only time-based thread/action signals and
  operator-reviewed delivery. Treating that accepted historical loop as the whole proactive
  requirement hid the missing semantic decision to intervene. This is a product/design gap, not
  evidence of a newly diagnosed production outage.
- **Prevention rule:** Define participation by useful new reasoning and issue/evidence state, not
  timers or keyword matches. Allow explicitly uncertain, reasoned concerns; do not demand an
  existing Wiki answer or present professional inference as a company fact. Keep task execution
  separate and distinguish policy authorization from human approval.
- **Guard under implementation, not yet accepted end to end:** Independent exact-group event-driven assessment,
  same-issue novelty checks, pre-send correction/source/pause checks, provenance-safe follow-ups
  and durable nonduplicating delivery. The [approved direction and written design](../superpowers/specs/2026-09-09-iris-proactive-discussion-design.md)
  records the contract and four-place documentation dispositions. Its written review is complete;
  the [implementation plan](../superpowers/plans/2026-09-14-iris-proactive-discussion.md) maps the guards
  to bounded tasks and tests. Local foundation acceptance and context review findings are tracked
  in the [execution record](../development/iris-proactive-discussion-execution.md); no model or
  production acceptance is claimed. The [finite end-to-end and release record](../development/iris-proactive-discussion.md)
  now records actual non-mention ingress/PG/worker/sent-receipt/ordinary-followup and member-stop/new-issue
  gates, a synthetic-only evaluator with two distinct calls per case, and explicit CI database setup.
  The [2026-09-15 two-round real-model run](../development/iris-proactive-discussion-model-eval-20260915.md)
  reused existing server configuration in an explicitly authorized isolated model process without
  copying credentials. It failed acceptance: 23 assessment failures, one render failure, and an
  explicit numeric-difference omission in one complete answer. All seven visible decisions matched
  expectations; null assessments in decisionMismatches are missing results, not wrong decisions.
  Error-stage labels alone do not establish HTTP/parse/validation root cause; a later single HTTP 200
  does not diagnose earlier failures. Preserve safe phase/status evidence, review numeric completeness
  against the original criteria, and distinguish risk qualification in prose from structured labels.
  Deterministic fixtures and a fake HTTP provider cannot substitute for real-model quality or
  real-group feedback acceptance. Retain every failed run separately; do not rerun blindly or lower gates.
- **Model/evaluator repair evidence (2026-09-15):** The [bounded repair record](../development/iris-proactive-discussion-model-fixes-20260915.md)
  separates safe typed diagnostics from wrong decisions. Run2 confirms 21 HTTP 429 failures and two
  genuine missed interventions; it does not retroactively attribute run1's unknown failures. The
  numeric totals/differences are now explicit in the available arithmetic/update outputs, but a
  successful local regression is not semantic acceptance. Decision prompts must positively explain
  when unsupported conclusions or unverified premises behind definite commitments merit intervention;
  requiring an already-observed loss would miss preventive value. Distinguish direct arithmetic
  from inferred feasibility/outcomes throughout assessment and prose. Any evaluation request pacing
  is technical capacity handling only, not a product cooldown; retain failure results and the exact
  pacing parameter rather than retrying silently until the report turns green.
  The same-model run3 with explicit evaluation pacing had no HTTP429, but still produced two missed
  interventions, two unsupported semantic expansions and two incomplete results (24 pass / 4 fail /
  2 incomplete). Positive prompt rules alone did not establish stable behavior; retain rejected
  draft/review and bounded validation evidence inside synthetic evaluation before selecting another
  mechanism change. A qualified label cannot repair an unconditional claim, and correct arithmetic
  cannot justify changing a cost category or inventing a company approval rule.
  The [synthetic trace and stage-contract repair](../development/iris-proactive-discussion-model-trace-20260915.md)
  separates successful provider candidates from locally accepted outputs, including rejected drafts
  and both assessment attempts. Structural/reference validation is not semantic approval: downstream
  rewriting and review must check the authorized source, including errors inherited from assessment,
  rather than treating agreement with an upstream model as confirmation. Trace replay is diagnostic,
  not evidence of the model's private reasoning or a replacement for semantic acceptance.
  Run4 also exposed a serialization gap: the trigger message ID survived, but its link to the
  material ref/body did not. Derive the trigger material from its unique trusted binding, never
  from array order or an old issue description; missing/ambiguous/unavailable trigger material
  must fail before model execution. This input repair does not prove every semantic miss fixed.
  Run5 made all 30 decisions correctly but still had two semantic failures and two rejected drafts.
  A source-grounded final draft cannot retroactively validate a retained assessment. Review must
  distinguish a suggested verification step from a claim that an action or approval occurred;
  a refusal is neither automatically a safety success nor a useful delivered intervention.
  Use the retained failures for a bounded joint-review design before adding any repair loop;
  keep an explicit maximum and stop on repeated failure rather than sampling until green.
- **Joint-review closure (2026-09-16):** The [bounded pair repair](../development/iris-proactive-discussion-joint-review-20260916.md)
  makes both the real worker and synthetic evaluator consume the same reviewed assessment/draft.
  Permit one semantic correction and one final review, not separate drifting consumer loops.
  A finally rejected pair must terminate before freshness-based requeue, including concurrent
  context/catalog/issue/source changes; preserve it only as blocked audit. Mutable new-issue
  wording needs comparison with the original issue in final review, not merely unchanged refs:
  one source can contain multiple distinct problems. Fixed identifiers/references remain locally
  enforced, while semantic review itself still requires real-model acceptance. No deployment is
  implied by the regression or CI configuration; current evidence and remaining gates are in the record.
- **Contract diagnostic (2026-09-17):** Before blaming or replacing a model, hold model, input and
  settings fixed and separate direct answering, assessment and downstream review. The
  [local diagnostic and repair](../development/iris-prompt-contract-diagnostic-20260917.md) found
  missing decision/issue/material-change relations in model instructions despite stricter local
  validation, and numeric-preservation rules absent from paired correction. Make the model-facing
  contract explicit, preserve source-grounded arithmetic and treat review reasons as fallible
  diagnoses rather than authority to delete correct facts. Never repair by echoing invalid private
  output or promoting malformed silence to an intervention. Prompt-contract tests passed, but the
  fixed local case still failed after recognizing the problem because issueRef remained null;
  shape-only schemas and improved raw decisions are not end-to-end acceptance. Preserve this
  result and design the output/state boundary before another mechanism change, not repeated sampling.
- **Generation contract repair (2026-09-17):** Independent field enums admitted contradictory
  decisions even after prompt repair. [Legal generation branches and a strict envelope](../development/iris-assessment-wire-fix-20260917.md)
  fix that adapter defect without filling missing model fields or relaxing local provenance/state
  checks. Keep runtime and trace decoding aligned. Test the actual emitted schema, including
  realistic UUID catalogs: duplicated ID sets exceeded the preexisting transport byte limit and
  required shared definitions. A complete assessment/draft/review chain can still omit or misstate
  arithmetic and receive a false-positive model review; never equate structural completion with
  semantic acceptance or enable production on that basis.
- **Explicit transport compatibility (2026-09-17):** A free-provider probe returned HTTP200 but
  produced fenced JSON, omitted a required field and added an unallowed field despite a native
  schema request. The [JSON-mode compatibility repair](../development/iris-json-mode-compatibility-20260917.md)
  makes the alternative transport an explicit Core opt-in, preserves the complete schema in system
  instructions and leaves local validation/defaults/call bounds intact; no automatic downgrade or
  response cleanup manufactures success. The new-mode probe then received HTTP429 without output:
  local request-shape tests do not establish live compatibility or semantic acceptance. Retain both
  results. Local experiments also showed that a reviewer can calculate a missing value yet falsely
  claim it appears in the draft, and a correct trigger summary can still precede a wrong decision.
  These experiments were not promoted; more fields or plausible review prose are not evidence of
  correctness. Distinguish one failed subcheck from the overall verdict and stop an unsuccessful
  bounded experiment instead of extending it indefinitely.
- **Current-draft quote evidence, bounded implementation closed; semantics still open (2026-09-17):** The
  [three-case fixed-draft probe](../development/iris-json-mode-compatibility-20260917.md#草稿引用存在性原型验证与第二项狭窄修复)
  retained a model's true verdict but rejected its claimed 6-unit receipt: the real quote said only
  that a gap existed. The complete arithmetic control had valid receipts. The wrong-category
  inference had valid literal advice and an empty numeric list despite a false model verdict with
  an unreliable reason. Quote presence is not factual support or completeness; do not confuse a
  vacuous numeric list with coverage. Keep synthetic expected-value oracles outside product code.
  The initial guard also rejected a correct draft because model-generated quotes borrowed source
  and assessment wording. Preserve that real false rejection. Binding quote-generation choices to
  unchanged current-draft spans/full text or null then returned the same correct pair in one real
  HTTP200 review with no repair. The fixed missing-gap control took three HTTP200 calls: two true
  model verdicts claimed numeric evidence absent from real quotes, both were rejected, and the
  sole paired correction still omitted the gap and retained an overstatement. Final null proves
  containment and the call bound, not successful generation or full semantic repair. See the
  [retained positive/negative runs](../development/iris-json-mode-compatibility-20260917.md#当次草稿引文枚举缺差额稿仍失败并被拦截).
  Fix `42db6b6c3678802acaf0c2936c67c8640e5f540c` passed fresh Core4716/469 conditional skips,
  typecheck/build and Compose+CLI40/1 conditional skip (Docker unavailable; CLI7 passed).
  Local model service was stopped. This closes the bounded receipt integration, not the remaining
  semantic failures, cloud compatibility, deployment or real-message acceptance.
- **Subsequent private repair experiments, not promoted (2026-09-17):** [Two bounded variants](../development/iris-json-mode-compatibility-20260917.md#继续修复的两项私有实验均未推广)
  each used two fresh HTTP200 calls after replayed assessment/draft/first review. Emitting only
  seven editable fields still omitted the gap and retained an overstatement; final review listed
  only the existing two quantities, so valid literal receipts returned an incorrect pair. Preserve
  this actual false acceptance caused by an incomplete required-number list. Explicit receipt-failure
  locations likewise left the pair unchanged; its final fabricated numeric receipt was rejected.
  Neither hypothesis improved the target or changed product code, so neither positive variants nor
  repeated sampling were pursued. Receipt presence remains containment, not complete semantic coverage.
- **Later free-cloud probes (2026-09-17):** [Retained results](../development/iris-json-mode-compatibility-20260917.md#后续免费云端格式通过与算术失败或未完整分开)
  show one successful minimal JSON-format response each from officially free GLM-4-Flash-250414
  and GLM-4.7-Flash. The former then returned a structurally valid but semantically wrong skip on
  the original arithmetic case. The latter's fifth-window assessment returned HTTP429, no judgment:
  incomplete, not semantic failure. Neither reached rendering/full evaluation or was adopted.
  Stop cloud calls after the capacity refusal; retain earlier format failures, false acceptance and
  incomplete runs. Do not generalize one minimal format result into full compatibility or billing verification.
- **Numeric-review continuity (2026-09-17):** The [four-response replay and repair](../development/iris-review-continuity-20260917.md)
  reproduced the edit experiment's incorrect pair in the real render path without its private adapter.
  Final review had forgotten the first required-number list. Carry earlier diagnoses into the final
  review and locally require retained current receipts or explicit source-quoted corrections or
  withdrawals. Reject missing items, duplicate/unknown indices and fabricated evidence without
  adding calls. Do not freeze a wrong initial number as truth. Runtime/trace must share full-input
  validation; successful accounting does not prove arithmetic, complete discovery or sound withdrawal
  reasons. Fresh regression and actual-model results are recorded separately in the linked record.
- **Provider boundary and retained-assessment false acceptance (2026-09-20):** The
  [Bailian free-only evaluation](../development/iris-bailian-free-eval-20260920.md) passed a minimal
  native schema but rejected the full assessment request with HTTP400, naming array constraints;
  the actual body contained uniqueItems. Test the real emitted contract, not just a small schema,
  before calling a provider compatible. The existing explicit JSON mode preserved the complete
  schema and local validation and completed the arithmetic chain, but retained a signed subtraction
  error and an unsupported certain consequence in assessment while the correct draft received a
  positive review. Literal draft receipts do not validate every assessment claim. Preserve that
  false acceptance and stop before full evaluation; do not delete constraints or sample until green.
  The same record archives a separately observed Zhipu business code1305: retain safe response codes
  to distinguish model overload from account limits, and never invent a next-day reset from HTTP429 alone.
- **Assessment field coverage (2026-09-20):** The [bounded field-review repair](../development/iris-field-review-20260920.md)
  closes an output-contract gap: full assessment was already present in the request, but a single
  overall verdict and draft-only receipts did not require a visible judgment on each retained field.
  Require six named checks, bounded reasons and local conjunction with the overall verdict; share
  fact-versus-qualified-inference rules with assessment/repair. Missing checks are invalid, and one
  failed check uses only the existing single pair repair/final review. Trace must retain and redact
  these diagnoses. Model verdicts can still be wrong: raw replay rejection proves contract enforcement,
  not automatic semantic detection. Record live negative/qualified-positive/fresh-generation results
  separately; do not erase the earlier falsely accepted pair or expand retries until green.
- **Unverified candidate as rewrite template (2026-09-20):** First render originally generated only
  a draft, leaving incorrect assessment unchanged unless review rejected it. Generating both fields
  closed that flow limitation but the real negative control still copied the wrong subtraction and
  review falsely accepted it. The [source-first repair](../development/iris-source-first-generation-20260920.md)
  removes prior semantic prose from initial generation: preserve issue/authority structure and raw
  authorized evidence, regenerate the same pair, then review the original identity and current pair.
  Do not retain a stale internal assessment behind a correct outward answer, or call a model's true
  verdict proof. Preserve failed experiments, fresh controls and complete-suite results separately.
  Unchanged call bounds and locked references are not an automatic semantic guarantee.
- **Negative review hid a simultaneous receipt failure (2026-09-25):** In the retained
  [full-run `material-update` second round](../development/iris-source-first-generation-20260920.md#32-9月25日完整15例两轮),
  the model rejected uncertainty but supplied `requiredNumbers[2]` as `2 人` with a draft quote for
  `2 个`. Local validation returned immediately on `supported=false`, so the sole pair repair received
  no numeric failure and changed only uncertainty; final literal validation still rejected the pair.
  Application `45fe8968` and the [bounded diagnostic fix](../development/iris-review-diagnostics-20260925.md) accumulate
  independently checkable field, number, advice and continuity failures even after a model rejection,
  preserves that rejection, and caps feedback to the existing reason length. Four RED-to-GREEN tests
  and a five-file/90-test focused run cover the regression; Core4774/469 conditional skips, type/build
  and independent 69-test scope review passed locally. Do not count fuller repair instructions
  as a successful model repair or erase the original 22/30 semantic result; the other failures remain.
- **Review lacked discussion state and a prior source baseline (2026-09-25):** The old full run
  retained repeated intervention, an unsupported missing-baseline assertion and excessive review
  reasons. Initial assessment already had current discussion; generation/review narrowed to selected
  references, and review/repair lacked the read-only current discussion and prior intervention state.
  Existing-issue updates could drop the last accepted basis text. Application `a0a7f2a0` and the
  [context repair record](../development/iris-review-context-20260925.md) carry necessity context
  to both reviews/sole repair, close locked evidence over the last accepted basis and fail before
  generation when authorized text is absent. Independent review found a P1: the new presence
  check rejected multiple fragments under one ref. Aggregation now accepts and retains them,
  also correcting the earlier Map's last-fragment-only projection. Five staged RED/GREEN
  regressions, focused66, Core4779/469 conditional skips and type/build passed locally. An old
  source binding is not itself readable content; historic basis outside current items still fails
  closed. The six-case diagnostic later returned four independent passes and two incomplete
  drafts; both rejections involved numeric/unit quote receipts, with additional unsupported
  material-update content. Do not promote these local guards or erase the original 22/30 failure.
- **Literal receipts improved, but current-assessment timing and conditional certainty failed (2026-09-25):**
  Application `bdef93c0` clarified literal number/unit receipts and comparison prose, with one
  prompt-contract regression. Its [dated diagnostic](../development/iris-literal-receipts-20260925.md)
  used 16 HTTP200 calls across six original cases. Five completed at the execution layer, but
  independent semantic review passed only arithmetic, material-update, paraphrase and handled.
  Inference was wrongly rejected after two reviews treated this round's original assessment as
  historical handled opinion; qualified-risk's final assessment asserted an overcertain
  conditional consequence while review returned true. Preserve both failures and the old 22/30;
  no full-suite, live-group or deployment acceptance follows from the four passes.
- **Current evaluation was mistaken for prior handling (2026-09-25):** In the `bdef93c0`
  inference diagnostic, both reviews treated this run's original assessment as a historical
  intervention and rejected a still-current draft. Application `04aa3a09` replaces that
  model-facing prose in initial review, sole repair and final review with a locked identity-only
  target and explicit unsent-evaluation role; current assessment/draft and actual discussion
  history remain separate. The [dated record](../development/iris-review-identity-20260925.md)
  retains 11 RED failures, 90 GREEN focused tests and Core4781/469 conditional skips.
  Its seven-case run ended after 17 HTTP200 calls with inference scope-review validation failure
  and paraphrase false intervention. Independent review passed four and failed three: inference
  generated pair invented an unsupported 1–5% conversion rate and review demanded an
  uncomputable absolute-income target, qualified-risk asserted an unsupported extreme
  consequence despite six true field checks, and paraphrase ignored real prior 16/10/6 history.
  The raw report's semantic field remains pending; the dated record holds the independent
  conclusion. Removing the mistaken-history input path is verified locally, but the broader
  de-anchoring and certainty hypotheses failed this diagnostic.
- **Thinking profile did not repair the first review false positive (2026-09-25):** On unchanged
  application `04aa3a09` and exactly the original qualified-risk first-review Core body,
  `qwen3.7-plus` with thinking enabled/budget4096 returned all six fields true and locally
  accepted the unsupported extreme consequence. The bounded [profile comparison](../development/iris-review-identity-20260925.md#同应用独立thinking-profile对照负向)
  stopped after one HTTP200/5486 usage tokens (1614 reasoning tokens); four planned cases
  were not called. This is not a full five-case failure or a reason to promote thinking.
- **Private physical split still missed a negative claim (2026-09-25):** On unchanged application
  `04aa3a09`, a private [claims/draft isolation probe](../development/iris-review-identity-20260925.md#同应用私有物理隔离双面审查probe首例负向)
  sent only assessment, evidence, real discussion and evaluation role in its first claims call;
  actual wire isolation excluded draft text, draft receipts and draft schema. Despite
  `16−10=−6` in current reasoning and unsupported certain risk claims, model and local review
  returned six true fields and overall true. One HTTP200/1934 tokens then halted; five planned
  controls were never called. A preceding preflight failed before any request. This falsifies
  this private candidate's first control, not every model or all split-review architectures.
- **Hand-paired discrimination did not transfer to full immutable review (2026-09-26):** A
  private fixed-ID three-way sentence probe distinguished a sign error with hand-written
  alternatives, then failed unknown-versus-contradicted classification. The separate
  [no-alternative full-span transfer](../development/iris-immutable-review-20260926.md)
  again accepted `16−10=−6`, rationalizing it as a negative shortage; all 16 spans were true.
  Overall false came only from uncertainty labeling. Exhaustive byte binding proves which text
  was checked, not that it was understood faithfully. Require target-specific negative results
  and no-oracle positive controls; a rejection for another defect is not target repair, and
  hand-authored correct choices cannot stand in for deployment input. Stop this failed candidate
  rather than resampling it or changing its oracle. No application or production change occurred.
- **Exit condition:** Unmentioned material risks receive useful, qualified intervention; normal
  discussion stays quiet; distinct consecutive risks are not blocked by a cooldown; corrected,
  duplicate, unauthorized and stopped issues are not sent. Deterministic tests, real Postgres,
  real-model drafts and one-group real-Feishu acceptance must be recorded separately before this
  feature is declared delivered.

- **Executable arithmetic versus interpretive approval (2026-09-26):** The
  [bounded calculation repair](../development/iris-executable-arithmetic-20260926.md) adds a local
  contradiction check over unchanged explicit calculation spans in both retained assessment and
  draft. A model approving a plausible reinterpretation cannot override a detected wrong sign.
  Extraction itself needs regression: arbitrary Han labels swallowed negative signs and Chinese
  chained expressions were truncated during review; preserve these counterexamples and exclude
  ambiguous/quoted/negated grammar instead of claiming general natural-language verification.
  Exit at the existing one-repair/final-review bound; correct local arithmetic does not establish
  risk qualification, duplicate suppression or complete product acceptance. Real results and the
  remaining blockers belong to the linked record, not an ever-growing prompt search.

- **Do not universalize scenario-specific advice (2026-09-27):** A numeric-case prompt change
  told every generated opinion to verify authorization. The [bounded removal](../development/iris-advice-ablation-20260927.md)
  deletes that unconditional instruction while still allowing relevant permission checks. A
  frozen-input render improved, but a fresh inference failed because review invented zero-value
  obligations for unknown totals and kept them through final review. Unknown is not zero; a
  locally valid quote is not proof of a useful or applicable requirement. Retain the original
  semantic oracle and legitimate permission control; stop at first failed case rather than
  iterating prompt variants or weakening receipt validation. This cleanup does not establish
  review reliability; numeric applicability and other proactive defects remain open.
  The [September 29 state fix](../development/iris-unavailable-numbers-20260929.md) represents
  unavailable inputs explicitly instead of forcing a numeric placeholder into a listed item.
  Mixed states are invalid; real zero values and known-amount continuity retain their checks.
  Exit requires both unavailable-input inference and computable-budget/update controls, not
  merely schema acceptance. Local4824/469 passed/skipped. After login recovery, the bounded
  six-HTTP window returned two limited inference passes, then stopped on an incomplete budget
  draft before review; the remaining three controls were uncalled. Valid JSON and finish_reason
  stop do not establish a complete candidate: the raw/client contents matched, and output619
  was below max2048. Do not blame token exhaustion or mark known-value applicability accepted.
  Complete classification and generation reliability remain unproven.

### Preserve issue history and the actual live-context producer contract

- **Observed implementation failures (2026-09-15):** Review of unshipped Task4 candidate
  `12d1280b` found two defects: after evidence A/B was replaced by C, unchanged A could qualify as
  new evidence again; and valid live-history messages without local ingestion rows could cancel a
  stored trigger permanently. These are local review findings, not diagnosed production incidents.
- **Confirmed causes:** Novelty compared only the latest `basisSources`; aggregate local-message
  validation assumed every live context source had been ingested, although the context builder
  obtains authorized history directly from Feishu and does not establish that persistence contract.
- **Prevention rule:** Check previously consumed issue evidence using immutable history, keeping
  prompt-visible current basis bounded. Separate strict durable trigger validation from contextual
  source protection; absence of a local history row is not loss of live authorization. Known
  contextual deletion/change requires same-job reevaluation, not false trigger invalidation.
  Carry verified identity/proof fields explicitly across asynchronous ingress/feedback boundaries.
- **Locally accepted guard:** Real-PG A/B → C → unchanged A (including resolution/reopen), a stored
  trigger plus valid history-only source, and non-trigger deletion/requeue regressions. Commit,
  actual test counts and scoped review status are tracked in the
  [execution record](../development/iris-proactive-discussion-execution.md): fix `b1c6564f` passed
  60 scoped tests (42 real-PG scenarios) and typecheck; scoped review accepted both fixes with no
  new blocker. Four-place local closure is complete; no production release is claimed.
- **Exit condition:** These behavioral regressions, covering repository/worker tests and typecheck
  pass, scoped review has no open blocker, and four-place closure records the actual level. This
  does not establish final-send, runtime, model quality or real-group delivery acceptance.

### Preserve prose provenance and distinguish unattempted work from completed effects

- **Observed local review failures (2026-09-15):** Original issue descriptions outlived their
  cited source bindings; uncited exposures disappeared from reused prose. A stale first draft
  consumed its evidence despite zero send attempts. Three successful 25-second model calls
  exhausted a fixed 60-second lease, and enabled startup acknowledged events before registration.
- **Confirmed causes:** One current-basis projection served two different provenance/novelty
  contracts; preparation was treated as a completed intervention; leases had no renewal; the
  enabled registrar returned success while no delegate existed.
- **Prevention:** Bind all surviving derived text to full exposure lineage and reject unknown
  legacy prose. Prove the narrow first-unattempted exception from immutable delivery/lifecycle
  history in the repository. Renew only unexpired owned work, check between internal model calls,
  and preserve retryable registration errors without blocking ordinary answer processing.
- **Guard/exit:** Actual model payload and PG delivery provenance, cancelled-first → reassessment
  → one send, attempted/unknown/stopped/resolved negatives, PG lease CAS plus injected clock and
  real default heartbeat, delayed app startup → raw queue replay → one ordinary reply and one
  stop registration. See the [fix/acceptance record](../development/iris-proactive-discussion-final-fixes.md).
  Local tests and four-place closure plus scoped review close these findings; real-model and
  single-group acceptance remain separate. Retain prior failures and the finite catalog backlog.

### Keep stored-event hashes separate from full live-source hashes

- **Observed implementation failure (2026-09-14):** Review of the unshipped proactive context
  candidate `9f9f51a0` found that an unchanged long human message could register successfully but
  always return no live context. This is a local review finding, not a diagnosed production incident.
- **Confirmed cause:** The conversation repository stores a bounded body with a truncation marker;
  registration hashes that stored representation. The context builder directly compared it with
  the complete live body hash. The original long-message test hand-built the full live hash into
  the job, bypassing the real producer contract and hiding the mismatch.
- **Prevention rule:** Keep registration/freshness identity separate from live evidence identity.
  Reuse the actual storage representation when comparing an event hash; hash full fresh evidence
  before prompt clipping. Do not duplicate an approximate truncation rule or weaken changed-source
  checks to make a test pass.
- **Guard and evidence:** Production-shaped persistence → registration → fresh-context regression,
  covering both unchanged long content and genuine changes; fix commit and actual acceptance are
  recorded in the [execution record](../development/iris-proactive-discussion-execution.md).
  Fix `4ec806d6` passed focused regression/typecheck and scoped re-review. The new production-shaped
  regression uses the real repository normalization with mocked database I/O; it is not real-PG proof.
- **Exit condition:** An unchanged long trigger produces context with its full live binding, stale
  or changed evidence remains rejected, focused regressions/typecheck pass and scoped re-review
  accepts the fix. This does not establish model, runtime, or real-group delivery acceptance.

### A working discussion is not required to become formal knowledge before it can be shared

- **Observed gap:** In the pilot, Iris could describe material in its source group but could not
  answer another pilot group's question unless the content had entered the separately governed
  document-sharing path. Users expected ordinary discussion to be available across their working groups.
- **Confirmed cause:** Raw-chat retrieval and assistant context were restricted to the current
  chat. The single-document grant intentionally did not grant raw chat; this is a newly approved
  product boundary, not evidence that the document permission guard was broken.
- **Prevention rule:** Keep a versioned, explicitly approved working-chat audience separate from
  formal Wiki publication. Do not require per-message publication inside that audience, and do not
  infer sharing from bot membership. Attribute discussion to its source group/time.
- **Implemented guard:** Scope-aware fresh retrieval, global budgets, all-exposed-message
  provenance, and durable send/revoke checks; an Iris rewrite cannot launder an old shared answer
  into source-free text. Tests, commits and acceptance status are tracked in
  [shared working-chat](../development/iris-shared-working-chat.md).
- **Exit condition:** Ordinary A-group discussion is answerable in participating B without a Wiki
  write; outside C remains isolated; revoke/delete/changed-text and rewrite-chain gates pass. This
  entry defines the gate; its dated code, CI and production outcomes live in the linked record.

### Check the outer message transaction when adding cross-source send locks

- **Discovered risk:** The existing processor held its incoming-message replay transaction while
  awaiting the whole answer. Two groups asking simultaneously and citing one another can hold
  different incoming locks while a new shared-scope send waits on both; application-level waits
  can hide the complete cycle from PostgreSQL's deadlock detector.
- **Prevention rule:** Ordinary receipt-backed generation runs outside that outer transaction.
  Prepare/send recheck the incoming tombstone together with external sources using one sorted
  lock set. Legacy commands and fallback effects keep their prior deletion protection. Deferring
  work must not strand an in-memory dedupe claim if the outer commit fails.
- **Finite gate:** Real processor/responder/receipt reciprocal-group concurrency, revoke-vs-send,
  and source/incoming-delete-vs-send tests must pass on PostgreSQL. Unit tests or skipped database
  cases do not prove the lock boundary. Implementation and actual gate status are recorded in
  [the shared-chat record](../development/iris-shared-working-chat.md); no production incident
  is inferred from this design review finding. Exact-candidate CI subsequently
  passed all nine real-PG concurrency/provenance cases, including persisted two-step rewrites;
  that does not claim a real Feishu send or a production race was exercised.

- **2026-09-15 local extension:** Proactive Task 5 SQL RED showed ordinary source `FOR SHARE`
  still allowed a concurrent snapshot INSERT's FK `KEY SHARE` after the old snapshot check.
  `30f75a98` takes sorted source `FOR UPDATE` before grants, preserving the existing writer
  order; remote reads/sends stay outside transactions and passive behavior is unchanged.
  Both snapshot-first and send-first races passed, plus the existing passive revoke/send case.
  [Task 5's record](../development/iris-proactive-discussion-execution.md#task-5-发送门禁与结果未知本地审查通过)
  distinguishes actual SQL RED/GREEN, scoped review, fixture timeouts and old pg warnings.
  This is a pre-release concurrency fix, not evidence of a production failure or deployment.

- **Local lineage extension:** `1071dfc3` carries full local bindings through real sent receipts,
  two ordinary persisted rewrites and source revalidation. Its SQL RED also found that the
  existing unresolved-send deletion query omitted new local traces; the same exact chat/message
  conflict now covers them. Mixed local/shared IDs use one sorted lock set, with no-source legacy
  behavior preserved. The actual two-rewrite PG and reciprocal deletion/runtime cases passed;
  [Task 6's record](../development/iris-proactive-discussion-execution.md#task-6-连续追问的完整来源本地审查通过)
  retains the failed attempts and compatibility boundaries. Production runtime wiring remains
  Task 7, not implied by successful dependency-injected integration tests.

### Do not confuse hardening with product completion

- **Failure:** Work continued through increasingly narrow robustness checks while whitepaper core
  capabilities were still missing, making a partially implemented product look nearly complete.
- **Root cause:** Quality gates had no explicit exit condition and there was no coverage baseline
  mapping shipped behavior to the whitepaper.
- **Prevention rule:** Fix P0/P1 blockers, then move to the next missing core capability. Put P2/P3
  hardening in the backlog.
- **Guard:** Keep the core-requirement coverage baseline current and require each feature plan to
  name its acceptance gate and next product capability.
- **Exit condition:** The agreed tests and one bounded real pilot workflow pass with no unresolved
  P0/P1 finding.

### Consolidate a validated frontier before stacked PRs hide the release state

- **Failure:** Iris production ran a reviewed descendant more than 400 commits ahead of `master`
  while over twenty stacked Draft PRs remained open. Individual checks were green, but a new
  developer could not determine the authoritative base without reconstructing the entire branch
  graph.
- **Root cause:** Each completed phase opened the next stacked PR, but no release gate required the
  exact deployed tree to return to the default branch after the product loops passed.
- **Prevention rule:** Once a descendant has full CI, exact-SHA production evidence, and no
  unresolved P0/P1 finding, open one consolidation PR from that exact tree to `master`. Preserve
  history with a merge commit, then close only old PRs whose exact heads are contained in the new
  default branch. Review independent sibling branches separately; never merge them just to empty
  the queue.
- **Guard:** Compare tree hashes between the deployed commit and the consolidation head, rerun CI
  against `master`, and prove every superseded PR head is an ancestor of the merged default branch.
  Keep conflicting alternate migrations closed with their still-useful gaps recorded as backlog.
- **Exit condition:** `master` contains the validated product tree, the production tree comparison
  is exact, no obsolete stacked PR remains open, and new work can branch directly from `master`.

### Activate coupled runtimes as one rollout unit

- **Failure:** A daily-pilot rollout enabled proactive planning and delivery without enabling the
  knowledge-card feedback runtime required by delivery. Core correctly refused startup. A later
  operator gate also read approval-interaction counts from the response root instead of its
  `queue` object, causing a second unnecessary fail-closed recovery.
- **Root cause:** The one-off rollout command duplicated configuration dependencies and response
  schemas instead of treating the deployed runtime contract as one unit.
- **Prevention rule:** Stage knowledge cards, planner, and delivery together with the same exact
  group allowlist. Verify the enabled component shape before changing durable runtime state, and
  read queue counters only from their canonical nested objects.
- **Guard:** Core startup rejects proactive delivery without a covering knowledge-card allowlist;
  every bounded opening keeps Caddy stopped until `/internal/status` proves both proactive workers
  running, then uses an expiring fail-closed timer around runtime activation. Any failed assertion
  invokes the checked-in autoclose script and recreates Core from the disabled environment.
- **Exit condition:** The three runtimes are healthy for exactly one group, one reviewed delivery
  is single-attempt `sent`, all canonical queue/DLQ counters are zero, public boundaries pass, and
  the fail-closed timer is explicitly cancelled only after those gates.

### Bind maintenance commands to the exact release context

- **Failure:** A backup script invoked from an immutable release silently used its historical
  `/opt/iris/repository` defaults. That checkout had an older image tag and stale feature flags, so
  fail-closed cleanup recreated Core from the wrong image and stopped public ingress. A subsequent
  correct backup also exceeded the generic 30-second Compose command timeout during `pg_dump`.
- **Root cause:** The command location, repository directory, environment file, Compose file, backup
  directory, and long-running snapshot timeout were treated as independent implicit defaults even
  though an exact-SHA release requires them to be one deployment identity.
- **Prevention rule:** Run release maintenance only with an explicit, matching release root,
  environment file, Compose file, durable backup directory, and a measured snapshot timeout. Never
  infer the active image from a mutable checkout or from the caller's current directory.
- **Guard:** Keep Caddy closed until the running Core image ID matches the approved immutable tag,
  private readiness is green, durable runtime and capabilities are disabled, unresolved action
  counts are zero, and a fresh encrypted backup passes size, mode, and age-header checks. Treat a
  maintenance timeout as fail closed and independently verify Core before retrying.
- **Exit condition:** The exact candidate is healthy, public `/health` is `200`, public
  `/internal/status` is `404`, the new encrypted backup is verified, and no maintenance process is
  still running.

### Release containment must survive its own cleanup failure

- **Observed defects:** Review of the 2026-09-09 release helper found that an unguarded Caddy-stop
  failure under `set -e` would exit its error handler before the independent Core-stop fallback.
  Separately, the production pre-migration gate caught `git apply` recreating `.env.pilot` as
  mode664 after it had been tightened to600. The entry remained closed and the old image was
  still running; this was a deployment-helper failure, not an application or sharing-policy failure.
- **Prevention rule:** Disable errexit inside bounded cleanup, attempt independent containment
  fallbacks, handle ERR/HUP/INT/TERM, and verify the final stopped/disabled state explicitly.
  Read-only preflight failures must not mutate runtime. Use a restrictive umask when replacing
  secret-bearing files and recheck their permissions after replacement, not only before it.
  Inspect backup retention targets before invoking a maintenance backup. When a release must
  preserve existing archives, use a fixed validated release subdirectory without old retention
  targets, while also holding the normal parent backup lock; changing the output directory must
  not silently allow concurrent default snapshots. The 2026-09-09 v3 preflight caught an archive
  aging into retention before any runtime mutation; the bounded directory/lock adjustment was
  independently reviewed and the old archive remained present after the new paired backup.
- **Guard:** Independently reviewed helper traps; a local Bash failure reproduction; remote
  syntax checks; exact regular-file/owner, mode600, configuration-patch and image checks before
  migration. Resume only from the observed partial stage, without replaying approvals or business writes.
- **Exit condition:** Containment is proven, file mode is600, the exact candidate resumes through
  migration and private health gates, and the dated release record preserves the interrupted step.

## External Providers

### Treat model capacity and latency as runtime state, not a code hypothesis

- **Failure:** Gemini checks returned rate limits, provider timeouts, and invalid responses across
  different windows. Repeated probes could consume quota without creating new evidence.
- **Root cause:** Provider availability was initially mixed with application correctness.
- **Prevention rule:** Perform at most one bounded probe in an approved window. Classify the real
  upstream status without storing response bodies, then stop on any non-success.
- **Guard:** Shared cooldowns, bounded timeouts, redacted provider status logs, and fake-provider
  tests for 429/5xx/timeout behavior.
- **Exit condition:** A single probe succeeds; application acceptance then runs separately and does
  not infer correctness from provider availability alone.

### Migrate embedding profiles without deleting the recovery trail

- **Failure:** A complete wiki scan exhausted Gemini's shared `embed_content_free_tier_requests`
  quota at 100 embedding requests. Changing Gemini embedding model names did not create a separate
  quota, and a rushed profile migration risked deleting the only evidence for old-profile reindex
  failures.
- **Root cause:** The remote quota metric was shared, while model-specific vector dimensions make
  profiles incompatible retrieval inputs. The first local candidate, Qwen3 Embedding 0.6B, then
  required 54-70 seconds for one real 1,200-character Chinese chunk on the 2-core pilot VPS; the
  64-item index batch exhausted the 30-second client deadline and created repeated DLQs.
- **Prevention rule:** Use the private Ollama `embeddinggemma:300m-qat-q4_0` service only for
  embeddings, require its full stored model-manifest SHA256 before Core starts, select
  `openai-compatible:embeddinggemma:300m-qat-q4_0:768`, and preserve the prior-profile fragments.
  Apply EmbeddingGemma's asymmetric document/query prefixes, index in batches of four with a
  60-second request deadline, and record old-profile DLQ evidence before deleting an unreplayable
  entry. Re-plan latest successful snapshots in bounded 100-item requests until the profile planner
  returns zero.
- **Guard:** Compose verifies the full manifest in both seed and runtime paths; the rollout
  procedure requires the active profile, zero queues/DLQs, a live Feishu permission check, and a
  unique Life Engine retrieval marker before ingress.
- **Exit condition:** Every latest successful snapshot has the selected profile's fragments, the
  private retrieval marker passes with live permission, and the legacy fragment/DLQ evidence remains
  available for rollback.

### Keep one migration in one target execution context

- **Failure:** The local-embedding bootstrap was converted to Ubuntu Bash, but later DLQ, reindex,
  coverage, and retrieval steps still used undefined PowerShell variables. The memory processing
  gate also queried a Redis sorted set with `LLEN`.
- **Root cause:** Review stopped at the first executable block instead of tracing the complete
  operator workflow and checking each queue key against its repository implementation.
- **Prevention rule:** Ship one canonical target-native migration entrypoint. Keep bearer-token
  access inside Core, and derive every direct Redis command from the queue's actual data type.
- **Guard:** Compose contracts reject mixed PowerShell in the Ubuntu migration section, syntax-check
  the Bash entrypoint, require exact model/profile gates, and require `ZCARD` for memory processing.
- **Exit condition:** The same script performs backup, evidence capture, bounded reindex, coverage,
  private retrieval, and fail-closed cleanup on the VPS with all 13 counters at zero.

### Bound transient answer-model retries without multiplying the deadline

- **Failure:** Authorized retrieval, live Feishu permission checks, and prompt assembly all
  succeeded, but `gemini-3.5-flash` returned HTTP 503 high demand and the internal answer endpoint
  failed before producing the exact requested marker.
- **Root cause:** The selected answer model was temporarily capacity-constrained, while the
  OpenAI-compatible adapter had neither a transient retry nor a model-compatible exact-output
  prompt for the available Gemini 3.6 model.
- **Prevention rule:** Select the answer model through configuration, omit deprecated sampling
  controls, and retry at most once only for HTTP 408/500/502/503/504 or a fetch transport failure.
  Never retry quota or permanent client errors. Treat the configured timeout as one total budget
  across the initial request, backoff, and retry.
- **Guard:** Deterministic tests cover every retryable status, 429 and 401 non-retry behavior,
  malformed error bodies, final transport-error identity, remaining timer duration, timer cleanup
  before backoff, and exact-value prompt policy.
- **Exit condition:** Local and CI verification pass, the internal authorized-document request
  returns exactly the requested marker through `gemini-3.6-flash`, one bounded Feishu pilot answer
  passes, and production is restored to a verified fail-closed state after evidence is recorded.

### Make timeout tests deterministic

- **Failure:** A streaming timeout test intermittently observed zero or one chunks on Windows even
  though production's wall-clock timeout wrapped the complete request.
- **Root cause:** The test expected scheduler-dependent progress inside an unrealistically small
  total time budget.
- **Prevention rule:** A timeout fixture must synchronously yield one known chunk and then wait
  forever; the assertion should prove the deadline interrupts the active stream.
- **Guard:** Repeat the focused timeout test enough times to expose scheduling flakes before the
  full suite.
- **Exit condition:** The focused test is repeatable and the full AI suite passes without relaxing
  the production deadline.

## Feishu Boundaries

### Require a postcondition for browser and OpenAPI writes

- **Failure:** Browser automation reported successful clicks on Feishu's visual `New` card, but no
  document, menu, navigation, or new tab appeared. The application-level document-create request
  was separately rejected with Feishu code `99991672`, and no document was created.
- **Root cause:** The visual card is a non-native interactive container whose automation result
  does not prove that Feishu accepted the action. The Iris application also does not currently
  hold a document-create scope, so the service API is not an equivalent fallback.
- **Prevention rule:** Treat every external write as incomplete until its domain postcondition is
  observed. Do not retry an unchanged permission denial. For an employee-submission acceptance,
  prefer a human-created, explicitly shared fixture instead of widening application permissions
  only to manufacture test data.
- **Guard:** Check for the new canonical document URL or API object before recording success,
  record only the bounded provider error code, and keep Iris fail-closed while awaiting the
  fixture.
- **Exit condition:** A genuinely new document exists, was not previously registered, and is
  explicitly shared with Iris before the bounded submission window opens.

### Acknowledge callbacks before doing expensive work

- **Failure:** Any filtering, model work, or slow dependency on the callback path risks crossing
  Feishu's retry deadline and creating duplicate events.
- **Root cause:** Ingress acknowledgement and asynchronous processing were not treated as separate
  reliability boundaries.
- **Prevention rule:** Authenticate, validate a bounded envelope, enqueue idempotently, and return
  HTTP 200. Perform signal extraction and external work in workers.
- **Guard:** Queue idempotency keys include the Feishu event/message identity, and callback tests
  cover retries.
- **Exit condition:** Duplicate delivery produces one durable job and no duplicate user-visible
  effect.

### Bind card actions to the exact sent delivery

- **Failure:** A stale or replayed card action could otherwise mutate a newer candidate or reveal
  whether an unrelated user is a group member.
- **Root cause:** Actor membership alone does not prove that the action belongs to the displayed
  delivery and entity version.
- **Prevention rule:** After the runtime and bot checks, validate delivery, candidate, group,
  message, and entity version before any membership network call or mutation.
- **Guard:** Repository binding checks, double runtime gates, current-membership checks, and
  idempotent feedback events.
- **Exit condition:** Stale bindings fail closed without membership I/O or state mutation.

### Expect transient and stale approval cards

- **Failure:** Feishu card operations returned transient or stale-card errors such as `200080` and
  `200341`; retrying an old card was not equivalent to acting on the current proposal.
- **Root cause:** Interactive cards are versioned external state and can outlive their current
  server-side review session.
- **Prevention rule:** Reissue a fresh card after stale-state failures, preserve idempotency, and
  revalidate proposal/session context on every action.
- **Guard:** Exact proposal-version binding, replay-safe callbacks, bounded retries, and
  user-visible replacement cards.
- **Exit condition:** Only the current card can change the current proposal, and repeated actions
  do not duplicate the effect.

### Diagnose card interaction errors from server evidence

- **Failure:** A real proactive-feedback click showed Feishu client code `200080` and created no
  feedback event.
- **Root cause:** The operator clicked after the bounded gray window had expired. The fail-closed
  timer had already stopped Caddy and disabled Iris, so the callback could not reach Core. The
  client code alone did not distinguish that transport closure from a stale card or application
  rejection.
- **Prevention rule:** Before changing callback code or reissuing a card, correlate the click with
  the gray-window deadline, Caddy state, callback diagnostics, queue state, and durable event
  count. Reopen a new bounded window only after proving the previous window closed cleanly.
- **Guard:** Every real card acceptance records its open and automatic-close deadlines, keeps the
  planner disabled, and verifies the public boundary plus empty queues before asking for the
  human click.
- **Exit condition:** The exact callback is durably recorded, its queue and DLQ drain to zero, and
  the same bounded cleanup restores global, group, capability, environment, and ingress state.

### Recheck mutable safety state immediately before an external side effect

- **Failure:** An active suppression could be created after a proactive delivery was claimed but
  before its Feishu card was sent, allowing one reminder the group had just marked irrelevant.
- **Root cause:** Suppression was checked during candidate creation and queue claim, but those
  checks did not authorize a later network side effect.
- **Prevention rule:** Make the final database authorization the last database operation before
  external send. Follow it only with one synchronous runtime gate, then invoke the external
  client immediately. The authorization must atomically cancel the claimed delivery when
  suppression now applies.
- **Guard:** Three-state authorization (`authorized`, `suppressed`, `stale`), a real PostgreSQL
  claim-to-feedback race regression required by CI, and dispatcher tests proving suppression or
  a runtime disable during authorization never calls Feishu.
- **Exit condition:** Feedback committed before final authorization changes the delivery to
  `cancelled`, clears its lease, and makes every later authorization stale.

### Preserve explicit intent across same-event document discovery

- **Failure:** A real `@Iris` document-submission command synced and indexed successfully, but the
  final source type was `group_visible_document` instead of `user_submitted_document`.
- **Root cause:** Mention handling registered the explicit user submission first. Generic link
  discovery then observed the same URI in the same Feishu message and applied the normal
  group-over-user source priority, treating a mechanical duplicate as independent evidence.
- **Prevention rule:** Attach group/message provenance to in-chat submissions. Keep user-submitted
  type and defaults only when every group observation is paired with an explicit submission from
  the exact same URI, group, and message. Any independent group observation resumes normal source
  precedence.
- **Guard:** Order-independent in-memory and real PostgreSQL tests, retry idempotency tests, a full
  Feishu event-chain regression, and pilot postconditions for source type, both evidence rows, and
  `canUseForKnowledgeDrafts=false`.
- **Exit condition:** One bounded real submission produces one canonical user-submitted source,
  exactly one user-submission and one same-message group evidence row, healthy sync/index state,
  and no pending or dead-letter work.

### Distinguish document commands from questions about documents

- **Failure:** A real question containing the noun phrase `用户提交文档` was treated as a new
  document-submission command and replied by asking for a link.
- **Root cause:** The Chinese intent pattern matched any occurrence of `提交文档`, without requiring
  an imperative cue or an explicit demonstrative such as `这个文档`.
- **Prevention rule:** Command routing must require command-shaped language. Ordinary questions
  that merely describe a user-submitted document stay on the answer path.
- **Guard:** A regression uses the exact failed sentence, while the existing explicit Chinese and
  English submission-command cases continue to bypass the answer model.
- **Exit condition:** The focused responder suite, full Core suite, typecheck, build, exact-SHA CI,
  and one real Feishu question all pass; the real answer is the target document marker.

### Verify automatic-close timers as runnable safety controls

- **Failure:** Invoking the automatic-close script directly depended on its executable bit, so a
  timer could be scheduled without a runnable command.
- **Root cause:** The deployment treated a checked-in shell script as an executable program rather
  than explicitly selecting its interpreter.
- **Prevention rule:** Schedule the script through `/bin/bash`, verify the timer is active before
  opening ingress, and independently restore fail-closed state immediately after the test.
- **Guard:** The bounded window records the transient unit, checks its active state, and verifies
  global, group, capability, Caddy, and queue state after manual cleanup.
- **Exit condition:** The timer command is runnable, cleanup succeeds before expiry, no timer
  remains, and every fail-closed invariant is rechecked.

### Serialize leases and suppression at the final delivery boundary

- **Failure:** A worker with an expired lease could still authorize a reminder, while a concurrent
  irrelevant-feedback transaction and candidate insert could both commit without observing the
  other's suppression state.
- **Root cause:** Final authorization checked worker ownership but not lease expiry under a row
  lock, and suppression writes shared no transaction lock with candidate registration.
- **Prevention rule:** Revalidate ownership and unexpired lease while locking the claimed delivery.
  Serialize suppression and candidate insertion with sorted, group-scoped transaction advisory
  locks.
- **Guard:** Real PostgreSQL tests force lease expiry and interleave the two transactions; SQL
  contract tests require the lease predicate and delivery row lock.
- **Exit condition:** Expired workers receive `stale`, suppression committed first prevents a
  pending candidate, and all focused tests pass against PostgreSQL.

## Data And Memory

### Recheck permissions at answer time

- **Failure:** A document may remain indexed after access is revoked indirectly through a parent
  folder or group membership change.
- **Root cause:** Webhook and local fact-layer state can lag behind Feishu's effective permission.
- **Prevention rule:** Revalidate every retrieved document with the live permission guard before
  fragments reach the model. Denial is a normal security outcome, not a retriable model error.
- **Guard:** Source-policy retrieval, content-free permission audit records, and revoked-access
  regression tests.
- **Unshipped implementation finding (2026-09-15):** The new proactive factory reused a permission
  verifier that normalized bindings but did not itself prove an ordinary latest snapshot or exact
  database grant. Actual synthetic-transport/real-PG tests exposed revoked document text and restored
  issue prose to the model; source sync/Wiki capability changes during remote permission also
  required fresh eligibility checks. The PD-only wrapper now verifies exact successful snapshots,
  grants, current source eligibility and runtime read gates around the live probe, including
  persisted derived premises. This does not relax ordinary Q&A or claim remote atomicity.
  Candidate `ab0f7dfe`, meaningful failed/passed factory cases and independent review status are in
  the [execution record](../development/iris-proactive-discussion-execution.md). Do not treat an early
  fixture rejection before its intended revocation as proof of that revocation scenario.
- **Exit condition:** Revoked content is absent from the prompt and cannot be reconstructed from a
  different source.

### Pace live permission probes instead of bursting Feishu

- **Failure:** Indexed knowledge-base fragments were present, but one answer-time guard launched
  several unique wiki permission probes together. Feishu returned HTTP 400 with code `99991400`
  (`request trigger frequency limit`), so every affected fragment was correctly excluded and the
  answer failed closed.
- **Root cause:** Per-answer document deduplication still used concurrent external checks, while the
  wiki-node endpoint allows 100 calls per minute and docx metadata allows 5 calls per second. HTTP
  400 is also a valid legacy rate-limit envelope.
- **Prevention rule:** Serialize process-local external permission probes with at least 650 ms
  between starts, coalesce only simultaneous checks for the same source, and never cache the
  completed authorization result.
- **Guard:** Deterministic tests prove one in-flight external request, exact probe spacing, and
  same-source request coalescing while existing denial, timeout, and error tests remain fail closed.
- **Exit condition:** A private Life Engine answer records the exact source as allowed, retrieves its
  marker, produces no new `permission_guard_error`, and leaves all queues and DLQs at zero.

### Separate retrieval authorization from answer generation failures

- **Failure:** A real user-submitted document synced and indexed correctly, but a later internal
  answer-draft request returned only the generic `answer_draft_failed` response.
- **Root cause:** The public error envelope intentionally hides whether context retrieval,
  permission checking, or the model provider failed, so the response alone cannot identify the
  failed boundary.
- **Prevention rule:** Validate the durable source, evidence, snapshot, fragment, and deployed live
  permission checker independently before classifying the failure. Do not retry the model merely
  to discover which earlier boundary passed.
- **Guard:** Content-free boundary diagnostics, a single live permission-check invocation, empty
  queue/DLQ checks, and an explicit residual entry for the unanswered provider/runtime failure.
- **Exit condition:** The document gate is accepted only for the boundaries proven by evidence;
  answer/citation remains open until a later bounded request succeeds and is independently
  observed.

### Isolate semantic replay evidence

- **Failure:** Reusing partially processed markers or replaying several semantic events together
  polluted inspection and could make later operations reference entities that were never created.
- **Root cause:** Append-only history and batch extraction made acceptance state ambiguous.
- **Prevention rule:** Use a fresh isolated group/marker and replay one event at a time in original
  order, waiting for each queue state to settle before the next.
- **Guard:** Inspector checks for lifecycle, owner, evidence, version, uniqueness, control-group
  isolation, and empty queues/DLQs.
- **Exit condition:** The complete lifecycle is reproduced once with no duplicates or unrelated
  data.

### Do not confuse a Wiki page anchor with the whole knowledge space

- **Failure:** Iris reported that an authorized Feishu knowledge space was available, but only the
  page whose URL was registered and its two descendants were indexed. Sibling top-level trees,
  including the material needed for a real question, were invisible.
- **Root cause:** The registered page token was used both to resolve the authoritative `space_id`
  and as the traversal boundary. A Feishu knowledge-space overview can show several sibling
  top-level trees, so one visible page is not necessarily the space root.
- **Prevention rule:** Treat a submitted Wiki page only as an authorization anchor. Resolve its
  `space_id`, enumerate every top-level node, then traverse all same-space trees. If the anchor is
  readable but whole-space enumeration is denied or empty, fail closed instead of reporting a
  successful partial scan.
- **Guard:** Client request-shape coverage for parentless top-level listing, scanner regressions
  with an anchor plus sibling tree, safe classification for Feishu error `131006`, and an empty
  top-level result regression.
- **Exit condition:** A real scan registers all supported pages visible in the authorized space,
  includes siblings of the anchor, remains idempotent on rescan, and returns every document/reindex
  queue and DLQ to zero.

### Select the latest snapshot before applying content eligibility filters

- **Failure:** A whitespace-only latest snapshot could be planned forever, while a latest snapshot
  containing only ordinary spaces could make the planner fall back to an older non-empty body and
  reindex stale content.
- **Root cause:** The missing-profile query filtered body text before `DISTINCT ON`, and PostgreSQL
  `btrim` did not match the indexer's JavaScript whitespace semantics for tabs and newlines.
- **Prevention rule:** Select each source's latest successful snapshot first. Apply source
  authorization and a POSIX-whitespace body gate only to that selected row, and use the same SQL
  ordering in migration coverage checks.
- **Guard:** A real PostgreSQL regression creates older non-empty versions followed by latest
  `"\n\t"` and `"   "` versions; neither source may be planned and neither old body may reappear.
- **Exit condition:** The repository regression, migration contract test, full verification, and
  independent review all pass on the same working tree.

### Do not treat Feishu-native recommendations as Iris retrieval evidence

- **Failure:** A `相关知识` link rendered below an Iris reply was interpreted as proof that Iris had
  retrieved the linked Feishu knowledge page.
- **Root cause:** Feishu's chat client can add its own knowledge recommendation independently of
  Iris. The decoration is visually adjacent to the bot reply but is not part of Iris's answer,
  source trace, or citation pipeline.
- **Prevention rule:** Validate Iris retrieval from durable source, snapshot, fragment, live
  permission-guard, and bounded unique-marker evidence. Never use Feishu-native recommendations,
  previews, or search decorations as Iris acceptance evidence.
- **Guard:** The wiki-space runbook labels client-native UI separately and states that the current
  release has neither durable per-answer source traces nor Iris-owned citation rendering.
- **Exit condition:** A bounded unique-marker test can prove the retrieval loop while durable
  source-level trace and citation acceptance remain explicitly open. Client-native `相关知识` is
  ignored.

### Propagate initial permission denials into durable answer delivery

- **Failure:** A revoked Wiki page was correctly denied before prompt assembly and removed from the
  source trace, but Iris still sent an ordinary answer based on lower-ranked backfill fragments.
  The reply was recalled during incident containment. The recalled body could not be recovered, so
  there is no evidence that the revoked marker itself was emitted.
- **Root cause:** `DocumentRetrievalContextResult.deniedDocumentIds` stopped at the answer
  orchestrator boundary. The mention responder passed only allowed source traces to the durable
  delivery service, whose later permission check could therefore see only sources already allowed
  into the prompt.
- **Prevention rule:** Preserve answer traces as prompt-only facts, propagate prompt-ranked denied
  IDs on a separate bounded field, and atomically transition preparation to `permission_blocked`
  in the same PostgreSQL transaction. Never invent a trace for denied content and never let
  lower-ranked backfill make that answer sendable. Treat denied IDs as monotonic idempotency facts:
  a concurrent replay may upgrade only an unsent prepared delivery even when the blocked candidate
  has a different semantic fingerprint, but it must preserve the stored answer fingerprint and
  source facts. Exact denied facts reuse the ledger, and changed denied facts conflict after the
  block is recorded. Skip the model/provider entirely when the original prompt-ranked window
  contains any denied source so provider fallbacks cannot bypass the block. Before resuming an old
  unsent receipt, rerun only prompt retrieval and permission inspection; never regenerate its
  answer.
- **Guard:** Retrieval-window, responder propagation, delivery-service, receipt-ledger, and real
  PostgreSQL regressions prove zero answer attempts, cross-instance prepared-to-blocked upgrade
  despite a changed blocked placeholder, exact replay without duplicate events, changed-denial
  conflict after blocking, and safe-notice-only behavior. Delivery tests prove a source-less old
  prepared receipt is re-inspected and blocked without another answer-model invocation. When replay
  denial IDs overlap or mix with persisted traces, derive one provenance class from the persisted
  prompt order so source counts and ledger validation cannot roll back the safety transition.
  A permission event must contain either prompt-trace IDs or external preflight-denied IDs, never a
  mixture. Reconciliation events remain restricted to persisted prompt traces. Runtime tests also
  prove zero model invocations and zero provider lifecycle events for prompt-ranked denial.
- **Exit condition:** The corrected exact-SHA build passes CI and internal repository acceptance;
  a fresh real Feishu message after revocation produces only the safe notice, a blocked receipt,
  and zero answer-send attempts.

### Drain in-flight work before an automatic acceptance shutdown

- **Failure:** A stale automatic-close timer recreated Core while a real Feishu event was still in
  processing, making the incoming event temporarily disappear from normal inspection and obscuring
  the actual permission-delivery defect.
- **Root cause:** The timer controlled service lifecycle without first closing ingress and waiting
  for the bounded in-flight queue to settle.
- **Prevention rule:** Before every gray run, enumerate and remove stale acceptance timers. A new
  shutdown must disable public ingress first, wait for processing to reach zero within a bounded
  deadline, then stop or recreate Core.
- **Guard:** Timer inventory is part of preflight and cleanup; queue processing is checked before
  any service recreation. This reliability follow-up stays separate from the permission fix.
- **Exit condition:** The next real gray run completes or safely returns its event to retry before
  shutdown, with no stale timer and all queues/DLQs at zero.

### Keep stale chat topics out of document retrieval queries

- **Failure:** A new question that depended only on the current group discussion was blocked by an
  unrelated revoked acceptance fixture from an older topic. The live permission guard prevented
  disclosure and sent only the safe notice, but Iris could not answer the valid current question.
- **Root cause:** The answer prompt correctly retained the latest 20 chat messages, but the document
  retrieval query also concatenated all 20. An older exact document title therefore ranked its
  revoked source inside the prompt window and triggered the intentionally strict preflight block.
- **Prevention rule:** For contextual requests, keep the bounded 20-message live-chat anchor in the model prompt, but build document
  retrieval queries from only the latest five messages that represent the current topic. Do not
  fix this class of false block by weakening denied-source handling or the final permission guard.
- **Guard:** An orchestrator regression proves the stale sixth message is absent from retrieval
  query text, a relevant recent fact remains present, and the complete live-chat window still goes
  to context assembly.
- **Exit condition:** Focused answer, delivery, responder, and typecheck gates pass; an exact-SHA
  pilot question using only recent multi-user context is sent normally while revoked-source tests
  remain fail closed.

### Do not equate prompt retrieval with visible source attribution

- **Failure:** A correct answer grounded in the current group discussion included three unrelated
  Wiki links and violated the user's exact-output request.
- **Root cause:** The citation renderer assigned visible ranks to the first three
  permission-approved prompt documents. Permission approval proved that the model could read them,
  not that the answer relied on them.
- **Prevention rule:** Give background fragments bounded prompt-local references. The model may
  return only materially used references as internal trailing metadata; Core validates and removes
  the metadata and renders the footer itself. All prompt fragments remain in immutable traces, but
  only declared sources receive visible citation ranks.
- **Guard:** Provider-parser, orchestrator-window, renderer, responder, and real-Feishu regressions
  must separately prove uncited traces, valid declared citations, unknown-reference rejection, and
  absence of the internal protocol from visible output.
- **Exit condition:** An exact-SHA pilot answer based only on current group context contains the
  requested value and no document footer; a document-grounded answer still names only its declared
  source, and all permission and queue gates remain green.

### Detach stdin from remote Compose exec inside piped scripts

- **Failure:** A piped SSH deployment script completed its container-local Node check but silently
  skipped later Caddy and timer-cleanup commands, even though the outer shell returned success.
- **Root cause:** `docker compose exec --no-TTY` still inherited the SSH script's stdin. Compose
  drained the remaining script bytes before the remote Bash process could parse them.
- **Prevention rule:** Every non-interactive `docker compose exec` inside a script delivered through
  stdin must use `</dev/null`, or the post-exec work must run in a separate SSH command. Never infer
  that later commands ran from the exit status of an earlier container-local check.
- **Guard:** Deployment gates independently inspect Caddy state, timer state, durable runtime state,
  and public HTTP boundaries after each mutation. Rollback stops timer and service units in separate
  commands because an unloaded companion unit must not mask timer cancellation.
- **Exit condition:** The exact-SHA pilot shows Caddy running, the bounded timer is either active or
  explicitly cancelled as intended, durable runtime matches the approved profile, and external
  `/health` and private-route checks return their expected status codes.

### Classify literal tasks before touching company context

- **Failure:** A permissive direct-task regex accepted meta instructions such as “output only the
  answer” and references to a previous message. Even genuine literal transformations loaded
  company retrieval and permission state before the model received an empty prompt.
- **Root cause:** Route classification happened after context assembly, and the instruction regex
  allowed arbitrary words between the verb and delimiter. Empty model context therefore did not
  guarantee an empty retrieval path or empty response metadata.
- **Prevention rule:** Parse the first delimiter, match the complete instruction against a strict
  allowlist, and classify before chat loading, retrieval, permission inspection, or context
  assembly. Return exact-output payloads literally without a model request. Treat meta-format and
  previous/attached/above-context requests as contextual, not as standalone. The contextual planner
  may still select an authorized direct transformation; context dependency is not synonymous with
  a company-fact question. This distinction supersedes the older company-factual-only wording.
- **Guard:** Orchestrator regressions make context builders throw for direct tasks, prove canonical
  empty metadata and zero citations, prove exact-output uses no provider, and send adversarial
  wrappers through contextual classification and the appropriate evidence planner. Runtime retrieval tests use company-factual
  questions rather than direct transformations.
- **Exit condition:** Focused orchestration/runtime suites, full verification, independent review,
  and PR CI pass on the same commit before merge.

### Decide ordinary conversational intent before retrieval

- **Failure:** A personal hunger remark retrieved and copied a diary example with a knowledge-base
  citation; substantive tone feedback could receive only laughter. A natural-looking replay still
  exposed unrelated background material, so apparent fluency did not prove the boundary worked.
- **Root cause:** Narrow phrase shortcuts left ordinary conversation dependent on retrieval-first
  planning. Even a semantic direct-task answer could see background documents that redefined the
  task. The observed original turn does not identify every failed model stage.
- **Prevention rule:** A question-only semantic context-need decision precedes history, memory and
  document loading. Standalone generation defensively rejects reference context and document
  citations; state/emotion/tone feedback need no company evidence. Contextual rewriting, analysis
  and explicit document lookup retain source traces and current permission checks.
- **Guard:** [Router tests](../../apps/core/tests/openai-compatible-request-context-router.test.ts),
  [provider tests](../../apps/core/tests/openai-compatible-model-provider.test.ts) and
  [runtime/orchestrator tests](../../apps/core/tests/intent-before-retrieval.test.ts) exercise actual
  boundaries, zero context-provider calls, empty provenance and contextual controls. Repeat hunger
  and tone requests against the real model, alongside explicit diary lookup and revoked/foreign sources.
- **Exit condition:** The bounded ordinary/contextual matrix and deployed internal-draft gate pass
  for the same application commit; no new permission or external-action capability is enabled.
  Fixes: `32ac1915`, `2ba91b2f`, `ae828488`; deployed within `748b8404`.
  [Dated acceptance and limits](../development/iris-continuous-dialogue.md).

### Separate source-grounded advice from proof of an outcome

- **Failure:** Both questionnaire originals were available, but Iris refused to recommend a version
  because there was no author verdict or field-test result. Structural HTTP assertions passed while
  manual answer review rejected the release; diagnostics later showed inconsistent evidence-state choices.
- **Root cause:** Planning and rendering blurred source facts, Iris's task-fit assessment and proof
  of empirical effectiveness. The original failed HTTP plan was not captured, so its first failing
  stage remains unproven rather than retrospectively assigned.
- **Prevention rule:** Assess sufficiency for the question asked. Available alternatives and source
  facts may support a conditional recommendation without an author conclusion; official decisions,
  author intention and proven outcomes still require their own evidence. Preserve validated advice
  with its premises, without inventing missing versions or effectiveness data.
- **Guard:** [Planner tests](../../apps/core/tests/openai-compatible-evidence-planner.test.ts)
  and [renderer tests](../../apps/core/tests/openai-compatible-grounded-answer-renderer.test.ts)
  check the contract. Real-model acceptance separately requires both originals, two concrete or
  conditional recommendations with source-specific reasons, and negative missing-evidence controls.
  A prompt assertion, zero HTTP errors or retrieved text alone is not a semantic pass. A correctly
  bounded answer such as “暂无授权证据” must not fail solely because a test omitted that synonym;
  preserve the failed output and verify an assertion correction still rejects unsupported claims.
- **Exit condition:** Required real-answer checks pass on the deployed immutable application, with
  rollback/rejected runs retained. Fixes `7a640154` and `627eeba0` are included in `748b8404`.
  The supplemental missing-third-version label confusion remains P2, not silently counted as passed.
  [Release and follow-ups](../development/iris-continuous-dialogue.md).

### Localize policy prose without rewriting evidence or literals

- **Failure:** An uncertain Chinese answer exposed internal conjecture/confidence words. A first
  normalization attempt could also rewrite those words inside URLs and code.
- **Root cause:** The display normalizer excluded the `none` state, and prose replacement did not
  initially protect literal spans. Model outputs were stochastic; the coverage gap was deterministic.
  A later 2026-09-09 shared-chat recap exposed another deterministic gap: Chinese `置信度` followed
  by an English enum (`置信度为medium`) did not match the English-only `confidence` prefix.
  Fix `ff9fab2a` covered that forward order, but the next real-model run still emitted
  `medium 的置信度`: separate forward/reverse rules did not share a complete bounded expression grammar.
- **Prevention rule:** Normalize only Chinese display prose for the affected states. Preserve
  structured evidence/confidence data, explicitly requested English, URLs, inline code and fenced code.
- **Guard:** [Renderer regression tests](../../apps/core/tests/openai-compatible-grounded-answer-renderer.test.ts)
  include `none`/`partial`, both Chinese/English label/value orders, English overrides and protected spans.
  The shared-chat acceptance now rejects the actual mixed-language output automatically. Check real negative answers as well;
  do not change evidence sufficiency merely to produce fluent wording.
- **Exit condition:** The 22 focused renderer cases and required real-model language controls pass.
  Fix `748b8404`; [dated production evidence](../development/iris-continuous-dialogue.md).
  Those 22 cases are historical, not sufficient evidence for the newly observed enum gap; its
  RED/GREEN regression and new release gate are tracked in [shared-chat acceptance](../development/iris-shared-working-chat.md).
  The bounded two-order fix is `d475c5d1`; local renderer185/Core4486 and independent review pass.
  Final application `f6a6dd41` passed its own exact-SHA CI and all nine internal real-model checks,
  including Chinese confidence prose, before public ingress reopened at 07:43:52 UTC on 2026-09-09.
  This is not a new real-Feishu delivery/receipt acceptance; both rejected candidates remain recorded.

### Preserve the reference date when restating older messages

- **Failure:** A 2026-09-09 questionnaire comparison correctly paired the two originals but reused a
  2026-09-08 message's “today/yesterday” labels without making the reference date clear.
- **Prevention rule:** Prefer original absolute dates or explicitly attribute relative wording to
  the source message. Correct source identity and content do not prove correct temporal phrasing.
- **Guard / exit:** Record the specific answer and source timestamps; a future focused regression
  should verify the reference date. This is P2 for the observed content-comparison question, not a
  reason to broaden permissions or indefinitely harden retrieval. It remains unresolved in
  [shared-chat follow-ups](../development/iris-shared-working-chat.md#非阻塞迁移影响).

## Test Architecture

### Do not equate callback storage with complete recent conversation

- **Failure:** A same-group follow-up could not find a questionnaire posted during maintenance;
  the Feishu history API returned the original rich post, but no local message or tombstone existed.
- **Root cause:** Answer context relied exclusively on received callback rows. Retained logs did
  not prove why this specific callback was missing. Supplying the long post also exposed OOM kills
  in the small embedding runner before evidence planning.
- **Prevention rule:** Use a bounded, authoritative same-chat history read in the configured Feishu
  runtime; preserve deletion and runtime gates, and never synthesize receive events to repair QA.
  Scan at most 100 raw messages; protect at most two source/reply-label bundles at each selection
  boundary so short intervening traffic cannot wash either version out of the twenty/ten-message
  limits. This extends the earlier two-individual-slot rule for single-source questions.
  Preserve prompt-local reply relations into model evidence, not only the context selector: the
  real planner still denied a questionnaire until “这是问卷” was explicitly bound to its original.
  Budget search-vector inputs separately from the actual answer evidence. Date-anchored follow-ups
  discover same-chat IDs, then read current Feishu bodies within fixed budgets; they do not authorize
  cross-group raw chat or promise complete archives. See the
  [bounded-history and comparison contract](../development/iris-continuous-dialogue.md).
- **Guard:** Reader and runtime regressions cover rich posts, missing local rows, scope, tombstones,
  access failure, and post-await disable. Embedding tests bound only EmbeddingGemma query bytes,
  preserving source text and document vectors.
- **Exit condition:** The real same-group questionnaire produces a grounded Chinese internal draft,
  cross-group raw context remains absent, OOM counts do not increase, and exact-SHA release checks
  pass. Durable callback acknowledgement and deeper reply-chain recovery remain separate backlog.

### Verify every cross-CTE column dependency in migration SQL

- **Failure:** The local-embedding rollout rebuilt every vector successfully, then its coverage
  query failed because the CTE projected only `id` while the outer authorization and body gates
  referenced `document_source_id` and `body_text`.
- **Root cause:** Static deployment tests checked ordering, filters, and table names but did not
  assert that every column consumed outside the CTE was part of its projection.
- **Prevention rule:** For operator SQL embedded in scripts, test both the semantic ordering and
  the exact projection required by each outer join or predicate.
- **Guard:** The pilot deployment contract requires
  `select distinct on (s.document_source_id) s.id, s.document_source_id, s.body_text` before the
  outer source authorization and body gates.
- **Exit condition:** The focused deployment contract, full verification, exact-SHA CI, corrected
  production coverage query, and remaining private retrieval gates all pass.

### Keep test doubles aligned with fail-closed interfaces

- **Failure:** A runtime assembly test returned `repository_unavailable` after the feedback worker
  added an exact-binding repository method, while the test double still implemented only the write.
- **Root cause:** An unsafe cast allowed the mock to drift from the production dependency contract.
- **Prevention rule:** Shared test factories and mocks must implement every method in the narrowed
  `Pick` interface; assembly tests should assert security-sensitive call arguments.
- **Guard:** Full repository typecheck, runtime assembly tests, and the root `npm run verify` gate.
- **Exit condition:** Focused assembly tests and the complete verification pipeline pass on the
  same working tree.

### Match the OAuth transaction window to the bounded human handoff

- **Failure:** A legitimate reviewer returned from Feishu OAuth with a state and authorization code,
  but the temporary transaction Cookie had expired, so Core correctly returned the generic
  unavailable page and recorded no review fact.
- **Root cause:** The five-minute OAuth transaction lifetime was shorter than the real card-to-browser
  handoff, while the proposal-bound review session already allowed fifteen minutes.
- **Prevention rule:** Keep the signed, single-use OAuth transaction bounded to fifteen minutes,
  retain PKCE and exact state matching, and clear the transaction Cookie on every callback outcome.
- **Guard:** Session-codec behavior tests prove a transaction remains valid after five minutes,
  remains valid immediately before fifteen minutes, expires at the exact boundary, and serializes
  the same lifetime into the host-only Cookie.
- **Exit condition:** The exact-SHA pilot completes one OAuth review on the existing proposal without
  a duplicate draft, proposal, approval, execution, or remote task, then restores the full safe-off
  profile.
