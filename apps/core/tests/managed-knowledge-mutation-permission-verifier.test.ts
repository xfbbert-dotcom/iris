import { describe, expect, it, vi } from "vitest";

import type { DocumentSource } from "../src/documents/document-source-registry.js";
import { createManagedKnowledgeMutationPermissionVerifier } from
  "../src/action-approvals/managed-knowledge-mutation-permission-verifier.js";
import type { ManagedKnowledgePage } from "../src/action-approvals/managed-knowledge-page.js";

const at = new Date("2026-08-21T01:00:00.000Z");

describe("createManagedKnowledgeMutationPermissionVerifier", () => {
  it("binds the durable page, group, source, Wiki node, document, and managed block before probing", async () => {
    const dependencies = verifierDependencies();
    const verifier = createManagedKnowledgeMutationPermissionVerifier(dependencies);

    await expect(verifier.verify(exactInput())).resolves.toBe(true);

    expect(dependencies.managedPages.findByRemoteIdentity).toHaveBeenCalledWith({
      remoteDocumentToken: "docx-1",
    });
    expect(dependencies.permissionChecker.canReadExactSource).toHaveBeenCalledWith({
      source: dependencies.source,
      remoteWikiNodeToken: "node-1",
      remoteDocumentToken: "docx-1",
    });
    expect(dependencies.permissionChecker.canReadSource).not.toHaveBeenCalled();
  });

  it.each([
    ["managed page", { managedPageId: "managed-other" }],
    ["authorization group", { authorizationGroupId: "group-other" }],
    ["document source", { documentSourceId: "source-other" }],
    ["Wiki node", { remoteNodeToken: "node-other" }],
    ["document", { remoteDocumentToken: "docx-other" }],
    ["managed block", { managedBodyBlockId: "blk_other" }],
  ])("rejects a mismatched %s without a live probe", async (_name, override) => {
    const dependencies = verifierDependencies();
    const verifier = createManagedKnowledgeMutationPermissionVerifier(dependencies);

    await expect(verifier.verify({ ...exactInput(), ...override })).resolves.toBe(false);

    expect(dependencies.permissionChecker.canReadExactSource).not.toHaveBeenCalled();
    expect(dependencies.permissionChecker.canReadSource).not.toHaveBeenCalled();
  });
});

function exactInput() {
  return {
    managedPageId: "managed-1",
    documentSourceId: "source-1",
    authorizationGroupId: "group-1",
    remoteNodeToken: "node-1",
    remoteDocumentToken: "docx-1",
    managedBodyBlockId: "blk_body",
  };
}

function verifierDependencies() {
  const page: ManagedKnowledgePage = {
    id: "managed-1",
    originKnowledgePublicationId: "publication-1",
    targetPolicyId: "policy-1",
    targetPolicyVersion: 3,
    authorizationGroupId: "group-1",
    remoteNodeToken: "node-1",
    remoteDocumentToken: "docx-1",
    managedBodyBlockId: "blk_body",
    linkedDocumentSourceId: "source-1",
    currentRemoteRevisionId: "12",
    currentBodyContentHash: "a".repeat(64),
    state: "updating",
    version: 2,
    createdAt: at,
    updatedAt: at,
  };
  const source: DocumentSource = {
    id: "source-1",
    sourceType: "authorized_wiki_document",
    sourceUri: "https://example.feishu.cn/wiki/node-1",
    permissionState: "readable",
    syncState: "synced",
    canUseForAnswering: true,
    canUseForKnowledgeDrafts: true,
    createdAt: at,
    updatedAt: at,
    evidence: [],
  };
  return {
    source,
    managedPages: {
      findByRemoteIdentity: vi.fn(async () => page),
    },
    documentSources: {
      findSourceById: vi.fn(async () => source),
    },
    permissionChecker: {
      canReadSource: vi.fn(async () => true),
      canReadExactSource: vi.fn(async () => true),
    },
  };
}
