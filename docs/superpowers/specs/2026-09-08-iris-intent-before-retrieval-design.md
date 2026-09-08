# Iris: intent before retrieval

Date: 2026-09-08. User approved implementation and deployment of: determine conversational intent first, ordinary chat directly, retrieve only when group/document context is needed. This records that approved design, not a new permission request.

## Cause and outcome

Production c4f83ee7 retrieved diary-writing examples for a personal hunger remark and visibly cited them. A subsequent production-model replay sometimes answered naturally, but still exposed over12000 characters of unrelated background context to the direct answering model. Style feedback could also fail citation parsing. The prior acceptance did not establish reliable ordinary conversation.

Introduce a question-only semantic retrieval-need decision before any document, memory, history or embedding load for non-literal/non-shortcut requests. The router sees only the current question, never retrieved content that might redefine the task. It returns standalone or contextual, not an answer or an action. Standalone covers self-contained social/emotional/state utterances, tone feedback, general explanations and self-contained drafting. References to previous messages, documents, actual company facts, comparisons or an earlier draft need contextual; uncertainty chooses contextual. No growing phrase whitelist.

Standalone generation receives only the current request and assistant policy. No documents, source-derived assistant messages, group memories, threads or actions enter its model prompt/result, and no citation or source traces are produced. This consciously excludes earlier context on that path: a dependent request such as a draft rewrite or advice about two versions must be routed contextual instead.

Contextual requests retain the complete existing fresh same-group history, two-source selection, source permissions, planner, document rewrite and assistant-lineage verification. Do not remove uncited source traces: model exposure still requires send-time revocation checks. Semantic direct_task inside the contextual path remains able to transform authorized material.

## Interfaces and behavior

New RequestContextRouter.classify({question}): Promise<'standalone'|'contextual'>; question maximum4000 characters, strict JSON {route}, exactly those two values, at most two structured-output attempts. Invalid output after repair or provider failure propagates as a normal answer-generation failure, not an unreviewed retrieval fallback. This router is never an authorization grant.

The orchestrator accepts an optional router for backward-compatible injected/test composition; production runtime always constructs the real router using the existing chat client. Existing literal/greeting shortcuts stay fast. Permission inspection makes the same routing decision before loading context. No new persistent routing cache.

GenerateAnswerDraftInput gains optional contextMode:'standalone'. The provider defensively excludes promptContext and citation instructions in this mode even if a caller supplies context. It rejects a nonempty document citation result in standalone mode. Default/contextual calls preserve references, but send untrusted reference context separately before the final current Question. Current-task and first-person ownership are explicit: diary examples and context instructions are not the user's request or Iris's own experience; style feedback receives a substantive adjustment, not merely laughter.

## Global constraints

- No new cross-group grants, knowledge writes, tasks, proactive messages, callbacks or Feishu test sends.
- Retain all current group, deletion, document-snapshot, grant-version and send-time permission checks.
- Keep existing literal-output, contextual document rewrite, old/new comparison and follow-up behavior.
- No dependency upgrade, schema migration, new model credentials or background service.
- Real-model acceptance must test varied ordinary utterances and contextual controls, not only mocked output or prompt wording.
- Do not claim production repaired until exact-SHA CI, paired backup, immutable deployment and actual deployed HTTP checks pass.

## Acceptance and exit

Structural regression: standalone route reaches model with empty retrieval context and zero calls to contextBuilder/history/planner/renderer, including when those providers would fail or contain a diary example; returned fragments and citation list empty. Contextual route still preserves source text, citations and revocation behavior. Runtime default factory wires the router. Invalid routing/citation output remains bounded and non-deliverable.

Real model: hunger, another personal state, emotion and tone feedback in the existing groups should answer naturally with no source references and no diary impersonation. Explicitly requesting a diary sample/doc rewrite, old/new questionnaire comparison, follow-up advice and prior-draft rewrite must still select contextual and retain evidence. Generic explanation/drafting and exact output remain usable. Cross-group and disabled-group negative controls remain. Repeat a small set of social cases to catch stochastic contamination. Stop after these gates; defer unrelated wording/archival refinements.
