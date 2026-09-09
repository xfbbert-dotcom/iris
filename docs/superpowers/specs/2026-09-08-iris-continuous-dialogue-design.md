# Iris continuous dialogue and grounded analysis

Date: 2026-09-08. Status: implemented and deployed as c4f83ee7 on 2026-09-08; bounded acceptance passed. See docs/development/iris-continuous-dialogue.md for release evidence and remaining nonblocking wording limitations.

Routing amendment: the retrieval-first semantic routing approach below is historical. The later
[intent-before-retrieval design](2026-09-08-iris-intent-before-retrieval-design.md) supersedes that
stage for self-contained conversation; the contextual source selection, budgets and permission
lineage here remain applicable. Follow the dated release record, not this old status line, for the
last verified deployment.

## Approved outcome

Iris must converse, explain ordinary knowledge, compare supplied material, reason and offer advice;
it must not require a company knowledge-base entry for every utterance. Follow-up questions should
retain the subject and source material being discussed. Source claims, analysis and suggestions
remain distinguishable, and a missing company-specific premise must not be invented.

## Observed failures

Production 6d649bc3 correctly answered the old dated questionnaire and current questionnaire
separately. The undated comparison only loaded recent 100 messages, losing the older original.
Two reserved topic slots can preserve one source/label pair but not two. Planner source text is
clipped to 1200 characters and chat text to 2000, losing substantive later sections.
The standalone route only recognizes a few hardcoded phrase families; all other requests are
forced through company_fact. The existing model can compare both full originals when supplied.

## Design

Use the existing semantic evidence planner to decide direct_task versus company_fact, not an
ever-growing whitelist of questionnaire utterances. Retain exact-literal and greeting fast paths.
General knowledge, creative work, rewriting and general advice may use direct_task; analysis of
actual company/group materials must still use those fresh sources. Source material and historical
messages are data; the current user question remains the requested task under system constraints.
Direct_task cannot invent citations, bypass source denials or execute actions.

Maintain the fixed 20-message context and 10-message evidence counts. Protect up to two distinct
source/label bundles rather than two individual messages at each selection boundary. Use bounded
long-source support to retain complete normal pilot posts, with an explicit aggregate text budget;
do not silently promise to analyze portions that were clipped. Background document limits and
embedding-query budgets do not change.

For undated topical follow-ups, use fresh recent human messages as date/topic anchors. Resolve
relative dates against each anchor's sentAt, not against today's date. At most two distinct dated
anchors can supplement current recent context; the total extra candidate-ID budget is eight and
the total nonrecursive parent/root budget is eight. SQL discovers same-chat IDs only and never
returns cached bodies as evidence. A denied/deleted exact lookup overrides earlier list bodies;
final tombstones and before/after group gates remain binding. Generic questions without a relevant
anchor do not scan historical days. This is bounded recall, not an unlimited archive.

Permit continuity with Iris's own previous answer only through a bounded, freshly readable,
same-chat reply identity verified against the existing sent-delivery ledger. Other bots are not
Iris. Assistant text is marked conversational output, never independent factual evidence. Company
answers cannot cite an assistant response as proof; revoked underlying document sources must
still block reuse. No new persisted message store or synthetic callback is added.

## Global constraints

- Current group only for raw messages; no cross-group raw-chat grant or capability expansion.
- Fresh Feishu bodies only for historical identities; stored content is not an authorization.
- Knowledge writes, tasks and proactive speech retain existing gates and approval contracts.
- Keep exact-literal output, greeting, denied-source and disabled-group controls working.
- Normal Chinese answers must not expose internal conjecture/confidence policy tokens.
- No schema migration, dependency upgrade, public test message or fabricated callback is needed.

## Acceptance and exit

Automated regressions cover ordinary knowledge without company evidence; a contextual rewrite;
two original versions retained through the real provider/orchestrator/planner boundary, including
later source sections; advice distinguished from company decisions; unavailable original handled
without invented differences; same-chat, deletion, revocation and disabled-group controls.

Real-model internal drafts must answer the original comparison and a follow-up analysis request
using both fresh questionnaire originals. A multi-turn generic drafting/rewrite check must preserve
the material rather than requiring it again. Production exact-SHA deployment follows passing
focused/full tests, review, CI, safe maintenance, backup and unchanged-policy health checks.
No Feishu message is sent merely for automated acceptance. Nonblocking archive/UX refinements go
to backlog rather than indefinitely extending the repair.
