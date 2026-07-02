import { randomUUID } from "node:crypto";

import pg from "pg";

import {
  DocumentSourceValidationError,
  higherPriorityDocumentSourceType,
  type DocumentPermissionState,
  type DocumentSource,
  type DocumentSourceEvidence,
  type DocumentSourceRegistryDependencies,
  type DocumentSourceType,
  type DocumentSyncState,
  type RegisterAuthorizedWikiDocumentInput,
  type RegisterGroupVisibleDocumentInput,
  type RegisterUserSubmittedDocumentInput,
} from "./document-source-registry.js";

export interface AsyncDocumentSourceRegistry {
  registerGroupVisibleDocument(input: RegisterGroupVisibleDocumentInput): Promise<DocumentSource>;
  registerAuthorizedWikiDocument(input: RegisterAuthorizedWikiDocumentInput): Promise<DocumentSource>;
  registerUserSubmittedDocument(input: RegisterUserSubmittedDocumentInput): Promise<DocumentSource>;
  markPermissionState(
    id: string,
    permissionState: DocumentPermissionState,
  ): Promise<DocumentSource>;
  markSyncState(id: string, syncState: DocumentSyncState): Promise<DocumentSource>;
  setAnsweringEnabled(id: string, enabled: boolean): Promise<DocumentSource>;
  setKnowledgeDraftsEnabled(id: string, enabled: boolean): Promise<DocumentSource>;
  listSources(): Promise<DocumentSource[]>;
  listSourcesByType(sourceType: DocumentSourceType): Promise<DocumentSource[]>;
  findSourceById(id: string): Promise<DocumentSource | undefined>;
  findSourceByUri(sourceUri: string): Promise<DocumentSource | undefined>;
  listSourcesUsableForAnswering(): Promise<DocumentSource[]>;
  listSourcesByGroupId(groupId: string): Promise<DocumentSource[]>;
  listSourcesByAuthorizedSpaceId(spaceId: string): Promise<DocumentSource[]>;
  listSourcesBySubmittingUserId(userId: string): Promise<DocumentSource[]>;
}

type Queryable = pg.Pool | pg.PoolClient;

type SourceRow = {
  id: string;
  source_type: DocumentSourceType;
  source_uri: string;
  title: string | null;
  origin_group_id: string | null;
  origin_message_id: string | null;
  submitted_by_user_id: string | null;
  authorized_space_id: string | null;
  permission_state: DocumentPermissionState;
  sync_state: DocumentSyncState;
  can_use_for_answering: boolean;
  can_use_for_knowledge_drafts: boolean;
  created_at: Date;
  updated_at: Date;
};

type EvidenceRow = {
  kind: DocumentSourceEvidence["kind"];
  source_uri: string;
  group_id: string | null;
  message_id: string | null;
  user_id: string | null;
  space_id: string | null;
  observed_at: Date;
};

type NextDocumentSource = {
  sourceType: DocumentSourceType;
  sourceUri: string;
  title?: string;
  originGroupId?: string;
  originMessageId?: string;
  submittedByUserId?: string;
  authorizedSpaceId?: string;
  canUseForAnswering: boolean;
  canUseForKnowledgeDrafts: boolean;
  evidence: DocumentSourceEvidence;
};

