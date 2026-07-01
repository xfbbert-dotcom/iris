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

  it("throws a typed error when DATABASE_URL is missing", () => {
    expect(() => readDatabaseConfig({})).toThrow(MissingDatabaseConfigError);
  });
});
