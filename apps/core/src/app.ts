import Fastify from "fastify";

export function buildApp() {
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ ok: true, service: "iris-core" }));

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = buildApp();
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
}
