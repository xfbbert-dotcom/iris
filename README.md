# Iris

Iris is the company's Feishu-native AI assistant and collaboration agent.

## Start Here

Read [AGENTS.md](AGENTS.md) and the [current handoff](docs/development/current-handoff.md) before
continuing work. Recheck `git status`, `git diff`, recent commits and `git worktree list`; an old
checkout or a remembered conversation is not the current implementation/release baseline.
Every bug fix requires the [four-place documentation closure](docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md#112-mandatory-bug-fix-documentation-closure):
whitepaper, failure ledger, coverage baseline and repository entry. Record updates or justified
unchanged reviews in the checked-in fix record before declaring completion.

The architecture constitution lives at:

`docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`

The internal rollout runbook lives at:

`docs/operations/internal-rollout-runbook.md`

Reusable engineering failures and prevention rules live at:

`docs/operations/engineering-failure-ledger.md`

The internal MVP acceptance checklist lives at:

`docs/runbooks/iris-internal-mvp-gray-checklist.md`

## Current Product State

The [source-plan runtime record](docs/development/iris-opinion-runtime-20261004.md) is the latest
proactive-discussion status. Application `397fedbf` passed the frozen eight synthetic business
cases and both source-role/time controls on exact `qwen3.8-max`, across retained and resumed
windows (24 HTTP200 / 89,408 reported tokens). This is bounded synthetic evidence, not real
Feishu acceptance or deployment; initial free assessment and reviewer explanations still have
documented defects. Earlier failed candidates below remain historical evidence.

The local runtime can select `IRIS_PROACTIVE_DISCUSSION_OPINION_MODE=source-plan`; synthetic
evaluation uses `--opinion-mode source-plan`. Both default to `legacy` and use the existing model
configuration. This selects the opinion contract only: existing source permissions and speech
enablement still apply. Consult the record for current local verification and authorization;
do not enable production speech or run paid evaluation from this example.
Local integration commit `1ea3ae7e` passed Core 5012 tests (469 conditional skips), typecheck,
build and 9 CLI tests. Offline replay preserved the eight accepted cases' exact model inputs and
final pairs through this entry point with trace both on and off; it is not a new live-model run.

### Retained prior candidate results

A new [canonical opinion candidate](docs/development/iris-canonical-opinion-20261001.md)
derives stored prose from one message instead of expanding a separate internal rationale.
Default off, original review retained; local checks passed. Six HTTP200/17924 tokens gave one
limited risk pass, then failed inference by asserting severe sample bias without sampling evidence.
Four cases were uncalled; candidate stopped. Both candidates remain off, no deployment or Feishu acceptance.

The [counterexample review candidate](docs/development/iris-counterexample-review-20261001.md)
is implemented behind an explicit local option, default off. Core4860 passed/469 conditional
skips, type/build/CLI7 passed; three added cases passed in the final focused17. After login recovery,
four HTTP200/11011 tokens removed invented quantities but left a necessary delivery consequence
that both final checks missed. The first case failed; five controls were uncalled. The candidate
is stopped and remains off; no runtime enablement, deployment or Feishu acceptance.

The latest [review receipt-duty ablation](docs/development/iris-review-duty-ablation-20260929.md)
made no application change. One HTTP200/3240-token diagnostic identified unsupported quantities
but missed the required conditional-consequence defect; it stopped before the positive control.
The proposed split was not integrated. Application remains `a2b3c449`; no deployment or Feishu acceptance.

Application `a2b3c449` makes the single correction [update explicit prose fields](docs/development/iris-repair-updates-20260929.md)
while preserving the current generated candidate. Core4853 passed/469 conditional skips;
type/build and CLI7 passed. A five-HTTP window (16794 tokens) passed the frozen correction and
final review, then failed on fresh risk: review approved unsupported quantities and certain
consequences before an empty numeric unit caused local rejection. Four cases were uncalled.
The window failed; no push, production access, deployment or real Feishu acceptance.

Application `3e7636b8` keeps [immutable issue identity and references outside model prose](docs/development/iris-bound-prose-20260929.md).
Core4845 passed/469 conditional skips; final focused43, type/build and CLI7 passed. The bounded
four-HTTP window (11706 tokens) failed: review correctly rejected invented interface arithmetic,
but the sole repair returned a null new-issue description and confused editing with business
change. No final review or remaining four cases ran. No deployment or real Feishu acceptance.

Application `8b39e8db` adds [bounded recovery of incomplete initial drafts](docs/development/iris-generated-recovery-20260929.md).
Core4837 passed/469 conditional skips, type/build and CLI7 passed. Six HTTP200 requests/21799
tokens passed the frozen recovery and fresh cost-update cases, then stopped on a malformed
source hash in risk generation before review. Duplicate control was uncalled. The window failed;
no production access, push, deployment or Feishu delivery. Earlier records below remain historical.

Application `88f7a169` adds an [explicit unavailable-quantity state](docs/development/iris-unavailable-numbers-20260929.md)
to proactive review, preserving known-value and arithmetic checks without forcing unknown
amounts into drafts as zero. Core4824 passed/469 conditional skips, type/build and CLI7 passed.
After login recovery, six HTTP200 requests/19517 tokens yielded two limited inference passes.
The budget control then failed during generation: valid JSON contained only half a draft and
omitted evidenceRefs, so review never ran. Update/risk/duplicate controls were uncalled after
the stop. The complete applicability gate remains unpassed; no production access, push,
deployment or Feishu delivery.

Application `1f00cc0e` removes an [unconditional authorization-advice instruction](docs/development/iris-advice-ablation-20260927.md).
Related local tests82 and type/build pass. The seven-request synthetic window still failed:
one frozen-input render passed narrowly, but fresh inference returned no opinion after review
invented required zero amounts for unknown values. Permission/risk/duplicate controls were not
called after that failure. Proactive semantics remain unaccepted; no push, production access,
deployment or Feishu delivery. Results below retain their historical application identities.

Application `60a8c2ac` adds [deterministic checks for explicit arithmetic](docs/development/iris-executable-arithmetic-20260926.md)
to initial/final proactive pair review without adding model calls. Core4811 passed/469 conditional
skips, type/build and CLI7 passed. A bounded nine-HTTP synthetic window repaired the old wrong-sign
pair and passed fresh arithmetic, but failed inference: the final advice made gathering payment
evidence conditional on approval policy. Risk and paraphrase cases were not called after that
failure. Full proactive semantics remain unaccepted; no push, production access, deployment or
Feishu delivery occurred. The entries below retain their historical application identities.

The [September 26 immutable-review probes](docs/development/iris-immutable-review-20260926.md)
did not repair the current application. A hand-paired sentence test distinguished the arithmetic
sign but failed its three-way relation classification; removing those alternatives and restoring
the frozen full review again accepted the wrong `16−10=−6` sentence. The transfer stopped after
one HTTP200 call, with four controls uncalled. This candidate is rejected; do not rerun it as a
new product gate or promote the paired result. That probe did not change application `04aa3a09` or production.

The [September 26 fixed-review model comparison](docs/development/iris-qwen38-review-20260926.md)
used newly authorized `Qwen3.8-Max` on the existing synthetic-test key, without an
application or production model change. It stopped after two HTTP200 calls: the old arithmetic
negative was rejected without recognizing its sign error, while `qualified-risk` was
incorrectly accepted. Three planned controls were not called. The original full-suite and
live-group acceptance gaps remain open.

The [September 25 review-identity projection](docs/development/iris-review-identity-20260925.md)
is committed as application `04aa3a09`. It removes the current evaluation's old assessment
prose from both reviews and the sole repair while retaining a locked issue identity, the
current candidate and real discussion history. The local Core suite passed 4781 tests with
469 conditional skips; type/build and evaluation CLI passed. The bounded seven-case run
ended with 17 HTTP200 calls but failed execution on inference and paraphrase; independent
semantic review passed four of seven, failing inference, qualified-risk and paraphrase.
An unchanged-app thinking-profile comparison stopped after its first `qualified-risk` review
again accepted the overcertain consequence; four planned controls were not called.
An unchanged-app private claims/draft isolation probe also stopped at its first claims-only
control: the reviewer missed `16−10=−6` despite actual wire isolation. Five planned controls
were not called; neither probe is a product change or an accepted architecture.
No full-suite or live-group acceptance is claimed.

The [September 25 literal-receipt diagnostic](docs/development/iris-literal-receipts-20260925.md)
is bound to application `bdef93c0`. Its six-case run had 16 HTTP200 calls and five execution
successes, but independent review found only four semantic passes: `inference` was wrongly
rejected and `qualified-risk` contained an overcertain consequence that review missed. It is
not a full-suite, CI, deployment or live-group acceptance.

The [September 25 review-context repair](docs/development/iris-review-context-20260925.md),
application `a0a7f2a0`, supplies current discussion and prior intervention state to review and
repair, preserves an existing issue's last accepted source basis for generation, and fails before
generation when its authorized text is missing. Five staged regressions, focused66, Core4779/469
conditional skips and type/build passed. A bounded six-case live diagnostic returned four independent
passes and two incomplete drafts after 18 HTTP200 calls; it does not establish full semantic acceptance.
The earlier full run remains 22/30. No push, deployment or activation occurred.

The [September 25 review-diagnostics fix](docs/development/iris-review-diagnostics-20260925.md)
is locally committed as application `45fe8968`. A negative model review no longer hides
simultaneous local field, number, advice-quote or continuity failures from the sole pair repair.
Four tests went red then green; 90 focused tests, Core4774/469 conditional skips, type/build,
and an independent 69-test scope review passed. The separate context fix is recorded above as
application `a0a7f2a0`; these earlier gates are not its acceptance evidence.
The earlier full-model result remains 22/30 semantically accepted. No repaired full-model or
live-group acceptance, push, deployment or activation is claimed.

The [September 20 source-first pair generation](docs/development/iris-source-first-generation-20260920.md),
application `dcaa2995`, rebuilds assessment and draft together from authorized evidence, retaining the
issue/authority structure but excluding unverified prior prose from initial generation. The earlier
pair-only attempt still falsely accepted a subtraction error and is preserved. Source-first negative,
positive and fresh arithmetic stages returned correct final pairs (9 HTTP200 calls, 29569 tokens).
September 25 Core4770/469 conditional skips, focused83, type/build and CLI7 passed; the earlier
scoped code review and original evidence are retained. The full 15-case, two-round window completed:
66 HTTP200 calls but only 22 semantic passes, 3 wrong decisions, 3 incomplete results and 2 content
failures. It is not accepted. No push, deployment or live-group activation occurred.

The [September 20 assessment-field review repair](docs/development/iris-field-review-20260920.md),
application `66c7a3c0`, requires six named field verdicts and local conjunction with the overall
review and existing receipts. Core4756/469 conditional skips, type/build, CLI7 and scoped review
passed. **This closes a contract gap, not the real-model semantic defect.** The fixed negative
control still received false-positive field verdicts; its unchanged pair was rejected only by the
old numeric-quote gate. Additional one-shot exact-target-quote and bounded-thinking probes also
failed; the thinking probe even passed the local literal-receipt gate. Neither was promoted.
Five free-protected HTTP200 calls (22457 usage tokens) and separate semantic stops are retained;
later controls/full evaluation were not started. No push, deployment or activation occurred.
Earlier versions and failures below are history.

The [September 20 Bailian free-only evaluation](docs/development/iris-bailian-free-eval-20260920.md)
completed six synthetic calls: native minimal format passed, the full assessment schema received
HTTP400 for array constraints, and the existing explicit JSON mode completed the original arithmetic
pipeline. Independent semantic review still failed: the retained assessment had a subtraction-sign
error and an unsupported certain consequence despite a correct draft and positive model review.
The 15-case two-round suite was not started; no model adoption or production change occurred.
Free-quota exhaustion protection remains enabled, local focused regression passed 93 tests, and
application remains `d699761e`. The record also preserves September 18's actual Zhipu 1305 overload
response; it is not evidence of a daily quota reset. All earlier failed runs below remain history.

The [September 18 generation follow-up](docs/development/iris-free-generation-followup-20260918.md)
retains seven local calls and one free-cloud call without application changes. Making the native
schema visible did not repair the known draft; GLM-4.7-Flash again returned HTTP429. A new offline
Qwen3-4B-Instruct-2507 candidate passed minimal format checks but failed the original arithmetic
case in both native and explicit JSON modes. It was not adopted or sent to full evaluation.
The local server is stopped; no paid fallback, production change or semantic completion is claimed.
Application remains `d699761e`; the regression counts below belong to their earlier repair runs.

The [numeric-review continuity repair](docs/development/iris-review-continuity-20260917.md), application
`d699761e`, prevents final review from silently dropping earlier numeric diagnoses while permitting
source-quoted corrections of mistaken diagnoses. Fresh Core4734/469 conditional skips, type/build,
Compose+CLI40/1 skip and scoped review passed. This is bounded control-flow/receipt verification,
not complete proactive semantics or deployment. Local model controls each used two HTTP200 calls:
the correct pair returned, while the incorrect pair still missed the gap and was rejected for a
fabricated numeric receipt. This is containment/availability evidence, not successful generation.
The following experiments and failures are retained history, not the current application version.

Two further [private repair experiments](docs/development/iris-json-mode-compatibility-20260917.md#继续修复的两项私有实验均未推广)
did not fix the missing gap or overstatement and were not promoted. The edit-only experiment
actually returned an incorrect pair when final review omitted the missing quantity from its list;
the explicit-diagnostic experiment was rejected without a semantic repair. Application code was
unchanged; these failures remain open. Subsequent [bounded free-cloud probes](docs/development/iris-json-mode-compatibility-20260917.md#后续免费云端格式通过与算术失败或未完整分开)
passed one minimal JSON-format request on each of GLM-4-Flash-250414 and GLM-4.7-Flash. The former
then incorrectly skipped the original arithmetic case; the latter's assessment was blocked by
HTTP429 without output. Neither entered rendering/full evaluation or was adopted; cloud requests stopped.

A second [current-draft quote guard](docs/development/iris-json-mode-compatibility-20260917.md#草稿引用存在性原型验证与第二项狭窄修复)
uses the existing single paired correction. After a retained correct-draft false rejection, quote
choices were bound to the actual current draft. A new fixed positive control returned its original
pair in one real HTTP200 review; the negative control's three HTTP200 calls ended in null after
two invalid numeric receipts, without fixing the missing gap. These are local return/containment
results, not fresh generation or full semantic acceptance. Commit `42db6b6c` passed fresh Core
4716/469 conditional skips, typecheck/build and Compose+CLI40/1 conditional skip (CLI7 passed;
Docker unavailable). The local model was stopped. Bounded implementation closure does not close
the remaining semantic failures or authorize deployment, activation or messages.

The latest [explicit JSON-mode compatibility repair](docs/development/iris-json-mode-compatibility-20260917.md)
adds an opt-in Core transport mode while preserving native-schema defaults, full schema instructions,
local domain validation and bounded calls. A free GLM probe returned HTTP200 but ignored the requested
native schema; its first repaired JSON-mode probe received HTTP429 without model output. Later
minimal cloud-format successes above do not establish full compatibility or semantic acceptance. The bounded local review/focus experiments
did not resolve the known failures and were not promoted. Application `a5e5e2e4` passed Core4673/469
conditional skips, type/build and one local real-model JSON-format check; that minimal result is not
Zhipu or proactive semantic acceptance. See the record for the Docker-dependent skipped boundary
probe; no production activation, deployment or paid fallback is implied.

The preceding [assessment output-adapter repair](docs/development/iris-assessment-wire-fix-20260917.md)
constrains complete generation branches and strictly unwraps them into the unchanged runtime
contract. The final commit completes the original arithmetic chain in a bounded local thinking
profile, but numeric omissions and false-positive review still fail semantic acceptance; two
normal-profile final probes timed out. See the record for full-suite
evidence and remaining gates; no production proactive activation or paid API test is implied.
Earlier prompt-only diagnosis below remains retained history, not the current structure implementation.

Prior work was the [2026-09-17 same-model integration diagnostic](docs/development/iris-prompt-contract-diagnostic-20260917.md),
after the user asked whether our own system was the problem. Application `01ee7c31` aligns model-facing
decision relations and preserves source-grounded arithmetic through review/repair, without relaxing
validation or adding calls. Core4651 passed/469 conditional skips, CLI7 and type/build passed.
The fixed local model can answer the plain budget question; after the prompt repair its raw decision
changes from skip to intervene, but null issueRef still prevents a valid final assessment. Both full
single-case attempts remain incomplete. No full model suite, deployment or proactive activation is
claimed. Next is a bounded output/state-contract design, not another blind model swap or cloud probe.
All10 requests were local and synthetic; the server is stopped, with no API cost or production changes.
The following free-probe and run1–6 records are preserved history.

The user authorized a **free-model-only isolated comparison**, not a paid upgrade or production
switch. The [2026-09-17 setup/probe record](docs/development/iris-free-model-probe-20260917.md)
retains the initial two capacity failures and two further single-request windows explicitly resumed
by the user (GLM-4.7-Flash, again HTTP429); four cloud attempts total, no automatic retries. A dedicated
test key is already encrypted on the local machine; do not request it in chat or recreate it.
No cloud format/semantic result was obtained. The [local free fallback](docs/development/iris-local-free-model-eval-20260917.md)
downloaded and verified portable llama.cpp plus official Qwen3-4B Q4_K_M: the minimal format passed,
but the original arithmetic case failed assessment validation after its existing one repair.
No full evaluation ran; the local server is stopped and no production settings changed.
Neither availability nor a minimal format pass replaces the open run6 quality gate below.

The approved [assessment/draft joint-review repair](docs/development/iris-proactive-discussion-joint-review-20260916.md)
is committed as `ee9a8ae2`: one paired correction and one final review at most, one accepted result for
worker and evaluator, no added calls on the ordinary successful path. Core 4649 passed / 469 conditional
skips, 110 separate database-gate cases passed (107 real PG), CLI7 and build/type gates passed.
Same-model run6 produced 30 correct decisions and no execution errors, but full semantic review is
**26 pass / 4 fail / 0 incomplete**. Numeric omissions and assessment overclaims still pass model review;
successful execution is not quality acceptance. A free-only comparison is now authorized as recorded
above; unchanged resampling is not the next step. The run1–5 status below is historical, not a request to reapprove this repair.
No push, deployment, real-Feishu sending or proactive activation occurred.

The approved direction is [content-triggered proactive discussion](docs/superpowers/specs/2026-09-09-iris-proactive-discussion-design.md):
Iris notices material work risks, explains its reasoning and suggests improvements, including
clearly qualified concerns. It is not duplicate deadline reminding and has no fixed conversational
cooldown that blocks a distinct important issue. The first scope is the original pilot group.
The written design is approved and the [implementation plan](docs/superpowers/plans/2026-09-14-iris-proactive-discussion.md)
is implemented through the local end-to-end path and a synthetic-only model evaluation CLI;
the [finite acceptance and release handoff](docs/development/iris-proactive-discussion.md) records
actual tests, retained failures and four-place dispositions. The [first failed real-model run](docs/development/iris-proactive-discussion-model-eval-20260915.md)
and the subsequent [bounded model/evaluator repairs and repeated evaluation](docs/development/iris-proactive-discussion-model-fixes-20260915.md)
are recorded separately. The preceding [synthetic trace, stage-contract and trigger-binding repairs](docs/development/iris-proactive-discussion-model-trace-20260915.md)
are `68f16e04` → `fbd18724`; complete local Core regression is 4631 passed / 463 conditionally skipped.
They preserve bounded diagnostics, distinguish structural validation from semantic approval and explicitly bind the trigger to its source text;
evaluation-only HTTP pacing does not add a production conversational cooldown.
Configuration is available. Run4 was 25 pass / 5 fail / 0 incomplete; latest run5 has all 30 decisions correct,
but complete semantic acceptance is still 26 pass / 2 fail / 2 incomplete. Remaining assessment overclaims
and mixed-quality draft rejection require a bounded joint-review design, not further unchanged sampling.
Exact-SHA CI and real-Feishu deployment/acceptance remain
pending and require current authorization; proactive discussion has not been activated.
The 2026-09-15 [final-review fixes](docs/development/iris-proactive-discussion-final-fixes.md)
address issue-prose provenance, unattempted stale drafts, owned lease renewal and startup registration;
the record distinguishes their local regression evidence from the pending model and live gates.

The approved three-group [shared working-chat extension](docs/development/iris-shared-working-chat.md)
is deployed as `f6a6dd41` after passing exact-SHA CI (including PostgreSQL), all nine internal
real-model checks and manual answer review. On 2026-09-09 at 07:43:52 UTC, public ingress was
restored with shared scope active/version5 and runtime revision3387. Ordinary discussion in these
exact three groups can now support cross-group questions without per-message Wiki publication.
The linked record preserves two earlier failed acceptance runs and revocations; it does not claim
new Feishu test-message delivery. Other groups, proactive speech and external-action gates remain
outside this activation; known nonblocking wording and migration follow-ups are recorded.

All ten previously defined P1 product loops have historical bounded real-Feishu acceptance evidence;
that evidence does not cover the newly clarified semantic proactive-discussion requirement. The
rollout began with a controlled 3-5 person, single-group daily pilot; consult the dated current
handoff and fresh runtime checks for present activation and group scope. This does not authorize expansion to all
20-30 employees; expansion follows only after ordinary pilot use contains no unresolved P0 or P1
issue.

The implemented internal-MVP loop includes:

- ack-first Feishu event ingestion and shared group context;
- mention replies grounded in recent chat, long-term memory, group documents, employee-submitted
  documents, and authorized Feishu Wiki spaces;
- real-time source permission rechecks and permission-safe citations;
- semantic discussion-thread and action memory;
- governed knowledge drafting, group confirmation, OAuth full-text review, approval, and Feishu Wiki
  publication;
- operator-reviewed proactive reminders with group-member feedback and suppression;
- durable runtime controls, fail-closed recovery, private local embeddings, and a lightweight Admin
  Console.

The knowledge-conflict candidate loop is implemented behind production-default-off controls but is
still pending its exact-SHA live acceptance. It can compare a newer group conclusion with current
authorized Wiki evidence, require operator approval for a bounded conflict card, and create a
governed update draft. It does not edit the existing Wiki page in place; the draft enters the
existing confirmation, review, approval, and publication path. Until the dedicated one-group pilot
and nonpilot-control runbook passes, this loop is not part of the accepted daily-pilot capability
set.

Managed existing-page knowledge updates are implemented and locally verified, but remain
default-off (`IRIS_MANAGED_KNOWLEDGE_UPDATE_ENABLED=false` with an empty allowlist). They are
restricted to fresh Iris-created, single managed plain-text blocks and require exact identity,
confirmation, OAuth review, approval, one-block mutation, and exact resync. Controlled Feishu
acceptance is pending; it is not delivered or deployed until the content-free evidence in
`docs/development/iris-managed-knowledge-update-pilot.md` records a real allowlisted pilot with an
immutable image/tag/SHA, timestamps, and operators. This does not alter the already accepted
publication pilot facts above.

Governed Feishu task creation is implemented and has passed one bounded real-Feishu acceptance.
One explicit chat request produced a versioned formal-task draft, and Task v2 was called only after
the same exact task-spec hash passed group confirmation, assignee OAuth review, designated-owner
approval, final membership, and runtime checks. The run recorded one fresh task, exact official
readback, one result card, drained recovery counts, and a safe-off rollback for an immutable
image/tag/SHA. The capability remains default-off for ordinary daily chat through
`IRIS_FEISHU_TASK_CREATION_ENABLED=false`, an empty allowlist, and disabled `generateTaskDrafts`,
`createFeishuTasks`, and `callExternalTools` runtime gates. It may be reopened only for a separate
intentional governed session; the acceptance evidence is recorded in
`docs/superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md` and the operating
contract remains `docs/runbooks/iris-governed-feishu-task-acceptance.md`.

High-impact capabilities remain bounded: knowledge-base writes open only for an intentional
governed session, and groups outside the exact approved pilot scope must remain disabled. Legacy
proactive reminders still require human review; the proposed low-risk discussion loop will use
separate explicit policy authorization, not fabricated human approval. It is not enabled by this
documentation change. Accepted capability coverage does not imply that a runtime gate is on.

## Local Development

The bounded conversation/analysis repair and its acceptance boundaries are documented in
[Continuous dialogue](docs/development/iris-continuous-dialogue.md). Code and local test results
alone are not proof that a production pilot has been upgraded.

Install TypeScript dependencies:

```powershell
npm install
```

Run TypeScript tests:

```powershell
npm test
```

Run Python worker tests:

```powershell
npm run test:python
```

Run the full local verification suite:

```powershell
npm run verify
```

Check the internal rollout configuration profile:

```powershell
npm run readiness
```

To validate a private env file directly:

```powershell
npm run readiness -- --env-file .env
```

Use `.env.example` as the non-secret variable checklist for local or private rollout setup.

## Local Database

Start local infrastructure:

```powershell
docker compose up -d
```

If this fails before containers start, first verify host Docker/WSL readiness:

```powershell
docker compose config
docker version
docker desktop status
wsl --status
```

`docker compose config` only validates repo configuration. `docker compose up -d` also needs Docker
Desktop's engine and WSL integration to be running on the host.

Run database migrations:

```powershell
$env:DATABASE_URL="postgres://iris:iris@localhost:5432/iris"
npm --workspace apps/core run db:migrate
```

Run optional Postgres integration tests:

```powershell
$env:DATABASE_URL="postgres://iris:iris@localhost:5432/iris"
npm --workspace apps/core test -- postgres-document-source-registry.test.ts
npm --workspace apps/core test -- document-snapshot-repository.test.ts
npm --workspace apps/core test -- document-fragment-repository.test.ts
```
