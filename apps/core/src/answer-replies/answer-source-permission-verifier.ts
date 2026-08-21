import { createHash } from "node:crypto";

export type AnswerSourcePermissionDecision = {
  documentSourceId: string;
  outcome: "allowed" | "denied" | "error";
  reason?: "managed_source_unavailable";
};

export interface AnswerSourcePermissionVerifier {
  verify(input: {
    chatId: string;
    documentSourceIds: readonly string[];
    crossGroupGrantBindings?: readonly AnswerSourcePermissionGrantBinding[];
  }): Promise<AnswerSourcePermissionDecision[]>;
};

export type AnswerSourcePermissionGrantBinding = {
  documentSourceId: string;
  grantId: string;
  version: number;
  grantorGroupId: string;
  granteeGroupId: string;
};

export type AnswerSourcePermissionAccessContext = {
  hasCrossGroupGrantBinding: boolean;
  crossGroupGrantValidated: boolean;
};

type AnswerSourcePermissionChecker = (
  documentSourceId: string,
  chatId: string,
  accessContext?: AnswerSourcePermissionAccessContext,
) => Promise<boolean>;

export type AnswerSourceFreshnessQueryable = {
  query: <T = unknown>(sql: string, values?: unknown[]) => Promise<{ rows: T[] }>;
};

type ManagedSourceStateRow = {
  linked_document_source_id: unknown;
  state: unknown;
};

type NormalizedSourceId = {
  dedupeKey: string;
  documentSourceId: string;
  valid: boolean;
};

export function createAnswerSourcePermissionVerifier({
  canReadDocument,
  managedSourceQueryable,
}: {
  canReadDocument: AnswerSourcePermissionChecker;
  managedSourceQueryable?: AnswerSourceFreshnessQueryable;
}): AnswerSourcePermissionVerifier {
  return {
    async verify({ chatId, documentSourceIds, crossGroupGrantBindings }) {
      const decisions: AnswerSourcePermissionDecision[] = [];
      const seen = new Set<string>();
      const grantBoundDocumentSourceIds = normalizeGrantBoundDocumentSourceIds({
        chatId,
        documentSourceIds,
        crossGroupGrantBindings,
      });
      if (grantBoundDocumentSourceIds === undefined) {
        return documentSourceIds.map((documentSourceId) => ({
          documentSourceId: typeof documentSourceId === "string"
            ? documentSourceId
            : invalidSourceId(`type:${typeof documentSourceId}`).documentSourceId,
          outcome: "error" as const,
        }));
      }
      const normalizedSourceIds = uniqueValidSourceIds(documentSourceIds);
      let managedSourceStates: Map<string, "active" | "barred"> | undefined;
      try {
        managedSourceStates = await loadManagedSourceStates(
          managedSourceQueryable,
          normalizedSourceIds,
        );
      } catch {
        managedSourceStates = undefined;
      }

      for (const documentSourceId of documentSourceIds) {
        const normalized = normalizeSourceId(documentSourceId);
        if (seen.has(normalized.dedupeKey)) {
          continue;
        }
        seen.add(normalized.dedupeKey);

        if (!normalized.valid) {
          decisions.push({ documentSourceId: normalized.documentSourceId, outcome: "error" });
          continue;
        }

        try {
          if (managedSourceStates === undefined) {
            decisions.push({ documentSourceId: normalized.documentSourceId, outcome: "error" });
            continue;
          }
          if (managedSourceStates.get(normalized.documentSourceId) === "barred") {
            decisions.push({
              documentSourceId: normalized.documentSourceId,
              outcome: "denied",
              reason: "managed_source_unavailable",
            });
            continue;
          }
          const allowed = await canReadDocument(
            normalized.documentSourceId,
            chatId,
            grantBoundDocumentSourceIds.has(normalized.documentSourceId)
              ? {
                  hasCrossGroupGrantBinding: true,
                  crossGroupGrantValidated: true,
                }
              : undefined,
          );
          decisions.push({
            documentSourceId: normalized.documentSourceId,
            outcome: allowed ? "allowed" : "denied",
          });
        } catch {
          decisions.push({ documentSourceId: normalized.documentSourceId, outcome: "error" });
        }
      }

      return decisions;
    },
  };
}

