# Iris Grounded-Inference Answering Design

Date: 2026-08-11
Status: Approved architecture A in conversation on 2026-08-11
Product: Iris
Original implementation baseline: `master@4aaa38bed1bf98a1d4fce5decd025597012cea3f`
Supersedes: the prompt-only design and implementation plan committed on 2026-08-11

## 1. Problem and Production Evidence

Iris refuses some questions whose answer is not written verbatim in the knowledge base, even when
authorized material contains useful premises from which Iris should reason.

The production example is:

> Quello 的电子宠物是如何自己产生目标的？

The source `Quello Life Engine（生命粒子引擎）副本` is synced, enabled for answering, and readable
in the pilot group. Its fragments describe personality-driven behavior, emotional priority,
capability limits, state evolution, a cognitive-friction buffer, daily ticks, and preferences that
emerge after repeated experiences.

The first design treated the refusal as a prompt-policy defect and deliberately left retrieval and
orchestration unchanged. The resulting candidate was deployed to the allowlisted production pilot,
passed repository and CI checks, but failed the live acceptance question. It was rolled back to the
previous approved production image.

Read-only diagnosis of that failed turn established all of the following:

- the deployed image contained the intended prompt change;
- the semantic retrieval query concatenated the current question with five recent chat messages,
  including meta-discussion about Iris failing to reason, and duplicated the current question;
- eight authorized fragments reached the model, but most were unrelated diary or watch sources;
- the Quello overview fragment ranked fifth and was included;
- the Quello daily-tick and cognitive-evolution fragment ranked tenth and was omitted by the
  eight-fragment prompt limit;
- all retrieved fragments passed live permission checks;
- adding the omitted Quello fragment to the exact failed prompt still resulted in a refusal;
- weakening another exact-attribute prompt sentence in an otherwise identical controlled request
  still resulted in a refusal and caused the model to cite an unrelated fragment.

The proven defect is therefore architectural rather than a single prompt sentence: noisy retrieval,
fragment-level truncation that loses same-source premises, and one model call that must both judge
evidence and render an answer.

## 2. Product Decision

Adopt architecture A:

1. clean, question-led retrieval with low-weight conversational supplementation;
2. source-aware evidence selection and bounded same-source completion;
3. a structured evidence planner;
4. a separate answer renderer;
5. authoritative programmatic citation validation and the existing send-time permission check.

For a company-factual question, Iris supports four evidence states:

1. **Explicit:** authorized evidence states the answer directly.
2. **Complete inference:** the answer is not verbatim, but authorized same-subject evidence contains
   every material premise needed for a reasonable conclusion.
3. **Partial:** at least one relevant authorized premise exists, but material information is
   missing. Iris first names the insufficiency, then gives a clearly labeled, confidence-bounded
   conjecture derived only from the available authorized evidence.
4. **None:** there is no relevant authorized premise from which to extrapolate. Iris states that no
   knowledge-base-grounded conjecture is possible and identifies the information needed.

The user explicitly approved the `partial` behavior: an insufficiency warning must not automatically
end the answer. Iris should still provide its best clearly labeled conjecture, but may not use
general world knowledge to invent a missing company-specific premise.

Permission-denied evidence is not ordinary partial evidence. It remains unavailable and cannot be
summarized, inferred, or acknowledged beyond the existing safe permission response.

## 3. Alternatives Considered

### 3.1 Selected: two-model evidence planning and rendering

Question-led retrieval and source-aware completion feed a structured evidence planner. A second
model call renders the validated plan.

This adds one model call but creates a deterministic inspection seam, prevents unrelated retrieved
documents from reaching the renderer, and lets the application own evidence-state and citation
validation.

### 3.2 Retrieval improvements with the existing single answer call

This is cheaper and faster, but it leaves evidence judgment and presentation coupled. The failed
candidate and two controlled follow-up requests show that another one-pass prompt adjustment is not
an adequate release strategy.

### 3.3 Model-based query rewrite, evidence planning, and rendering

