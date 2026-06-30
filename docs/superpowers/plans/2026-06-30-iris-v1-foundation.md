# Iris v1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first working Iris foundation slice: repository scaffold, TypeScript Core App boundaries, Feishu ack-first ingestion contract, runtime switches, real-time permission guard, context assembly, and Python worker job contracts.

**Architecture:** Iris v1 starts as a modular monolith plus Python workers. The TypeScript Core App owns product behavior, permissions, Feishu ingress, admin runtime controls, and prompt assembly; Python workers own intelligent processing jobs and never execute high-impact actions directly.

**Tech Stack:** Node.js 24, TypeScript, Fastify, Vitest, Zod, BullMQ-compatible queue interface, Python 3.12, pytest, Docker Compose, Postgres with pgvector, Redis.

---

## Scope

This plan implements the foundation layer only. It does not implement real Feishu OAuth installation, production LLM calls, full document parsing, real pgvector indexing, or a polished admin UI. Those become follow-up plans after this foundation is passing tests.

This plan must preserve the whitepaper rules in `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`:

- Feishu Gateway is ack-first.
- Signal filtering and agent decisions happen asynchronously.
- Retrieved document fragments pass through a real-time permission guard before model context injection.
- Live chat context is the prompt anchor.
- Iris runtime capabilities are configurable and pausable.

## File Structure

Create this structure:

```text
apps/core/
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    app.ts
    config/runtime-config.ts
    feishu/feishu-gateway.ts
    feishu/feishu-types.ts
    queues/event-queue.ts
    queues/in-memory-event-queue.ts
    permissions/permission-guard.ts
    memory/context-assembly.ts
    admin/runtime-controller.ts
    audit/audit-log.ts
  tests/
    feishu-gateway.test.ts
    runtime-controller.test.ts
    permission-guard.test.ts
    context-assembly.test.ts
workers/ai/
  pyproject.toml
  iris_worker/
    __init__.py
    jobs.py
  tests/
    test_jobs.py
docker-compose.yml
package.json
README.md
```

Responsibilities:

- `apps/core/src/feishu/feishu-gateway.ts`: accepts Feishu callbacks, records idempotency, enqueues raw events, returns quickly.
- `apps/core/src/queues/*`: queue abstraction and in-memory test implementation.
- `apps/core/src/config/runtime-config.ts`: runtime capability state model.
- `apps/core/src/admin/runtime-controller.ts`: enable, disable, and emergency pause logic.
- `apps/core/src/permissions/permission-guard.ts`: verifies retrieved document fragments against live Feishu permission checks.
- `apps/core/src/memory/context-assembly.ts`: assembles prompts with `<background_documents>` before `<live_chat_context>`.
- `workers/ai/iris_worker/jobs.py`: Python worker job contracts for parse and summarize jobs used by the foundation tests.

## Task 1: Repository Tooling Scaffold

**Files:**
- Create: `package.json`
- Create: `apps/core/package.json`
- Create: `apps/core/tsconfig.json`
- Create: `apps/core/vitest.config.ts`
- Create: `apps/core/src/app.ts`
- Create: `workers/ai/pyproject.toml`
- Create: `README.md`

- [ ] **Step 1: Create root Node workspace manifest**

Create `package.json`:

```json
{
  "name": "iris",
  "private": true,
  "type": "module",
  "workspaces": [
    "apps/core"
  ],
  "scripts": {
    "test": "npm --workspace apps/core test",
    "typecheck": "npm --workspace apps/core run typecheck"
  }
}
```

- [ ] **Step 2: Create Core App package manifest**

Create `apps/core/package.json`:

```json
{
  "name": "@iris/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx src/app.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@fastify/type-provider-zod": "^1.0.0",
    "fastify": "^5.0.0",
    "zod": "^4.4.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 3: Create TypeScript config**

Create `apps/core/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 4: Create Vitest config**

Create `apps/core/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts"]
  }
});
```

- [ ] **Step 5: Create minimal Core App entrypoint**

Create `apps/core/src/app.ts`:

```ts
import Fastify from "fastify";
import { pathToFileURL } from "node:url";

export function buildApp() {
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ ok: true, service: "iris-core" }));

  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = buildApp();
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
}
```

- [ ] **Step 6: Create Python worker package config**

