import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  KnowledgeConflictCallbackIdentityConflictError,
  createPostgresKnowledgeConflictCallbackIdentityStore,
} from "../src/knowledge-conflicts/postgres-knowledge-conflict-callback-identity-store.js";
import { normalizeApprovalInteractionJob } from "../src/knowledge-cards/knowledge-card.js";
import type { KnowledgeConflictConfirmationInteractionJob } from
  "../src/knowledge-cards/knowledge-card.js";

const receivedAt = new Date("2026-08-13T00:00:00.000Z");

describe("PostgresKnowledgeConflictCallbackIdentityStore", () => {
  it("defines an append-only callback identity fact behind an opaque primary key", () => {
    const migration = readFileSync(new URL(
      "../migrations/0047_knowledge_conflict_callback_identities.sql",
      import.meta.url,
    ), "utf8");
    expect(migration).toMatch(/create table knowledge_conflict_callback_identities/iu);
    expect(migration).toMatch(/actor_open_id text not null/iu);
    expect(migration).toMatch(/callback_key text not null unique/iu);
    expect(migration).toMatch(/knowledge_conflict_callback_identities_append_only/iu);
  });

  it("persists verified callback context and resolves it only through the exact opaque job binding", async () => {
    const row = identityRow();
    const query = vi.fn(async (sql: string) => sql.includes("INSERT INTO")
      ? { rows: [{ id: row.id }] }
      : { rows: [row] });
    const store = createPostgresKnowledgeConflictCallbackIdentityStore({
      dataSource: { query } as never,
      idGenerator: () => row.id,
    });

    await expect(store.persistIdentity(identityInput())).resolves.toEqual({ id: row.id });
    const job = conflictJob();
    await expect(store.resolveIdentity({ id: row.id, interaction: job })).resolves.toEqual({
      eventId: "event-1",
      appId: "cli_conflict",
      actorOpenId: "ou_member",
      chatId: "oc_group",
      messageId: "om_conflict_card",
    });
    expect(JSON.stringify(job)).not.toContain("ou_member");
  });

  it("rejects an opaque reference when any replay binding was changed", async () => {
    const store = createPostgresKnowledgeConflictCallbackIdentityStore({
      dataSource: { query: vi.fn(async () => ({ rows: [identityRow()] })) } as never,
    });

    await expect(store.resolveIdentity({
      id: "callback-identity-1",
      interaction: conflictJob({ action: "not_a_conflict" }),
    })).rejects.toBeInstanceOf(KnowledgeConflictCallbackIdentityConflictError);
  });

  it("reuses the first opaque identity when an exact event is redelivered at a later arrival time", async () => {
    const row = identityRow();
    row.operation_fingerprint = createHash("sha256").update(JSON.stringify([
      "knowledge_conflict_callback_identity_v2",
      "feishu-card:cli_conflict:event-1",
      "event-1",
      "cli_conflict",
      "ou_member",
      "oc_group",
      "om_conflict_card",
      "candidate-1",
      "candidate-1",
      3,
      "oc_group",
      "nonce-1",
      "create_update_draft",
    ])).digest("hex");
    let insertCount = 0;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO")) {
        insertCount += 1;
        return { rows: insertCount === 1 ? [{ id: row.id }] : [] };
      }
      return { rows: [row] };
    });
    const store = createPostgresKnowledgeConflictCallbackIdentityStore({
      dataSource: { query } as never,
      idGenerator: () => row.id,
    });
    const later = new Date(receivedAt.getTime() + 30_000);

    await expect(store.persistIdentity(identityInput())).resolves.toEqual({ id: row.id });
    await expect(store.persistIdentity(identityInput({ receivedAt: later })))
      .resolves.toEqual({ id: row.id });
    await expect(store.resolveIdentity({
      id: row.id,
      interaction: conflictJob({ receivedAt: later }),
    })).resolves.toMatchObject({ actorOpenId: "ou_member", messageId: "om_conflict_card" });
    await expect(store.persistIdentity(identityInput({
      receivedAt: later,
      action: "not_a_conflict",
    }))).rejects.toBeInstanceOf(KnowledgeConflictCallbackIdentityConflictError);
  });
});

function identityInput(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: "feishu-card:cli_conflict:event-1",
    eventId: "event-1",
    appId: "cli_conflict",
    actorOpenId: "ou_member",
    chatId: "oc_group",
    messageId: "om_conflict_card",
    presentationId: "candidate-1",
    candidateId: "candidate-1",
    candidateVersion: 3,
    groupId: "oc_group",
    nonce: "nonce-1",
    action: "create_update_draft" as const,
    receivedAt,
    ...overrides,
  };
}

function conflictJob(overrides: Record<string, unknown> = {}): KnowledgeConflictConfirmationInteractionJob {
  return normalizeApprovalInteractionJob({
    kind: "knowledge_conflict_confirmation",
    idempotencyKey: "feishu-card:cli_conflict:event-1",
    callbackIdentityId: "callback-identity-1",
    presentationId: "candidate-1",
    candidateId: "candidate-1",
    candidateVersion: 3,
    groupId: "oc_group",
    nonce: "nonce-1",
    action: "create_update_draft",
    receivedAt,
    attempts: 0,
    ...overrides,
  }) as KnowledgeConflictConfirmationInteractionJob;
}

function identityRow() {
  return {
    id: "callback-identity-1",
    callback_key: "feishu-card:cli_conflict:event-1",
    event_id: "event-1",
    app_id: "cli_conflict",
    actor_open_id: "ou_member",
    chat_id: "oc_group",
    message_id: "om_conflict_card",
    presentation_id: "candidate-1",
    candidate_id: "candidate-1",
    candidate_version: 3,
    group_id: "oc_group",
    nonce: "nonce-1",
    action: "create_update_draft",
    operation_fingerprint: createHash("sha256").update(JSON.stringify([
      "knowledge_conflict_callback_identity_v1",
      "feishu-card:cli_conflict:event-1",
      "event-1",
      "cli_conflict",
      "ou_member",
      "oc_group",
      "om_conflict_card",
      "candidate-1",
      "candidate-1",
      3,
      "oc_group",
      "nonce-1",
      "create_update_draft",
      receivedAt.toISOString(),
    ])).digest("hex"),
    received_at: receivedAt,
    created_at: receivedAt,
  };
}
