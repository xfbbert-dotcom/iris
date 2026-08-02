export type AnswerSourcePermissionDecision = {
  documentSourceId: string;
  outcome: "allowed" | "denied" | "error";
};

export interface AnswerSourcePermissionVerifier {
  verify(input: {
    chatId: string;
    documentSourceIds: readonly string[];
  }): Promise<AnswerSourcePermissionDecision[]>;
};

type AnswerSourcePermissionChecker = (
  documentSourceId: string,
  chatId: string,
) => Promise<boolean>;

type NormalizedSourceId = {
  dedupeKey: string;
  documentSourceId: string;
  valid: boolean;
};

export function createAnswerSourcePermissionVerifier({
  canReadDocument,
}: {
  canReadDocument: AnswerSourcePermissionChecker;
}): AnswerSourcePermissionVerifier {
  return {
    async verify({ chatId, documentSourceIds }) {
      const decisions: AnswerSourcePermissionDecision[] = [];
      const seen = new Set<string>();

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
          const allowed = await canReadDocument(normalized.documentSourceId, chatId);
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

export function createUnavailableAnswerSourcePermissionVerifier(): AnswerSourcePermissionVerifier {
  return createAnswerSourcePermissionVerifier({
    canReadDocument: async () => {
      throw new Error("answer source permission verifier unavailable");
    },
  });
}

function normalizeSourceId(documentSourceId: string): NormalizedSourceId {
  if (typeof documentSourceId !== "string") {
    return {
      dedupeKey: "invalid:type",
      documentSourceId: "invalid-source-id-type",
      valid: false,
    };
  }

  const normalized = documentSourceId.trim();
  if (normalized.length === 0) {
    return {
      dedupeKey: "invalid:blank",
      documentSourceId: "invalid-source-id-blank",
      valid: false,
    };
  }
  if (normalized.length > 512) {
    return {
      dedupeKey: "invalid:too-long",
      documentSourceId: "invalid-source-id-too-long",
      valid: false,
    };
  }

  return {
    dedupeKey: `valid:${normalized}`,
    documentSourceId: normalized,
    valid: true,
  };
}