A third model call could rewrite ambiguous follow-up questions before retrieval. It would improve
some pronoun-heavy conversations, but adds latency, cost, and a new failure boundary. The selected
design preserves follow-up support with a deterministic secondary retrieval channel first. A query
rewrite stage requires separate pilot evidence before adoption.

## 4. End-to-End Architecture

The company-factual flow is:

```text
current question
  -> primary question-only retrieval
  -> low-weight contextual supplemental retrieval
  -> deterministic merge and deduplication
  -> live permission filtering
  -> source-aware ranking and bounded same-source completion
  -> structured evidence planner
  -> schema and citation validation
  -> answer renderer using only selected evidence and the validated plan
  -> authoritative citation mapping
  -> existing send-time source-permission revalidation
  -> Feishu reply
```

The existing runtime gates, source scoping, Feishu permission checker, prompt-injection boundary,
answer-reply delivery service, and pilot controls remain in force.

The planner also classifies direct tasks such as translation, rewriting, summarization, and exact
formatting as `direct_task`. Those tasks proceed to the renderer without pretending that retrieved
company evidence is required.

## 5. Retrieval Design

### 5.1 Primary query

The primary semantic query is the trimmed current question only. It never includes arbitrary recent
chat, and the current question is never duplicated from the live-chat window.

Conversation-state lookup also uses the primary question rather than the polluted combined query.

### 5.2 Contextual supplemental query

A second, lower-weight query may include a bounded recent-chat window to preserve support for
follow-ups such as “它为什么这样？”. Exact duplicates of the current question are removed before
the supplemental query is built.

Primary and supplemental results are searched independently and merged deterministically. Weighted
reciprocal-rank fusion gives the primary query twice the weight of the supplemental query. The
precise constant is implementation-owned and must be locked by a production-shaped regression;
changing it later requires retrieval acceptance evidence, not prompt intuition.

### 5.3 Source-aware evidence selection

The merged candidate pool is grouped by `documentSourceId` before the final prompt window is built.
Selection follows these rules:

- rank a source by its strongest fused fragment score;
- use a normalized exact-title or title-containment match to the named subject only as a bounded
  boost, never as permission or factual proof;
- take one strong fragment from each leading source before allowing a noisy source to consume the
  whole window;
- then take additional semantically strong fragments from the leading sources, up to three per
  source and within the existing maximum of twelve prompt documents;
- include an immediate same-snapshot neighbor when needed to complete text split by a chunk
  boundary;
- never include a blank, stale-snapshot, non-answerable, out-of-group, or permission-denied
  fragment.

This makes the evidence window both diverse across sources and sufficiently complete within a
strongly matched source. In the production-shaped Quello fixture, both the overview and the
daily-tick/cognitive-evolution fragments must survive selection.

### 5.4 Permission ordering

Candidate sources are evaluated through the existing live permission guard before their text enters
either model request. If a source that would materially occupy the evidence window is denied or its
permission check fails, the turn takes the existing fail-closed permission path.

Allowed citations are revalidated again immediately before answer delivery. Retrieval success never
implies current read permission.

## 6. Structured Evidence Planner

The planner receives:

- the current question;
- bounded, permission-allowed evidence with stable `D1` through `D12` references;
- only the minimum conversational context needed to resolve the subject;
- system rules that treat every evidence and chat field as untrusted data, never instructions.

It returns strict JSON equivalent to:

```json
{
  "taskMode": "company_fact",
  "evidenceState": "partial",
  "premises": [
    {
      "citationRef": "D2",
      "statement": "A concise premise supported by D2"
    }
  ],
  "proposedAnswer": "A bounded conclusion derived from the premises",
  "missingInformation": ["The material fact that is not documented"],
  "confidence": "low"
}
```

Allowed values are:

- `taskMode`: `company_fact` or `direct_task`;
- `evidenceState`: `explicit`, `complete_inference`, `partial`, or `none` for company facts;
- `confidence`: `high`, `medium`, or `low`.

