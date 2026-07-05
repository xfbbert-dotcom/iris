import { DOCUMENT_SOURCE_URI_MAX_CHARS } from "./document-source-registry.js";
import { normalizeFeishuDocumentSourceUri } from "./feishu-document-body-fetcher.js";

export type FeishuDocumentLink = {
  sourceUri: string;
};

export type FeishuDocumentLinkExtractor = {
  extractLinks(text: string): FeishuDocumentLink[];
};

export const MAX_FEISHU_DOCUMENT_LINKS_PER_MESSAGE = 20;

const fullwidthTrailingPunctuation =
  "\uFF0C\u3002\uFF1B\uFF1A\uFF01\uFF1F\u3001\uFF09\u3011\u300B\u300D\u300F\u3015";
const urlPattern = new RegExp(`https://[^\\s<>"',${fullwidthTrailingPunctuation}]+`, "gi");
const trailingPunctuationPattern = new RegExp(
  `[),.;:!?${fullwidthTrailingPunctuation}]+$`,
  "u",
);

export function createFeishuDocumentLinkExtractor(): FeishuDocumentLinkExtractor {
  return {
    extractLinks(text) {
      const links: FeishuDocumentLink[] = [];
      const seen = new Set<string>();

      for (const match of text.matchAll(urlPattern)) {
        const normalized = normalizeCandidateUrl(match[0]);
        if (normalized === undefined || seen.has(normalized)) {
          continue;
        }

        seen.add(normalized);
        links.push({ sourceUri: normalized });
        if (links.length >= MAX_FEISHU_DOCUMENT_LINKS_PER_MESSAGE) {
          break;
        }
      }

      return links;
    },
  };
}

function normalizeCandidateUrl(candidate: string): string | undefined {
  let normalized = candidate.trim();
  while (trailingPunctuationPattern.test(normalized)) {
    normalized = normalized.replace(trailingPunctuationPattern, "");
  }

  try {
    const sourceUri = normalizeFeishuDocumentSourceUri(normalized);
    if (sourceUri === undefined || sourceUri.length > DOCUMENT_SOURCE_URI_MAX_CHARS) {
      return undefined;
    }

    return sourceUri;
  } catch {
    return undefined;
  }
}
