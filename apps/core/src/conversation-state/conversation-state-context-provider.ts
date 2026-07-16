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
const MAX_MERGE_DEPTH = 8;
const QUERY_SEGMENT_PATTERN = /[\p{Script=Han}]+|[\p{Script=Latin}\p{N}_%]+/gu;
const LATIN_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in", "is",
  "it", "no", "of", "on", "or", "please", "the", "to", "was", "what", "when", "where", "who", "with",
]);
const CJK_STOPWORDS = new Set([
  "的", "了", "和", "是", "在", "有", "请", "请问", "帮", "我", "你", "他", "她", "它", "我们", "你们",
  "他们", "这个", "那个", "什么", "怎么", "如何", "吗", "呢", "吧", "啊", "呀", "将", "已", "能", "可以",
  "需要", "关于", "以及", "与", "或", "并", "而", "但", "从", "到", "对", "把", "被", "给", "就", "都",
  "也", "很", "再", "还",
]);
const CJK_EDGE_STOPWORDS = [...CJK_STOPWORDS].sort((left, right) => right.length - left.length);
const VALID_SINGLE_CJK_TERMS = new Set(["人", "税", "钱", "票", "码", "号", "款"]);

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

      const queryTerms = normalizeConversationStateQueryTerms(input.queryText);
      const threadResult = await dataSource.query<ContextRow>(
        `
        WITH RECURSIVE canonical_threads AS (
          SELECT thread.id,
                 thread.group_id,
                 thread.status,
                 thread.title,
                 thread.summary,
                 thread.last_activity_at,
                 thread.id AS canonical_thread_id,
                 LOWER(CONCAT_WS(' ', thread.title, thread.summary)) AS source_text
          FROM discussion_threads thread
          WHERE thread.group_id = $1
            AND thread.status IN ('open', 'resolved')
        ), merge_walk AS (
          SELECT source.id AS source_thread_id,
                 source.group_id,
                 source.merged_into_thread_id AS next_thread_id,
                 ARRAY[source.id]::text[] AS visited_thread_ids,
                 1 AS depth,
                 LOWER(CONCAT_WS(' ', source.title, source.summary)) AS source_text
          FROM discussion_threads source
          WHERE source.group_id = $1
            AND source.status = 'merged'
          UNION ALL
          SELECT walk.source_thread_id,
                 walk.group_id,
                 next_thread.merged_into_thread_id AS next_thread_id,
                 walk.visited_thread_ids || next_thread.id,
                 walk.depth + 1,
                 CONCAT_WS(' ', walk.source_text, LOWER(CONCAT_WS(' ', next_thread.title, next_thread.summary)))
          FROM merge_walk walk
          JOIN discussion_threads next_thread
            ON next_thread.id = walk.next_thread_id
           AND next_thread.group_id = walk.group_id
          WHERE walk.depth < ${MAX_MERGE_DEPTH}
            AND next_thread.status = 'merged'
            AND NOT next_thread.id = ANY(walk.visited_thread_ids)
        ), merge_terminals AS (
          SELECT terminal.id,
                 terminal.group_id,
                 terminal.status,
                 terminal.summary,
                 terminal.last_activity_at,
                 terminal.id AS canonical_thread_id,
                 CONCAT_WS(' ', walk.source_text, LOWER(CONCAT_WS(' ', terminal.title, terminal.summary))) AS source_text
          FROM merge_walk walk
          JOIN canonical_threads terminal
            ON terminal.id = walk.next_thread_id
           AND terminal.group_id = walk.group_id
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
          SELECT terminal.id,
                 terminal.group_id,
                 terminal.status,
                 terminal.summary,
                 terminal.last_activity_at,
                 terminal.canonical_thread_id,
                 terminal.source_text
          FROM merge_terminals terminal
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
                   WHERE strpos(source.source_text, term) > 0
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
                   WHERE strpos(LOWER(action.description), term) > 0
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

export function normalizeConversationStateQueryTerms(value: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  const normalized = value.toLocaleLowerCase();
  for (const match of normalized.matchAll(QUERY_SEGMENT_PATTERN)) {
    const segment = match[0];
    if (segment === undefined) {
      continue;
    }
    const segmentTerms = isCjkSegment(segment)
      ? cjkNgrams(trimCjkStopwordEdges(segment))
      : LATIN_STOPWORDS.has(segment) ? [] : [segment];
    for (const term of segmentTerms) {
      if (seen.has(term)) {
        continue;
      }
      seen.add(term);
      terms.push(term);
      if (terms.length === MAX_QUERY_TERMS) {
        return terms;
      }
    }
  }
  return terms;
}

function isCjkSegment(value: string): boolean {
  return /^\p{Script=Han}+$/u.test(value);
}

function trimCjkStopwordEdges(value: string): string {
  let trimmed = value;
  let changed = true;
  while (changed && trimmed.length > 0) {
    changed = false;
    for (const stopword of CJK_EDGE_STOPWORDS) {
      if (trimmed.startsWith(stopword)) {
        trimmed = trimmed.slice(stopword.length);
        changed = true;
        break;
      }
      if (trimmed.endsWith(stopword)) {
        trimmed = trimmed.slice(0, -stopword.length);
        changed = true;
        break;
      }
    }
  }
  return trimmed;
}

function cjkNgrams(value: string): string[] {
  if (value.length === 1) {
    return VALID_SINGLE_CJK_TERMS.has(value) ? [value] : [];
  }
  if (CJK_STOPWORDS.has(value)) {
    return [];
  }
  const terms: string[] = [];
  for (let index = 0; index < value.length - 1; index += 1) {
    const term = value.slice(index, index + 2);
    if (!CJK_STOPWORDS.has(term)) {
      terms.push(term);
    }
  }
  return terms;
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
