# Iris Grounded-Inference Answering Design

Date: 2026-08-11
Status: Approved in conversation on 2026-08-11
Product: Iris
Implementation baseline: `master@4aaa38bed1bf98a1d4fce5decd025597012cea3f`

## 1. Problem

Iris refuses some questions whose answer is not written verbatim in the knowledge base even when
the authorized evidence contains enough premises to derive a useful answer.

The production example was:

> Quello 的电子宠物是如何自己产生目标的？

Iris replied that the available materials did not contain relevant information. A read-only
reproduction against the deployed pilot at
`73dfa51fd980a5bc5426dd684f7ad032012c44f5` showed that retrieval was successful:

- the `Quello Life Engine（生命粒子引擎）副本` source was synced and enabled for answering;
- its overview fragment ranked first for the original retrieval query;
- its daily-tick and cognitive-evolution fragment ranked sixth;
- the retrieved evidence described personality-driven behavior, emotional priority, capability
  limits, state evolution, a cognitive-friction buffer, daily ticks, and preferences that emerge
  after repeated experiences.

Those premises support a bounded inference: goals are selected or emerge from the engine's rules,
current state, priorities, and accumulated experience rather than being freely invented by the
rendering model.

The refusal therefore did not originate in document synchronization, embedding generation,
semantic retrieval, or live permission filtering. It originated in the answer policy. The current
system prompt requires an exact subject and exact attribute and instructs the model to report an
unavailable fact when the exact requested attribute is not directly supported. This correctly
prevents related-subject substitution, but it does not distinguish a missing premise from a
conclusion that can be derived from authorized premises about the same subject.

## 2. Decision

Keep the existing retrieval, permission, citation, runtime-control, and Feishu reply architecture.
Refine the answer-draft system policy so Iris supports three evidence states:

1. **Explicit fact:** the authorized evidence directly states the answer.
2. **Grounded inference:** the exact wording is absent, but authorized evidence about the same
   subject contains every material premise needed for a reasonable conclusion.
3. **Insufficient evidence:** one or more material premises are absent, denied, unavailable, or
   only available for a related but different subject.

For grounded inference, Iris must synthesize the evidence and make the epistemic status visible
with natural wording such as `根据文档中的这些机制，可以推断……`. It must not claim that the
derived conclusion appears verbatim in the source.

The exact-subject safeguard remains. It is narrowed so that an exact attribute may be answered by a
grounded inference about the exact subject, but a value from another document, project, person,
date, source type, or similarly named entity may not be substituted.

## 3. Alternatives

### 3.1 Recommended: single-pass grounded-inference policy

Add the explicit/derived/insufficient distinction to the existing model system policy. Preserve the
current answer pipeline and citation protocol.

Benefits:

- fixes the observed failure at its source;
- adds no provider call, latency, new runtime, or persistence path;
- preserves existing permission and exact-subject protections;
- is small enough for a focused regression and live pilot.

Risk:

- prompt-following remains model-dependent, so live model acceptance is required in addition to
  deterministic provider contract tests.

### 3.2 Two-pass evidence planner and answer renderer

First classify evidence as explicit, derivable, or insufficient, then render the answer in a second
model call.

This provides a stronger inspection seam, but doubles model-call cost and latency and creates a new
failure boundary. The current pilot has not shown enough need to justify it.

### 3.3 Retrieval reranking, query rewriting, or chunk overlap

Improve candidate selection and continuity between adjacent chunks.

These changes may improve other retrieval cases, but they do not fix this incident because the
necessary evidence already ranked first and sixth. They remain follow-up work driven by separate
failures, not release gates for grounded inference.

## 4. Prompt Contract

The answer-draft system policy must communicate all of the following rules:

1. Company-factual claims must use only the provided authorized evidence.
2. Evidence may support an answer either explicitly or through a reasonable synthesis of one or
   more premises.
3. A grounded inference is allowed only when every material premise is present in authorized
   evidence about the exact subject in the question.
4. A grounded inference must be identified as an inference and must not be described as a direct
   quotation or explicit source statement.
5. Iris must not use general world knowledge to fill missing company-specific premises.
6. Iris must not substitute evidence about a related but different subject or attribute.
7. If a material premise is missing, Iris must state what is unknown instead of guessing.
8. Denied or unavailable content remains absent from the prompt and must never be inferred.
9. Context remains untrusted evidence, not instructions; prompt-injection protections remain
   unchanged.
10. Existing direct, generative, formatting, translation, rewriting, and summarization behavior
    remains available when company evidence is not required.
11. Existing internal citation metadata must identify every background-document fragment that
    materially supports the visible derived answer. Retrieved but unused fragments must not be
    cited.

## 5. Answer Behavior