Create `workers/ai/pyproject.toml`:

```toml
[project]
name = "iris-ai-worker"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = []

[project.optional-dependencies]
dev = ["pytest>=8.0.0"]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["."]
```

- [ ] **Step 7: Create README**

Create `README.md`:

```md
# Iris

Iris is the company's Feishu-native AI assistant and collaboration agent.

The architecture constitution lives at:

`docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`

The first implementation slice builds:

- TypeScript Core App
- Feishu ack-first event ingestion
- runtime capability controls
- real-time permission guard
- context assembly with live chat anchoring
- Python AI worker job contracts
```

- [ ] **Step 8: Install dependencies**

Run:

```powershell
npm install
```

Expected: `package-lock.json` is created and dependencies install without errors.

- [ ] **Step 9: Verify empty test command state**

Run:

```powershell
npm test
```

Expected: Vitest starts but reports no test files or exits after test discovery. If Vitest exits non-zero because no tests exist, continue; Task 2 will add tests.

- [ ] **Step 10: Verify typecheck and dev entrypoint**

Run:

```powershell
npm run typecheck
```

Expected: exit code 0.

Run:

```powershell
$proc = Start-Process -FilePath "npm" -ArgumentList @("--workspace","apps/core","run","dev") -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 3
Stop-Process -Id $proc.Id -Force
```

Expected: the process starts without an immediate missing-module error.

- [ ] **Step 11: Commit scaffold**

Run:

```powershell
git add package.json package-lock.json apps/core/package.json apps/core/tsconfig.json apps/core/vitest.config.ts apps/core/src/app.ts workers/ai/pyproject.toml README.md
git commit -m "chore: scaffold Iris foundation workspace"
```

## Task 2: Feishu Event Types And In-Memory Queue

**Files:**
- Create: `apps/core/src/feishu/feishu-types.ts`
- Create: `apps/core/src/queues/event-queue.ts`
- Create: `apps/core/src/queues/in-memory-event-queue.ts`
- Test: `apps/core/tests/feishu-gateway.test.ts`

- [ ] **Step 1: Write failing queue test**

Create `apps/core/tests/feishu-gateway.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { InMemoryEventQueue } from "../src/queues/in-memory-event-queue.js";

describe("InMemoryEventQueue", () => {
  it("stores raw Feishu events with idempotency keys", async () => {
    const queue = new InMemoryEventQueue();

    await queue.enqueueRawFeishuEvent({
      idempotencyKey: "event-1",
      receivedAt: new Date("2026-06-30T00:00:00.000Z"),
      body: { event_id: "event-1", message: { chat_id: "chat-a" } }
    });

    expect(queue.events).toHaveLength(1);
    expect(queue.events[0]?.idempotencyKey).toBe("event-1");
  });

  it("deduplicates events by idempotency key", async () => {
    const queue = new InMemoryEventQueue();
    const event = {
      idempotencyKey: "event-1",
      receivedAt: new Date("2026-06-30T00:00:00.000Z"),
      body: { event_id: "event-1" }
    };

    await queue.enqueueRawFeishuEvent(event);
    await queue.enqueueRawFeishuEvent(event);

    expect(queue.events).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm --workspace apps/core test -- feishu-gateway.test.ts
```

Expected: FAIL because `InMemoryEventQueue` does not exist.

- [ ] **Step 3: Create Feishu event types**

Create `apps/core/src/feishu/feishu-types.ts`:

```ts
import { z } from "zod";

export const rawFeishuEventSchema = z.object({
  idempotencyKey: z.string().min(1),
  receivedAt: z.date(),
  body: z.unknown()
});

export type RawFeishuEvent = z.infer<typeof rawFeishuEventSchema>;
```

- [ ] **Step 4: Create queue interface**

Create `apps/core/src/queues/event-queue.ts`:

```ts
import type { RawFeishuEvent } from "../feishu/feishu-types.js";

export interface EventQueue {
  enqueueRawFeishuEvent(event: RawFeishuEvent): Promise<void>;
}
```

- [ ] **Step 5: Create in-memory queue**

Create `apps/core/src/queues/in-memory-event-queue.ts`:

