export type DatabaseConfig = {
  databaseUrl: string;
};

export type DatabaseEnv = Record<string, string | undefined>;

export class MissingDatabaseConfigError extends Error {
  constructor() {
    super("DATABASE_URL is required for database operations");
    this.name = "MissingDatabaseConfigError";
  }
}

export function readDatabaseConfig(
  env: DatabaseEnv = process.env,
): DatabaseConfig {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new MissingDatabaseConfigError();
  }
  assertPostgresUrl(databaseUrl);

  return { databaseUrl };
}

function assertPostgresUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a postgres URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must be a postgres URL");
  }
}