Programmatic structural validation enforces:

- every citation reference exists in the current allowed evidence set;
- every premise has one citation and non-blank text;
- `explicit` and `complete_inference` have at least one premise and a proposed answer;
- `complete_inference` has no missing material premise;
- `partial` has at least one premise, at least one missing-information item, a proposed answer, and
  cannot use `high` confidence;
- `none` has no proposed company-factual answer and identifies what information is missing;
- list lengths and text lengths are bounded;
- unknown fields, malformed JSON, duplicate references, or out-of-range references are rejected.

Exact-subject alignment and whether a premise statement is genuinely supported by its cited text
are semantic constraints, not facts that ordinary schema validation can prove. They are enforced by
the planner system contract, by limiting the planner and renderer to selected authorized evidence,
by production-shaped contract tests, and by live pilot acceptance. The application must not claim a
deterministic semantic guarantee that it does not implement.

The provider performs at most one bounded retry for malformed or invalid planner output. A second
invalid result is a provider failure, not permission to fall back to unconstrained guessing.

## 7. Answer Renderer and Citations

For company-factual answers, the renderer receives only:

- the current question;
- the validated plan;
- the evidence fragments cited by the plan;
- bounded live-chat context needed for language and conversational continuity.

It does not receive unrelated retrieved fragments. It may improve clarity and tone, but it may not
change `evidenceState`, add premises, increase confidence, remove the insufficiency warning from a
`partial` answer, or convert conjecture into fact.

For company-factual turns, the renderer returns bounded structured output containing the visible
answer plus an echo of `evidenceState` and `confidence`. The application rejects a structural state
or confidence mismatch. Natural-language compliance inside the visible answer remains covered by
the renderer contract, focused tests, and live acceptance.

Required visible behavior is:

| Evidence state | Required response behavior |
| --- | --- |
| `explicit` | Answer directly and cite the explicit premise. |
| `complete_inference` | Say that the conclusion is inferred from the available material, explain the bounded reasoning, and cite every material premise. |
| `partial` | First name the evidence gap, then say “基于现有证据，我的推测是……” or an equivalent phrase, give the conjecture and confidence, and cite its actual premises. |
| `none` | State that the knowledge base provides no basis for a conjecture and say what evidence would be needed. |

Planner premise references are authoritative. The renderer does not independently select citations.
The orchestrator maps validated references to the existing `allowedFragments`, and the existing
delivery layer performs the final live permission check and reference rendering.

Direct tasks retain the existing behavior and output-format contract. They do not acquire citations
unless the task actually uses a company document as source material.

## 8. Safety and Trust Boundaries

- General world knowledge may be used for language and reasoning form, but not to fill an unknown
  company-specific fact or premise.
- User-supplied text may be transformed as requested without treating its claims as verified.
- Retrieved documents, group memory, conversation state, and live chat remain untrusted evidence.
- Instructions embedded inside any context container cannot change roles, reveal prompts, call
  tools, bypass permissions, or authorize external actions.
- Denied or unavailable content never enters planner or renderer input.
- A title match can affect ranking only; it cannot establish identity, truth, or permission.
- Planner reasoning is not persisted as hidden chain-of-thought. Persist only bounded operational
  metadata and the ordinary answer/citation records already needed by the product.

## 9. Errors and Observability

The orchestrator records content-free phase metadata for `retrieval`, `evidence_planning`, and
`answer_rendering`, including evidence state, confidence, candidate count, selected source count,
selected fragment count, and outcome. It must not log document bodies, model reasoning, credentials,
or denied content.

Failure behavior is:

- embedding, repository, or provider transport failure: existing user-safe failure response;
- malformed planner result after one retry: provider failure, with no unconstrained answer call;
- `partial`: warning plus bounded evidence-derived conjecture;
- `none`: transparent no-basis response and requested missing evidence;
- permission denial or permission-check failure: existing fail-closed permission response;
- renderer failure: existing user-safe provider failure unless a later implementation plan proves a
  separately validated deterministic renderer fallback;
