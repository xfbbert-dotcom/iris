import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("knowledge publication migration contract", () => {
  const migration = readFileSync(
    new URL("../migrations/0035_knowledge_publications.sql", import.meta.url),
    "utf8",
  );
  const draftPublicationMetadataMigration = readFileSync(
    new URL("../migrations/0036_knowledge_draft_publication_metadata.sql", import.meta.url),
    "utf8",
  );

  it("defines append-only publication facts for exact approved draft revisions", () => {
    expect(migration).toMatch(/create table knowledge_publications/iu);
    expect(migration).toMatch(/proposal_id/iu);
    expect(migration).toMatch(/execution_id/iu);
    expect(migration).toMatch(/draft_id/iu);
    expect(migration).toMatch(/revision_number/iu);
    expect(migration).toMatch(/draft_version/iu);
    expect(migration).toMatch(/target_policy_id/iu);
    expect(migration).toMatch(/target_policy_version/iu);
    expect(migration).toMatch(/space_id/iu);
    expect(migration).toMatch(/remote_node_token/iu);
    expect(migration).toMatch(/remote_document_token/iu);
    expect(migration).toMatch(/remote_document_version/iu);
    expect(migration).toMatch(/content_hash/iu);
    expect(migration).toMatch(/permission_check_summary/iu);
    expect(migration).toMatch(/published_at/iu);
    expect(migration).toMatch(/unique \(draft_id, revision_number\)/iu);
    expect(migration).toMatch(/knowledge_publications_append_only/iu);
    expect(migration).toMatch(/knowledge_publications_truncate_guard/iu);
    expect(migration).toMatch(/publication_succeeded/iu);
  });

  it("adds publication metadata columns to knowledge drafts", () => {
    expect(draftPublicationMetadataMigration).toMatch(/alter table knowledge_drafts/iu);
    expect(draftPublicationMetadataMigration).toMatch(/add column published_at timestamptz/iu);
    expect(draftPublicationMetadataMigration).toMatch(/add column published_by text/iu);
  });
});
