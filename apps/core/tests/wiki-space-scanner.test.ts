import { describe, expect, it } from "vitest";

import {
  scanFeishuWikiSpace,
  type FeishuWikiNode,
  type FeishuWikiSpaceClient,
} from "../src/documents/wiki-space-scanner.js";

describe("scanFeishuWikiSpace", () => {
  it("walks a same-space wiki breadth first and emits supported documents in stable order", async () => {
    const client = fakeClient({
      root: wikiNode("root", { hasChild: true }),
      children: {
        root: [
          wikiNode("child-a", { hasChild: true }),
          wikiNode("child-b", { objectType: "doc" }),
        ],
        "child-a": [wikiNode("grandchild")],
      },
    });

    await expect(scanFeishuWikiSpace({ client, rootNodeToken: "root" })).resolves.toEqual({
      spaceId: "space-1",
      rootTitle: "root",
      documents: [
        { nodeToken: "root", title: "root" },
        { nodeToken: "child-a", title: "child-a" },
        { nodeToken: "child-b", title: "child-b" },
        { nodeToken: "grandchild", title: "grandchild" },
      ],
      discoveredNodeCount: 4,
      skippedNodeCount: 0,
    });
  });

  it("continues through an empty page and removes duplicate node tokens", async () => {
    const root = wikiNode("root", { hasChild: true });
    const child = wikiNode("child");
    const client: FeishuWikiSpaceClient = {
      getNode: async () => root,
      listChildren: async ({ pageToken }) => {
        if (pageToken === undefined) return { nodes: [], nextPageToken: "next" };
        return { nodes: [child, child] };
      },
    };

    await expect(scanFeishuWikiSpace({ client, rootNodeToken: "root" })).resolves.toMatchObject({
      documents: [{ nodeToken: "root" }, { nodeToken: "child" }],
      discoveredNodeCount: 2,
      skippedNodeCount: 1,
    });
  });

  it("does not emit unsupported objects but continues through them to supported descendants", async () => {
    const client = fakeClient({
      root: wikiNode("root", { hasChild: true }),
      children: {
        root: [
          wikiNode("bitable", { objectType: "bitable", hasChild: true }),
          wikiNode("foreign", { spaceId: "space-2" }),
        ],
        bitable: [wikiNode("nested-document")],
      },
    });

    const result = await scanFeishuWikiSpace({ client, rootNodeToken: "root" });

    expect(result.documents.map((document) => document.nodeToken)).toEqual(["root", "nested-document"]);
    expect(result.discoveredNodeCount).toBe(4);
    expect(result.skippedNodeCount).toBe(2);
  });

  it("stops deterministically at maxNodes without following more descendants", async () => {
    const children = Array.from({ length: 500 }, (_, index) => wikiNode(`child-${index}`));
    const client = fakeClient({ root: wikiNode("root", { hasChild: true }), children: { root: children } });

    const result = await scanFeishuWikiSpace({ client, rootNodeToken: "root", maxNodes: 500 });

    expect(result.discoveredNodeCount).toBe(500);
    expect(result.documents.map((document) => document.nodeToken)).toEqual([
      "root",
      ...Array.from({ length: 499 }, (_, index) => `child-${index}`),
    ]);
    expect(result.skippedNodeCount).toBe(1);
  });

  it("does not traverse descendants beyond maxDepth", async () => {
    const nodes = Array.from({ length: 22 }, (_, index) => wikiNode(`node-${index}`, { hasChild: index < 21 }));
    const children = Object.fromEntries(nodes.slice(0, -1).map((item, index) => [item.nodeToken, [nodes[index + 1]]]));
    const client = fakeClient({ root: nodes[0], children });

    const result = await scanFeishuWikiSpace({ client, rootNodeToken: "node-0", maxDepth: 20 });

    expect(result.discoveredNodeCount).toBe(21);
    expect(result.documents.map((document) => document.nodeToken)).toEqual(
      Array.from({ length: 21 }, (_, index) => `node-${index}`),
    );
    expect(result.skippedNodeCount).toBe(1);
  });
});

function fakeClient(input: {
  root: FeishuWikiNode;
  children: Record<string, FeishuWikiNode[]>;
}): FeishuWikiSpaceClient {
  return {
    getNode: async () => input.root,
    listChildren: async ({ parentNodeToken }) => ({ nodes: input.children[parentNodeToken] ?? [] }),
  };
}

function wikiNode(nodeToken: string, overrides: Partial<FeishuWikiNode> = {}): FeishuWikiNode {
  return {
    nodeToken,
    objectToken: `doc-${nodeToken}`,
    objectType: "docx",
    spaceId: "space-1",
    title: nodeToken,
    hasChild: false,
    ...overrides,
  };
}
