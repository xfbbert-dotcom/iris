import { createHash } from "node:crypto";

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
