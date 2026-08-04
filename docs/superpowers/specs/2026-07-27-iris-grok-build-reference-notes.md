# Iris Grok Build Reference Notes

Date: 2026-07-27

Source inspected: `xai-org/grok-build` at commit `b41c75a578f98bddbd326ab02cd53618451d97ee`.

## Decision

Do not directly copy Grok Build code into Iris now.

Grok Build is a Rust terminal coding agent. Iris is a Feishu organization agent with group chat memory, document/wiki permissions, knowledge publication governance, and human approval cards. The product surface, runtime language, and trust boundary are different enough that direct reuse would slow Iris down.

However, several architecture patterns are worth adopting as Iris grows beyond the first internal 20-30 person pilot.

## Useful Patterns

### 1. Tool Runtime Contract

Grok Build separates a typed tool definition from dispatch. Tools declare an ID, argument schema, output shape, visibility predicate, and streaming result contract. Dispatch sees JSON at the boundary, but tools stay typed internally.

Iris should keep the same idea in TypeScript:

- every Iris capability should become a registered tool or action with stable ID;
- each tool should declare input schema, output schema, risk level, required runtime capability, and approval policy;
- tool execution should emit `started`, `progress`, `completed`, `failed`, and `cancelled` events;
- Feishu card rendering should consume those events, not own the business logic.

Candidate Iris tool IDs:

- `iris.feishu.readDocument`
- `iris.feishu.searchWiki`
- `iris.memory.retrieveContext`
- `iris.knowledge.proposeDraft`
- `iris.knowledge.publishDraft`
- `iris.action.proposeFollowup`
- `iris.action.markResolved`

### 2. Session Event Ledger

Grok Build models session lifecycle events such as turn start/end, tool call start/end, and phase changes. This maps well to Iris because the user-facing group chat is multiplayer and asynchronous.

Iris should introduce a durable Agent Execution Ledger:

- one row per model turn;
- one row per tool/action call;
- one row per approval/card lifecycle event;
- all rows carry tenant, group, thread/action IDs, model/provider status, permission decision, and Feishu message/card IDs where applicable.

This would make "Iris 正在做什么", "谁批准了什么", and "为什么没有回复" inspectable without reading logs.

### 3. Hooks Without Blocking The Main Loop

Grok Build uses before/after turn hooks and hook replies as a structured extension point. For Iris, hooks are useful, but they must not violate the Feishu 3-second callback rule.

Iris-compatible hook rule:

- Feishu Gateway still ack-firsts and never runs hooks inline.
- Workers may emit hook events after queue claim.
- Hook failures are recorded in the ledger but cannot block safe ingestion.
- Only explicit approval hooks may pause high-impact actions.

Useful Iris hooks:

- `before_answer_context_assembly`
- `after_answer_posted`
- `before_knowledge_publication`
- `after_memory_extraction`
- `on_unresolved_thread_detected`

### 4. Context Compaction As A Product Primitive

Grok Build treats compaction as an explicit subsystem with trigger policy, sampler boundary, output validation, and host-owned persistence.

Iris should not rely only on vector retrieval. It needs separate compaction tracks:

- live group context anchor: recent raw messages stay closest to the model;
- thread summary: unresolved topic state, decisions, owner, next step;
- group memory: durable claims with evidence;
- document/wiki excerpts: permission-guarded background only.

The Grok Build lesson is that compaction should be observable and reversible. Iris compaction output must keep source evidence IDs and should never become the permission authority.

### 5. Permission Manager Pattern

Grok Build centralizes permission decisions instead of letting every tool decide for itself. Iris already follows this spirit with runtime switches, live permission guard, and approval cards. The next step is to unify it.

Iris should maintain a single permission manager for:

- global enable/disable;
- group enable/disable;
- source/document readability;
- tool capability gates;
- action risk levels;
- approval requirements;
- provider availability gates.

Every denied action should produce a structured denial reason. Unknown or timed-out checks fail closed.

### 6. Harness And UI Separation

Grok Build's TUI, headless mode, ACP embedding, and harness concepts show the right boundary: the agent runtime should not be inseparable from one UI.

For Iris:

- Core runtime should emit structured events and action proposals.
- Feishu bot should render those as messages/cards.
- Internal acceptance harness should drive the same runtime without Feishu.
- Future web console should inspect the same ledger and proposals.

This is directly worth borrowing.

## Less Useful For Iris Right Now

- The TUI renderer itself is not useful; Iris's first surface is Feishu.
- Shell/workspace/git tooling is not core to the company assistant.
- Rust crate structure should not drive the TypeScript modular monolith.
- Grok's coding subagent worktree isolation is only relevant if Iris later becomes a coding/task execution agent.

## Recommended Iris Backlog

1. Add an `agent_execution_events` / `tool_call_ledger` table and API before broad proactive automation.
2. Refactor high-impact operations behind a typed Iris tool/action registry.
3. Move Feishu card approval rendering behind event consumers, so card bugs cannot corrupt action state.
4. Add explicit thread-summary compaction with evidence references, separate from raw group memory extraction.
5. Keep the current whitepaper rule: live chat is the answer anchor, documents are background, and permission guard is final.

## Architecture Constraint

This research does not change the whitepaper. It clarifies an implementation direction:

> Iris should evolve from "chatbot plus handlers" into "agent runtime plus Feishu UI adapter", while keeping the modular-monolith deployment shape until real scale forces a split.
