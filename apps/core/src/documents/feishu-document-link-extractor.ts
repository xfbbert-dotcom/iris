export type FeishuDocumentLink = {
  sourceUri: string;
};

export type FeishuDocumentLinkExtractor = {
  extractLinks(text: string): FeishuDocumentLink[];
};

const urlPattern = /https:\/\/[^\s<>"'，。；：！？、）】」』》]+/gi;
const trailingPunctuationPattern = /[),.;:!?，。；：！？、）】」』》]+$/u;

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

    url.search = "";
    url.hash = "";

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
  const firstPathSegment = url.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
  return (
    firstPathSegment === "docx" ||
    firstPathSegment === "docs" ||
    firstPathSegment === "wiki"
  );
}
