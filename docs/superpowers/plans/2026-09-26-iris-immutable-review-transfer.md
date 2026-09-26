# Immutable Review Transfer Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Determine whether exhaustive immutable source spans transfer from hand-paired controls to frozen product review inputs, without changing the application.

**Architecture:** A private disposable harness derives complete span catalogs from frozen inputs and augments existing scope review with mandatory per-ID checks. Existing rejection remains authoritative; a strict bounded run is archived regardless of outcome.

**Tech Stack:** TypeScript / tsx, node:assert, current Core review validator, PowerShell DPAPI launcher, offline Node archive helper.

**Spec:** [Immutable review transfer design](../specs/2026-09-26-iris-immutable-review-transfer.md)

## Global Constraints

- No application source edits, production access, push, deployment, real-group model input, or Feishu messages.
- Synthetic-only existing key, exact qwen3.8-max, fresh free quota and exhaustion-stop verification; no paid fallback.
- One run: at most 5 HTTP requests, 300000 ms, 45000 reported tokens stop-before-next-request threshold (not an absolute billing cap), 6000 ms spacing, max_tokens 4096, non-thinking, 60000 ms per request, no retry or repair.
- Preserve all failed/preflight artifacts; no overwritten run markers or post-run oracle changes.
- Private artifacts stay under `C:/Users/59912/AppData/Local/Iris/bailian-eval-20260918`; only sanitized evidence enters git.

## Review Focus

- Loss of a conditional/negative clause: every original character must survive in contiguous spans and full field context.
- Missing new issue description: it is a retained candidate field even though existing IDs have no description.
- Receipt swapping/omission: unknown, duplicate or missing IDs fail regardless of overall supported.
- False acceptance by a different defect: wrong arithmetic and excessive certainty must fail on their own original spans.
- Negative-only success: positive arithmetic and update candidates must pass the unchanged local validator as well as all spans.

## Task 1: Private span harness and offline verification

**Files:** Private transfer `.mts`, helper/tests if separated, and PowerShell launcher; no application edits.

**Interfaces:** Consume frozen first-review `originalMessages`/responseFormat and current `validatePdScopeReview`; produce immutable span catalog and a one-shot safe report. The archival task consumes the report bytes and script hashes, not reconstructed claims of success.

- [x] Add offline coverage/receipt preflight assertions. Exercise description inclusion, empty fields, CRLF, Chinese punctuation, comma-bound condition, duplicate/omitted/unknown IDs and global false plus all spans true. This disposable probe does not claim product TDD evidence (see execution decision).

```ts
assert.equal(spans.map(s => s.text).join(''), sourceText);
assert.equal(spans[0].start, 0);
assert.equal(spans.at(-1).end, sourceText.length);
spans.forEach((s, i) => {
  assert.equal(s.text, sourceText.slice(s.start, s.end));
  if (i) assert.equal(s.start, spans[i - 1].end);
});
assert.equal(combinedSupported(false, true), false);
assert.equal(combinedSupported(true, false), false);
assert.equal(combinedSupported(true, true), true);
```

- [x] Run `D:/软件安装/node.exe --import tsx C:/Users/59912/AppData/Local/Iris/bailian-eval-20260918/immutable-transfer-probe-20260926.mts --preflight`; expected all coverage/receipt assertions pass with zero HTTP and no key. Implementer and independent reviewer both observed exit 0.
- [x] Derive five frozen controls with no human alternative text, freeze their hashes and local expected results before any API request. Preserve the complete original input and global checks; add only mechanically derived span catalog and receipt schema/prompt.
- [x] Strict TypeScript check and PowerShell AST parse; implementer reports zero diagnostics/errors. Offline preflight exits before key access and creates no run markers/HTTP. Independent reviewer checked exact wire and limits before main executes.

## Task 2: Single bounded run and evidence closure

**Files:** Private run/report/start/halt, offline archive helper; checked-in sanitized evidence, dated release record, README and current handoff.

**Interfaces:** Consume Task 1's reviewed immutable scripts and frozen expectations. Produce independent semantic verdict and a documented product decision, not a product pass.

- [x] Main fully reads harness/launcher; verifies precise quota row and uses the launcher's fresh-quota/model-scope assertions. Exactly one run started and stopped at the first targeted failure: one HTTP200 / 6605 reported tokens; four cases uncalled.
- [x] Independently compare decoded receipts against original texts, source scope and per-span expectations; no API rerun. Independent conclusion: wrong arithmetic sentence and unsupported certain consequence were rationalized as supported; candidate rejected, uncalled cases untested.
- [x] Main reads offline archive helper, then archives via its explicit archive mode. Original wire/spans and source/script hashes verified, host/user redacted and originals unchanged; manifest readback verified.
- [x] Record arithmetic improvement and three-way classification failure of the preceding probe without changing its failed status. Record this transfer's actual outcome and limitations in [the dated record](../../development/iris-immutable-review-20260926.md), including all four document dispositions.
- [x] Run `git diff --check`, verify manifest hashes and local Markdown links, inspect scoped diff; main verified 10 archived file hashes/byte lengths and 25 local link targets. Fresh independent review found no closure blocker and also verified the 10 archives. This plan is included in the local diagnostic/docs commit; no push or product acceptance. Application suite was not rerun for docs-only changes, and older dates were not presented as fresh validation.

## Execution decisions

User has explicitly requested continuous scoped execution without routine permission questions. This plan proceeds within the existing synthetic/free-only authorization; no new access or production action is inferred. A helper agent prepares the private harness while main owns quota verification, execution and final evidence review.

This is a disposable feasibility probe rather than application behavior implementation. If it fails, Task 2 ends with a rejected candidate and clear remaining blocker; no follow-on prompt search is included.

Ruling before API execution: the already-prepared throwaway harness uses offline preflight assertions rather than claiming a RED→GREEN product implementation cycle. The scope remains diagnostic and cannot be promoted on this evidence; if reused as product code it still requires its own design, TDD and integration verification. Both frozen excessive-risk sentences must be rejected, not merely one. Reviewer confirmed the amended script and offline boundaries before launch.
