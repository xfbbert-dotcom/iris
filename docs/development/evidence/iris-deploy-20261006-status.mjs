// Container-local status only, under the explicit deployment authorization.
// These GETs may synchronize durable policy into the live controller.
import { createHash } from "node:crypto";
const get = async path => {
  const response = await fetch(`http://127.0.0.1:3000${path}`, {
    headers: { authorization: `Bearer ${process.env.IRIS_INTERNAL_API_TOKEN}` }, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw Error(`status_http_${response.status}`);
  return response.json();
};
try {
  const status = await get("/internal/status");
  const control = await get("/internal/runtime-control/status");
  const components = Object.fromEntries(Object.entries(status.components ?? {}).map(([name, value]) => [name,
    Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => typeof v === "number" || typeof v === "boolean"))]));
  console.log(JSON.stringify({ capturedAt: new Date().toISOString(), ok: status.ok, components,
    control: { globalEnabled: control.globalEnabled, desiredGlobalEnabled: control.desiredGlobalEnabled,
      activationRequired: control.activationRequired, revision: control.revision, capabilities: control.capabilities,
      persistence: { storage: control.persistence?.storage, ok: control.persistence?.ok },
      disabledGroupCount: control.disabledGroupIds?.length,
      disabledGroupsFingerprint: createHash("sha256").update(JSON.stringify([...(control.disabledGroupIds ?? [])].sort())).digest("hex") },
  }, null, 2));
} catch { console.error("deployment_status_unavailable"); process.exitCode = 1; }
