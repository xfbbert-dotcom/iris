import { DOCUMENT_SOURCE_URI_MAX_CHARS } from "./document-source-registry.js";
import {
  parseFeishuDocxDocumentId,
  parseFeishuWikiNodeToken,
} from "./feishu-document-body-fetcher.js";

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
    const url = new URL(normalized);
    if (!isSupportedHost(url.hostname)) {
      return undefined;
    }
    if (!isSupportedDocumentPath(url)) {
      return undefined;
    }
    if (url.username.length > 0 || url.password.length > 0) {
      return undefined;
    }

    url.search = "";
    url.hash = "";

    if (url.href.length > DOCUMENT_SOURCE_URI_MAX_CHARS) {
      return undefined;
    }

    return url.href;
  } catch {
    return undefined;
  }
}

function isSupportedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "docs.feishu.cn" ||
    host.endsWith(".feishu.cn") ||
    host.endsWith(".larksuite.com")
  );
}

function isSupportedDocumentPath(url: URL): boolean {
  return (
    parseFeishuDocxDocumentId(url.href) !== undefined ||
    parseFeishuWikiNodeToken(url.href) !== undefined
  );
}