export function createPostgresDocumentSourceRegistry(
  pool: pg.Pool,
  dependencies: DocumentSourceRegistryDependencies = {},
): AsyncDocumentSourceRegistry {
  const resolvedDependencies: Required<DocumentSourceRegistryDependencies> = {
    createId: dependencies.createId ?? randomUUID,
    now: dependencies.now ?? (() => new Date()),
  };

  return {
    registerGroupVisibleDocument(input) {
      const sourceUri = requireNonBlank("sourceUri", input.sourceUri);
      const originGroupId = requireNonBlank("originGroupId", input.originGroupId);
      const originMessageId = requireNonBlank("originMessageId", input.originMessageId);

      return registerSource(pool, resolvedDependencies, {
        sourceType: "group_visible_document",
        sourceUri,
        title: normalizeOptional(input.title),
        originGroupId,
        originMessageId,
        submittedByUserId: undefined,
        authorizedSpaceId: undefined,
        canUseForAnswering: true,
        canUseForKnowledgeDrafts: true,
        evidence: {
          kind: "group_message",
          sourceUri,
          groupId: originGroupId,
          messageId: originMessageId,
          userId: undefined,
          spaceId: undefined,
          observedAt: new Date(input.observedAt),
        },
      });
    },

    registerAuthorizedWikiDocument(input) {
      const sourceUri = requireNonBlank("sourceUri", input.sourceUri);
      const authorizedSpaceId = requireNonBlank(
        "authorizedSpaceId",
        input.authorizedSpaceId,
      );

      return registerSource(pool, resolvedDependencies, {
        sourceType: "authorized_wiki_document",
        sourceUri,
        title: normalizeOptional(input.title),
        originGroupId: undefined,
        originMessageId: undefined,
        submittedByUserId: undefined,
        authorizedSpaceId,
        canUseForAnswering: true,
        canUseForKnowledgeDrafts: true,
        evidence: {
          kind: "admin_authorization",
          sourceUri,
          groupId: undefined,
          messageId: undefined,
          userId: undefined,
          spaceId: authorizedSpaceId,
          observedAt: new Date(input.observedAt),
        },
      });
    },

    registerUserSubmittedDocument(input) {
      const sourceUri = requireNonBlank("sourceUri", input.sourceUri);
      const submittedByUserId = requireNonBlank(
        "submittedByUserId",
        input.submittedByUserId,
      );

      return registerSource(pool, resolvedDependencies, {
        sourceType: "user_submitted_document",
        sourceUri,
        title: normalizeOptional(input.title),
        originGroupId: undefined,
        originMessageId: undefined,
        submittedByUserId,
        authorizedSpaceId: undefined,
        canUseForAnswering: true,
        canUseForKnowledgeDrafts: false,
        evidence: {
          kind: "user_submission",
          sourceUri,
          groupId: undefined,
          messageId: undefined,
          userId: submittedByUserId,
          spaceId: undefined,
          observedAt: new Date(input.observedAt),
        },
      });
    },

    markPermissionState(id, permissionState) {
      return updateSource(pool, resolvedDependencies, id, {
        sql: `
update document_sources
set
  permission_state = $2,
  can_use_for_answering = case when $2 = 'denied' then false else can_use_for_answering end,
  updated_at = $3
where id = $1
returning *
`,
        values: [id, permissionState],
      });
    },

    markSyncState(id, syncState) {
      return updateSource(pool, resolvedDependencies, id, {
        sql: `
update document_sources
set sync_state = $2, updated_at = $3
where id = $1
returning *
`,
        values: [id, syncState],
      });
    },

    setAnsweringEnabled(id, enabled) {
      return updateSource(pool, resolvedDependencies, id, {
        sql: `
update document_sources
set
  can_use_for_answering = case when permission_state = 'denied' then false else $2 end,
  updated_at = $3
where id = $1
returning *
`,
        values: [id, enabled],
      });
    },

    setKnowledgeDraftsEnabled(id, enabled) {
      return updateSource(pool, resolvedDependencies, id, {
        sql: `
update document_sources
set can_use_for_knowledge_drafts = $2, updated_at = $3
where id = $1
returning *
`,
        values: [id, enabled],
      });
    },

    listSources() {
      return fetchSources(pool, "true", []);
    },

    listSourcesByType(sourceType) {
      return fetchSources(pool, "source_type = $1", [sourceType]);
    },

    findSourceById(id) {
      return fetchSourceById(pool, id);
    },

    findSourceByUri(sourceUri) {
      return fetchSourceByUri(pool, sourceUri.trim());
    },

    listSourcesUsableForAnswering() {
      return fetchSources(pool, "can_use_for_answering = true", []);
    },

    listSourcesByGroupId(groupId) {
      return fetchSources(
        pool,
        `
origin_group_id = $1
or exists (
  select 1
  from document_source_evidence evidence
  where evidence.document_source_id = document_sources.id
    and evidence.group_id = $1
)
`,
        [groupId],
      );
    },

    listSourcesByAuthorizedSpaceId(spaceId) {
      return fetchSources(
        pool,
        `
authorized_space_id = $1
or exists (
  select 1
  from document_source_evidence evidence
  where evidence.document_source_id = document_sources.id
    and evidence.space_id = $1
)
`,
        [spaceId],
      );
    },

    listSourcesBySubmittingUserId(userId) {
      return fetchSources(
        pool,
        `
submitted_by_user_id = $1
or exists (
  select 1
  from document_source_evidence evidence
  where evidence.document_source_id = document_sources.id
    and evidence.user_id = $1
)
`,
        [userId],
      );
    },
  };
}

