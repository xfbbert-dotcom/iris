import { describe, expect, it } from "vitest";
import {
  createDocumentSourceRegistry,
  documentSourceEvidenceKey,
  documentSourceTypePriority,
  higherPriorityDocumentSourceType,
  type DocumentPermissionState,
  type DocumentSourceEvidence,
  type DocumentSourceEvidenceKind,
  type DocumentSourceRegistryDependencies,
  type DocumentSourceType,
  DocumentSourceValidationError,
} from "../src/documents/document-source-registry.js";

const documentSourceTypes = [
  "group_visible_document",
  "authorized_wiki_document",
  "user_submitted_document",
] satisfies DocumentSourceType[];

const documentPermissionStates = [
  "unknown",
  "readable",
  "denied",
  "stale",
] satisfies DocumentPermissionState[];

const documentSourceEvidenceKinds = [
  "group_message",
  "admin_authorization",
  "user_submission",
] satisfies DocumentSourceEvidenceKind[];

const adminAuthorizationEvidence: DocumentSourceEvidence = {
  kind: "admin_authorization",
  sourceUri: "https://example.com/wiki/space-1",
  spaceId: "space-1",
  observedAt: new Date("2026-07-01T04:02:00.000Z"),
};

const optionalDependencies = {} satisfies DocumentSourceRegistryDependencies;

describe("document source merge helpers", () => {
  it("exposes source type priority for merge decisions", () => {
    expect(documentSourceTypePriority("authorized_wiki_document")).toBeGreaterThan(
      documentSourceTypePriority("group_visible_document"),
    );
  });

  it("returns the higher priority source type", () => {
    expect(
      higherPriorityDocumentSourceType("authorized_wiki_document", "group_visible_document"),
    ).toBe("authorized_wiki_document");
  });

  it("builds evidence keys without observedAt", () => {
    const first: DocumentSourceEvidence = {
      kind: "group_message",
      sourceUri: "https://example.com/docs/doc-1",
      groupId: "group-1",
      messageId: "message-1",
      observedAt: new Date("2026-07-01T04:01:00.000Z"),
    };
    const second: DocumentSourceEvidence = {
      ...first,
      observedAt: new Date("2026-07-01T04:02:00.000Z"),
    };

    expect(documentSourceEvidenceKey(first)).toBe(documentSourceEvidenceKey(second));
  });
});

