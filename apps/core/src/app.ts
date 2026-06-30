import Fastify from "fastify";
import { pathToFileURL } from "node:url";

export function buildApp() {
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ ok: true, service: "iris-core" }));

  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = buildApp();
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
}
