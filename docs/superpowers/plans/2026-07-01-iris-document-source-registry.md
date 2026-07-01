# Iris Document Source Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 2B of Iris: an in-memory Document Source Registry that records group-visible documents, authorized wiki documents, and user-submitted documents through one consistent domain boundary.

**Architecture:** The registry is a pure TypeScript Core domain module with no Feishu API calls, no Postgres, and no vector indexing. It records document-source facts, merges repeated sightings, preserves evidence, tracks permission/sync/capability state, and exposes deterministic query methods for later document fetching and permission-guard phases.

**Tech Stack:** TypeScript, Vitest, Node.js runtime primitives.

---

## Scope

This plan implements the Phase 2B in-memory registry described in `docs/superpowers/specs/2026-07-01-iris-document-source-registry-design.md`.

This plan intentionally does not implement:

- real Feishu document body fetching;
- Feishu wiki traversal;
- OAuth installation or token refresh;
- Postgres persistence;
- pgvector indexing;
- document parsing, chunking, or embeddings;
- real-time Feishu permission API calls;
- admin UI screens.

Known v1 limitation:

- Registry state is in-memory. Admin mutations such as disabled answering, permission state changes, and sync state changes are lost on process restart. This is accepted for Phase 2B and must be fixed in Phase 2C by moving registry state to Postgres.

## File Structure

Create:

```text
apps/core/src/documents/
  document-source-registry.ts

apps/core/tests/
  document-source-registry.test.ts
```

Responsibilities:

- `document-source-registry.ts`: owns document-source types, validation errors, in-memory registration, merging, state mutation, and query behavior.
- `document-source-registry.test.ts`: locks the in-memory domain behavior with focused tests.

No route, worker, Feishu API, or persistence file should be modified in this phase.

## Domain API Shape

The module should export these types and functions:

```ts
export type DocumentSourceType =
  | "group_visible_document"
  | "authorized_wiki_document"
  | "user_submitted_document";

export type DocumentPermissionState = "unknown" | "readable" | "denied" | "stale";

export type DocumentSyncState = "pending" | "syncing" | "synced" | "failed";

export type DocumentSourceEvidenceKind =
  | "group_message"
  | "admin_authorization"
  | "user_submission";

export type DocumentSourceEvidence = {
  kind: DocumentSourceEvidenceKind;
  sourceUri: string;
  groupId?: string;
  messageId?: string;
  userId?: string;
  spaceId?: string;
  observedAt: Date;
};

export type DocumentSource = {
  id: string;
  sourceType: DocumentSourceType;
  sourceUri: string;
  title?: string;
  originGroupId?: string;
  originMessageId?: string;
  submittedByUserId?: string;
  authorizedSpaceId?: string;
  permissionState: DocumentPermissionState;
  syncState: DocumentSyncState;
  canUseForAnswering: boolean;
  canUseForKnowledgeDrafts: boolean;
  createdAt: Date;
  updatedAt: Date;
  evidence: DocumentSourceEvidence[];
};

export class DocumentSourceValidationError extends Error {
  constructor(message: string);
}

export type DocumentSourceRegistryDependencies = {
  now?: () => Date;
  createId?: () => string;
};

export function createDocumentSourceRegistry(
  dependencies?: DocumentSourceRegistryDependencies
): DocumentSourceRegistry;
```

The returned `DocumentSourceRegistry` should provide:

```ts
type DocumentSourceRegistry = {
  registerGroupVisibleDocument(input: RegisterGroupVisibleDocumentInput): DocumentSource;
  registerAuthorizedWikiDocument(input: RegisterAuthorizedWikiDocumentInput): DocumentSource;
  registerUserSubmittedDocument(input: RegisterUserSubmittedDocumentInput): DocumentSource;
  markPermissionState(id: string, permissionState: DocumentPermissionState): DocumentSource;
  markSyncState(id: string, syncState: DocumentSyncState): DocumentSource;
  setAnsweringEnabled(id: string, enabled: boolean): DocumentSource;
  setKnowledgeDraftsEnabled(id: string, enabled: boolean): DocumentSource;
  listSources(): DocumentSource[];
  listSourcesByType(sourceType: DocumentSourceType): DocumentSource[];
  findSourceById(id: string): DocumentSource | undefined;
  findSourceByUri(sourceUri: string): DocumentSource | undefined;
  listSourcesUsableForAnswering(): DocumentSource[];
  listSourcesByGroupId(groupId: string): DocumentSource[];
  listSourcesByAuthorizedSpaceId(spaceId: string): DocumentSource[];
  listSourcesBySubmittingUserId(userId: string): DocumentSource[];
};
```