```ts
import type { RawFeishuEvent } from "../feishu/feishu-types.js";
import type { EventQueue } from "./event-queue.js";

export class InMemoryEventQueue implements EventQueue {
  readonly events: RawFeishuEvent[] = [];
  private readonly seenKeys = new Set<string>();

  async enqueueRawFeishuEvent(event: RawFeishuEvent): Promise<void> {
    if (this.seenKeys.has(event.idempotencyKey)) {
      return;
    }

    this.seenKeys.add(event.idempotencyKey);
    this.events.push(event);
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run:

```powershell
npm --workspace apps/core test -- feishu-gateway.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 7: Commit queue contract**

Run:

```powershell
git add apps/core/src/feishu/feishu-types.ts apps/core/src/queues/event-queue.ts apps/core/src/queues/in-memory-event-queue.ts apps/core/tests/feishu-gateway.test.ts
git commit -m "feat: add Iris event queue contract"
```

## Task 3: Ack-First Feishu Gateway

**Files:**
- Create: `apps/core/src/feishu/feishu-gateway.ts`
- Modify: `apps/core/tests/feishu-gateway.test.ts`

- [ ] **Step 1: Add failing gateway tests**

Append to `apps/core/tests/feishu-gateway.test.ts`:

```ts
import { createFeishuGateway } from "../src/feishu/feishu-gateway.js";

describe("FeishuGateway", () => {
  it("returns HTTP 200 payload immediately after enqueueing", async () => {
    const queue = new InMemoryEventQueue();
    const gateway = createFeishuGateway({ queue });

    const response = await gateway.handleCallback({
      headers: { "x-iris-event-id": "event-1" },
      body: { event_id: "event-1", message: { chat_id: "chat-a" } }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(queue.events).toHaveLength(1);
  });

  it("does not run signal filtering before acknowledging", async () => {
    const queue = new InMemoryEventQueue();
    let signalFilterCalled = false;
    const gateway = createFeishuGateway({
      queue,
      signalFilter: async () => {
        signalFilterCalled = true;
      }
    });

    await gateway.handleCallback({
      headers: { "x-iris-event-id": "event-2" },
      body: { event_id: "event-2", message: { chat_id: "chat-a" } }
    });

    expect(signalFilterCalled).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm --workspace apps/core test -- feishu-gateway.test.ts
```

Expected: FAIL because `createFeishuGateway` does not exist.

- [ ] **Step 3: Implement ack-first gateway**

Create `apps/core/src/feishu/feishu-gateway.ts`:

```ts
import type { EventQueue } from "../queues/event-queue.js";
import { randomUUID } from "node:crypto";

export type FeishuCallbackRequest = {
  headers: Record<string, string | undefined>;
  body: unknown;
};

export type FeishuCallbackResponse = {
  statusCode: 200;
  body: { ok: true };
};

type SignalFilter = (event: unknown) => Promise<void>;

export type FeishuGatewayDependencies = {
  queue: EventQueue;
  signalFilter?: SignalFilter;
  now?: () => Date;
};

export function createFeishuGateway(dependencies: FeishuGatewayDependencies) {
  const now = dependencies.now ?? (() => new Date());

  return {
    async handleCallback(request: FeishuCallbackRequest): Promise<FeishuCallbackResponse> {
      const idempotencyKey = resolveIdempotencyKey(request);

      await dependencies.queue.enqueueRawFeishuEvent({
        idempotencyKey,
        receivedAt: now(),
        body: request.body
      });

      return {
        statusCode: 200,
        body: { ok: true }
      };
    }
  };
}

function resolveIdempotencyKey(request: FeishuCallbackRequest): string {
  const headerKey = request.headers["x-iris-event-id"];
  if (headerKey) {
    return headerKey;
  }

  if (isRecord(request.body) && typeof request.body.event_id === "string") {
    return request.body.event_id;
  }

  return randomUUID();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npm --workspace apps/core test -- feishu-gateway.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit gateway**

Run:

```powershell
git add apps/core/src/feishu/feishu-gateway.ts apps/core/tests/feishu-gateway.test.ts
git commit -m "feat: add ack-first Feishu gateway"
```

## Task 4: Runtime Capability Controls

**Files:**
- Create: `apps/core/src/config/runtime-config.ts`
- Create: `apps/core/src/admin/runtime-controller.ts`
- Test: `apps/core/tests/runtime-controller.test.ts`

- [ ] **Step 1: Write failing runtime controller tests**

Create `apps/core/tests/runtime-controller.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createDefaultRuntimeConfig } from "../src/config/runtime-config.js";
import { RuntimeController } from "../src/admin/runtime-controller.js";

