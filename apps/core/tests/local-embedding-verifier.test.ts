import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const verifierPath = fileURLToPath(
  new URL("../../../deploy/pilot/verify-local-embedding.mjs", import.meta.url),
);
const temporaryDirectories: string[] = [];
const model = "embeddinggemma:300m-qat-q4_0";
const dimensions = 768;
const unitEmbedding = Array.from({ length: dimensions }, () => 1 / Math.sqrt(dimensions));
const verifierInputs = Array.from(
  { length: 4 },
  (_, index) => `title: none | text: iris-local-embedding-verifier-v2-${index + 1}`,
);

describe("local embedding verifier", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("accepts a complete cache and a valid known-input embedding response", async () => {
    const cache = await createModelCache();
    await withEmbeddingServer(
      validEmbeddingResponse(),
      async ({ baseUrl, requests }) => {
        const result = await runVerifier(cache, baseUrl);

        expect(result).toEqual({ code: 0, stderr: "" });
        expect(requests).toEqual([
          {
            method: "POST",
            path: "/v1/embeddings",
            body: {
              dimensions,
              input: verifierInputs,
              model,
            },
          },
        ]);
      },
    );
  });

  it("rejects a missing manifest-referenced config blob", async () => {
    const cache = await createModelCache({ omitConfigBlob: true });

    const result = await runVerifier(cache, "http://127.0.0.1:1/v1");

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("missing model blob");
    expect(result.stderr).toContain(cache.configDigest);
  });

  it("rejects a corrupt manifest-referenced layer blob", async () => {
    const cache = await createModelCache({ corruptLayerBlob: true });

    const result = await runVerifier(cache, "http://127.0.0.1:1/v1");

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("model blob SHA256 mismatch");
    expect(result.stderr).toContain(cache.layerDigest);
  });

  it("rejects a full model-manifest SHA256 mismatch", async () => {
    const cache = await createModelCache();

    const result = await runVerifier(
      { ...cache, manifestSha256: "0".repeat(64) },
      "http://127.0.0.1:1/v1",
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("model manifest SHA256 mismatch");
  });

  it.each([
    [
      "malformed",
      JSON.stringify({ data: [], model }),
      "embedding response must contain exactly 4 items",
    ],
    [
      "non-finite",
      validEmbeddingResponse({ index: 0, embedding: [null, ...unitEmbedding.slice(1)] }),
      "embedding values must be finite numbers",
    ],
    [
      "wrong-dimension",
      validEmbeddingResponse({ index: 0, embedding: unitEmbedding.slice(1) }),
      "embedding dimension must be exactly 768",
    ],
    [
      "non-unit",
      validEmbeddingResponse({
        index: 3,
        embedding: Array.from({ length: dimensions }, () => 0.1),
      }),
      "embedding norm must be within 0.001 of 1",
    ],
  ])("rejects a %s embedding response", async (_label, responseBody, expectedError) => {
    const cache = await createModelCache();
    await withEmbeddingServer(responseBody, async ({ baseUrl }) => {
      const result = await runVerifier(cache, baseUrl);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(expectedError);
    });
  });
});

type ModelCache = {
  modelRoot: string;
  manifestSha256: string;
  configDigest: string;
  layerDigest: string;
};

async function createModelCache(
  options: { omitConfigBlob?: boolean; corruptLayerBlob?: boolean } = {},
): Promise<ModelCache> {
  const root = await mkdtemp(join(tmpdir(), "iris-embedding-verifier-"));
  temporaryDirectories.push(root);
  const modelRoot = join(root, "models");
  const config = Buffer.from('{"model_format":"gguf"}', "utf8");
  const layer = Buffer.from("approved-model-layer", "utf8");
  const configDigest = digest(config);
  const layerDigest = digest(layer);
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.docker.distribution.manifest.v2+json",
    config: {
      mediaType: "application/vnd.docker.container.image.v1+json",
      digest: configDigest,
      size: config.length,
    },
    layers: [{
      mediaType: "application/vnd.ollama.image.model",
      digest: layerDigest,
      size: layer.length,
    }],
  }), "utf8");
  const manifestPath = join(
    modelRoot,
    "manifests",
    "registry.ollama.ai",
    "library",
    "embeddinggemma",
    "300m-qat-q4_0",
  );
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, manifest);
  await mkdir(join(modelRoot, "blobs"), { recursive: true });
  if (!options.omitConfigBlob) {
    await writeFile(join(modelRoot, "blobs", configDigest.replace(":", "-")), config);
  }
  await writeFile(
    join(modelRoot, "blobs", layerDigest.replace(":", "-")),
    options.corruptLayerBlob ? Buffer.from("corrupt-layer", "utf8") : layer,
  );

  return {
    modelRoot,
    manifestSha256: createHash("sha256").update(manifest).digest("hex"),
    configDigest,
    layerDigest,
  };
}

function validEmbeddingResponse(
  replacement?: { index: number; embedding: unknown[] },
): string {
  return JSON.stringify({
    data: Array.from({ length: 4 }, (_, index) => ({
      index,
      embedding: replacement?.index === index ? replacement.embedding : unitEmbedding,
    })),
    model,
  });
}

function digest(content: Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function runVerifier(cache: ModelCache, baseUrl: string): Promise<{
  code: number | null;
  stderr: string;
}> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [verifierPath], {
      env: {
        ...process.env,
        IRIS_EMBEDDING_BASE_URL: baseUrl,
        IRIS_EMBEDDING_MODEL: model,
        IRIS_EMBEDDING_DIMENSIONS: String(dimensions),
        IRIS_EMBEDDING_MODEL_MANIFEST_SHA256: cache.manifestSha256,
        IRIS_EMBEDDING_MODEL_ROOT: cache.modelRoot,
        IRIS_EMBEDDING_NORM_TOLERANCE: "0.001",
        IRIS_EMBEDDING_VERIFIER_TIMEOUT_MS: "5000",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ code, stderr: stderr.trim() }));
  });
}

async function withEmbeddingServer(
  responseBody: string,
  operation: (input: {
    baseUrl: string;
    requests: Array<{ method: string; path: string; body: unknown }>;
  }) => Promise<void>,
): Promise<void> {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    requests.push({
      method: request.method ?? "",
      path: request.url ?? "",
      body: JSON.parse(body),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(responseBody);
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test embedding server did not bind a TCP port");
  }

  try {
    await operation({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      requests,
    });
  } finally {
    await new Promise<void>((resolveClose, reject) => {
      server.close((error) => error === undefined ? resolveClose() : reject(error));
    });
  }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