async function registerSource(
  pool: pg.Pool,
  dependencies: Required<DocumentSourceRegistryDependencies>,
  next: NextDocumentSource,
): Promise<DocumentSource> {
  return withTransaction(pool, async (client) => {
    const now = new Date(dependencies.now());

    await client.query(
      `
insert into document_sources (
  id,
  source_type,
  source_uri,
  title,
  origin_group_id,
  origin_message_id,
  submitted_by_user_id,
  authorized_space_id,
  permission_state,
  sync_state,
  can_use_for_answering,
  can_use_for_knowledge_drafts,
  created_at,
  updated_at
)
values ($1, $2, $3, $4, $5, $6, $7, $8, 'unknown', 'pending', $9, $10, $11, $11)
on conflict (source_uri) do nothing
`,
      [
        dependencies.createId(),
        next.sourceType,
        next.sourceUri,
        next.title ?? null,
        next.originGroupId ?? null,
        next.originMessageId ?? null,
        next.submittedByUserId ?? null,
        next.authorizedSpaceId ?? null,
        next.canUseForAnswering,
        next.canUseForKnowledgeDrafts,
        now,
      ],
    );

    const existing = await getSourceByUriForUpdate(client, next.sourceUri);
    const mergedSourceType = higherPriorityDocumentSourceType(
      existing.source_type,
      next.sourceType,
    );

    await client.query(
      `
update document_sources
set
  source_type = $1,
  title = coalesce(title, $2),
  origin_group_id = coalesce(origin_group_id, $3),
  origin_message_id = coalesce(origin_message_id, $4),
  submitted_by_user_id = coalesce(submitted_by_user_id, $5),
  authorized_space_id = coalesce(authorized_space_id, $6),
  updated_at = $7
where id = $8
`,
      [
        mergedSourceType,
        next.title ?? null,
        next.originGroupId ?? null,
        next.originMessageId ?? null,
        next.submittedByUserId ?? null,
        next.authorizedSpaceId ?? null,
        now,
        existing.id,
      ],
    );

    await client.query(
      `
insert into document_source_evidence (
  document_source_id,
  kind,
  source_uri,
  group_id,
  message_id,
  user_id,
  space_id,
  observed_at,
  created_at
)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
on conflict do nothing
`,
      [
        existing.id,
        next.evidence.kind,
        next.evidence.sourceUri,
        next.evidence.groupId ?? null,
        next.evidence.messageId ?? null,
        next.evidence.userId ?? null,
        next.evidence.spaceId ?? null,
        next.evidence.observedAt,
        now,
      ],
    );

    return getExistingSourceById(client, existing.id);
  });
}

async function updateSource(
  pool: pg.Pool,
  dependencies: Required<DocumentSourceRegistryDependencies>,
  id: string,
  update: { sql: string; values: unknown[] },
): Promise<DocumentSource> {
  return withTransaction(pool, async (client) => {
    const now = new Date(dependencies.now());
    const result = await client.query<SourceRow>(update.sql, [...update.values, now]);
    const row = result.rows[0];

    if (row === undefined) {
      throw new DocumentSourceValidationError(`document source not found: ${id}`);
    }

    return getExistingSourceById(client, row.id);
  });
}

