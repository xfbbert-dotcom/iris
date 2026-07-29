import { describe, expect, it } from "vitest";

import {
  scanFeishuWikiSpace,
  type FeishuWikiNode,
  type FeishuWikiSpaceClient,
} from "../src/documents/wiki-space-scanner.js";

describe("scanFeishuWikiSpace", () => {
  it("uses the supplied page only to resolve the space and scans every top-level tree", async () => {
    const anchor = wikiNode("anchor");
    const client: FeishuWikiSpaceClient = {
      getNode: async () => anchor,
      listChildren: async ({ parentNodeToken }) => {
        if (parentNodeToken === undefined) {
          return {
            nodes: [
              anchor,
              wikiNode("sibling-root", { hasChild: true }),
            ],
          };
        }
        if (parentNodeToken === "sibling-root") {
          return { nodes: [wikiNode("sibling-child")] };
        }
        return { nodes: [] };
      },
    };

    await expect(scanFeishuWikiSpace({ client, rootNodeToken: "anchor" })).resolves.toEqual({
      spaceId: "space-1",
      rootTitle: "anchor",
      documents: [
        { nodeToken: "anchor", title: "anchor" },
        { nodeToken: "sibling-root", title: "sibling-root" },
        { nodeToken: "sibling-child", title: "sibling-child" },
      ],
      discoveredNodeCount: 3,
      skippedNodeCount: 0,
    });
  });

  it("fails closed when the anchor is readable but no top-level space nodes are visible", async () => {
    const client: FeishuWikiSpaceClient = {
      getNode: async () => wikiNode("anchor"),
      listChildren: async () => ({ nodes: [] }),
    };

    await expect(scanFeishuWikiSpace({
      client,
      rootNodeToken: "anchor",
    })).rejects.toMatchObject({
      classification: "forbidden",
      retriable: false,
    });
  });

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
      listChildren: async ({ parentNodeToken, pageToken }) => {
        if (parentNodeToken === undefined) {
          if (pageToken === undefined) return { nodes: [], nextPageToken: "next" };
          return { nodes: [root] };
        }
        return { nodes: [child, child] };
      },
    };

    await expect(scanFeishuWikiSpace({ client, rootNodeToken: "root" })).resolves.toMatchObject({
      documents: [{ nodeToken: "root" }, { nodeToken: "child" }],
      discoveredNodeCount: 2,
      skippedNodeCount: 1,
    });
  });

  it("continues through successful child pagination", async () => {
    const root = wikiNode("root", { hasChild: true });
    const listCalls: Array<{ parentNodeToken?: string; pageToken?: string }> = [];
    const client: FeishuWikiSpaceClient = {
      getNode: async () => root,
      listChildren: async ({ parentNodeToken, pageToken }) => {
        listCalls.push({
          ...(parentNodeToken === undefined ? {} : { parentNodeToken }),
          ...(pageToken === undefined ? {} : { pageToken }),
        });
        if (parentNodeToken === undefined) {
          return { nodes: [root] };
        }
        if (pageToken === undefined) {
          return {
            nodes: [wikiNode("child-a")],
            nextPageToken: "next-child-page",
          };
        }
        return { nodes: [wikiNode("child-b")] };
      },
    };

    await expect(scanFeishuWikiSpace({ client, rootNodeToken: "root" })).resolves.toMatchObject({
      documents: [
        { nodeToken: "root" },
        { nodeToken: "child-a" },
        { nodeToken: "child-b" },
      ],
      discoveredNodeCount: 3,
    });
    expect(listCalls).toEqual([
      {},
      { parentNodeToken: "root" },
      { parentNodeToken: "root", pageToken: "next-child-page" },
    ]);
  });

  it("does not emit unsupported objects but continues through them to supported descendants", async () => {
    const client = fakeClient({
      root: wikiNode("root", { hasChild: true }),
      children: {
        root: [wikiNode("bitable", { objectType: "bitable", hasChild: true })],
        bitable: [wikiNode("nested-document")],
      },
    });

    const result = await scanFeishuWikiSpace({ client, rootNodeToken: "root" });

    expect(result.documents.map((document) => document.nodeToken)).toEqual(["root", "nested-document"]);
    expect(result.discoveredNodeCount).toBe(3);
    expect(result.skippedNodeCount).toBe(1);
  });

  it("rejects a foreign-space child with a terminal safe classification", async () => {
    const client = fakeClient({
      root: wikiNode("root", { hasChild: true }),
      children: { root: [wikiNode("foreign", { spaceId: "space-2" })] },
    });

    await expect(scanFeishuWikiSpace({ client, rootNodeToken: "root" })).rejects.toMatchObject({
      classification: "cross_space_node",
      retriable: false,
    });
  });

  it("rejects known node overflow without following more descendants", async () => {
    const children = Array.from({ length: 500 }, (_, index) => wikiNode(`child-${index}`));
    const client = fakeClient({ root: wikiNode("root", { hasChild: true }), children: { root: children } });

    await expect(scanFeishuWikiSpace({
      client,
      rootNodeToken: "root",
      maxNodes: 500,
    })).rejects.toMatchObject({
      classification: "node_limit_exceeded",
      retriable: false,
    });
  });

  it("rejects a known next page once maxNodes is reached without fetching it", async () => {
    const listCalls: Array<{ parentNodeToken?: string; pageToken?: string }> = [];
    const root = wikiNode("root", { hasChild: true });
    const client: FeishuWikiSpaceClient = {
      getNode: async () => root,
      listChildren: async ({ parentNodeToken, pageToken }) => {
        listCalls.push({
          ...(parentNodeToken === undefined ? {} : { parentNodeToken }),
          ...(pageToken === undefined ? {} : { pageToken }),
        });
        if (parentNodeToken === undefined) {
          return { nodes: [root] };
        }
        if (parentNodeToken === "root" && pageToken === undefined) {
          return {
            nodes: [wikiNode("child", { hasChild: true })],
            nextPageToken: "next-root-page",
          };
        }
        if (parentNodeToken === "root") {
          return { nodes: [wikiNode("overflow")] };
        }
        return { nodes: [wikiNode("grandchild")] };
      },
    };

    await expect(scanFeishuWikiSpace({
      client,
      rootNodeToken: "root",
      maxNodes: 2,
    })).rejects.toMatchObject({
      classification: "node_limit_exceeded",
      retriable: false,
    });

    expect(listCalls).toEqual([{}, { parentNodeToken: "root" }]);
  });

  it("rejects a node that reports children at maxDepth", async () => {
    const nodes = Array.from({ length: 22 }, (_, index) => wikiNode(`node-${index}`, { hasChild: index < 21 }));
    const children = Object.fromEntries(nodes.slice(0, -1).map((item, index) => [item.nodeToken, [nodes[index + 1]]]));
    const client = fakeClient({ root: nodes[0], children });

    await expect(scanFeishuWikiSpace({
      client,
      rootNodeToken: "node-0",
      maxDepth: 20,
    })).rejects.toMatchObject({
      classification: "depth_limit_exceeded",
      retriable: false,
    });
  });
});

function fakeClient(input: {
  root: FeishuWikiNode;
  children: Record<string, FeishuWikiNode[]>;
}): FeishuWikiSpaceClient {
  return {
    getNode: async () => input.root,
    listChildren: async ({ parentNodeToken }) => ({
      nodes: parentNodeToken === undefined
        ? [input.root]
        : (input.children[parentNodeToken] ?? []),
    }),
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