Input types:

```ts
type RegisterGroupVisibleDocumentInput = {
  sourceUri: string;
  originGroupId: string;
  originMessageId: string;
  observedAt: Date;
  title?: string;
};

type RegisterAuthorizedWikiDocumentInput = {
  sourceUri: string;
  authorizedSpaceId: string;
  observedAt: Date;
  title?: string;
};

type RegisterUserSubmittedDocumentInput = {
  sourceUri: string;
  submittedByUserId: string;
  observedAt: Date;
  title?: string;
};
```

## Task 1: Create Registry Types And First Registration Path

**Files:**
- Create: `apps/core/src/documents/document-source-registry.ts`
- Create: `apps/core/tests/document-source-registry.test.ts`

- [ ] **Step 1: Write failing tests for group-visible registration**

Create `apps/core/tests/document-source-registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  createDocumentSourceRegistry,
  DocumentSourceValidationError
} from "../src/documents/document-source-registry.js";

describe("DocumentSourceRegistry", () => {
  it("registers group-visible documents with defaults and evidence", () => {
    const registry = createDocumentSourceRegistry({
      now: () => new Date("2026-07-01T00:00:00.000Z"),
      createId: () => "source-1"
    });

    const source = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.feishu.cn/docx/ABC123",
      originGroupId: "chat-a",
      originMessageId: "msg-a",
      observedAt: new Date("2026-07-01T00:01:00.000Z"),
      title: "Design Notes"
    });

    expect(source).toEqual({
      id: "source-1",
      sourceType: "group_visible_document",
      sourceUri: "https://example.feishu.cn/docx/ABC123",
      title: "Design Notes",
      originGroupId: "chat-a",
      originMessageId: "msg-a",
      submittedByUserId: undefined,
      authorizedSpaceId: undefined,
      permissionState: "unknown",
      syncState: "pending",
      canUseForAnswering: true,
      canUseForKnowledgeDrafts: true,
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
      evidence: [
        {
          kind: "group_message",
          sourceUri: "https://example.feishu.cn/docx/ABC123",
          groupId: "chat-a",
          messageId: "msg-a",
          userId: undefined,
          spaceId: undefined,
          observedAt: new Date("2026-07-01T00:01:00.000Z")
        }
      ]
    });
  });

  it("rejects blank source URIs for group-visible documents", () => {
    const registry = createDocumentSourceRegistry();

    expect(() => registry.registerGroupVisibleDocument({
      sourceUri: "   ",
      originGroupId: "chat-a",
      originMessageId: "msg-a",
      observedAt: new Date("2026-07-01T00:01:00.000Z")
    })).toThrow(DocumentSourceValidationError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm --workspace apps/core test -- document-source-registry.test.ts
```

Expected: FAIL because `document-source-registry.ts` does not exist.

- [ ] **Step 3: Implement minimal registry and group-visible registration**

Create `apps/core/src/documents/document-source-registry.ts`:

```ts
import { randomUUID } from "node:crypto";

export type DocumentSourceType =
  | "group_visible_document"
  | "authorized_wiki_document"
  | "user_submitted_document";

export type DocumentPermissionState = "unknown" | "readable" | "denied" | "stale";
export type DocumentSyncState = "pending" | "syncing" | "synced" | "failed";

export type DocumentSourceEvidenceKind =
  | "group_message"
  | "admin_authorization"
  | "user_submission";

export type DocumentSourceEvidence = {
  kind: DocumentSourceEvidenceKind;
  sourceUri: string;
  groupId?: string;
  messageId?: string;
  userId?: string;
  spaceId?: string;
  observedAt: Date;
};

export type DocumentSource = {
  id: string;
  sourceType: DocumentSourceType;
  sourceUri: string;
  title?: string;
  originGroupId?: string;
  originMessageId?: string;
  submittedByUserId?: string;
  authorizedSpaceId?: string;
  permissionState: DocumentPermissionState;
  syncState: DocumentSyncState;
  canUseForAnswering: boolean;
  canUseForKnowledgeDrafts: boolean;
  createdAt: Date;
  updatedAt: Date;
  evidence: DocumentSourceEvidence[];
};

export type RegisterGroupVisibleDocumentInput = {
  sourceUri: string;
  originGroupId: string;
  originMessageId: string;
  observedAt: Date;
  title?: string;
};

export type DocumentSourceRegistryDependencies = {
  now?: () => Date;
  createId?: () => string;
};

export class DocumentSourceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentSourceValidationError";
  }
}

export type DocumentSourceRegistry = {
  registerGroupVisibleDocument(input: RegisterGroupVisibleDocumentInput): DocumentSource;
};

export function createDocumentSourceRegistry(
  dependencies: DocumentSourceRegistryDependencies = {}
): DocumentSourceRegistry {
  const sourcesByUri = new Map<string, DocumentSource>();
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.createId ?? randomUUID;

  return {
    registerGroupVisibleDocument(input) {
      const sourceUri = requireNonBlank(input.sourceUri, "sourceUri");
      const originGroupId = requireNonBlank(input.originGroupId, "originGroupId");
      const originMessageId = requireNonBlank(input.originMessageId, "originMessageId");
      const timestamp = now();

      const source: DocumentSource = {
        id: createId(),
        sourceType: "group_visible_document",
        sourceUri,
        title: normalizeOptional(input.title),
        originGroupId,
        originMessageId,
        submittedByUserId: undefined,
        authorizedSpaceId: undefined,
        permissionState: "unknown",
        syncState: "pending",
        canUseForAnswering: true,
        canUseForKnowledgeDrafts: true,
        createdAt: timestamp,
        updatedAt: timestamp,
        evidence: [
          {
            kind: "group_message",
            sourceUri,
            groupId: originGroupId,
            messageId: originMessageId,
            userId: undefined,
            spaceId: undefined,
            observedAt: input.observedAt
          }
        ]
      };

      sourcesByUri.set(sourceUri, source);
      return cloneSource(source);
    }
  };
}

function requireNonBlank(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new DocumentSourceValidationError(`${fieldName} is required`);
  }

  return trimmed;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function cloneSource(source: DocumentSource): DocumentSource {
  return {
    ...source,
    createdAt: new Date(source.createdAt),
    updatedAt: new Date(source.updatedAt),
    evidence: source.evidence.map((evidence) => ({
      ...evidence,
      observedAt: new Date(evidence.observedAt)
    }))
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npm --workspace apps/core test -- document-source-registry.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run typecheck and commit**

Run:

```powershell
npm run typecheck
git add apps/core/src/documents/document-source-registry.ts apps/core/tests/document-source-registry.test.ts
git commit -m "feat: add document source registry basics"
```

Expected: typecheck PASS and commit succeeds.

## Task 2: Add Registration Paths And Merge Semantics

**Files:**
- Modify: `apps/core/src/documents/document-source-registry.ts`
- Modify: `apps/core/tests/document-source-registry.test.ts`

- [ ] **Step 1: Add failing tests for all source types and URI merging**

Append these tests inside the existing `describe("DocumentSourceRegistry", () => { ... })` block:

```ts
  it("registers authorized wiki documents with admin evidence", () => {
    const registry = createDocumentSourceRegistry({
      now: () => new Date("2026-07-01T00:00:00.000Z"),
      createId: () => "source-wiki"
    });

    const source = registry.registerAuthorizedWikiDocument({
      sourceUri: "https://example.feishu.cn/wiki/WIKI123",
      authorizedSpaceId: "space-a",
      observedAt: new Date("2026-07-01T00:02:00.000Z"),
      title: "Team Wiki"
    });

    expect(source).toMatchObject({
      id: "source-wiki",
      sourceType: "authorized_wiki_document",
      sourceUri: "https://example.feishu.cn/wiki/WIKI123",
      title: "Team Wiki",
      authorizedSpaceId: "space-a",
      permissionState: "unknown",
      syncState: "pending",
      canUseForAnswering: true,
      canUseForKnowledgeDrafts: true,
      evidence: [
        {
          kind: "admin_authorization",
          sourceUri: "https://example.feishu.cn/wiki/WIKI123",
          spaceId: "space-a",
          observedAt: new Date("2026-07-01T00:02:00.000Z")
        }
      ]
    });
  });

  it("registers user-submitted documents with draft usage disabled by default", () => {
    const registry = createDocumentSourceRegistry({
      now: () => new Date("2026-07-01T00:00:00.000Z"),
      createId: () => "source-user"
    });

    const source = registry.registerUserSubmittedDocument({
      sourceUri: "file://manual-upload/a.pdf",
      submittedByUserId: "user-a",
      observedAt: new Date("2026-07-01T00:03:00.000Z"),
      title: "Manual Upload"
    });

    expect(source).toMatchObject({
      id: "source-user",
      sourceType: "user_submitted_document",
      submittedByUserId: "user-a",
      canUseForAnswering: true,
      canUseForKnowledgeDrafts: false,
      evidence: [
        {
          kind: "user_submission",
          sourceUri: "file://manual-upload/a.pdf",
          userId: "user-a",
          observedAt: new Date("2026-07-01T00:03:00.000Z")
        }
      ]
    });
  });

  it("deduplicates by source URI and appends distinct evidence", () => {
    let id = 0;
    const registry = createDocumentSourceRegistry({
      now: () => new Date("2026-07-01T00:00:00.000Z"),
      createId: () => `source-${++id}`
    });

    const first = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.feishu.cn/docx/ABC123",
      originGroupId: "chat-a",
      originMessageId: "msg-a",
      observedAt: new Date("2026-07-01T00:01:00.000Z")
    });

    const second = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.feishu.cn/docx/ABC123",
      originGroupId: "chat-a",
      originMessageId: "msg-b",
      observedAt: new Date("2026-07-01T00:02:00.000Z"),
      title: "Later Title"
    });

    expect(second.id).toBe(first.id);
    expect(second.title).toBe("Later Title");
    expect(second.evidence).toHaveLength(2);
  });

  it("does not append duplicate evidence for retried Feishu message events", () => {
    const registry = createDocumentSourceRegistry({
      now: () => new Date("2026-07-01T00:00:00.000Z"),
      createId: () => "source-1"
    });

    registry.registerGroupVisibleDocument({
      sourceUri: "https://example.feishu.cn/docx/ABC123",
      originGroupId: "chat-a",
      originMessageId: "msg-a",
      observedAt: new Date("2026-07-01T00:01:00.000Z")
    });

    const retried = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.feishu.cn/docx/ABC123",
      originGroupId: "chat-a",
      originMessageId: "msg-a",
      observedAt: new Date("2026-07-01T00:01:00.000Z")
    });

    expect(retried.evidence).toHaveLength(1);
  });

  it("upgrades source type for admin-authorized wiki registration without later downgrade", () => {
    const registry = createDocumentSourceRegistry({
      now: () => new Date("2026-07-01T00:00:00.000Z"),
      createId: () => "source-1"
    });

    registry.registerGroupVisibleDocument({
      sourceUri: "https://example.feishu.cn/wiki/WIKI123",
      originGroupId: "chat-a",
      originMessageId: "msg-a",
      observedAt: new Date("2026-07-01T00:01:00.000Z")
    });

    const upgraded = registry.registerAuthorizedWikiDocument({
      sourceUri: "https://example.feishu.cn/wiki/WIKI123",
      authorizedSpaceId: "space-a",
      observedAt: new Date("2026-07-01T00:02:00.000Z")
    });

    expect(upgraded.sourceType).toBe("authorized_wiki_document");

    const repeatedGroupMention = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.feishu.cn/wiki/WIKI123",
      originGroupId: "chat-b",
      originMessageId: "msg-b",
      observedAt: new Date("2026-07-01T00:03:00.000Z")
    });

    expect(repeatedGroupMention.sourceType).toBe("authorized_wiki_document");
    expect(repeatedGroupMention.evidence).toHaveLength(3);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm --workspace apps/core test -- document-source-registry.test.ts
