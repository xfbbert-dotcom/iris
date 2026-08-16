import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, it } from "vitest";

describe("KnowledgeCardStatusReader generation ownership", () => {
  it("releases completed generations before reader close", async () => {
    const fixturePath = fileURLToPath(new URL(
      "./support/knowledge-card-status-reader-ownership.gc.ts",
      import.meta.url,
    ));
    const result = await spawnOutcome(process.execPath, [
      "--expose-gc",
      "--import",
      "tsx",
      fixturePath,
    ]);
    if (result.exitCode !== 0) {
      throw new Error([
        `garbage-collected ownership fixture exited ${result.exitCode}`,
        result.stdout,
        result.stderr,
      ].filter(Boolean).join("\n"));
    }
  }, 20_000);
});

function spawnOutcome(command: string, args: string[]): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}