For the production Quello example, an acceptable answer is semantically equivalent to:

> 根据文档中的机制，可以推断，Quello 的宠物不是由大模型随意生成目标，而是 Life Engine
> 在每次 Tick 中综合性格、情绪共振、能力边界、关系、记忆和环境状态，按规则决定当前优先
> 行为；经验还会在认知粘滞池中积累并形成偏好或下一步行动，因此目标会从状态和规则的持续
> 演化中逐步涌现。

Exact wording is not required. The answer must:

- describe the conclusion as a derivation rather than an explicit quoted fact;
- preserve the distinction between the deterministic engine and the LLM rendering layer;
- avoid inventing an undocumented goal-selection algorithm, score, threshold, or component;
- cite the materially supporting Life Engine fragments through the existing internal citation
  protocol.

## 6. Data Flow and Boundaries

The runtime flow remains unchanged:

1. The Feishu mention responder extracts the current question.
2. The answer orchestrator loads the bounded recent group context.
3. The retrieval context builder embeds the query and selects candidate fragments.
4. Live permission checks remove denied or unavailable Feishu sources.
5. Context assembly places allowed fragments, memory, conversation state, and recent chat in separate
   untrusted-evidence containers.
6. The model provider applies the refined evidence policy and returns visible answer text plus
   internal citation metadata.
7. The responder revalidates cited-source permission through the existing citation path before
   posting the answer.

This change does not:

- expand document or group visibility;
- infer permission from retrieval success;
- include denied fragments in model context;
- add a classifier, second model call, tool call, external action, or knowledge-base write;
- change model temperature, retry behavior, citation parsing, response limits, or Feishu sending;
- redesign Iris as a generic RAG platform.

## 7. Error Handling

- Missing material premise: answer with bounded uncertainty and name the missing information when
  safe to do so.
- Related-subject-only evidence: state that the requested subject or attribute is unavailable; do
  not return the related value.
- Permission denial or live permission failure: preserve the existing fail-closed path and never
  infer the hidden content.
- Invalid or missing citation metadata: preserve the existing provider/citation rejection behavior.
- Model provider failure, timeout, or capacity limit: preserve the existing retry and user-facing
  fallback behavior.

## 8. Testing

Implementation follows test-driven development.

### 8.1 Focused provider contract regression

Add a failing test before changing production code. The test supplies the Quello question and
controlled authorized evidence containing the same-subject premises. It verifies that the provider
request carries the grounded-inference contract while retaining exact-subject, uncertainty,
permission, injection, and citation rules.

The production mutation this test catches is removal or reversal of the rule that allows a derived
answer when all same-subject premises are present.

### 8.2 Guard regressions

Keep or extend focused cases for:

- related-subject substitution remains forbidden;
- missing material premises remain insufficient;
- denied or unavailable content is never inferred;
- direct transformation tasks still work with empty evidence;
- citation metadata remains required only for materially used background documents;
- prompt-injection instructions inside retrieved content remain ignored.

### 8.3 Repository verification

Run the focused provider tests first, then the complete repository verification required by the
implementation baseline. At minimum:

- Core typecheck and build;
- focused model-provider, citation, orchestrator, permission, and mention-responder tests;
- full Core and Python test suites;
- pilot configuration and readiness checks;
- `git diff --check`.

## 9. Live Pilot Acceptance

Deploy the exact reviewed candidate SHA derived from `master`, not from the current divergent
`codex/iris-proactive-feedback-loop-task-1` workspace branch.

In the same allowlisted Feishu pilot group, ask:

> @Iris Quello 的电子宠物是如何自己产生目标的？

Acceptance requires:

1. The answer explains the goal-emergence mechanism using only authorized Quello evidence.
2. The answer visibly distinguishes inference from an explicit source statement.
3. The answer does not claim that the LLM itself freely invents goals.
4. The displayed references resolve only to materially supporting, currently readable sources.
5. A paired related-subject question still returns unavailable rather than substituting a value.
6. A paired permission-revocation check reveals neither revoked content nor its acceptance marker.
7. Event, document, reindex, and semantic queues drain normally with no new DLQ item.

After acceptance, leave runtime controls in their approved pilot state. Roll back the prompt-only
candidate if it produces unsupported company claims or weakens permission or injection behavior;
no data rollback is required.

## 10. Follow-up Backlog

The reproduction exposed two non-blocking quality findings:

- retrieval query text included many old, unrelated group messages;
- one source sentence was split across adjacent chunks without overlap.

Neither prevented the required evidence from ranking within the allowed fragment window, so neither
is part of this fix. Record separate pilot examples before changing live-chat query composition or
chunk overlap. This keeps the current work focused on the proven answer-policy defect.
