// Read the running service's report, which includes the enabled runtime components.
try {
  const response = await fetch("http://127.0.0.1:3000/internal/readiness", {
    headers: { authorization: `Bearer ${process.env.IRIS_INTERNAL_API_TOKEN}` }, signal: AbortSignal.timeout(10000),
  });
  if (response.status !== 200) throw Error("readiness_http_failed");
  const report = await response.json();
  console.log(JSON.stringify({ capturedAt: new Date().toISOString(), ok: report.ok, status: report.status,
    summary: report.summary, checks: report.checks.map(({ id, status }) => ({ id, status })) }, null, 2));
  if (report.ok !== true || report.summary.failCount !== 0 || report.summary.passCount !== report.summary.checkCount) {
    process.exitCode = 1;
  }
} catch { console.error("live_readiness_unavailable"); process.exitCode = 1; }
