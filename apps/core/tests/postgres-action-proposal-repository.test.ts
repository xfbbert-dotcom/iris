import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type {
  ActionProposalRepository,
  ActionProposalStatusCounts,
} from "../src/action-approvals/action-proposal-repository.js";

describe("action approval migration contract", () => {
  const migration = readFileSync(
    new URL("../migrations/0032_action_approval_facts.sql", import.meta.url),
    "utf8",
  );

  it("defines durable policy, proposal, approval, card, and execution facts", () => {
    for (const table of [
      "knowledge_publication_target_policies",
      "action_role_grants",
      "action_proposals",
      "action_approval_requirements",
      "action_approvals",
      "action_events",
      "action_approval_presentations",
      "action_approval_presentation_events",
      "action_approval_presentation_outbox",
      "action_executions",
      "action_execution_events",
    ]) expect(migration).toMatch(new RegExp(`create table ${table}`, "iu"));

    expect(migration).toMatch(/action_proposals_one_live_subject_idx/iu);
    expect(migration).toMatch(/action_approvals_one_requirement_actor_idx/iu);
    expect(migration).toMatch(/action_approval_presentations_one_active_recipient_idx/iu);
    expect(migration).toMatch(/action_approvals_append_only/iu);
    expect(migration).toMatch(/action_events_append_only/iu);
    expect(migration).toMatch(/action_approval_presentation_events_append_only/iu);
    expect(migration).toMatch(/action_execution_events_append_only/iu);
    expect(migration).toMatch(/review_approved/iu);
    expect(migration).toMatch(/approval_invalidated/iu);
  });

  it("keeps repository status counts content free", () => {
    const counts: ActionProposalStatusCounts = {
      pending_approval: 1,
      approved: 2,
      executing: 3,
      succeeded: 4,
      failed: 5,
      cancelled: 6,
      expired: 7,
      reconciliation_required: 8,
    };
    const repository = {} as ActionProposalRepository;

    expect(counts).not.toHaveProperty("content");
    expect(repository).not.toHaveProperty("approveAsActor");
  });
});
