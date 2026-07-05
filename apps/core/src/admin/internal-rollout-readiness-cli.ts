import { pathToFileURL } from "node:url";

import {
  buildInternalRolloutReadinessReport,
  type InternalRolloutReadinessReport,
} from "./internal-rollout-readiness.js";

export function formatInternalRolloutReadinessReport(
  report: InternalRolloutReadinessReport,
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function getInternalRolloutReadinessExitCode(
  report: InternalRolloutReadinessReport,
): 0 | 1 {
  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = buildInternalRolloutReadinessReport(process.env);
  process.stdout.write(formatInternalRolloutReadinessReport(report));
  process.exitCode = getInternalRolloutReadinessExitCode(report);
}
