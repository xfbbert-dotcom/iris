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
  });
});