async function withTransaction<T>(
  pool: pg.Pool,
  operation: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("begin");
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // Preserve the original transaction failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function getSourceByUriForUpdate(
  client: pg.PoolClient,
  sourceUri: string,
): Promise<SourceRow> {
  const result = await client.query<SourceRow>(
    "select * from document_sources where source_uri = $1 for update",
    [sourceUri],
  );
  const row = result.rows[0];

  if (row === undefined) {
    throw new DocumentSourceValidationError(`document source not found: ${sourceUri}`);
  }

  return row;
}

async function getExistingSourceById(client: Queryable, id: string): Promise<DocumentSource> {
  const source = await fetchSourceById(client, id);

  if (source === undefined) {
    throw new DocumentSourceValidationError(`document source not found: ${id}`);
  }

  return source;
}

async function fetchSourceById(
  client: Queryable,
  id: string,
): Promise<DocumentSource | undefined> {
  const sources = await fetchSources(client, "id = $1", [id]);
  return sources[0];
}

async function fetchSourceByUri(
  client: Queryable,
  sourceUri: string,
): Promise<DocumentSource | undefined> {
  const sources = await fetchSources(client, "source_uri = $1", [sourceUri]);
  return sources[0];
}

async function fetchSources(
  client: Queryable,
  whereClause: string,
  values: unknown[],
): Promise<DocumentSource[]> {
  const sourceResult = await client.query<SourceRow>(
    `
select *
from document_sources
where ${whereClause}
order by updated_at desc, id asc
`,
    values,
  );
  const sourceRows = sourceResult.rows;

  if (sourceRows.length === 0) {
    return [];
  }

  const evidenceBySourceId = await fetchEvidenceBySourceId(
    client,
    sourceRows.map((row) => row.id),
  );

  return sourceRows.map((row) => mapSourceRow(row, evidenceBySourceId.get(row.id) ?? []));
}

async function fetchEvidenceBySourceId(
  client: Queryable,
  sourceIds: string[],
): Promise<Map<string, DocumentSourceEvidence[]>> {
  const evidenceResult = await client.query<EvidenceRow & { document_source_id: string }>(
    `
select
  document_source_id,
  kind,
  source_uri,
  group_id,
  message_id,
  user_id,
  space_id,
  observed_at
from document_source_evidence
where document_source_id = any($1::text[])
order by created_at asc, id asc
`,
    [sourceIds],
  );
  const evidenceBySourceId = new Map<string, DocumentSourceEvidence[]>();

  for (const row of evidenceResult.rows) {
    const evidence = evidenceBySourceId.get(row.document_source_id) ?? [];
    evidence.push(mapEvidenceRow(row));
    evidenceBySourceId.set(row.document_source_id, evidence);
  }

  return evidenceBySourceId;
}

function mapSourceRow(
  row: SourceRow,
  evidence: DocumentSourceEvidence[],
): DocumentSource {
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceUri: row.source_uri,
    title: row.title ?? undefined,
    originGroupId: row.origin_group_id ?? undefined,
    originMessageId: row.origin_message_id ?? undefined,
    submittedByUserId: row.submitted_by_user_id ?? undefined,
    authorizedSpaceId: row.authorized_space_id ?? undefined,
    permissionState: row.permission_state,
    syncState: row.sync_state,
    canUseForAnswering: row.can_use_for_answering,
    canUseForKnowledgeDrafts: row.can_use_for_knowledge_drafts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    evidence,
  };
}

function mapEvidenceRow(row: EvidenceRow): DocumentSourceEvidence {
  return {
    kind: row.kind,
    sourceUri: row.source_uri,
    groupId: row.group_id ?? undefined,
    messageId: row.message_id ?? undefined,
    userId: row.user_id ?? undefined,
    spaceId: row.space_id ?? undefined,
    observedAt: row.observed_at,
  };
}

function requireNonBlank(fieldName: string, value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new DocumentSourceValidationError(`${fieldName} must not be blank`);
  }

  return normalized;
}

function normalizeOptional(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}
