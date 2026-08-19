import { describe, expect, it } from "vitest";

import {
  canonicalManagedBody,
  canonicalManagedBodyHash,
  normalizeManagedKnowledgePage,
} from "../src/action-approvals/managed-knowledge-page.js";

const validPage = {
  id: "managed-page-1",
  originKnowledgePublicationId: "publication-1",
  targetPolicyId: "policy-1",
  targetPolicyVersion: 1,
  authorizationGroupId: "group-1",
  remoteNodeToken: "node-1",
  remoteDocumentToken: "document-1",
  managedBodyBlockId: "block-1",
  currentRemoteRevisionId: "revision-1",
  currentBodyContentHash: "a".repeat(64),
  state: "active" as const,
  version: 1,
  createdAt: new Date("2026-08-20T00:00:00.000Z"),
  updatedAt: new Date("2026-08-20T00:00:00.000Z"),
};

describe("managed knowledge page domain", () => {
  it("normalizes the managed body identically across CRLF and trailing outer whitespace", () => {
    expect(canonicalManagedBody("  Line one\r\nLine two  ")).toBe("Line one\nLine two");
    expect(canonicalManagedBodyHash("  Line one\r\nLine two  ")).toBe(
      "6991ce0a6fcde71f7e4c492b1746e1f04727fe3b124691803aab99fccdb4d8c6",
    );
  });

  it("rejects an active page without exact positive revision and block identity", () => {
    expect(() => normalizeManagedKnowledgePage({
      ...validPage,
      managedBodyBlockId: "",
    })).toThrow(/managedBodyBlockId/u);
    expect(() => normalizeManagedKnowledgePage({
      ...validPage,
      currentRemoteRevisionId: "",
    })).toThrow(/currentRemoteRevisionId/u);
  });
});