```

Expected: FAIL because `registerAuthorizedWikiDocument` and `registerUserSubmittedDocument` do not exist and merge behavior is not implemented.

- [ ] **Step 3: Implement all registration paths and merge logic**

Replace the Task 1 implementation with a complete registry that keeps sources by URI and ID. The important implementation details are:

```ts
const sourceTypeRank: Record<DocumentSourceType, number> = {
  authorized_wiki_document: 3,
  group_visible_document: 2,
  user_submitted_document: 1
};

function mergeSource(input: {
  existing: DocumentSource | undefined;
  next: DocumentSource;
  evidence: DocumentSourceEvidence;
}): DocumentSource {
  if (!input.existing) {
    return input.next;
  }

  const merged: DocumentSource = {
    ...input.existing,
    sourceType: higherPrioritySourceType(input.existing.sourceType, input.next.sourceType),
    title: input.existing.title ?? input.next.title,
    originGroupId: input.existing.originGroupId ?? input.next.originGroupId,
    originMessageId: input.existing.originMessageId ?? input.next.originMessageId,
    submittedByUserId: input.existing.submittedByUserId ?? input.next.submittedByUserId,
    authorizedSpaceId: input.existing.authorizedSpaceId ?? input.next.authorizedSpaceId,
    updatedAt: input.next.updatedAt,
    evidence: appendEvidenceIfNew(input.existing.evidence, input.evidence)
  };

  return merged;
}

