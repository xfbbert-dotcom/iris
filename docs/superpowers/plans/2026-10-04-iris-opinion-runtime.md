# Iris Source Plan Runtime Integration Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for the two independent implementation tasks, then independent whole-change review and verification.

**Goal:** Make the source-bound opinion path available through the real local runtime and synthetic evaluation entry points after its frozen semantic gates pass.

**Architecture:** A shared `legacy | source-plan` mode selects the existing generation contract. Runtime and eval use the same mapping. Trace records the compiled pair actually sent to scope review; it does not reconstruct a replacement candidate.

**Tech Stack:** TypeScript, Vitest, existing Node CLI tests. No new dependency.

**Spec:** [source-plan acceptance](../../development/iris-opinion-plan-20261001.md#一次新鲜八例窗口及两项负控), [decision-only contract](../../development/iris-opinion-decision-only-20261002.md), and [integration/evidence record](../../development/iris-opinion-runtime-20261004.md).

## Constraints and exit condition

- Existing app `397fedbf` passed eight business cases and two role/time controls across retained and resumed windows on exact qwen3.8-max. Preserve earlier failures, interruption and zero-request stop.
- Default is `legacy`. Opt-in mode changes no model configuration, source access, send enablement, authorization or deployment.
- Preserve the model flow and one total correction; no new prompt variants or real-model requests in this integration.
- Exit after mode/trace regression tests, full Core tests, typecheck/build, CLI tests, scoped independent review and four-place documentation closure. Real Feishu and deployment remain separately unaccepted and outside current authorization.

## Review focus

- Invalid/empty explicit mode must fail rather than silently select a contract (Task 1 and CLI tests in Task 2).
- Trace on/off must use identical model behavior (Task 2).
- A bound candidate observed before a failed scope call is still observable but never accepted (Task 2).
- Binding repair has localValidation and no invented review/draft; semantic repair has actual review input (Task 2).
- Unparseable/truncated plans must not appear to have compiled or been accepted (Task 2).

## Task 1: Shared mode and runtime

Files: create `apps/core/src/proactive-discussion/opinion-mode.ts`; modify `apps/core/src/config/runtime-config.ts`, `apps/core/src/runtime/proactive-discussion-runtime.ts`; test shared mode/config/runtime in `apps/core/tests`.

Interface: export `PdOpinionMode = "legacy" | "source-plan"`, `parsePdOpinionMode(value?: string): PdOpinionMode`, and `pdOpinionModeOptions(mode)`. Undefined defaults to legacy; explicit invalid values fail. `source-plan` maps only the existing `canonicalOpinion`, `sourceBoundIdentity`, `opinionPlan` flags to true.

- [x] Write/run failing tests for parse/default/invalid values and actual runtime selection.
- [x] Read `IRIS_PROACTIVE_DISCUSSION_OPINION_MODE` into config and pass mapped options to the runtime model factory.
- [x] Verify exact model configuration, active-send controls and legacy behavior stay under their existing configuration.
- [x] Run focused runtime/config tests; root performs combined verification before local commit.

## Task 2: Evaluation entry and actual trace

Files: modify `scripts/pilot/proactive-discussion-eval.ts`, its CLI tests and associated Core eval/trace tests.

Consumes Task 1 mode/parser/mapping. CLI `--opinion-mode legacy|source-plan` and callable eval option select the same contract; report records the selected mode.

- [x] Write/run failing mode-selection and plan-trace tests.
- [x] Wire both traced and non-traced model creation to the shared mapping.
- [x] Record actual raw plan, plan repair and localValidation under existing redaction/size limits. At the actual scope request, associate its `assessment/draft/sourcePlan` with that plan as `boundCandidate` before HTTP.
- [x] Keep compilation observation separate from final render acceptance; never recompile plans to fill trace gaps. Preserve existing legacy trace semantics.
- [x] Test normal plan, binding repair, semantic repair, malformed/schema-invalid output, failed scope request, accepted skip and trace-on/off parity. Run eval/CLI tests.

## Task 3: Verify and close local handoff

- [x] Archive actual resumed window bytes with manifest and independent semantic reasons; verify all hashes and no credentials.
- [x] Review the final diff against both entry points and product requirements.
- [x] Run full Core, typecheck, build and CLI verification; distinguish conditional skips.
- [x] Update whitepaper, failure ledger, requirement baseline and README/AGENTS/current-handoff dispositions in the integration record, including limitations and acceptance level.
- [x] Commit locally only. Record the application commit separately from any documentation follow-up commit; do not deploy, push or send Feishu messages.
