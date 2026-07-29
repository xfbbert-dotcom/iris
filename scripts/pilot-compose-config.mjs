import { renderPilotCompose } from "./pilot-compose-lib.mjs";

const result = renderPilotCompose();

if (result.status !== 0) {
  const details =
    result.error?.message ||
    result.stderr?.trim() ||
    result.stdout?.trim() ||
    `docker compose exited with status ${String(result.status)}`;
  console.error(`Unable to render pilot Compose config: ${details}`);
  process.exitCode = 1;
} else {
  process.stdout.write(result.stdout);
}
