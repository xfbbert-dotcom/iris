import { describe, expect, it, vi } from "vitest";

import {
  createFeishuKnowledgePublicationPublisher,
} from "../src/action-approvals/feishu-knowledge-publication-publisher.js";

describe("FeishuKnowledgePublicationPublisher", () => {
  it("creates a docx wiki node and writes draft content into the root block", async () => {
    const tokenProvider = { getTenantAccessToken: vi.fn(async () => "tenant-token") };
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith("/open-apis/wiki/v2/spaces/space-1/nodes")) {
        expect(init?.method).toBe("POST");
        expect(init?.headers).toMatchObject({ authorization: "Bearer tenant-token" });
        expect(JSON.parse(String(init?.body))).toEqual({
          obj_type: "docx",
          node_type: "origin",
          title: "Pilot summary",
          parent_node_token: "parent-1",
        });
        return jsonResponse({
          code: 0,
          data: { node: { node_token: "wikcn_new", obj_token: "docx_new", obj_type: "docx" } },
        });
      }
      if (href.endsWith("/open-apis/docx/v1/documents/docx_new/blocks/docx_new/children")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          children: [{
            block_type: 2,
            text: {
              elements: [{
                text_run: {
                  content: "Line one\n\nLine two",
                  text_element_style: {},
                },
              }],
              style: {},
            },
          }],
        });
        return jsonResponse({ code: 0, data: { revision_id: 5 } });
      }
      throw new Error(`unexpected URL: ${href}`);
    });

    const publisher = createFeishuKnowledgePublicationPublisher({
      baseUrl: "https://open.feishu.cn",
      tokenProvider,
      fetch: fetch as unknown as typeof globalThis.fetch,
      timeoutMs: 1_000,
    });

    await expect(publisher.publish({
      proposal: { id: "proposal-1" } as never,
      execution: { id: "execution-1" } as never,
      draft: {
        id: "draft-1",
        revisionNumber: 1,
        version: 3,
        title: "Pilot summary",
        content: "Line one\n\nLine two",
        riskLevel: "low",
        suggestedPublication: { spaceId: "space-1", parentNodeToken: "parent-1" },
      },
      policy: {
        id: "policy-1",
        spaceId: "space-1",
        parentNodeToken: "parent-1",
      } as never,
    })).resolves.toEqual({
      remoteNodeToken: "wikcn_new",
      remoteDocumentToken: "docx_new",
      remoteDocumentType: "docx",
      remoteDocumentVersion: 5,
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      permissionCheckSummary: "feishu_write_access_verified",
    });
  });

  it("fails safely without leaking upstream bodies or tenant tokens", async () => {
    const tokenProvider = { getTenantAccessToken: vi.fn(async () => "tenant-secret") };
    const fetch = vi.fn(async () => jsonResponse({
      code: 999,
      msg: "bad tenant-secret raw draft body",
    }, { status: 403 }));
    const publisher = createFeishuKnowledgePublicationPublisher({
      baseUrl: "https://open.feishu.cn",
      tokenProvider,
      fetch: fetch as unknown as typeof globalThis.fetch,
      timeoutMs: 1_000,
    });

    await expect(publisher.publish({
      proposal: { id: "proposal-1" } as never,
      execution: { id: "execution-1" } as never,
      draft: {
        id: "draft-1",
        revisionNumber: 1,
        version: 3,
        title: "Pilot summary",
        content: "raw draft body",
        riskLevel: "low",
        suggestedPublication: { spaceId: "space-1" },
      },
      policy: { id: "policy-1", spaceId: "space-1" } as never,
    })).rejects.toThrow("Feishu wiki node creation failed with status 403");
    await publisher.publish({
      proposal: { id: "proposal-1" } as never,
      execution: { id: "execution-1" } as never,
      draft: {
        id: "draft-1",
        revisionNumber: 1,
        version: 3,
        title: "Pilot summary",
        content: "raw draft body",
        riskLevel: "low",
        suggestedPublication: { spaceId: "space-1" },
      },
      policy: { id: "policy-1", spaceId: "space-1" } as never,
    }).catch((error) => {
      expect(String(error)).not.toMatch(/tenant-secret|raw draft body/iu);
    });
  });
});

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}
