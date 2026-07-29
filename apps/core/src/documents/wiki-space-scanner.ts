import type { FeishuWikiNode, FeishuWikiSpaceClient } from "./feishu-wiki-space-client.js";

export type { FeishuWikiNode, FeishuWikiSpaceClient } from "./feishu-wiki-space-client.js";

export type WikiSpaceScanResult = {
  spaceId: string;
  rootTitle?: string;
  documents: Array<{ nodeToken: string; title?: string }>;
  discoveredNodeCount: number;
  skippedNodeCount: number;
};

export async function scanFeishuWikiSpace({
  client,
  rootNodeToken,
  maxNodes = 500,
  maxDepth = 20,
  pageSize = 50,
}: {
  client: FeishuWikiSpaceClient;
  rootNodeToken: string;
  maxNodes?: number;
  maxDepth?: number;
  pageSize?: number;
}): Promise<WikiSpaceScanResult> {
  const safeMaxNodes = requireBoundedInteger(maxNodes, "maxNodes", 500);
  const safeMaxDepth = requireBoundedInteger(maxDepth, "maxDepth", 20, true);
  const safePageSize = requireBoundedInteger(pageSize, "pageSize", 50);
  const root = await client.getNode(rootNodeToken);
  const spaceId = root.spaceId;
  const queue: Array<{ node: FeishuWikiNode; depth: number }> = [{ node: root, depth: 0 }];
  const visited = new Set([root.nodeToken]);
  const documents: Array<{ nodeToken: string; title?: string }> = [];
  let discoveredNodeCount = 1;
  let skippedNodeCount = 0;

  for (let index = 0; index < queue.length; index += 1) {
    const { node, depth } = queue[index];
    if (node.spaceId !== spaceId) {
      skippedNodeCount += 1;
      continue;
    }
    if (isSupportedDocument(node.objectType)) {
      documents.push({ nodeToken: node.nodeToken, ...(node.title === undefined ? {} : { title: node.title }) });
    } else {
      skippedNodeCount += 1;
    }
    if (!node.hasChild) continue;
    if (depth >= safeMaxDepth) {
      skippedNodeCount += 1;
      continue;
    }

    let pageToken: string | undefined;
    const pageTokens = new Set<string>();
    do {
      const page = await client.listChildren({
        spaceId,
        parentNodeToken: node.nodeToken,
        ...(pageToken === undefined ? {} : { pageToken }),
        pageSize: safePageSize,
      });
      for (const child of page.nodes) {
        if (visited.has(child.nodeToken)) {
          skippedNodeCount += 1;
          continue;
        }
        if (discoveredNodeCount >= safeMaxNodes) {
          skippedNodeCount += 1;
          continue;
        }
        visited.add(child.nodeToken);
        discoveredNodeCount += 1;
        queue.push({ node: child, depth: depth + 1 });
      }
      pageToken = page.nextPageToken;
      if (pageToken !== undefined && (pageTokens.has(pageToken) || pageTokens.size >= safeMaxNodes)) {
        throw new Error("Feishu wiki space pagination did not advance");
      }
      if (pageToken !== undefined) pageTokens.add(pageToken);
    } while (pageToken !== undefined);
  }

  return {
    spaceId,
    ...(root.title === undefined ? {} : { rootTitle: root.title }),
    documents,
    discoveredNodeCount,
    skippedNodeCount,
  };
}

function isSupportedDocument(objectType: string): boolean {
  return objectType === "docx" || objectType === "doc";
}

function requireBoundedInteger(
  value: unknown,
  name: string,
  maximum: number,
  allowZero = false,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value > maximum ||
    value < (allowZero ? 0 : 1)
  ) {
    throw new Error(`${name} must be a ${allowZero ? "non-negative" : "positive"} integer no greater than ${maximum}`);
  }
  return value;
}