function higherPrioritySourceType(left: DocumentSourceType, right: DocumentSourceType): DocumentSourceType {
  return sourceTypeRank[right] > sourceTypeRank[left] ? right : left;
}

function appendEvidenceIfNew(
  evidenceList: DocumentSourceEvidence[],
  next: DocumentSourceEvidence
): DocumentSourceEvidence[] {
  if (evidenceList.some((evidence) => isSameEvidence(evidence, next))) {
    return evidenceList;
  }

  return [...evidenceList, next];
}

function isSameEvidence(left: DocumentSourceEvidence, right: DocumentSourceEvidence): boolean {
  return (
    left.kind === right.kind &&
    left.sourceUri === right.sourceUri &&
    left.groupId === right.groupId &&
    left.messageId === right.messageId &&
    left.userId === right.userId &&
    left.spaceId === right.spaceId
  );
}
```

Add `registerAuthorizedWikiDocument` and `registerUserSubmittedDocument` with the defaults from the spec. Keep validation strict for `sourceUri`, `authorizedSpaceId`, and `submittedByUserId`.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```powershell
npm --workspace apps/core test -- document-source-registry.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run typecheck and commit**

Run:

```powershell
npm run typecheck
git add apps/core/src/documents/document-source-registry.ts apps/core/tests/document-source-registry.test.ts
git commit -m "feat: register document source types"
```

Expected: typecheck PASS and commit succeeds.

## Task 3: Add State Mutations

**Files:**
- Modify: `apps/core/src/documents/document-source-registry.ts`
- Modify: `apps/core/tests/document-source-registry.test.ts`

- [ ] **Step 1: Add failing tests for permission, sync, and capability mutations**

Append:

```ts
  it("marks permission denied and disables answering", () => {
    const registry = createDocumentSourceRegistry({ createId: () => "source-1" });
    const source = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.feishu.cn/docx/ABC123",
      originGroupId: "chat-a",
      originMessageId: "msg-a",
      observedAt: new Date("2026-07-01T00:01:00.000Z")
    });

    const updated = registry.markPermissionState(source.id, "denied");

    expect(updated.permissionState).toBe("denied");
    expect(updated.canUseForAnswering).toBe(false);
  });

  it("marks permission stale without disabling answering", () => {
    const registry = createDocumentSourceRegistry({ createId: () => "source-1" });
    const source = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.feishu.cn/docx/ABC123",
      originGroupId: "chat-a",
      originMessageId: "msg-a",
      observedAt: new Date("2026-07-01T00:01:00.000Z")
    });

    const updated = registry.markPermissionState(source.id, "stale");

    expect(updated.permissionState).toBe("stale");
    expect(updated.canUseForAnswering).toBe(true);
  });

  it("updates sync state", () => {
    const registry = createDocumentSourceRegistry({ createId: () => "source-1" });
    const source = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.feishu.cn/docx/ABC123",
      originGroupId: "chat-a",
      originMessageId: "msg-a",
      observedAt: new Date("2026-07-01T00:01:00.000Z")
    });

    expect(registry.markSyncState(source.id, "syncing").syncState).toBe("syncing");
    expect(registry.markSyncState(source.id, "synced").syncState).toBe("synced");
  });

  it("does not silently re-enable admin-disabled answering on re-registration", () => {
    const registry = createDocumentSourceRegistry({ createId: () => "source-1" });
    const source = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.feishu.cn/docx/ABC123",
      originGroupId: "chat-a",
      originMessageId: "msg-a",
      observedAt: new Date("2026-07-01T00:01:00.000Z")
    });

    registry.setAnsweringEnabled(source.id, false);

    const repeated = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.feishu.cn/docx/ABC123",
      originGroupId: "chat-a",
      originMessageId: "msg-b",
      observedAt: new Date("2026-07-01T00:02:00.000Z")
    });

    expect(repeated.canUseForAnswering).toBe(false);
  });

  it("can enable knowledge draft usage explicitly", () => {
    const registry = createDocumentSourceRegistry({ createId: () => "source-1" });
    const source = registry.registerUserSubmittedDocument({
      sourceUri: "file://manual-upload/a.pdf",
      submittedByUserId: "user-a",
      observedAt: new Date("2026-07-01T00:01:00.000Z")
    });

    expect(source.canUseForKnowledgeDrafts).toBe(false);
    expect(registry.setKnowledgeDraftsEnabled(source.id, true).canUseForKnowledgeDrafts).toBe(true);
  });

  it("throws validation error when mutating an unknown source id", () => {
    const registry = createDocumentSourceRegistry();

    expect(() => registry.markSyncState("missing", "synced")).toThrow(DocumentSourceValidationError);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm --workspace apps/core test -- document-source-registry.test.ts
```

