import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";

describe("Admin Console routes", () => {
  it("serves the static console shell without weakening internal API auth", async () => {
    const app = await buildApp({ internalApiToken: "operator-secret" });

    const page = await app.inject({ method: "GET", url: "/admin" });
    const unauthorizedInternal = await app.inject({ method: "GET", url: "/internal/status" });

    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.body).toContain("Iris Admin Console");
    expect(page.body).not.toContain("operator-secret");
    expect(unauthorizedInternal.statusCode).toBe(401);

    await app.close();
  });

  it("serves static console assets with bounded cache and no token material", async () => {
    const app = await buildApp({ internalApiToken: "operator-secret" });

    const css = await app.inject({ method: "GET", url: "/admin/console.css" });
    const js = await app.inject({ method: "GET", url: "/admin/console.js" });

    expect(css.statusCode).toBe(200);
    expect(css.headers["content-type"]).toContain("text/css");
    expect(css.headers["cache-control"]).toBe("public, max-age=300");
    expect(css.body).not.toContain("operator-secret");
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toContain("javascript");
    expect(js.headers["cache-control"]).toBe("public, max-age=300");
    expect(js.body).toContain("/internal/runtime-control/status");
    expect(js.body).not.toContain("operator-secret");

    await app.close();
  });

  it("does not expose document-source governance without the internal bearer token", async () => {
    const app = await buildApp({ internalApiToken: "operator-secret" });

    const unauthorizedList = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources?includeLatestSnapshot=true",
    });
    const unauthorizedPolicy = await app.inject({
      method: "PATCH",
      url: "/internal/document-sync/sources/source-1/policy",
      payload: { answeringEnabled: false },
    });

    expect(unauthorizedList.statusCode).toBe(401);
    expect(unauthorizedPolicy.statusCode).toBe(401);

    await app.close();
  });

  it("keeps managed metadata and the operator reconciliation action behind the bearer and exact request contract", async () => {
    const getProposalMetadata = vi.fn(async () => ({
      managedTarget: { id: "target-1", expectedRevision: "13", currentBodyHash: "a".repeat(64), proposedBodyHash: "b".repeat(64), state: "reconciliation_required" },
      page: { id: "page-1", sourceId: "source-1", state: "reconciliation_required", version: 8, currentRevision: "12", safeWikiUrl: "https://www.feishu.cn/wiki/wiki-node-1" },
      executions: [{ id: "execution-1", state: "outcome_unknown", version: 4, requestFingerprint: "f".repeat(64), reasonCode: "timeout", createdAt: new Date(), updatedAt: new Date(), events: [] }],
    }));
    const reconcile = vi.fn(async () => ({ executionId: "execution-1", state: "reconciliation_required", version: 5, reasonCode: "operator_requested" }));
    const app = await buildApp({
      internalApiToken: "operator-secret",
      createActionApprovalRuntime: () => ({
        repository: { getProposal: vi.fn(async () => ({ proposal: { id: "proposal-1" } })) },
        managedKnowledgeAdmin: { getProposalMetadata, reconcile },
        canUseActionApprovalsForSourceGroup: vi.fn(), start: vi.fn(), getStatus: vi.fn(), close: vi.fn(),
      }) as never,
    });

    const unauthorized = await app.inject({ method: "GET", url: "/internal/action-proposals/proposal-1" });
    const metadata = await app.inject({ method: "GET", url: "/internal/action-proposals/proposal-1", headers: { authorization: "Bearer operator-secret" } });
    const missingOperator = await app.inject({
      method: "POST", url: "/internal/managed-knowledge-updates/execution-1/reconcile",
      headers: { authorization: "Bearer operator-secret" }, payload: { expectedExecutionVersion: 4, expectedManagedPageVersion: 8, operationKey: "reconcile:1" },
    });
    const reconciled = await app.inject({
      method: "POST", url: "/internal/managed-knowledge-updates/execution-1/reconcile",
      headers: { authorization: "Bearer operator-secret", "x-iris-operator": "operator@example.com" },
      payload: { expectedExecutionVersion: 4, expectedManagedPageVersion: 8, operationKey: "reconcile:1" },
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(metadata.statusCode).toBe(200);
    expect(metadata.body).not.toMatch(/docx|blk|token|draft body|raw remote/iu);
    expect(missingOperator.statusCode).toBe(400);
    expect(reconciled.json()).toMatchObject({ ok: true, execution: { version: 5 } });
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      executionId: "execution-1", expectedExecutionVersion: 4, expectedManagedPageVersion: 8,
      operationKey: "reconcile:1", operator: "operator@example.com",
    }));
    await app.close();
  });
});