- send-time permission revocation: withhold the affected answer through the existing delivery
  guard;
- queue or rollout-health regression: roll back the candidate image and retain no data migration.

Planner and renderer each have bounded timeouts and retries. The implementation must expose the
two phases separately in tests and observations; it must not create an unbounded retry loop.

## 10. Testing Strategy

Implementation uses test-driven development.

### 10.1 Retrieval regressions

- the primary query equals the current question and excludes recent meta-chat;
- the current question is removed from the supplemental chat query when duplicated;
- primary results dominate conflicting contextual noise;
- a contextual follow-up can still recover a subject from recent chat;
- source-aware selection prevents one unrelated source from consuming the window;
- the production-shaped Quello fixture includes both the overview and daily-tick/evolution
  fragments;
- denied fragments never enter either model input.

### 10.2 Planner contract tests

- accept valid `explicit`, `complete_inference`, `partial`, `none`, and `direct_task` plans;
- reject unknown references, malformed JSON, blank premises, invalid state combinations, excess
  fields, excess lengths, and `partial` plans with no actual premise;
- reject a related-subject substitution;
- retry one malformed result, then fail closed;
- ignore prompt-injection text inside documents and chat.

### 10.3 Orchestrator and renderer tests

- renderer input contains only planner-selected evidence;
- `partial` visibly warns, labels the conjecture, and preserves low or medium confidence;
- renderer cannot add citation references or upgrade evidence state;
- authoritative planner references map to the correct fragments;
- direct transformation and exact-output tasks remain functional;
- permission denial bypasses both planner and renderer;
- provider and renderer failures use bounded safe responses;
- execution observations distinguish both model phases without content leakage.

### 10.4 Repository verification

Run focused Core tests first and then the complete repository verification. At minimum this includes
Core typecheck/build, all Core and Python tests, pilot/readiness checks, Compose validation, and
`git diff --check`.

## 11. Live Pilot Acceptance

Deploy only an exact reviewed SHA whose Core and AI Worker checks passed. Keep production limited to
the existing allowlisted pilot group.

Ask the original question:

> @Iris Quello 的电子宠物是如何自己产生目标的？

Acceptance requires:

1. Retrieval uses the current question as its primary query without duplicated meta-chat.
2. The selected evidence includes the materially relevant Quello overview and daily-tick/evolution
   fragments.
3. The planner selects only Quello premises and returns `complete_inference` or a justified
   `partial` state.
4. The visible answer explains goal emergence from Life Engine rules, state, priorities, and
   accumulated experience without inventing an undocumented algorithm, score, or threshold.
5. A `complete_inference` answer is visibly labeled as inference; a `partial` answer first explains
   the evidence gap and then visibly labels its conjecture and confidence.
6. Displayed references resolve only to materially supporting, currently readable sources.
7. A paired related-subject question does not substitute another project's facts.
8. A paired zero-evidence question does not invent a company fact.
9. A paired permission-revocation check reveals neither revoked content nor an inferred acceptance
   marker.
10. Event, document, reindex, semantic, memory, and answer-reply queues drain normally with no new
    DLQ item.

If any security, citation, or core behavior gate fails, roll back to the currently approved image.
The previous prompt-only candidate remains diagnostic evidence and is not independently deployable.

## 12. Scope and Follow-up Backlog

This design changes retrieval query composition, evidence selection, model orchestration, planner
validation, renderer input, citations, observations, and their tests. It does not add a database
migration, new external provider, generic tool-use agent, knowledge-base write path, permission
expansion, or broad RAG-platform redesign.

Non-blocking follow-up work requires separate evidence:

- model-based rewrite for highly ambiguous follow-up questions;
- general chunk overlap or a rechunk/reindex migration;
- a dedicated stronger planner model or different planner model configuration;
- deterministic multilingual renderer fallback;
- offline retrieval-quality evaluation beyond the production-shaped regression set.

These items must not extend the current fix after its agreed end-to-end acceptance gates pass.