Expected: FAIL because mutation methods do not exist.

- [ ] **Step 3: Implement mutation methods**

Add maps by ID and URI, then add helpers:

```ts
function requireSourceById(sourcesById: Map<string, DocumentSource>, id: string): DocumentSource {
  const source = sourcesById.get(id);
  if (!source) {
    throw new DocumentSourceValidationError(`source not found: ${id}`);
  }

  return source;
}

function persistSource(
  source: DocumentSource,
  sourcesById: Map<string, DocumentSource>,
  sourcesByUri: Map<string, DocumentSource>
): DocumentSource {
  sourcesById.set(source.id, source);
  sourcesByUri.set(source.sourceUri, source);
  return cloneSource(source);
}
```

Implement:

```ts
markPermissionState(id, permissionState) {
  const source = requireSourceById(sourcesById, id);
  return persistSource({
    ...source,
    permissionState,
    canUseForAnswering: permissionState === "denied" ? false : source.canUseForAnswering,
    updatedAt: now()
  }, sourcesById, sourcesByUri);
}

markSyncState(id, syncState) {
  const source = requireSourceById(sourcesById, id);
  return persistSource({ ...source, syncState, updatedAt: now() }, sourcesById, sourcesByUri);
}

setAnsweringEnabled(id, enabled) {
  const source = requireSourceById(sourcesById, id);
  return persistSource({ ...source, canUseForAnswering: enabled, updatedAt: now() }, sourcesById, sourcesByUri);
}

setKnowledgeDraftsEnabled(id, enabled) {
  const source = requireSourceById(sourcesById, id);
  return persistSource({ ...source, canUseForKnowledgeDrafts: enabled, updatedAt: now() }, sourcesById, sourcesByUri);
}
```

