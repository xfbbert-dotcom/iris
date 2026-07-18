import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("knowledge card migration contract", () => {
  const migration = readFileSync(
    new URL("../migrations/0031_knowledge_draft_presentations.sql", import.meta.url),
    "utf8",
  );

  it("defines immutable presentation and confirmation facts", () => {
    for (const table of [
      "knowledge_draft_presentations",
      "knowledge_draft_presentation_events",
      "knowledge_draft_group_confirmations",
      "knowledge_draft_presentation_outbox",
    ]) expect(migration).toMatch(new RegExp(`create table ${table}`, "iu"));

    expect(migration).toMatch(/knowledge_draft_presentation_events_append_only/iu);
    expect(migration).toMatch(/knowledge_draft_group_confirmations_append_only/iu);
    expect(migration).toMatch(/knowledge_draft_presentations_one_active_idx/iu);
    expect(migration).toMatch(/where state = 'active'/iu);
    expect(migration).toMatch(/callback_event_id text not null unique/iu);
    expect(migration).toMatch(/drop constraint knowledge_draft_events_event_type_check/iu);
    expect(migration).toMatch(/group_confirmed/iu);
  });
});
