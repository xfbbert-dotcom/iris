export type Queryable = {
  query: <T = unknown>(sql: string, values?: unknown[]) => Promise<{ rows: T[] }>;
};

export type EmbeddingProfileProvider = "static-dev" | "openai-compatible";
export type EmbeddingProfileStatus = "active" | "deprecated";

export type EmbeddingProfile = {
  id: string;
  provider: EmbeddingProfileProvider;
  model: string;
  dimensions: number;
  displayName: string;
  status: EmbeddingProfileStatus;
  createdAt: Date;
};

export type FindOrCreateEmbeddingProfileInput = {
  provider: EmbeddingProfileProvider;
  model: string;
  dimensions: number;
  displayName: string;
};

export type EmbeddingProfileRepositoryDependencies = {
  queryable: Queryable;
};

export interface EmbeddingProfileRepository {
  findOrCreateProfile(input: FindOrCreateEmbeddingProfileInput): Promise<EmbeddingProfile>;
  getStaticDevelopmentProfile(): Promise<EmbeddingProfile>;
}

export const staticDevelopmentEmbeddingProfile = {
  id: "static-dev-6d",
  provider: "static-dev" as const,
  model: "static-dev-6d",
  dimensions: 6,
  displayName: "Static development embeddings (6d)",
  status: "active" as const,
};

type EmbeddingProfileRow = {
  id: string;
  provider: string;
  model: string;
  dimensions: number;
  display_name: string;
  status: string;
  created_at: Date;
};

export function createEmbeddingProfileRepository(
  dependencies: EmbeddingProfileRepositoryDependencies,
): EmbeddingProfileRepository {
  return {
    async findOrCreateProfile(input) {
      const id = profileId(input.provider, input.model, input.dimensions);
      const result = await dependencies.queryable.query<EmbeddingProfileRow>(
        `
insert into embedding_profiles (
  id,
  provider,
  model,
  dimensions,
  display_name,
  status,
  created_at
)
values ($1, $2, $3, $4, $5, $6, now())
on conflict (provider, model, dimensions)
do update set display_name = excluded.display_name
returning *
`,
        [id, input.provider, input.model, input.dimensions, input.displayName, "active"],
      );

      return mapProfileRow(readSingleRow(result.rows, "embedding profile was not returned"));
    },

    async getStaticDevelopmentProfile() {
      const result = await dependencies.queryable.query<EmbeddingProfileRow>(
        `
select *
from embedding_profiles
where id = $1
`,
        [staticDevelopmentEmbeddingProfile.id],
      );

      return mapProfileRow(
        readSingleRow(result.rows, "static development embedding profile was not found"),
      );
    },
  };
}

function profileId(provider: EmbeddingProfileProvider, model: string, dimensions: number): string {
  return `${provider}:${model}:${dimensions}`;
}

function readSingleRow<T>(rows: T[], errorMessage: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(errorMessage);
  }

  return row;
}

function mapProfileRow(row: EmbeddingProfileRow): EmbeddingProfile {
  if (row.provider !== "static-dev" && row.provider !== "openai-compatible") {
    throw new Error(`Unsupported embedding profile provider: ${row.provider}`);
  }
  if (row.status !== "active" && row.status !== "deprecated") {
    throw new Error(`Unsupported embedding profile status: ${row.status}`);
  }

  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    dimensions: Number(row.dimensions),
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at,
  };
}
