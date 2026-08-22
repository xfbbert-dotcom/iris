import { createHash } from "node:crypto";

import type { ChatFormalTaskDraftGenerator } from
  "./chat-formal-task-draft-generator.js";
import type {
  FeishuTaskTargetPolicy,
  FormalTaskRepository,
} from "./formal-task-repository.js";
import type { FormalTaskDraftPresentation } from "./formal-task-card-repository.js";

export type ChatFormalTaskDraftCommandResult =
  | {
      status: "created" | "already_created";
      draftId: string;
      presentationId: string;
    }
  | {
      status:
        | "assignee_clarification_required"
        | "runtime_disabled"
        | "no_context"
        | "target_unavailable";
    };

export type ChatFormalTaskDraftCommand = {
  execute(input: {
    messageId: string;
    chatId: string;
    requesterOpenId: string;
    requestText: string;
    assigneeOpenIds: string[];
    observedAt: Date;
  }): Promise<ChatFormalTaskDraftCommandResult>;
};

export type ChatFormalTaskDraftCommandDependencies = {
  generator: ChatFormalTaskDraftGenerator;
  canReadGroupContext(groupId: string): boolean;
  runtime: {
    repository: Pick<
      FormalTaskRepository,
      "getDraft" | "getTargetPolicyForGroup" | "createDraft"
    >;
    canCreateDraft(input: { sourceGroupId: string }): boolean;
    canUseFormalTaskCards(groupId: string): boolean;
    presentDraft(input: {
      draftId: string;
      expectedVersion: number;
      operationKey: string;
      at: Date;
    }): Promise<{
      outcome: "applied" | "already_applied";
      presentation: FormalTaskDraftPresentation;
    }>;
  };
};

export class ChatFormalTaskDraftCommandConflictError extends Error {
  constructor() {
    super("chat formal task draft command identity conflict");
    this.name = "ChatFormalTaskDraftCommandConflictError";
  }
}

export function createChatFormalTaskDraftCommand(
  dependencies: ChatFormalTaskDraftCommandDependencies,
): ChatFormalTaskDraftCommand {
  const inFlight = new Map<string, Promise<ChatFormalTaskDraftCommandResult>>();
  return {
    execute(rawInput) {
      const input = normalizeInput(rawInput);
      const identity = commandIdentity(input.messageId);
      const existing = inFlight.get(identity.digest);
      if (existing !== undefined) return existing;
      const execution = executeOnce(dependencies, input, identity).finally(() => {
        if (inFlight.get(identity.digest) === execution) inFlight.delete(identity.digest);
      });
      inFlight.set(identity.digest, execution);
      return execution;
    },
  };
}

async function executeOnce(
  dependencies: ChatFormalTaskDraftCommandDependencies,
  input: NormalizedInput,
  identity: CommandIdentity,
): Promise<ChatFormalTaskDraftCommandResult> {
  if (input.assigneeOpenIds.length !== 1) {
    return { status: "assignee_clarification_required" };
  }
  const assigneeOpenId = input.assigneeOpenIds[0]!;
  const existing = await dependencies.runtime.repository.getDraft(identity.draftId);
  if (existing !== undefined) {
    if (existing.sourceGroupId !== input.chatId || existing.createdBy !== "iris") {
      throw new ChatFormalTaskDraftCommandConflictError();
    }
    if (
      "taskSpec" in existing.currentRevision &&
      existing.currentRevision.taskSpec.assigneeOpenId !== assigneeOpenId
    ) throw new ChatFormalTaskDraftCommandConflictError();
    if (!readGate(() => dependencies.runtime.canUseFormalTaskCards(input.chatId))) {
      return { status: "runtime_disabled" };
    }
    const presentation = await dependencies.runtime.presentDraft({
      draftId: existing.id,
      expectedVersion: existing.version,
      operationKey: identity.presentationOperationKey,
      at: input.observedAt,
    });
    assertExactPresentation(presentation.presentation, existing.id, input.chatId, existing.version);
    return {
      status: "already_created",
      draftId: existing.id,
      presentationId: presentation.presentation.id,
    };
  }

  const initialTarget = await readCreationTarget(dependencies, input.chatId, assigneeOpenId);
  if (initialTarget.status !== "available") return { status: initialTarget.status };
  const generated = await dependencies.generator.generate({
    messageId: input.messageId,
    chatId: input.chatId,
    requesterOpenId: input.requesterOpenId,
    requestText: input.requestText,
    observedAt: input.observedAt,
  });
  if (generated.status === "no_context") return { status: "no_context" };

  const confirmedTarget = await readCreationTarget(dependencies, input.chatId, assigneeOpenId);
  if (
    confirmedTarget.status !== "available" ||
    !sameTargetPolicy(initialTarget.policy, confirmedTarget.policy)
  ) return { status: confirmedTarget.status === "runtime_disabled"
      ? "runtime_disabled"
      : "target_unavailable" };

  const targetPolicy = confirmedTarget.policy;
  const creation = await dependencies.runtime.repository.createDraft({
    id: identity.draftId,
    operationKey: identity.creationOperationKey,
    createdBy: "iris",
    revision: {
      taskSpec: {
        title: generated.title,
        description: generated.description,
        assigneeOpenId,
        ...(generated.dueAt === undefined ? {} : { dueAt: generated.dueAt }),
        ...(generated.reminderMinutes === undefined
          ? {}
          : { reminderMinutes: generated.reminderMinutes }),
        sourceGroupId: input.chatId,
        targetPolicyId: targetPolicy.id,
        targetPolicyVersion: targetPolicy.version,
      },
      riskLevel: "high",
      author: "iris",
      evidence: generated.evidence,
    },
    at: input.observedAt,
  });
  if (
    creation.draft.id !== identity.draftId ||
    creation.draft.sourceGroupId !== input.chatId
  ) throw new ChatFormalTaskDraftCommandConflictError();
  const presentation = await dependencies.runtime.presentDraft({
    draftId: creation.draft.id,
    expectedVersion: creation.draft.version,
    operationKey: identity.presentationOperationKey,
    at: input.observedAt,
  });
  assertExactPresentation(
    presentation.presentation,
    creation.draft.id,
    input.chatId,
    creation.draft.version,
  );
  return {
    status: creation.outcome === "applied" ? "created" : "already_created",
    draftId: creation.draft.id,
    presentationId: presentation.presentation.id,
  };
}

