import Fastify from "fastify";
import { pathToFileURL } from "node:url";
import {
  createFeishuGateway,
  type FeishuCallbackRequest
} from "./feishu/feishu-gateway.js";
import type { EventQueue } from "./queues/event-queue.js";
import { InMemoryEventQueue } from "./queues/in-memory-event-queue.js";

export type BuildAppDependencies = {
  queue?: EventQueue;
  verifyFeishuRequest?: (request: FeishuCallbackRequest) => Promise<boolean> | boolean;
};

export function buildApp(dependencies: BuildAppDependencies = {}) {
  const queue = dependencies.queue ?? new InMemoryEventQueue();
  const gateway = createFeishuGateway({
    queue,
    verifyRequest: dependencies.verifyFeishuRequest
  });
  const app = Fastify({ logger: false });

  app.post("/feishu/events", async (request, reply) => {
    const response = await gateway.handleCallback({
      headers: normalizeHeaders(request.headers),
      body: request.body
    });

    return reply.code(response.statusCode).send(response.body);
  });

  app.get("/health", async () => ({ ok: true, service: "iris-core" }));

  return app;
}

function normalizeHeaders(headers: Record<string, unknown>): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key.toLowerCase(),
      Array.isArray(value) ? String(value[0]) : typeof value === "string" ? value : undefined
    ])
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = buildApp();
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
}
