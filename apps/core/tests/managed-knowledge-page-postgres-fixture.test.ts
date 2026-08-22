import { describe, expect, it, vi } from "vitest";

import { insertManagedKnowledgePageFixture } from "./managed-knowledge-page-postgres-fixture.js";

describe("insertManagedKnowledgePageFixture", () => {
  it("uses one acquired client and one transaction when given a pool", async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql.trim());
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(),
      connect: vi.fn(async () => client),
    };

    await insertManagedKnowledgePageFixture({
      queryable: pool,
      state: "active",
      suffix: "transaction",
    });

    expect(pool.connect).toHaveBeenCalledOnce();
    expect(pool.query).not.toHaveBeenCalled();
    expect(statements[0]).toBe("BEGIN");
    expect(statements.at(-1)).toBe("COMMIT");
    expect(statements).toHaveLength(9);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("reuses an acquired client without nesting or releasing its transaction", async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql.trim());
        return { rows: [] };
      }),
      connect: vi.fn(),
      release: vi.fn(),
    };

    await insertManagedKnowledgePageFixture({
      queryable: client,
      state: "blocked",
      suffix: "existing-client",
    });

    expect(statements).toHaveLength(7);
    expect(statements).not.toContain("BEGIN");
    expect(statements).not.toContain("COMMIT");
    expect(client.connect).not.toHaveBeenCalled();
    expect(client.release).not.toHaveBeenCalled();
  });
});
