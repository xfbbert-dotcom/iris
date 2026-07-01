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

  return { databaseUrl };
}