describe("RuntimeController", () => {
  it("disables all processing when Iris is globally disabled", () => {
    const controller = new RuntimeController(createDefaultRuntimeConfig());

    controller.disableGlobal();

    expect(controller.canProcessGroupMessage("chat-a")).toBe(false);
    expect(controller.canReadDocuments()).toBe(false);
    expect(controller.canWriteKnowledgeBase()).toBe(false);
  });

  it("supports per-group enablement", () => {
    const controller = new RuntimeController(createDefaultRuntimeConfig());

    controller.disableGroup("chat-a");

    expect(controller.canProcessGroupMessage("chat-a")).toBe(false);
    expect(controller.canProcessGroupMessage("chat-b")).toBe(true);
  });

  it("emergency pause disables proactive behavior but keeps mention replies enabled", () => {
    const controller = new RuntimeController(createDefaultRuntimeConfig());

    controller.pauseProactiveBehavior();

    expect(controller.canProactivelySpeak("chat-a")).toBe(false);
    expect(controller.canReplyWhenMentioned("chat-a")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm --workspace apps/core test -- runtime-controller.test.ts
```

Expected: FAIL because runtime config files do not exist.

- [ ] **Step 3: Implement runtime config**

Create `apps/core/src/config/runtime-config.ts`:

```ts
export type IrisCapability = {
  readGroupContext: boolean;
  replyWhenMentioned: boolean;
  readGroupDocuments: boolean;
  retrieveKnowledgeBase: boolean;
  proactiveSpeech: boolean;
  generateKnowledgeDrafts: boolean;
  writeKnowledgeBase: boolean;
  callExternalTools: boolean;
};

export type RuntimeConfig = {
  globalEnabled: boolean;
  disabledGroupIds: Set<string>;
  capabilities: IrisCapability;
};

export function createDefaultRuntimeConfig(): RuntimeConfig {
  return {
    globalEnabled: true,
    disabledGroupIds: new Set<string>(),
    capabilities: {
      readGroupContext: true,
      replyWhenMentioned: true,
      readGroupDocuments: true,
      retrieveKnowledgeBase: true,
      proactiveSpeech: true,
      generateKnowledgeDrafts: true,
      writeKnowledgeBase: false,
      callExternalTools: false
    }
  };
}
```

- [ ] **Step 4: Implement runtime controller**

Create `apps/core/src/admin/runtime-controller.ts`:

```ts
import type { RuntimeConfig } from "../config/runtime-config.js";

export class RuntimeController {
  constructor(private readonly config: RuntimeConfig) {}

  disableGlobal(): void {
    this.config.globalEnabled = false;
  }

  enableGlobal(): void {
    this.config.globalEnabled = true;
  }

  disableGroup(groupId: string): void {
    this.config.disabledGroupIds.add(groupId);
  }

  enableGroup(groupId: string): void {
    this.config.disabledGroupIds.delete(groupId);
  }

  pauseProactiveBehavior(): void {
    this.config.capabilities.proactiveSpeech = false;
  }

  canProcessGroupMessage(groupId: string): boolean {
    return this.config.globalEnabled && !this.config.disabledGroupIds.has(groupId);
  }

  canReplyWhenMentioned(groupId: string): boolean {
    return this.canProcessGroupMessage(groupId) && this.config.capabilities.replyWhenMentioned;
  }

  canProactivelySpeak(groupId: string): boolean {
    return this.canProcessGroupMessage(groupId) && this.config.capabilities.proactiveSpeech;
  }

  canReadDocuments(): boolean {
    return this.config.globalEnabled && this.config.capabilities.readGroupDocuments;
  }

  canWriteKnowledgeBase(): boolean {
    return this.config.globalEnabled && this.config.capabilities.writeKnowledgeBase;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```powershell
npm --workspace apps/core test -- runtime-controller.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 6: Commit runtime controls**

Run:

```powershell
git add apps/core/src/config/runtime-config.ts apps/core/src/admin/runtime-controller.ts apps/core/tests/runtime-controller.test.ts
git commit -m "feat: add Iris runtime controls"
```

## Task 5: Real-Time Permission Guard

**Files:**
- Create: `apps/core/src/permissions/permission-guard.ts`
- Test: `apps/core/tests/permission-guard.test.ts`

- [ ] **Step 1: Write failing permission guard tests**

Create `apps/core/tests/permission-guard.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { filterFragmentsByLivePermission } from "../src/permissions/permission-guard.js";

describe("filterFragmentsByLivePermission", () => {
  it("keeps only fragments whose document IDs pass live permission checks", async () => {
    const fragments = [
      { id: "frag-1", documentId: "doc-allowed", text: "Allowed content" },
      { id: "frag-2", documentId: "doc-denied", text: "Denied content" }
    ];

    const result = await filterFragmentsByLivePermission({
      fragments,
      canReadDocument: async (documentId) => documentId === "doc-allowed"
    });

    expect(result.allowedFragments).toEqual([fragments[0]]);
    expect(result.deniedDocumentIds).toEqual(["doc-denied"]);
  });

  it("excludes fragments when live permission checks throw", async () => {
    const fragments = [{ id: "frag-1", documentId: "doc-timeout", text: "Uncertain content" }];

    const result = await filterFragmentsByLivePermission({
      fragments,
      canReadDocument: async () => {
        throw new Error("Feishu permission timeout");
      }
    });

    expect(result.allowedFragments).toEqual([]);
    expect(result.deniedDocumentIds).toEqual(["doc-timeout"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm --workspace apps/core test -- permission-guard.test.ts
```

Expected: FAIL because `permission-guard.ts` does not exist.

- [ ] **Step 3: Implement permission guard**

Create `apps/core/src/permissions/permission-guard.ts`:

```ts
export type RetrievedDocumentFragment = {
  id: string;
  documentId: string;
  text: string;
};

export type PermissionGuardInput = {
  fragments: RetrievedDocumentFragment[];
  canReadDocument: (documentId: string) => Promise<boolean>;
};

export type PermissionGuardResult = {
  allowedFragments: RetrievedDocumentFragment[];
  deniedDocumentIds: string[];
};

export async function filterFragmentsByLivePermission(
  input: PermissionGuardInput
): Promise<PermissionGuardResult> {
  const allowedFragments: RetrievedDocumentFragment[] = [];
  const deniedDocumentIds = new Set<string>();
  const permissionCache = new Map<string, boolean>();

  for (const fragment of input.fragments) {
    const allowed = await resolvePermission(fragment.documentId, input.canReadDocument, permissionCache);
    if (allowed) {
      allowedFragments.push(fragment);
    } else {
      deniedDocumentIds.add(fragment.documentId);
    }
  }

  return {
    allowedFragments,
    deniedDocumentIds: [...deniedDocumentIds]
  };
}

async function resolvePermission(
  documentId: string,
  canReadDocument: (documentId: string) => Promise<boolean>,
  permissionCache: Map<string, boolean>
): Promise<boolean> {
  const cached = permissionCache.get(documentId);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const allowed = await canReadDocument(documentId);
    permissionCache.set(documentId, allowed);
    return allowed;
  } catch {
    permissionCache.set(documentId, false);
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npm --workspace apps/core test -- permission-guard.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit permission guard**

Run:

```powershell
git add apps/core/src/permissions/permission-guard.ts apps/core/tests/permission-guard.test.ts
git commit -m "feat: add live document permission guard"
```

## Task 6: Context Assembly With Live Chat Anchor

**Files:**
- Create: `apps/core/src/memory/context-assembly.ts`
- Test: `apps/core/tests/context-assembly.test.ts`

- [ ] **Step 1: Write failing context assembly tests**

Create `apps/core/tests/context-assembly.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { assemblePromptContext } from "../src/memory/context-assembly.js";

describe("assemblePromptContext", () => {
  it("places background documents before live chat context", () => {
    const context = assemblePromptContext({
      backgroundDocuments: [
        { source: "doc-a", text: "Document evidence" }
      ],
      liveChatMessages: [
        { speaker: "Alice", text: "What changed today?" },
        { speaker: "Iris", text: "I will check the latest context." }
      ]
    });

    expect(context).toContain("<background_documents>");
    expect(context).toContain("<live_chat_context>");
    expect(context.indexOf("<background_documents>")).toBeLessThan(context.indexOf("<live_chat_context>"));
    expect(context.trim().endsWith("</live_chat_context>")).toBe(true);
  });

  it("limits live chat to the latest 20 messages", () => {
    const liveChatMessages = Array.from({ length: 25 }, (_, index) => ({
      speaker: "User",
      text: `message-${index + 1}`
    }));

    const context = assemblePromptContext({
      backgroundDocuments: [],
      liveChatMessages
    });

    expect(context).not.toContain("message-1");
    expect(context).toContain("message-6");
    expect(context).toContain("message-25");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm --workspace apps/core test -- context-assembly.test.ts
```

Expected: FAIL because `context-assembly.ts` does not exist.

- [ ] **Step 3: Implement context assembly**

Create `apps/core/src/memory/context-assembly.ts`:

```ts
export type BackgroundDocument = {
  source: string;
  text: string;
};

export type LiveChatMessage = {
  speaker: string;
  text: string;
};

export type PromptContextInput = {
  backgroundDocuments: BackgroundDocument[];
  liveChatMessages: LiveChatMessage[];
  liveChatLimit?: number;
};

export function assemblePromptContext(input: PromptContextInput): string {
  const liveChatLimit = input.liveChatLimit ?? 20;
  const liveMessages = input.liveChatMessages.slice(-liveChatLimit);

  return [
    "<background_documents>",
    ...input.backgroundDocuments.map(formatBackgroundDocument),
    "</background_documents>",
    "",
    "<live_chat_context>",
    ...liveMessages.map(formatLiveChatMessage),
    "</live_chat_context>"
  ].join("\n");
}

function formatBackgroundDocument(document: BackgroundDocument): string {
  return `<document source="${escapeXml(document.source)}">${escapeXml(document.text)}</document>`;
}

function formatLiveChatMessage(message: LiveChatMessage): string {
  return `<message speaker="${escapeXml(message.speaker)}">${escapeXml(message.text)}</message>`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npm --workspace apps/core test -- context-assembly.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit context assembly**

Run:

```powershell
git add apps/core/src/memory/context-assembly.ts apps/core/tests/context-assembly.test.ts
git commit -m "feat: add anchored context assembly"
```

## Task 7: Fastify App Wiring

**Files:**
- Modify: `apps/core/src/app.ts`
- Modify: `apps/core/tests/feishu-gateway.test.ts`

- [ ] **Step 1: Add app route test**

Append to `apps/core/tests/feishu-gateway.test.ts`:

```ts
import { buildApp } from "../src/app.js";

describe("Core App Feishu route", () => {
  it("returns 200 from the Feishu callback route", async () => {
    const queue = new InMemoryEventQueue();
    const app = buildApp({ queue });

    const response = await app.inject({
      method: "POST",
      url: "/feishu/events",
      headers: { "x-iris-event-id": "event-route-1" },
      payload: { event_id: "event-route-1" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(queue.events).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm --workspace apps/core test -- feishu-gateway.test.ts
```

Expected: FAIL because `buildApp` does not exist.

- [ ] **Step 3: Implement Fastify app**

Replace `apps/core/src/app.ts`:

```ts
import Fastify from "fastify";
import { createFeishuGateway } from "./feishu/feishu-gateway.js";
import type { EventQueue } from "./queues/event-queue.js";
import { InMemoryEventQueue } from "./queues/in-memory-event-queue.js";

export type BuildAppDependencies = {
  queue?: EventQueue;
};

export function buildApp(dependencies: BuildAppDependencies = {}) {
  const queue = dependencies.queue ?? new InMemoryEventQueue();
  const gateway = createFeishuGateway({ queue });
  const app = Fastify({ logger: false });

  app.post("/feishu/events", async (request, reply) => {
    const response = await gateway.handleCallback({
      headers: normalizeHeaders(request.headers),
      body: request.body
    });

    return reply.code(response.statusCode).send(response.body);
  });

  app.get("/health", async () => ({ ok: true, service: "iris-core" }));

  return app;
}

function normalizeHeaders(headers: Record<string, unknown>): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key.toLowerCase(),
      Array.isArray(value) ? String(value[0]) : typeof value === "string" ? value : undefined
    ])
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = buildApp();
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npm --workspace apps/core test -- feishu-gateway.test.ts
```

Expected: PASS, including route test.

- [ ] **Step 5: Commit app wiring**

Run:

```powershell
git add apps/core/src/app.ts apps/core/tests/feishu-gateway.test.ts
git commit -m "feat: wire Iris core HTTP app"
```

## Task 8: Python AI Worker Job Contracts

**Files:**
- Create: `workers/ai/iris_worker/__init__.py`
- Create: `workers/ai/iris_worker/jobs.py`
- Create: `workers/ai/tests/test_jobs.py`

- [ ] **Step 1: Write failing Python worker tests**

Create `workers/ai/tests/test_jobs.py`:

```py
from iris_worker.jobs import parse_document_job, summarize_group_job


def test_parse_document_job_returns_chunks_with_source():
    result = parse_document_job(
        document_id="doc-1",
        source="group-visible",
        text="First paragraph.\n\nSecond paragraph."
    )

    assert result["document_id"] == "doc-1"
    assert result["source"] == "group-visible"
    assert result["chunks"] == ["First paragraph.", "Second paragraph."]


def test_summarize_group_job_returns_evidence_bound_summary():
    result = summarize_group_job(
        group_id="chat-a",
        messages=["Alice: We should publish the FAQ.", "Bob: Confirmed."]
    )

    assert result["group_id"] == "chat-a"
    assert "publish the FAQ" in result["summary"]
    assert result["evidence_count"] == 2
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
cd workers/ai
python -m pytest
cd ../..
```

Expected: FAIL because `iris_worker.jobs` does not exist.

- [ ] **Step 3: Create worker package files**

Create `workers/ai/iris_worker/__init__.py`:

```py
"""Iris AI worker package."""
```

Create `workers/ai/iris_worker/jobs.py`:

```py
from __future__ import annotations


def parse_document_job(document_id: str, source: str, text: str) -> dict:
    chunks = [chunk.strip() for chunk in text.split("\n\n") if chunk.strip()]
    return {
        "document_id": document_id,
        "source": source,
        "chunks": chunks,
    }


def summarize_group_job(group_id: str, messages: list[str]) -> dict:
    joined = " ".join(messages)
    summary = joined[:240]
    return {
        "group_id": group_id,
        "summary": summary,
        "evidence_count": len(messages),
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
cd workers/ai
python -m pytest
cd ../..
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit worker contracts**

Run:

```powershell
git add workers/ai/iris_worker/__init__.py workers/ai/iris_worker/jobs.py workers/ai/tests/test_jobs.py
git commit -m "feat: add Iris AI worker job contracts"
```

## Task 9: Local Infrastructure Compose

**Files:**
- Create: `docker-compose.yml`
- Modify: `README.md`

- [ ] **Step 1: Create Docker Compose file**

Create `docker-compose.yml`:

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: iris
      POSTGRES_PASSWORD: iris
      POSTGRES_DB: iris
    ports:
      - "5432:5432"
    volumes:
      - iris_postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

volumes:
  iris_postgres_data:
```

- [ ] **Step 2: Update README with local commands**

Append to `README.md`:

````md

## Local Development

Install TypeScript dependencies:

```powershell
npm install
```

Run TypeScript tests:

```powershell
npm test
```

Run Python worker tests:

```powershell
cd workers/ai
python -m pytest
cd ../..
```

Start local infrastructure:

```powershell
docker compose up -d
```
````

- [ ] **Step 3: Validate compose syntax**

Run:

```powershell
docker compose config
```

Expected: Docker prints the resolved compose config without errors.

- [ ] **Step 4: Commit local infrastructure docs**

Run:

```powershell
git add docker-compose.yml README.md
git commit -m "chore: add local Iris infrastructure"
```

## Task 10: Final Verification

**Files:**
- No new files.

- [ ] **Step 1: Run TypeScript typecheck**

Run:

```powershell
npm run typecheck
```

Expected: exit code 0.

- [ ] **Step 2: Run TypeScript tests**

Run:

```powershell
npm test
```

Expected: all Vitest suites pass.

- [ ] **Step 3: Run Python tests**

Run:

```powershell
cd workers/ai
python -m pytest
cd ../..
```

Expected: all pytest tests pass.

- [ ] **Step 4: Check git status**

Run:

```powershell
git status --short
```

Expected: no unstaged or uncommitted files.
