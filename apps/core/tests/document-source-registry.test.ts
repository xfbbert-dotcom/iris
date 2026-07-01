import { describe, expect, it } from "vitest";
import {
  createDocumentSourceRegistry,
  type DocumentPermissionState,
  type DocumentSourceEvidence,
  type DocumentSourceEvidenceKind,
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

describe("createDocumentSourceRegistry", () => {
  it("registers a group_visible_document with defaults and evidence", () => {
    expect(documentSourceTypes).toContain("group_visible_document");
    expect(documentPermissionStates).toContain("unknown");
    expect(documentSourceEvidenceKinds).toContain("group_message");
    expect(adminAuthorizationEvidence.groupId).toBeUndefined();
    expect(adminAuthorizationEvidence.messageId).toBeUndefined();

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
          userId: undefined,
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
    expect(groupVisible.sourceType).toBe("authorized_wiki_document");
    expect(groupVisible.evidence).toHaveLength(3);
    expect(groupVisible.evidence.map((evidence) => evidence.kind)).toEqual([
      "user_submission",
      "admin_authorization",
      "group_message",
    ]);
  });
});