describe("createDocumentSourceRegistry", () => {
  it("registers a group_visible_document with defaults and evidence", () => {
    expect(documentSourceTypes).toContain("group_visible_document");
    expect(documentPermissionStates).toContain("unknown");
    expect(documentSourceEvidenceKinds).toContain("group_message");
    expect(adminAuthorizationEvidence.groupId).toBeUndefined();
    expect(adminAuthorizationEvidence.messageId).toBeUndefined();
    expect(optionalDependencies).toEqual({});

    const createdAt = new Date("2026-07-01T04:00:00.000Z");
    const observedAt = new Date("2026-07-01T04:01:00.000Z");
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
      now: () => createdAt,
    });

    const source = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/docs/doc-1",
      title: "  Launch Notes  ",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedByUserId: " user-1 ",
      observedAt,
    });

    expect(source).toEqual({
      id: "doc-source-1",
      sourceType: "group_visible_document",
      sourceUri: "https://example.com/docs/doc-1",
      title: "Launch Notes",
      originGroupId: "group-1",
      originMessageId: "message-1",
      submittedByUserId: undefined,
      authorizedSpaceId: undefined,
      permissionState: "unknown",
      syncState: "pending",
      canUseForAnswering: true,
      canUseForKnowledgeDrafts: true,
      createdAt,
      updatedAt: createdAt,
      evidence: [
        {
          kind: "group_message",
          sourceUri: "https://example.com/docs/doc-1",
          groupId: "group-1",
          messageId: "message-1",
          userId: "user-1",
          spaceId: undefined,
          observedAt,
        },
      ],
    });
  });

  it("throws DocumentSourceValidationError for blank sourceUri", () => {
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
      now: () => new Date("2026-07-01T04:00:00.000Z"),
    });

    expect(() =>
      registry.registerGroupVisibleDocument({
        sourceUri: "   ",
        originGroupId: "group-1",
        originMessageId: "message-1",
        observedAt: new Date("2026-07-01T04:01:00.000Z"),
      }),
    ).toThrow(DocumentSourceValidationError);
  });

  it("rejects oversized registration strings before storing evidence", () => {
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
      now: () => new Date("2026-07-01T04:00:00.000Z"),
    });

    expect(() =>
      registry.registerGroupVisibleDocument({
        sourceUri: "x".repeat(2049),
        originGroupId: "group-1",
        originMessageId: "message-1",
        observedAt: new Date("2026-07-01T04:01:00.000Z"),
      }),
    ).toThrow("sourceUri must be at most 2048 characters");
    expect(() =>
      registry.registerGroupVisibleDocument({
        sourceUri: "https://example.com/docs/doc-1",
        title: "t".repeat(513),
        originGroupId: "group-1",
        originMessageId: "message-1",
        observedAt: new Date("2026-07-01T04:01:00.000Z"),
      }),
    ).toThrow("title must be at most 512 characters");
    expect(registry.listSources()).toEqual([]);
  });

  it("rejects invalid evidence timestamps before storing evidence", () => {
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
      now: () => new Date("2026-07-01T04:00:00.000Z"),
    });

    expect(() =>
      registry.registerGroupVisibleDocument({
        sourceUri: "https://example.com/docs/doc-1",
        originGroupId: "group-1",
        originMessageId: "message-1",
        observedAt: new Date("invalid"),
      }),
    ).toThrow("observedAt must be a valid date");
    expect(registry.listSources()).toEqual([]);
  });

  it("registers an authorized_wiki_document with defaults and evidence", () => {
    const createdAt = new Date("2026-07-01T04:00:00.000Z");
    const observedAt = new Date("2026-07-01T04:02:00.000Z");
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
      now: () => createdAt,
    });

    const source = registry.registerAuthorizedWikiDocument({
      sourceUri: "https://example.com/wiki/space-1",
      title: "  Wiki Space  ",
      authorizedSpaceId: "space-1",
      observedAt,
    });

    expect(source).toEqual({
      id: "doc-source-1",
      sourceType: "authorized_wiki_document",
      sourceUri: "https://example.com/wiki/space-1",
      title: "Wiki Space",
      originGroupId: undefined,
      originMessageId: undefined,
      submittedByUserId: undefined,
      authorizedSpaceId: "space-1",
      permissionState: "unknown",
      syncState: "pending",
      canUseForAnswering: true,
      canUseForKnowledgeDrafts: true,
      createdAt,
      updatedAt: createdAt,
      evidence: [
        {
          kind: "admin_authorization",
          sourceUri: "https://example.com/wiki/space-1",
          groupId: undefined,
          messageId: undefined,
          userId: undefined,
          spaceId: "space-1",
          observedAt,
        },
      ],
    });
  });

  it("registers a user_submitted_document with defaults and evidence", () => {
    const createdAt = new Date("2026-07-01T04:00:00.000Z");
    const observedAt = new Date("2026-07-01T04:03:00.000Z");
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
      now: () => createdAt,
    });

    const source = registry.registerUserSubmittedDocument({
      sourceUri: "https://example.com/uploads/user-guide.pdf",
      title: "  User Guide  ",
      submittedByUserId: "user-1",
      observedAt,
    });

    expect(source).toEqual({
      id: "doc-source-1",
      sourceType: "user_submitted_document",
      sourceUri: "https://example.com/uploads/user-guide.pdf",
      title: "User Guide",
      originGroupId: undefined,
      originMessageId: undefined,
      submittedByUserId: "user-1",
      authorizedSpaceId: undefined,
      permissionState: "unknown",
      syncState: "pending",
      canUseForAnswering: true,
      canUseForKnowledgeDrafts: false,
      createdAt,
      updatedAt: createdAt,
      evidence: [
        {
          kind: "user_submission",
          sourceUri: "https://example.com/uploads/user-guide.pdf",
          groupId: undefined,
          messageId: undefined,
          userId: "user-1",
          spaceId: undefined,
          observedAt,
        },
      ],
    });
  });

  it("deduplicates by sourceUri and appends distinct group evidence", () => {
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
      now: () => new Date("2026-07-01T04:00:00.000Z"),
    });

    const first = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/docs/doc-1",
      title: "Launch Notes",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedAt: new Date("2026-07-01T04:01:00.000Z"),
    });
    const second = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/docs/doc-1",
      originGroupId: "group-2",
      originMessageId: "message-2",
      observedAt: new Date("2026-07-01T04:02:00.000Z"),
    });

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toEqual(first.createdAt);
    expect(second.updatedAt).toEqual(new Date("2026-07-01T04:00:00.000Z"));
    expect(second.evidence).toHaveLength(2);
    expect(second.evidence).toMatchObject([
      { kind: "group_message", groupId: "group-1", messageId: "message-1" },
      { kind: "group_message", groupId: "group-2", messageId: "message-2" },
    ]);
  });

  it("does not append duplicate evidence for retried Feishu message events", () => {
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
      now: () => new Date("2026-07-01T04:00:00.000Z"),
    });

    registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/docs/doc-1",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedAt: new Date("2026-07-01T04:01:00.000Z"),
    });
    const retried = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/docs/doc-1",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedAt: new Date("2026-07-01T04:02:00.000Z"),
    });

    expect(retried.evidence).toHaveLength(1);
    expect(retried.evidence[0]?.observedAt).toEqual(new Date("2026-07-01T04:01:00.000Z"));
  });

  it("does not refresh updatedAt for duplicate evidence retries without metadata changes", () => {
    let now = new Date("2026-07-01T04:00:00.000Z");
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
      now: () => now,
    });

    const first = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/docs/doc-1",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedAt: new Date("2026-07-01T04:01:00.000Z"),
    });
    now = new Date("2026-07-01T05:00:00.000Z");
    const retried = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/docs/doc-1",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedAt: new Date("2026-07-01T05:01:00.000Z"),
    });

    expect(retried.updatedAt).toEqual(first.updatedAt);
    expect(registry.listSources()[0]?.updatedAt).toEqual(first.updatedAt);
  });

  it("upgrades sourceType for admin authorization and does not downgrade later", () => {
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
      now: () => new Date("2026-07-01T04:00:00.000Z"),
    });

    const userSubmitted = registry.registerUserSubmittedDocument({
      sourceUri: "https://example.com/wiki/space-1/doc-1",
      submittedByUserId: "user-1",
      observedAt: new Date("2026-07-01T04:01:00.000Z"),
    });
    const authorized = registry.registerAuthorizedWikiDocument({
      sourceUri: "https://example.com/wiki/space-1/doc-1",
      authorizedSpaceId: "space-1",
      observedAt: new Date("2026-07-01T04:02:00.000Z"),
    });
    const groupVisible = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/wiki/space-1/doc-1",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedAt: new Date("2026-07-01T04:03:00.000Z"),
    });

    expect(authorized.id).toBe(userSubmitted.id);
    expect(authorized.sourceType).toBe("authorized_wiki_document");
    expect(authorized.canUseForKnowledgeDrafts).toBe(true);
    expect(groupVisible.sourceType).toBe("authorized_wiki_document");
    expect(groupVisible.canUseForKnowledgeDrafts).toBe(true);
    expect(groupVisible.evidence).toHaveLength(3);
    expect(groupVisible.evidence.map((evidence) => evidence.kind)).toEqual([
      "user_submission",
      "admin_authorization",
      "group_message",
    ]);
  });

  it("keeps an explicit user submission canonical when the same message is discovered generically", () => {
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
      now: () => new Date("2026-07-28T11:30:00.000Z"),
    });

    registry.registerUserSubmittedDocument({
      sourceUri: "https://example.com/wiki/user-submitted-doc",
      submittedByUserId: "user-1",
      submissionGroupId: "group-1",
      submissionMessageId: "message-1",
      observedAt: new Date("2026-07-28T11:29:00.000Z"),
    });
    const discovered = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/wiki/user-submitted-doc",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedByUserId: "user-1",
      observedAt: new Date("2026-07-28T11:29:00.000Z"),
    });

    expect(discovered.sourceType).toBe("user_submitted_document");
    expect(discovered.canUseForKnowledgeDrafts).toBe(false);
    expect(discovered.evidence).toEqual([
      {
        kind: "user_submission",
        sourceUri: "https://example.com/wiki/user-submitted-doc",
        groupId: "group-1",
        messageId: "message-1",
        userId: "user-1",
        spaceId: undefined,
        observedAt: new Date("2026-07-28T11:29:00.000Z"),
      },
      {
        kind: "group_message",
        sourceUri: "https://example.com/wiki/user-submitted-doc",
        groupId: "group-1",
        messageId: "message-1",
        userId: "user-1",
        spaceId: undefined,
        observedAt: new Date("2026-07-28T11:29:00.000Z"),
      },
    ]);
  });

  it("keeps the same-message result canonical when generic discovery runs first", () => {
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
      now: () => new Date("2026-07-28T11:30:00.000Z"),
    });

    registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/wiki/reverse-order-doc",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedByUserId: "user-1",
      observedAt: new Date("2026-07-28T11:29:00.000Z"),
    });
    const submitted = registry.registerUserSubmittedDocument({
      sourceUri: "https://example.com/wiki/reverse-order-doc",
      submittedByUserId: "user-1",
      submissionGroupId: "group-1",
      submissionMessageId: "message-1",
      observedAt: new Date("2026-07-28T11:29:00.000Z"),
    });

    expect(submitted.sourceType).toBe("user_submitted_document");
    expect(submitted.canUseForKnowledgeDrafts).toBe(false);
    expect(submitted.evidence.map((evidence) => evidence.kind)).toEqual([
      "group_message",
      "user_submission",
    ]);
  });

  it("deduplicates retries of both same-message registration paths", () => {
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
      now: () => new Date("2026-07-28T11:30:00.000Z"),
    });
    const userSubmission = {
      sourceUri: "https://example.com/wiki/retried-doc",
      submittedByUserId: "user-1",
      submissionGroupId: "group-1",
      submissionMessageId: "message-1",
      observedAt: new Date("2026-07-28T11:29:00.000Z"),
    };
    const groupDiscovery = {
      sourceUri: "https://example.com/wiki/retried-doc",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedByUserId: "user-1",
      observedAt: new Date("2026-07-28T11:29:00.000Z"),
    };

    registry.registerUserSubmittedDocument(userSubmission);
    registry.registerGroupVisibleDocument(groupDiscovery);
    registry.registerUserSubmittedDocument(userSubmission);
    const retried = registry.registerGroupVisibleDocument(groupDiscovery);

    expect(retried.sourceType).toBe("user_submitted_document");
    expect(retried.evidence).toHaveLength(2);
  });

  it.each([
    {
      name: "message differs",
      independentGroupId: "group-1",
      independentMessageId: "message-2",
    },
    {
      name: "group differs",
      independentGroupId: "group-2",
      independentMessageId: "message-1",
    },
  ])("uses normal group precedence when only the $name", ({
    independentGroupId,
    independentMessageId,
  }) => {
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
      now: () => new Date("2026-07-28T11:30:00.000Z"),
    });

    registry.registerUserSubmittedDocument({
      sourceUri: "https://example.com/wiki/independent-group-doc",
      submittedByUserId: "user-1",
      submissionGroupId: "group-1",
      submissionMessageId: "message-1",
      observedAt: new Date("2026-07-28T11:29:00.000Z"),
    });
    registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/wiki/independent-group-doc",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedByUserId: "user-1",
      observedAt: new Date("2026-07-28T11:29:00.000Z"),
    });
    const independent = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/wiki/independent-group-doc",
      originGroupId: independentGroupId,
      originMessageId: independentMessageId,
      observedByUserId: "user-2",
      observedAt: new Date("2026-07-28T11:35:00.000Z"),
    });

    expect(independent.sourceType).toBe("group_visible_document");
    expect(independent.evidence).toHaveLength(3);
  });

  it("preserves an administrator-enabled knowledge-draft policy during same-message discovery", () => {
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
    });
    const submitted = registry.registerUserSubmittedDocument({
      sourceUri: "https://example.com/wiki/admin-enabled-doc",
      submittedByUserId: "user-1",
      submissionGroupId: "group-1",
      submissionMessageId: "message-1",
      observedAt: new Date("2026-07-28T11:29:00.000Z"),
    });
    registry.setKnowledgeDraftsEnabled(submitted.id, true);

    const discovered = registry.registerGroupVisibleDocument({
      sourceUri: submitted.sourceUri,
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedAt: new Date("2026-07-28T11:29:00.000Z"),
    });

    expect(discovered.sourceType).toBe("user_submitted_document");
    expect(discovered.canUseForKnowledgeDrafts).toBe(true);
  });

  it("preserves an administrator-disabled knowledge-draft policy when discovery runs first", () => {
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
    });
    const discovered = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/wiki/admin-disabled-doc",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedAt: new Date("2026-07-28T11:29:00.000Z"),
    });
    registry.setKnowledgeDraftsEnabled(discovered.id, false);

    const submitted = registry.registerUserSubmittedDocument({
      sourceUri: discovered.sourceUri,
      submittedByUserId: "user-1",
      submissionGroupId: "group-1",
      submissionMessageId: "message-1",
      observedAt: new Date("2026-07-28T11:29:00.000Z"),
    });

    expect(submitted.sourceType).toBe("user_submitted_document");
    expect(submitted.canUseForKnowledgeDrafts).toBe(false);
  });

  it("requires user-submission group and message provenance together", () => {
    const registry = createDocumentSourceRegistry();

    expect(() =>
      registry.registerUserSubmittedDocument({
        sourceUri: "https://example.com/wiki/incomplete-provenance",
        submittedByUserId: "user-1",
        submissionGroupId: "group-1",
        observedAt: new Date("2026-07-28T11:29:00.000Z"),
      }),
    ).toThrow(DocumentSourceValidationError);
    expect(() =>
      registry.registerUserSubmittedDocument({
        sourceUri: "https://example.com/wiki/incomplete-provenance",
        submittedByUserId: "user-1",
        submissionMessageId: "message-1",
        observedAt: new Date("2026-07-28T11:29:00.000Z"),
      }),
    ).toThrow(DocumentSourceValidationError);
  });

  it("marks denied permissionState and disables answering", () => {
    const updatedAt = new Date("2026-07-01T04:05:00.000Z");
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
      now: () => updatedAt,
    });
    const source = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/docs/doc-1",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedAt: new Date("2026-07-01T04:01:00.000Z"),
    });

    const updated = registry.markPermissionState(source.id, "denied");

    expect(updated.permissionState).toBe("denied");
    expect(updated.canUseForAnswering).toBe(false);
    expect(updated.canUseForKnowledgeDrafts).toBe(false);
    expect(updated.updatedAt).toEqual(updatedAt);
  });

  it("marks stale permissionState without disabling answering", () => {
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
      now: () => new Date("2026-07-01T04:05:00.000Z"),
    });
    const source = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/docs/doc-1",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedAt: new Date("2026-07-01T04:01:00.000Z"),
    });

    const updated = registry.markPermissionState(source.id, "stale");

    expect(updated.permissionState).toBe("stale");
    expect(updated.canUseForAnswering).toBe(true);
  });

  it("marks syncState from syncing to synced", () => {
    let now = new Date("2026-07-01T04:00:00.000Z");
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
      now: () => now,
    });
    const source = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/docs/doc-1",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedAt: new Date("2026-07-01T04:01:00.000Z"),
    });

    now = new Date("2026-07-01T04:05:00.000Z");
    const syncing = registry.markSyncState(source.id, "syncing");
    now = new Date("2026-07-01T04:06:00.000Z");
    const synced = registry.markSyncState(source.id, "synced");

    expect(syncing.syncState).toBe("syncing");
    expect(synced.syncState).toBe("synced");
    expect(synced.updatedAt).toEqual(new Date("2026-07-01T04:06:00.000Z"));
  });

  it("resets failed sync state to pending when new evidence is registered", () => {
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
      now: () => new Date("2026-07-01T04:00:00.000Z"),
    });
    const source = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/docs/doc-1",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedAt: new Date("2026-07-01T04:01:00.000Z"),
    });

    registry.markSyncState(source.id, "failed");
    const rediscovered = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/docs/doc-1",
      originGroupId: "group-1",
      originMessageId: "message-2",
      observedAt: new Date("2026-07-01T04:02:00.000Z"),
    });

    expect(rediscovered.syncState).toBe("pending");
    expect(rediscovered.evidence.map((evidence) => evidence.messageId)).toEqual([
      "message-1",
      "message-2",
    ]);
  });

  it("keeps failed sync state when duplicate evidence is retried", () => {
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
      now: () => new Date("2026-07-01T04:00:00.000Z"),
    });
    const source = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/docs/doc-1",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedAt: new Date("2026-07-01T04:01:00.000Z"),
    });

    registry.markSyncState(source.id, "failed");
    const retried = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/docs/doc-1",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedAt: new Date("2026-07-01T04:02:00.000Z"),
    });

    expect(retried.syncState).toBe("failed");
    expect(retried.evidence).toHaveLength(1);
  });

  it("keeps answering disabled when re-registering the same group visible sourceUri", () => {
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
      now: () => new Date("2026-07-01T04:00:00.000Z"),
    });
    const source = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/docs/doc-1",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedAt: new Date("2026-07-01T04:01:00.000Z"),
    });

    registry.setAnsweringEnabled(source.id, false);
    const reregistered = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/docs/doc-1",
      originGroupId: "group-2",
      originMessageId: "message-2",
      observedAt: new Date("2026-07-01T04:02:00.000Z"),
    });

    expect(reregistered.canUseForAnswering).toBe(false);
  });

  it("keeps knowledge drafts disabled when re-registering the same group visible sourceUri", () => {
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
      now: () => new Date("2026-07-01T04:00:00.000Z"),
    });
    const source = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/docs/doc-1",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedAt: new Date("2026-07-01T04:01:00.000Z"),
    });

    registry.setKnowledgeDraftsEnabled(source.id, false);
    const reregistered = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/docs/doc-1",
      originGroupId: "group-2",
      originMessageId: "message-2",
      observedAt: new Date("2026-07-01T04:02:00.000Z"),
    });

    expect(reregistered.canUseForKnowledgeDrafts).toBe(false);
  });

  it("does not re-enable knowledge drafts for denied sources when registration upgrades capability", () => {
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
      now: () => new Date("2026-07-01T04:00:00.000Z"),
    });
    const source = registry.registerUserSubmittedDocument({
      sourceUri: "https://example.com/docs/doc-1",
      submittedByUserId: "user-1",
      observedAt: new Date("2026-07-01T04:01:00.000Z"),
    });

    registry.markPermissionState(source.id, "denied");
    const reregistered = registry.registerAuthorizedWikiDocument({
      sourceUri: "https://example.com/docs/doc-1",
      authorizedSpaceId: "space-1",
      observedAt: new Date("2026-07-01T04:02:00.000Z"),
    });

    expect(reregistered.permissionState).toBe("denied");
    expect(reregistered.sourceType).toBe("authorized_wiki_document");
    expect(reregistered.canUseForKnowledgeDrafts).toBe(false);
  });

  it("does not re-enable manually disabled user-submitted knowledge drafts when registration upgrades capability", () => {
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
      now: () => new Date("2026-07-01T04:00:00.000Z"),
    });
    const source = registry.registerUserSubmittedDocument({
      sourceUri: "https://example.com/docs/doc-1",
      submittedByUserId: "user-1",
      observedAt: new Date("2026-07-01T04:01:00.000Z"),
    });

    registry.setKnowledgeDraftsEnabled(source.id, false);
    const reregistered = registry.registerAuthorizedWikiDocument({
      sourceUri: "https://example.com/docs/doc-1",
      authorizedSpaceId: "space-1",
      observedAt: new Date("2026-07-01T04:02:00.000Z"),
    });

    expect(reregistered.sourceType).toBe("authorized_wiki_document");
    expect(reregistered.canUseForKnowledgeDrafts).toBe(false);
  });

  it("keeps answering disabled while permission is denied", () => {
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
      now: () => new Date("2026-07-01T04:00:00.000Z"),
    });
    const source = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/docs/doc-1",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedAt: new Date("2026-07-01T04:01:00.000Z"),
    });

    registry.markPermissionState(source.id, "denied");
    const updated = registry.setAnsweringEnabled(source.id, true);

    expect(updated.permissionState).toBe("denied");
    expect(updated.canUseForAnswering).toBe(false);
  });

  it("keeps knowledge drafts disabled while permission is denied", () => {
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
      now: () => new Date("2026-07-01T04:00:00.000Z"),
    });
    const source = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/docs/doc-1",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedAt: new Date("2026-07-01T04:01:00.000Z"),
    });

    registry.markPermissionState(source.id, "denied");
    const updated = registry.setKnowledgeDraftsEnabled(source.id, true);

    expect(updated.permissionState).toBe("denied");
    expect(updated.canUseForKnowledgeDrafts).toBe(false);
  });

  it("enables knowledge drafts for user_submitted_document after opt-in", () => {
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
      now: () => new Date("2026-07-01T04:00:00.000Z"),
    });
    const source = registry.registerUserSubmittedDocument({
      sourceUri: "https://example.com/uploads/user-guide.pdf",
      submittedByUserId: "user-1",
      observedAt: new Date("2026-07-01T04:01:00.000Z"),
    });

    const updated = registry.setKnowledgeDraftsEnabled(source.id, true);

    expect(source.canUseForKnowledgeDrafts).toBe(false);
    expect(updated.canUseForKnowledgeDrafts).toBe(true);
  });

  it("updates answering and knowledge draft policy together", () => {
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
      now: () => new Date("2026-07-01T04:05:00.000Z"),
    });
    const source = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/docs/doc-1",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedAt: new Date("2026-07-01T04:01:00.000Z"),
    });

    const updated = registry.updatePolicy(source.id, {
      canUseForAnswering: false,
      canUseForKnowledgeDrafts: false,
    });

    expect(updated.canUseForAnswering).toBe(false);
    expect(updated.canUseForKnowledgeDrafts).toBe(false);
    expect(updated.updatedAt).toEqual(new Date("2026-07-01T04:05:00.000Z"));
  });

  it("throws DocumentSourceValidationError when mutating an unknown id", () => {
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
      now: () => new Date("2026-07-01T04:00:00.000Z"),
    });

    expect(() => registry.markPermissionState("missing-source", "denied")).toThrow(
      DocumentSourceValidationError,
    );
    expect(() => registry.markSyncState("missing-source", "syncing")).toThrow(
      DocumentSourceValidationError,
    );
    expect(() => registry.setAnsweringEnabled("missing-source", false)).toThrow(
      DocumentSourceValidationError,
    );
    expect(() => registry.setKnowledgeDraftsEnabled("missing-source", true)).toThrow(
      DocumentSourceValidationError,
    );
    expect(() =>
      registry.updatePolicy("missing-source", {
        canUseForAnswering: false,
      }),
    ).toThrow(DocumentSourceValidationError);
  });

  it("lists sources in deterministic updatedAt order", () => {
    let nowIndex = 0;
    const times = [
      new Date("2026-07-01T04:00:00.000Z"),
      new Date("2026-07-01T04:01:00.000Z"),
    ];
    const registry = createDocumentSourceRegistry({
      createId: (() => {
        let id = 0;
        return () => `doc-source-${++id}`;
      })(),
      now: () => times[nowIndex++] ?? times.at(-1)!,
    });

    const first = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/docs/doc-1",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedAt: new Date("2026-07-01T04:01:00.000Z"),
    });
    const second = registry.registerUserSubmittedDocument({
      sourceUri: "https://example.com/uploads/user-guide.pdf",
      submittedByUserId: "user-1",
      observedAt: new Date("2026-07-01T04:02:00.000Z"),
    });

    expect(registry.listSources().map((source) => source.id)).toEqual([second.id, first.id]);
  });

  it("finds sources by id and URI", () => {
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
      now: () => new Date("2026-07-01T04:00:00.000Z"),
    });
    const source = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/docs/doc-1",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedAt: new Date("2026-07-01T04:01:00.000Z"),
    });

    expect(registry.findSourceById(source.id)?.sourceUri).toBe(source.sourceUri);
    expect(registry.findSourceByUri(source.sourceUri)?.id).toBe(source.id);
  });

  it("filters sources by type, group, space, submitting user, and answering capability", () => {
    let id = 0;
    const registry = createDocumentSourceRegistry({
      createId: () => `doc-source-${++id}`,
      now: () => new Date("2026-07-01T04:00:00.000Z"),
    });

    const groupSource = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/docs/doc-1",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedAt: new Date("2026-07-01T04:01:00.000Z"),
    });
    const wikiSource = registry.registerAuthorizedWikiDocument({
      sourceUri: "https://example.com/wiki/space-1",
      authorizedSpaceId: "space-1",
      observedAt: new Date("2026-07-01T04:02:00.000Z"),
    });
    const userSource = registry.registerUserSubmittedDocument({
      sourceUri: "https://example.com/uploads/user-guide.pdf",
      submittedByUserId: "user-1",
      observedAt: new Date("2026-07-01T04:03:00.000Z"),
    });
    registry.setAnsweringEnabled(userSource.id, false);

    expect(registry.listSourcesByType("group_visible_document").map((source) => source.id)).toEqual([
      groupSource.id,
    ]);
    expect(registry.listSourcesByGroupId("group-1").map((source) => source.id)).toEqual([
      groupSource.id,
    ]);
    expect(registry.listSourcesByAuthorizedSpaceId("space-1").map((source) => source.id)).toEqual([
      wikiSource.id,
    ]);
    expect(registry.listSourcesBySubmittingUserId("user-1").map((source) => source.id)).toEqual([
      userSource.id,
    ]);
    expect(registry.listSourcesUsableForAnswering().map((source) => source.id)).not.toContain(
      userSource.id,
    );
    expect(registry.listSourcesByAnsweringEnabled(false).map((source) => source.id)).toEqual([
      userSource.id,
    ]);
    expect(registry.listSourcesByAnsweringEnabled(true).map((source) => source.id)).toEqual([
      groupSource.id,
      wikiSource.id,
    ]);
  });

  it("filters sources by evidence from repeated registrations", () => {
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
      now: () => new Date("2026-07-01T04:00:00.000Z"),
    });

    registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/docs/doc-1",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedAt: new Date("2026-07-01T04:01:00.000Z"),
    });
    registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/docs/doc-1",
      originGroupId: "group-2",
      originMessageId: "message-2",
      observedAt: new Date("2026-07-01T04:02:00.000Z"),
    });
    registry.registerAuthorizedWikiDocument({
      sourceUri: "https://example.com/docs/doc-1",
      authorizedSpaceId: "space-2",
      observedAt: new Date("2026-07-01T04:03:00.000Z"),
    });
    registry.registerUserSubmittedDocument({
      sourceUri: "https://example.com/docs/doc-1",
      submittedByUserId: "user-2",
      observedAt: new Date("2026-07-01T04:04:00.000Z"),
    });

    expect(registry.listSourcesByGroupId("group-2").map((source) => source.sourceUri)).toEqual([
      "https://example.com/docs/doc-1",
    ]);
    expect(registry.listSourcesByAuthorizedSpaceId("space-2").map((source) => source.sourceUri)).toEqual([
      "https://example.com/docs/doc-1",
    ]);
    expect(registry.listSourcesBySubmittingUserId("user-2").map((source) => source.sourceUri)).toEqual([
      "https://example.com/docs/doc-1",
    ]);
  });

  it("normalizes filter identifiers before matching sources", () => {
    let id = 0;
    const registry = createDocumentSourceRegistry({
      createId: () => `doc-source-${++id}`,
      now: () => new Date("2026-07-01T04:00:00.000Z"),
    });

    const groupSource = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/docs/doc-1",
      originGroupId: " group-1 ",
      originMessageId: "message-1",
      observedAt: new Date("2026-07-01T04:01:00.000Z"),
    });
    const wikiSource = registry.registerAuthorizedWikiDocument({
      sourceUri: "https://example.com/wiki/space-1",
      authorizedSpaceId: " space-1 ",
      observedAt: new Date("2026-07-01T04:02:00.000Z"),
    });
    const userSource = registry.registerUserSubmittedDocument({
      sourceUri: "https://example.com/uploads/user-guide.pdf",
      submittedByUserId: " user-1 ",
      observedAt: new Date("2026-07-01T04:03:00.000Z"),
    });

    expect(registry.listSourcesByGroupId(" group-1 ").map((source) => source.id)).toEqual([
      groupSource.id,
    ]);
    expect(registry.listSourcesByAuthorizedSpaceId(" space-1 ").map((source) => source.id)).toEqual([
      wikiSource.id,
    ]);
    expect(registry.listSourcesBySubmittingUserId(" user-1 ").map((source) => source.id)).toEqual([
      userSource.id,
    ]);
  });

  it("keeps answering filter shortcuts independent from method binding", () => {
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
      now: () => new Date("2026-07-01T04:00:00.000Z"),
    });

    const source = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/docs/doc-1",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedAt: new Date("2026-07-01T04:01:00.000Z"),
    });
    const listUsableForAnswering = registry.listSourcesUsableForAnswering;

    expect(listUsableForAnswering().map((entry) => entry.id)).toEqual([source.id]);
  });
});
