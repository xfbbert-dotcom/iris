export const DISCUSSION_THREAD_STATUSES = ["candidate", "open", "resolved", "merged"] as const;
export const DISCUSSION_THREAD_EVENT_TYPES = [
  "created",
  "promoted",
  "summary_updated",
  "resolved",
  "reopened",
  "merged",
  "corrected",
  "evidence_attached",
] as const;
export const ACTION_ITEM_OWNER_REF_TYPES = ["feishu_user", "text_label"] as const;
export const ACTION_ITEM_STATUSES = ["open", "completed", "cancelled"] as const;
export const ACTION_ITEM_EVENT_TYPES = [
  "created",
  "completed",
  "cancelled",
  "reopened",
  "owner_resolved",
  "corrected",
] as const;
export const CONVERSATION_STATE_ENTITY_TYPES = ["thread", "action"] as const;
export const PROJECTION_REPAIR_STATUSES = [
  "pending",
  "processing",
  "completed",
  "failed",
] as const;

export type DiscussionThreadStatus = (typeof DISCUSSION_THREAD_STATUSES)[number];
export type DiscussionThreadEventType = (typeof DISCUSSION_THREAD_EVENT_TYPES)[number];
export type ActionItemOwnerRefType = (typeof ACTION_ITEM_OWNER_REF_TYPES)[number];
export type ActionItemStatus = (typeof ACTION_ITEM_STATUSES)[number];
export type ActionItemEventType = (typeof ACTION_ITEM_EVENT_TYPES)[number];
export type ConversationStateEntityType = (typeof CONVERSATION_STATE_ENTITY_TYPES)[number];
export type ProjectionRepairStatus = (typeof PROJECTION_REPAIR_STATUSES)[number];

export type DiscussionThread = {
  id: string;
  groupId: string;
  title: string;
  summary: string;
  status: DiscussionThreadStatus;
  confidence: number;
  mergedIntoThreadId?: string;
  version: number;
  firstEvidenceAt: Date;
  lastActivityAt: Date;
  resolvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type DiscussionThreadEvidence = {
  threadId: string;
  groupId: string;
  conversationMessageId: string;
  createdAt: Date;
};

export type DiscussionThreadEvent = {
  id: string;
  threadId: string;
  groupId: string;
  eventType: DiscussionThreadEventType;
  fromVersion?: number;
  toVersion: number;
  operationKey: string;
  createdAt: Date;
};

export type DiscussionThreadEventEvidence = {
  eventId: string;
  groupId: string;
  conversationMessageId: string;
};

export type ActionItem = {
  id: string;
  groupId: string;
  threadId?: string;
  description: string;
  ownerRefType: ActionItemOwnerRefType;
  ownerRef: string;
  dueAt?: Date;
  status: ActionItemStatus;
  confidence: number;
  version: number;
  completedAt?: Date;
  cancelledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type ActionItemEvent = {
  id: string;
  actionItemId: string;
  groupId: string;
  eventType: ActionItemEventType;
  fromVersion?: number;
  toVersion: number;
  operationKey: string;
  createdAt: Date;
};

export type ActionItemEventEvidence = {
  eventId: string;
  groupId: string;
  conversationMessageId: string;
};

export type ConversationStateMemoryProjection = {
  entityType: ConversationStateEntityType;
  entityId: string;
  groupId: string;
  projectedVersion: number;
  memoryId?: string;
  updatedAt: Date;
};

export type ProjectionRepair = {
  id: string;
  entityType: ConversationStateEntityType;
  entityId: string;
  groupId: string;
  entityVersion: number;
  status: ProjectionRepairStatus;
  attemptCount: number;
  nextAttemptAt: Date;
  failureClassification?: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ConversationStateProjectionTarget =
  | {
      entityType: "thread";
      entity: DiscussionThread;
      evidenceMessageIds: string[];
      memoryId?: string;
    }
  | {
      entityType: "action";
      entity: ActionItem;
      evidenceMessageIds: string[];
      memoryId?: string;
    };

export type CreateDiscussionThreadEvent = DiscussionThreadEvent & {
  fromVersion?: undefined;
};

export type MutationDiscussionThreadEvent = DiscussionThreadEvent & {
  fromVersion: number;
};

export type CreateActionItemEvent = ActionItemEvent & {
  fromVersion?: undefined;
};

export type MutationActionItemEvent = ActionItemEvent & {
  fromVersion: number;
};

export type CreateConversationStateOperation = {
  kind: "create";
  operationKey: string;
  expectedVersion?: never;
  thread?: DiscussionThread;
  action?: ActionItem;
  threadEvent?: CreateDiscussionThreadEvent;
  actionEvent?: CreateActionItemEvent;
  evidenceMessageIds: string[];
};

export type MutationConversationStateOperation = {
  kind: "mutation";
  operationKey: string;
  expectedVersion: number;
  thread?: DiscussionThread;
  action?: ActionItem;
  threadEvent?: MutationDiscussionThreadEvent;
  actionEvent?: MutationActionItemEvent;
  evidenceMessageIds: string[];
};

export type ConversationStateOperation =
  | CreateConversationStateOperation
  | MutationConversationStateOperation;

export type ApplyConversationStateOperationsInput = {
  groupId: string;
  operations: ConversationStateOperation[];
};

export type RelevantThreadQuery = {
  groupId: string;
  limit: number;
  statuses?: DiscussionThreadStatus[];
};

export type RelevantActionQuery = {
  groupId: string;
  limit: number;
  statuses?: ActionItemStatus[];
  threadId?: string;
};

export type ConversationStateStatusCounts = {
  threads: Record<DiscussionThreadStatus, number>;
  actions: Record<ActionItemStatus, number>;
  projectionRepairs: Record<ProjectionRepairStatus, number>;
};

export interface ConversationStateRepository {
  loadExtractionContext(input: {
    groupId: string;
    threadLimit: number;
    actionLimit: number;
  }): Promise<{ threads: DiscussionThread[]; actions: ActionItem[] }>;
  applyOperations(input: ApplyConversationStateOperationsInput): Promise<{
    status: "applied" | "already_applied";
    threadIds: string[];
    actionItemIds: string[];
  }>;
  listRelevantThreads(input: RelevantThreadQuery): Promise<DiscussionThread[]>;
  listRelevantActions(input: RelevantActionQuery): Promise<ActionItem[]>;
  /** Privileged exact projection worker boundary; never expose to answering paths. */
  loadProjectionTarget(input: {
    entityType: ConversationStateEntityType;
    entityId: string;
    groupId: string;
  }): Promise<ConversationStateProjectionTarget | undefined>;
  /** Privileged system-wide projection worker boundary; never expose to answering paths. */
  claimProjectionRepairs(input: { limit: number; now: Date }): Promise<ProjectionRepair[]>;
  /** Privileged system-wide projection worker boundary; never expose to answering paths. */
  completeProjectionRepair(input: { id: string; memoryId?: string }): Promise<void>;
  /** Privileged system-wide projection worker boundary; never expose to answering paths. */
  failProjectionRepair(input: {
    id: string;
    retryAt: Date;
    classification: string;
  }): Promise<void>;
  /** Privileged system-wide operator boundary; never expose to answering paths. */
  getStatusCounts(): Promise<ConversationStateStatusCounts>;
}
