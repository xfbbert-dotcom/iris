import {
  normalizeFeishuDocumentSourceUri,
} from "../documents/feishu-document-body-fetcher.js";
import {
  type RetrievedDocumentFragment,
  type RetrievedDocumentSourceType,
} from "../documents/document-fragment-repository.js";
import {
  DOCUMENT_SOURCE_METADATA_MAX_CHARS,
  DOCUMENT_SOURCE_URI_MAX_CHARS,
} from "../documents/document-source-registry.js";

const MAX_REPLY_CHARS = 8000;
const MAX_VISIBLE_SOURCES = 3;
const MAX_VISIBLE_TITLE_CHARS = 120;
const TRUNCATION_MARKER = " ... [truncated]";
const SOURCE_FOOTER_HEADING = "Iris 参考资料：";

const SOURCE_LABELS: Record<RetrievedDocumentSourceType, string> = {
  feishu_wiki: "知识库",
  feishu_group_document: "群文档",
  manual_upload: "用户文档",
};

export type AnswerReplySourceTraceInput = {
  promptRank: number;
  citationRank?: number;
  documentSourceId: string;
  documentSnapshotId: string;
  fragmentId: string;
  chunkIndex: number;
  sourceType: RetrievedDocumentSourceType;
  sourceUri: string;
  sourceTitle?: string;
  contentHash: string;
  embeddingProfileId: string;
  initialPermissionCheckedAt: Date;
};

type NormalizedDocumentMetadata = {
  documentSnapshotId: string;
  sourceType: RetrievedDocumentSourceType;
  sourceUri: string;
  sourceTitle?: string;
  citationRank?: number;
};

export function renderAnswerWithSourceCitations(input: {
  answerText: string;
  allowedFragments: readonly RetrievedDocumentFragment[];
  initialPermissionCheckedAt: Date;
}): {
  renderedText: string;
  sourceTraces: AnswerReplySourceTraceInput[];
} {
  const documents = new Map<string, NormalizedDocumentMetadata>();
  const sourceTraces: AnswerReplySourceTraceInput[] = [];

  input.allowedFragments.forEach((fragment, index) => {
    const sourceUri = normalizeFeishuDocumentSourceUri(fragment.sourceUri);
    if (sourceUri === undefined) {
      throw new Error(`invalid Feishu document source URI for ${fragment.documentSourceId}`);
    }
    if (sourceUri.length > DOCUMENT_SOURCE_URI_MAX_CHARS) {
      throw new Error(`Feishu document source URI is too long for ${fragment.documentSourceId}`);
    }

    if (!Object.hasOwn(SOURCE_LABELS, fragment.sourceType)) {
      throw new Error(`invalid retrieved document source type for ${fragment.documentSourceId}`);
    }

    const sourceTitle = normalizeSourceTitle(fragment.sourceTitle);
    const existing = documents.get(fragment.documentSourceId);
    if (existing !== undefined) {
      if (
        existing.documentSnapshotId !== fragment.documentSnapshotId ||
        existing.sourceType !== fragment.sourceType ||
        existing.sourceUri !== sourceUri ||
        existing.sourceTitle !== sourceTitle
      ) {
        throw new Error(`conflicting metadata for document source ${fragment.documentSourceId}`);
      }
    } else {
      documents.set(fragment.documentSourceId, {
        documentSnapshotId: fragment.documentSnapshotId,
        sourceType: fragment.sourceType,
        sourceUri,
        ...(sourceTitle === undefined ? {} : { sourceTitle }),
        ...(documents.size < MAX_VISIBLE_SOURCES
          ? { citationRank: documents.size + 1 }
          : {}),
      });
    }

    const metadata = documents.get(fragment.documentSourceId);
    if (metadata === undefined) {
      throw new Error(`missing metadata for document source ${fragment.documentSourceId}`);
    }

    sourceTraces.push({
      promptRank: index + 1,
      ...(metadata.citationRank === undefined
        ? {}
        : { citationRank: metadata.citationRank }),
      documentSourceId: fragment.documentSourceId,
      documentSnapshotId: fragment.documentSnapshotId,
      fragmentId: fragment.id,
      chunkIndex: fragment.chunkIndex,
      sourceType: fragment.sourceType,
      sourceUri,
      ...(sourceTitle === undefined ? {} : { sourceTitle }),
      contentHash: fragment.contentHash,
      embeddingProfileId: fragment.embeddingProfileId,
      initialPermissionCheckedAt: new Date(input.initialPermissionCheckedAt.getTime()),
    });
  });

  if (documents.size === 0) {
    return {
      renderedText: truncateWithMarker(input.answerText, MAX_REPLY_CHARS),
      sourceTraces,
    };
  }

  const footer = buildFooter(documents);
  // Bounded source metadata should keep this branch unreachable; retain it as a fail-closed guard.
  if (footer.length + 2 > MAX_REPLY_CHARS) {
    throw new Error("answer source citation footer cannot fit within the reply limit");
  }

  const answerBudget = MAX_REPLY_CHARS - footer.length - 2;
  const answerBody =
    input.answerText.length <= answerBudget
      ? input.answerText
      : answerBudget <= 0
        ? ""
        : truncateWithMarker(input.answerText, answerBudget);

  return {
    renderedText: `${answerBody}\n\n${footer}`,
    sourceTraces,
  };
}

function normalizeSourceTitle(sourceTitle: string | undefined): string | undefined {
  if (sourceTitle === undefined) {
    return undefined;
  }

  const normalized = sourceTitle.trim();
  if (normalized.length === 0) {
    return undefined;
  }
  if (normalized.length > DOCUMENT_SOURCE_METADATA_MAX_CHARS) {
    throw new Error("source title exceeds the bounded metadata limit");
  }
  return normalized;
}

function buildFooter(documents: Map<string, NormalizedDocumentMetadata>): string {
  const visibleSources = [...documents.values()].filter(
    (document) => document.citationRank !== undefined,
  );
  const lines = visibleSources.map((document) => {
    const title = truncateWithMarker(
      document.sourceTitle ?? "飞书文档",
      MAX_VISIBLE_TITLE_CHARS,
    );
    return `[${document.citationRank}] [${SOURCE_LABELS[document.sourceType]}] ${title}\n${document.sourceUri}`;
  });
  return [SOURCE_FOOTER_HEADING, ...lines].join("\n");
}

function truncateWithMarker(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= TRUNCATION_MARKER.length) {
    throw new Error("bounded text limit cannot fit the truncation marker");
  }

  return `${value.slice(0, maxChars - TRUNCATION_MARKER.length).trimEnd()}${TRUNCATION_MARKER}`;
}