type CreationTarget =
  | { status: "runtime_disabled" | "target_unavailable" }
  | { status: "available"; policy: FeishuTaskTargetPolicy };

async function readCreationTarget(
  dependencies: ChatFormalTaskDraftCommandDependencies,
  sourceGroupId: string,
  assigneeOpenId: string,
): Promise<CreationTarget> {
  if (
    !readGate(() => dependencies.canReadGroupContext(sourceGroupId)) ||
    !readGate(() => dependencies.runtime.canCreateDraft({ sourceGroupId })) ||
    !readGate(() => dependencies.runtime.canUseFormalTaskCards(sourceGroupId))
  ) return { status: "runtime_disabled" };
  const policy = await dependencies.runtime.repository.getTargetPolicyForGroup(sourceGroupId);
  if (
    policy === undefined ||
    !policy.enabled ||
    policy.sourceGroupId !== sourceGroupId ||
    !policy.allowedAssigneeOpenIds.includes(assigneeOpenId)
  ) return { status: "target_unavailable" };
  return { status: "available", policy };
}

function sameTargetPolicy(
  first: FeishuTaskTargetPolicy,
  second: FeishuTaskTargetPolicy,
): boolean {
  return first.id === second.id &&
    first.sourceGroupId === second.sourceGroupId &&
    first.version === second.version;
}

type NormalizedInput = {
  messageId: string;
  chatId: string;
  requesterOpenId: string;
  requestText: string;
  assigneeOpenIds: string[];
  observedAt: Date;
};

type CommandIdentity = {
  digest: string;
  draftId: string;
  creationOperationKey: string;
  presentationOperationKey: string;
};

function normalizeInput(input: NormalizedInput): NormalizedInput {
  const assigneeOpenIds = Array.isArray(input.assigneeOpenIds)
    ? input.assigneeOpenIds.map((value) => requireReference(value, "assigneeOpenId"))
    : [];
  return {
    messageId: requireReference(input.messageId, "messageId"),
    chatId: requireReference(input.chatId, "chatId"),
    requesterOpenId: requireReference(input.requesterOpenId, "requesterOpenId"),
    requestText: requireNonBlank(input.requestText, "requestText"),
    assigneeOpenIds: [...new Set(assigneeOpenIds)].sort(),
    observedAt: requireDate(input.observedAt),
  };
}

function commandIdentity(messageId: string): CommandIdentity {
  const digest = createHash("sha256")
    .update(JSON.stringify({ provider: "feishu", messageId }))
    .digest("hex");
  return {
    digest,
    draftId: `chat-formal-task-draft-${digest.slice(0, 40)}`,
    creationOperationKey: `chat-formal-task-draft-create-${digest}`,
    presentationOperationKey: `chat-formal-task-card-${digest}`,
  };
}

function assertExactPresentation(
  presentation: FormalTaskDraftPresentation,
  draftId: string,
  groupId: string,
  draftVersion: number,
): void {
  if (
    presentation.draftId !== draftId ||
    presentation.groupId !== groupId ||
    presentation.draftVersion !== draftVersion
  ) throw new ChatFormalTaskDraftCommandConflictError();
}

function readGate(read: () => boolean): boolean {
  try {
    return read();
  } catch {
    return false;
  }
}

function requireReference(value: string, name: string): string {
  const normalized = requireNonBlank(value, name);
  if ([...normalized].length > 512 || /[\u0000-\u001f\u007f\s]/u.test(normalized)) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function requireNonBlank(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must not be blank`);
  }
  return value.trim();
}

function requireDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("observedAt must be a valid date");
  }
  return new Date(value);
}