Ensure merge logic preserves existing `canUseForAnswering` and `canUseForKnowledgeDrafts` values rather than resetting them to registration defaults.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```powershell
npm --workspace apps/core test -- document-source-registry.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run typecheck and commit**

Run:

```powershell
npm run typecheck
git add apps/core/src/documents/document-source-registry.ts apps/core/tests/document-source-registry.test.ts
git commit -m "feat: add document source state mutations"
```

Expected: typecheck PASS and commit succeeds.

## Task 4: Add Query Methods And Deterministic Ordering

**Files:**
- Modify: `apps/core/src/documents/document-source-registry.ts`
- Modify: `apps/core/tests/document-source-registry.test.ts`

- [ ] **Step 1: Add failing tests for query methods**

Append:

```ts
  it("lists sources in deterministic updatedAt order", () => {
    let nowIndex = 0;
    const times = [
      new Date("2026-07-01T00:00:00.000Z"),
      new Date("2026-07-01T00:01:00.000Z")
    ];
    const registry = createDocumentSourceRegistry({
      now: () => times[nowIndex++] ?? times.at(-1)!,
      createId: (() => {
        let id = 0;
        return () => `source-${++id}`;
      })()
    });

    const first = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.feishu.cn/docx/A",
      originGroupId: "chat-a",
      originMessageId: "msg-a",
      observedAt: new Date("2026-07-01T00:01:00.000Z")
    });
    const second = registry.registerUserSubmittedDocument({
      sourceUri: "file://manual-upload/b.pdf",
      submittedByUserId: "user-a",
      observedAt: new Date("2026-07-01T00:02:00.000Z")
    });

    expect(registry.listSources().map((source) => source.id)).toEqual([second.id, first.id]);
  });

  it("finds sources by id and URI", () => {
    const registry = createDocumentSourceRegistry({ createId: () => "source-1" });
    const source = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.feishu.cn/docx/ABC123",
      originGroupId: "chat-a",
      originMessageId: "msg-a",
      observedAt: new Date("2026-07-01T00:01:00.000Z")
    });

    expect(registry.findSourceById(source.id)?.sourceUri).toBe(source.sourceUri);
    expect(registry.findSourceByUri(source.sourceUri)?.id).toBe(source.id);
  });

  it("filters sources by type, group, space, submitting user, and answering capability", () => {
    let id = 0;
    const registry = createDocumentSourceRegistry({ createId: () => `source-${++id}` });

    const groupSource = registry.registerGroupVisibleDocument({
      sourceUri: "https://example.feishu.cn/docx/A",
      originGroupId: "chat-a",
      originMessageId: "msg-a",
      observedAt: new Date("2026-07-01T00:01:00.000Z")
    });
    const wikiSource = registry.registerAuthorizedWikiDocument({
      sourceUri: "https://example.feishu.cn/wiki/B",
      authorizedSpaceId: "space-a",
      observedAt: new Date("2026-07-01T00:02:00.000Z")
    });
    const userSource = registry.registerUserSubmittedDocument({
      sourceUri: "file://manual-upload/c.pdf",
      submittedByUserId: "user-a",
      observedAt: new Date("2026-07-01T00:03:00.000Z")
    });
    registry.setAnsweringEnabled(userSource.id, false);

    expect(registry.listSourcesByType("group_visible_document").map((source) => source.id)).toEqual([groupSource.id]);
    expect(registry.listSourcesByGroupId("chat-a").map((source) => source.id)).toEqual([groupSource.id]);
    expect(registry.listSourcesByAuthorizedSpaceId("space-a").map((source) => source.id)).toEqual([wikiSource.id]);
    expect(registry.listSourcesBySubmittingUserId("user-a").map((source) => source.id)).toEqual([userSource.id]);
    expect(registry.listSourcesUsableForAnswering().map((source) => source.id)).not.toContain(userSource.id);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm --workspace apps/core test -- document-source-registry.test.ts
```

Expected: FAIL because query methods do not exist.

- [ ] **Step 3: Implement query methods**

Add:

```ts
function sortSources(sources: DocumentSource[]): DocumentSource[] {
  return [...sources].sort((left, right) => {
    const updatedDelta = right.updatedAt.getTime() - left.updatedAt.getTime();
    if (updatedDelta !== 0) {
      return updatedDelta;
    }

    return left.id.localeCompare(right.id);
  });
}
```

Implement query methods by filtering `Array.from(sourcesById.values())`, sorting with `sortSources`, and returning cloned sources.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```powershell
npm --workspace apps/core test -- document-source-registry.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run full TypeScript tests and commit**

Run:

```powershell
npm test
npm run typecheck
git add apps/core/src/documents/document-source-registry.ts apps/core/tests/document-source-registry.test.ts
git commit -m "feat: query document source registry"
```

Expected: tests PASS, typecheck PASS, commit succeeds.

## Task 5: Final Verification

**Files:**
- No new files.

- [ ] **Step 1: Run TypeScript typecheck**

Run:

```powershell
npm run typecheck
```

Expected: PASS.

- [ ] **Step 2: Run all TypeScript tests**

Run:

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 3: Run Python worker tests**

Run:

```powershell
python -m pytest
```

from:

```text
workers/ai
```

Expected: PASS.

- [ ] **Step 4: Check git status**

Run:

```powershell
git status --short --branch
```

Expected: clean worktree on the implementation branch.

- [ ] **Step 5: Record Docker limitation if unchanged**

Run:

```powershell
docker compose config
```

Expected in the current local environment: this may fail with `docker` not found. If it fails for that reason, report it as an environment limitation, not a product failure.
