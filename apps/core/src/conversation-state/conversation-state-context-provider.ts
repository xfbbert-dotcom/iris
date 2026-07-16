import type {
  PromptActionItem,
  PromptDiscussionThread,
} from "../memory/context-assembly.js";
import type { Queryable } from "./postgres-conversation-state-repository.js";

export type ConversationStateContext = {
  threads: PromptDiscussionThread[];
  actions: PromptActionItem[];
};

export type ConversationStateContextProvider = {
  loadRelevant(input: {
    groupId: string;
    queryText: string;
    askerId?: string;
    limit?: number;
  }): Promise<ConversationStateContext>;
};

const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 6;
const MAX_IDENTIFIER_CHARS = 512;
const MAX_QUERY_TERMS = 24;

type ContextRow = Record<string, unknown>;

export function createConversationStateContextProvider({
  dataSource,
}: {
  dataSource: Queryable;
}): ConversationStateContextProvider {
  return {
    async loadRelevant(input) {
      const groupId = normalizeIdentifier("groupId", input.groupId);
      const askerId = input.askerId === undefined
        ? undefined
        : normalizeIdentifier("askerId", input.askerId);
      const limit = sanitizeLimit(input.limit);
      if (limit === 0) {
        return { threads: [], actions: [] };
      }

      const queryTerms = normalizeQueryTerms(input.queryText);
      const threadResult = await dataSource.query<ContextRow>(
        `
        WITH merged_sources AS (
          SELECT merged.id AS source_thread_id,
                 canonical.id AS canonical_thread_id,
                 LOWER(CONCAT_WS(' ', merged.title, merged.summary)) AS source_text
          FROM discussion_threads merged
          JOIN discussion_threads canonical
            ON canonical.id = merged.merged_into_thread_id
           AND canonical.group_id = merged.group_id
          WHERE merged.group_id = $1
            AND merged.status = 'merged'
            AND canonical.status IN ('open', 'resolved')
        ), canonical_threads AS (
          SELECT thread.id,
                 thread.group_id,
                 thread.status,
                 thread.summary,
                 thread.last_activity_at,
                 thread.id AS canonical_thread_id,
                 LOWER(CONCAT_WS(' ', thread.title, thread.summary)) AS source_text
          FROM discussion_threads thread
          WHERE thread.group_id = $1
            AND thread.status IN ('open', 'resolved')
        ), thread_sources AS (
          SELECT canonical.id,
                 canonical.group_id,
                 canonical.status,
                 canonical.summary,
                 canonical.last_activity_at,
                 canonical.canonical_thread_id,
                 canonical.source_text
          FROM canonical_threads canonical
          UNION ALL
          SELECT canonical.id,
                 canonical.group_id,
                 canonical.status,
                 canonical.summary,
                 canonical.last_activity_at,
                 merged.canonical_thread_id,
                 merged.source_text
          FROM merged_sources merged
          JOIN canonical_threads canonical
            ON canonical.id = merged.canonical_thread_id
           AND canonical.group_id = $1
        ), ranked_threads AS (
          SELECT source.id,
                 source.group_id,
                 source.status,
                 source.summary,
                 source.last_activity_at,
                 source.canonical_thread_id,
                 MAX(CARDINALITY(ARRAY(
                   SELECT term
                   FROM UNNEST($2::text[]) AS term
                   WHERE source.source_text LIKE '%' || term || '%'
                 ))) AS lexical_overlap
          FROM thread_sources source
          GROUP BY source.id, source.group_id, source.status, source.summary,
                   source.last_activity_at, source.canonical_thread_id
        )
        SELECT thread.id,
               thread.group_id,
               thread.status,
               thread.summary,
               ARRAY(
                 SELECT DISTINCT evidence.conversation_message_id
                 FROM discussion_thread_evidence evidence
                 WHERE evidence.thread_id = thread.id
                   AND evidence.group_id = thread.group_id
                 ORDER BY evidence.conversation_message_id
                 LIMIT 40
               ) AS evidence_message_ids
        FROM ranked_threads thread
        WHERE thread.status = 'open'
           OR (thread.status = 'resolved' AND thread.lexical_overlap > 0)
        ORDER BY CASE thread.status WHEN 'open' THEN 0 ELSE 1 END,
                 thread.lexical_overlap DESC,
                 thread.last_activity_at DESC,
                 thread.id ASC
        LIMIT $3
        `,
        [groupId, queryTerms, limit],
      );
      const threads = threadResult.rows.map((row) => mapThread(row, groupId)).slice(0, limit);
      const selectedThreadIds = threads.map((thread) => thread.id);
      const actionResult = await dataSource.query<ContextRow>(
        `
        WITH ranked_actions AS (
          SELECT action.id,
                 action.group_id,
                 action.thread_id,
                 action.description,
                 action.owner_ref,
                 action.due_at,
                 action.status,
                 action.updated_at,
                 CARDINALITY(ARRAY(
                   SELECT term
                   FROM UNNEST($2::text[]) AS term
                   WHERE LOWER(action.description) LIKE '%' || term || '%'
                 )) AS lexical_overlap,
                 (action.thread_id = ANY($3::text[])) AS selected_thread_match,
                 ($4::text IS NOT NULL AND LOWER(action.owner_ref) = LOWER($4::text)) AS owner_match
          FROM action_items action
          WHERE action.group_id = $1
            AND action.status = 'open'
            AND NOT EXISTS (
              SELECT 1
              FROM discussion_threads thread
              WHERE thread.id = action.thread_id
                AND thread.group_id = action.group_id
                AND thread.status IN ('candidate', 'merged')
            )
        )
        SELECT action.id,
               action.group_id,
               action.thread_id,
               action.description,
               action.owner_ref,
               action.due_at,
               action.status,
               ARRAY(
                 SELECT DISTINCT evidence.conversation_message_id
                 FROM action_item_events event
                 JOIN action_item_event_evidence evidence
                   ON evidence.event_id = event.id
                  AND evidence.group_id = event.group_id
                 WHERE event.action_item_id = action.id
                   AND event.group_id = action.group_id
                 ORDER BY evidence.conversation_message_id
                 LIMIT 40
               ) AS evidence_message_ids
        FROM ranked_actions action
        WHERE action.selected_thread_match
           OR action.owner_match
           OR action.lexical_overlap > 0
        ORDER BY action.selected_thread_match DESC,
                 action.owner_match DESC,
                 action.lexical_overlap DESC,
                 action.updated_at DESC,
                 action.id ASC
        LIMIT $5
        `,
        [groupId, queryTerms, selectedThreadIds, askerId ?? null, limit],
      );

      return {
        threads,
        actions: actionResult.rows.map((row) => mapAction(row, groupId)).slice(0, limit),
      };
    },
  };
}

