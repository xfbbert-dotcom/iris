const MANAGED_KNOWLEDGE_SOURCE_LOCK_PREFIX = "managed-knowledge-source:";
const MAX_DOCUMENT_SOURCE_ID_CHARS = 512;

export type ManagedKnowledgeSourceLockClient = {
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
};

export async function acquireManagedKnowledgeSourceLocks(
  client: ManagedKnowledgeSourceLockClient,
  documentSourceIds: readonly string[],
): Promise<void> {
  const normalizedIds = [...new Set(documentSourceIds.map(normalizeDocumentSourceId))].sort();
  for (const documentSourceId of normalizedIds) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`${MANAGED_KNOWLEDGE_SOURCE_LOCK_PREFIX}${documentSourceId}`],
    );
  }
}

function normalizeDocumentSourceId(value: unknown): string {
  if (typeof value !== "string") throw new Error("document source ID is invalid");
  const normalized = value.trim();
  const characters = [...normalized].length;
  if (characters < 1 || characters > MAX_DOCUMENT_SOURCE_ID_CHARS) {
    throw new Error("document source ID is invalid");
  }
  return normalized;
}
