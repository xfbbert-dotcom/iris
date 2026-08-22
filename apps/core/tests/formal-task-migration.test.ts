import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("governed Feishu task action migration", () => {
  it("creates typed draft, policy, execution, success, and result-outbox facts", async () => {
    const sql = await readFile(
      new URL("../migrations/0057_governed_feishu_task_actions.sql", import.meta.url),
      "utf8",
    );

    for (const table of [
      "feishu_task_target_policies",
      "feishu_task_target_policy_operations",
      "formal_task_drafts",
      "formal_task_draft_revisions",
      "formal_task_draft_evidence",
      "formal_task_draft_events",
      "formal_task_draft_presentations",
      "formal_task_draft_presentation_events",
      "formal_task_draft_presentation_outbox",
      "feishu_task_creation_executions",
      "feishu_task_creation_execution_events",
      "feishu_task_creations",
      "feishu_task_result_presentations",
      "feishu_task_result_presentation_events",
      "feishu_task_result_presentation_outbox",
    ]) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE ${table}\\b`, "u"));
    }
  });

  it("keeps history append-only and unresolved external effects unique", async () => {
    const sql = await readFile(
      new URL("../migrations/0057_governed_feishu_task_actions.sql", import.meta.url),
      "utf8",
    );

    expect(sql).toMatch(/formal_task_draft_revisions_append_only/iu);
    expect(sql).toMatch(/formal_task_draft_events_append_only/iu);
    expect(sql).toMatch(/feishu_task_creations_append_only/iu);
    expect(sql).toMatch(/feishu_task_creation_one_unresolved_proposal_idx/iu);
    expect(sql).toMatch(/CREATE UNIQUE INDEX feishu_task_creations_remote_guid_idx/iu);
    expect(sql).toMatch(/reminder_minutes IN \(0, 30, 60, 1440\)/iu);
    expect(sql).toMatch(/client_token_hash ~ '\^\[0-9a-f\]\{64\}\$'/iu);
    expect(sql).toMatch(/formal_task_draft_confirmation/iu);
    expect(sql).toMatch(/createFeishuTasks/iu);
  });

  it("extends shared proposals with typed task bindings while preserving publication foreign keys", async () => {
    const [sql, baseSql] = await Promise.all([
      readFile(new URL("../migrations/0057_governed_feishu_task_actions.sql", import.meta.url), "utf8"),
      readFile(new URL("../migrations/0032_action_approval_facts.sql", import.meta.url), "utf8"),
    ]);

    expect(sql).toMatch(/action_type IN \([^)]+create_feishu_task/isu);
    expect(sql).toMatch(/subject_type IN \([^)]+formal_task_draft/isu);
    expect(sql).toMatch(/task_draft_id TEXT/iu);
    expect(sql).toMatch(/task_target_policy_id TEXT[\s\S]+REFERENCES feishu_task_target_policies/iu);
    expect(sql).toMatch(/task_group_confirmation_presentation_id TEXT[\s\S]+REFERENCES formal_task_draft_presentations/iu);
    expect(baseSql).toMatch(/FOREIGN KEY \(subject_id, subject_revision\)[\s\S]+REFERENCES knowledge_draft_revisions/iu);
    expect(sql).not.toMatch(/DROP CONSTRAINT action_proposals_subject_id_subject_revision_fkey/iu);
    expect(sql).toMatch(/FOREIGN KEY \(task_draft_id, task_draft_revision\)[\s\S]+REFERENCES formal_task_draft_revisions/iu);
    expect(sql).toMatch(/action_proposals_action_binding_check/iu);
    expect(sql).toMatch(/action_approval_requirements_policy_binding_check/iu);
  });
});