function mapThread(row: ContextRow, groupId: string): PromptDiscussionThread {
  const status = row.status;
  if (row.group_id !== groupId || (status !== "open" && status !== "resolved")) {
    throw new Error("conversation state thread is invalid");
  }
  return {
    id: requireText(row.id),
    status,
    summary: requireText(row.summary),
    evidenceMessageIds: requireEvidenceIds(row.evidence_message_ids),
  };
}

function mapAction(row: ContextRow, groupId: string): PromptActionItem {
  if (row.group_id !== groupId || row.status !== "open") {
    throw new Error("conversation state action is invalid");
  }
  const threadId = row.thread_id === null || row.thread_id === undefined
    ? undefined
    : requireText(row.thread_id);
  const dueAt = row.due_at === null || row.due_at === undefined
    ? undefined
    : requireDate(row.due_at);
  return {
    id: requireText(row.id),
    ...(threadId === undefined ? {} : { threadId }),
    status: "open",
    description: requireText(row.description),
    ownerRef: requireText(row.owner_ref),
    ...(dueAt === undefined ? {} : { dueAt }),
    evidenceMessageIds: requireEvidenceIds(row.evidence_message_ids),
  };
}

function normalizeIdentifier(field: string, value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_IDENTIFIER_CHARS) {
    throw new Error(`${field} must be a non-blank identifier`);
  }
  return normalized;
}

function normalizeQueryTerms(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])]
    .slice(0, MAX_QUERY_TERMS);
}

function sanitizeLimit(value: number | undefined): number {
  if (
    value !== undefined &&
    (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error("conversation state context limit must be a finite safe-magnitude number");
  }
  return Math.min(MAX_LIMIT, Math.max(0, Math.floor(value ?? DEFAULT_LIMIT)));
}

function requireText(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("conversation state context row is invalid");
  }
  return value.trim();
}

function requireEvidenceIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("conversation state context row is invalid");
  }
  return [...new Set(value.map(requireText))].sort();
}

function requireDate(value: unknown): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("conversation state context row is invalid");
  }
  return new Date(value);
}
