import { describe, expect, it } from "vitest";
import {
  MissingDatabaseConfigError,
  readDatabaseConfig,
} from "../src/database/database-config.js";

describe("readDatabaseConfig", () => {
  it("reads a trimmed DATABASE_URL", () => {
    expect(
      readDatabaseConfig({
        DATABASE_URL: " postgres://iris:iris@localhost:5432/iris ",
      }),
    ).toEqual({
      databaseUrl: "postgres://iris:iris@localhost:5432/iris",
    });
  });

  it("accepts postgresql URLs with credentials, paths, and query params", () => {
    expect(
      readDatabaseConfig({
        DATABASE_URL: " postgresql://iris:secret@db.example.com:5432/iris?sslmode=require ",
      }),
    ).toEqual({
      databaseUrl: "postgresql://iris:secret@db.example.com:5432/iris?sslmode=require",
    });
  });

  it("throws a typed error when DATABASE_URL is missing", () => {
    expect(() => readDatabaseConfig({})).toThrow(MissingDatabaseConfigError);
  });

  it("rejects malformed and non-Postgres database URLs", () => {
    expect(() => readDatabaseConfig({ DATABASE_URL: "not a url" })).toThrow(
      "DATABASE_URL must be a postgres URL",
    );
    expect(() => readDatabaseConfig({ DATABASE_URL: "mysql://localhost:3306/iris" })).toThrow(
      "DATABASE_URL must be a postgres URL",
    );
  });
});