function uniqueValidSourceIds(documentSourceIds: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const documentSourceId of documentSourceIds) {
    const normalized = normalizeSourceId(documentSourceId);
    if (!normalized.valid || seen.has(normalized.documentSourceId)) continue;
    seen.add(normalized.documentSourceId);
    result.push(normalized.documentSourceId);
  }
  return result;
}

async function loadManagedSourceStates(
  queryable: AnswerSourceFreshnessQueryable | undefined,
  documentSourceIds: readonly string[],
): Promise<Map<string, "active" | "barred">> {
  const states = new Map<string, "active" | "barred">();
  if (queryable === undefined || documentSourceIds.length === 0) return states;

  const result = await queryable.query<ManagedSourceStateRow>(
    `SELECT linked_document_source_id, state
     FROM managed_knowledge_pages
     WHERE linked_document_source_id = ANY($1::text[])
     ORDER BY linked_document_source_id ASC`,
    [[...documentSourceIds]],
  );
  const requested = new Set(documentSourceIds);
  for (const row of result.rows) {
    if (
      typeof row.linked_document_source_id !== "string"
      || !requested.has(row.linked_document_source_id)
      || states.has(row.linked_document_source_id)
      || typeof row.state !== "string"
    ) {
      throw new Error("managed source freshness result is invalid");
    }
    states.set(row.linked_document_source_id, row.state === "active" ? "active" : "barred");
  }
  return states;
}

function normalizeGrantBoundDocumentSourceIds(input: {
  chatId: string;
  documentSourceIds: readonly string[];
  crossGroupGrantBindings: readonly AnswerSourcePermissionGrantBinding[] | undefined;
}): Set<string> | undefined {
  if (input.crossGroupGrantBindings === undefined) return new Set();
  if (!Array.isArray(input.crossGroupGrantBindings)) return undefined;
  const requested = new Set(input.documentSourceIds);
  const result = new Set<string>();
  for (const binding of input.crossGroupGrantBindings) {
    if (
      binding === null || typeof binding !== "object" ||
      typeof binding.documentSourceId !== "string" ||
      !requested.has(binding.documentSourceId) ||
      typeof binding.grantId !== "string" || binding.grantId.trim().length === 0 ||
      !Number.isSafeInteger(binding.version) || binding.version < 1 ||
      typeof binding.grantorGroupId !== "string" || binding.grantorGroupId.trim().length === 0 ||
      typeof binding.granteeGroupId !== "string" ||
      binding.granteeGroupId !== input.chatId ||
      binding.grantorGroupId === binding.granteeGroupId ||
      result.has(binding.documentSourceId)
    ) {
      return undefined;
    }
    result.add(binding.documentSourceId);
  }
  return result;
}

export function createUnavailableAnswerSourcePermissionVerifier(): AnswerSourcePermissionVerifier {
  return createAnswerSourcePermissionVerifier({
    canReadDocument: async () => {
      throw new Error("answer source permission verifier unavailable");
    },
  });
}

function normalizeSourceId(documentSourceId: string): NormalizedSourceId {
  if (typeof documentSourceId !== "string") {
    return invalidSourceId(`type:${typeof documentSourceId}`);
  }

  const normalized = documentSourceId.trim();
  if (normalized.length === 0) {
    return invalidSourceId("blank");
  }
  if (normalized.length > 512) {
    return invalidSourceId(`overlong:${normalized}`);
  }

  return {
    dedupeKey: `valid:${normalized}`,
    documentSourceId: normalized,
    valid: true,
  };
}

function invalidSourceId(seed: string): NormalizedSourceId {
  const digest = createHash("sha256").update(seed).digest("hex");
  const documentSourceId = `invalid-source-id-${digest}`;
  return {
    dedupeKey: `invalid:${digest}`,
    documentSourceId,
    valid: false,
  };
}
