import { describe, expect, it, vi } from "vitest";

import {
  createEmbeddingProfileRepository,
  staticDevelopmentEmbeddingProfile,
  type Queryable,
} from "../src/documents/embedding-profile-repository.js";

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function queryableFrom(query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>): Queryable {
  return { query: query as Queryable["query"] };
}

describe("EmbeddingProfileRepository", () => {
  it("returns the static development profile", async () => {
    const createdAt = new Date("2026-07-02T01:00:00.000Z");
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      expect(normalizeSql(sql)).toContain("select * from embedding_profiles");
      expect(values).toEqual(["static-dev-6d"]);
      return {
        rows: [
          {
            id: "static-dev-6d",
            provider: "static-dev",
            model: "static-dev-6d",
            dimensions: 6,
            display_name: "Static development embeddings (6d)",
            status: "active",
            created_at: createdAt,
          },
        ],
      };
    });
    const repository = createEmbeddingProfileRepository({ queryable: queryableFrom(query) });

    await expect(repository.getStaticDevelopmentProfile()).resolves.toEqual({
      ...staticDevelopmentEmbeddingProfile,
      createdAt,
    });
  });

  it("finds or creates an active profile using provider model and dimensions", async () => {
    const createdAt = new Date("2026-07-02T02:00:00.000Z");
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      expect(normalizeSql(sql)).toContain("insert into embedding_profiles");
      expect(values).toEqual([
        "openai-compatible:text-embedding-small:6",
        "openai-compatible",
        "text-embedding-small",
        6,
        "OpenAI-compatible text-embedding-small (6d)",
        "active",
      ]);
      return {
        rows: [
          {
            id: "openai-compatible:text-embedding-small:6",
            provider: "openai-compatible",
            model: "text-embedding-small",
            dimensions: 6,
            display_name: "OpenAI-compatible text-embedding-small (6d)",
            status: "active",
            created_at: createdAt,
          },
        ],
      };
    });
    const repository = createEmbeddingProfileRepository({ queryable: queryableFrom(query) });

    await expect(
      repository.findOrCreateProfile({
        provider: "openai-compatible",
        model: "text-embedding-small",
        dimensions: 6,
        displayName: "OpenAI-compatible text-embedding-small (6d)",
      }),
    ).resolves.toEqual({
      id: "openai-compatible:text-embedding-small:6",
      provider: "openai-compatible",
      model: "text-embedding-small",
      dimensions: 6,
      displayName: "OpenAI-compatible text-embedding-small (6d)",
      status: "active",
      createdAt,
    });
  });

  it("throws when the static development profile is missing", async () => {
    const repository = createEmbeddingProfileRepository({
      queryable: queryableFrom(vi.fn(async () => ({ rows: [] }))),
    });

    await expect(repository.getStaticDevelopmentProfile()).rejects.toThrow(
      "static development embedding profile was not found",
    );
  });

  it("reads a profile by id", async () => {
    const createdAt = new Date("2026-07-02T03:00:00.000Z");
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      expect(normalizeSql(sql)).toContain("select * from embedding_profiles");
      expect(values).toEqual(["openai-compatible:text-embedding-small:1536"]);
      return {
        rows: [
          {
            id: "openai-compatible:text-embedding-small:1536",
            provider: "openai-compatible",
            model: "text-embedding-small",
            dimensions: 1536,
            display_name: "OpenAI-compatible text-embedding-small (1536d)",
            status: "active",
            created_at: createdAt,
          },
        ],
      };
    });
    const repository = createEmbeddingProfileRepository({ queryable: queryableFrom(query) });

    await expect(
      repository.getProfileById("openai-compatible:text-embedding-small:1536"),
    ).resolves.toEqual({
      id: "openai-compatible:text-embedding-small:1536",
      provider: "openai-compatible",
      model: "text-embedding-small",
      dimensions: 1536,
      displayName: "OpenAI-compatible text-embedding-small (1536d)",
      status: "active",
      createdAt,
    });
  });

  it("throws when a profile id is missing", async () => {
    const repository = createEmbeddingProfileRepository({
      queryable: queryableFrom(vi.fn(async () => ({ rows: [] }))),
    });

    await expect(repository.getProfileById("missing-profile")).rejects.toThrow(
      "embedding profile was not found: missing-profile",
    );
  });
});
