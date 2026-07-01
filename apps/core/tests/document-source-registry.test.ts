import { describe, expect, it } from "vitest";
import {
  createDocumentSourceRegistry,
  type DocumentPermissionState,
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

describe("createDocumentSourceRegistry", () => {
  it("registers a group_visible_document with defaults and evidence", () => {
    expect(documentSourceTypes).toContain("group_visible_document");
    expect(documentPermissionStates).toContain("unknown");
    expect(documentSourceEvidenceKinds).toContain("group_message");

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
});
