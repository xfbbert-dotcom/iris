import Fastify from "fastify";
import { pathToFileURL } from "node:url";
import {
  createFeishuGateway,
  type FeishuCallbackRequest
} from "./feishu/feishu-gateway.js";
import { readFeishuAuthConfig } from "./config/env.js";
import { createFeishuRequestVerifier } from "./feishu/feishu-auth.js";
import type { EventQueue } from "./queues/event-queue.js";
import { InMemoryEventQueue } from "./queues/in-memory-event-queue.js";

export type BuildAppDependencies = {
  queue?: EventQueue;
  verifyFeishuRequest?: (request: FeishuCallbackRequest) => Promise<boolean> | boolean;
};

type ParsedJsonBody = {
  parsedBody: unknown;
  rawBody: string;
};

export function buildApp(dependencies: BuildAppDependencies = {}) {
  const queue = dependencies.queue ?? new InMemoryEventQueue();
  const feishuAuthConfig = readFeishuAuthConfig();
  const verifyFeishuRequest =
    dependencies.verifyFeishuRequest ??
    (feishuAuthConfig.verificationToken || feishuAuthConfig.encryptKey
      ? createFeishuRequestVerifier(feishuAuthConfig)
      : undefined);
  const gateway = createFeishuGateway({
    queue,
    verifyRequest: verifyFeishuRequest
  });
  const app = Fastify({ logger: false });

  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, payload, done) => {
    const rawBody = typeof payload === "string" ? payload : payload.toString("utf8");
    try {
      done(null, {
        parsedBody: JSON.parse(rawBody),
        rawBody
      });
    } catch (error) {
      done(createBadJsonError());
    }
  });

  app.post("/feishu/events", async (request, reply) => {
    const body = isParsedJsonBody(request.body) ? request.body.parsedBody : request.body;
    const rawBody = isParsedJsonBody(request.body) ? request.body.rawBody : undefined;
    const response = await gateway.handleCallback({
      headers: normalizeHeaders(request.headers),
      body,
      rawBody
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

function isParsedJsonBody(value: unknown): value is ParsedJsonBody {
  return (
    typeof value === "object" &&
    value !== null &&
    "parsedBody" in value &&
    typeof (value as { rawBody?: unknown }).rawBody === "string"
  );
}

function createBadJsonError(): Error & { statusCode: number } {
  const error = new Error("Invalid JSON");
  return Object.assign(error, { statusCode: 400 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = buildApp();
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
}
