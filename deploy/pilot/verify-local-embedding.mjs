import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const verifierInputs = Array.from(
  { length: 4 },
  (_, index) => `title: none | text: iris-local-embedding-verifier-v2-${index + 1}`,
);

try {
  const configuration = readConfiguration(process.env);
  await verifyModelCache(configuration);
  await verifyKnownInputEmbedding(configuration);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Local embedding verification failed: ${message}\n`);
  process.exitCode = 1;
}

function readConfiguration(environment) {
  const baseUrl = requireEnvironmentValue(environment, "IRIS_EMBEDDING_BASE_URL");
  const model = requireEnvironmentValue(environment, "IRIS_EMBEDDING_MODEL");
  const dimensions = parsePositiveInteger(
    requireEnvironmentValue(environment, "IRIS_EMBEDDING_DIMENSIONS"),
    "IRIS_EMBEDDING_DIMENSIONS",
  );
  const manifestSha256 = requireEnvironmentValue(
    environment,
    "IRIS_EMBEDDING_MODEL_MANIFEST_SHA256",
  );
  if (!sha256Pattern.test(manifestSha256)) {
    throw new Error("IRIS_EMBEDDING_MODEL_MANIFEST_SHA256 must be 64 lowercase hex characters");
  }
  const normTolerance = parsePositiveNumber(
    requireEnvironmentValue(environment, "IRIS_EMBEDDING_NORM_TOLERANCE"),
    "IRIS_EMBEDDING_NORM_TOLERANCE",
  );
  const timeoutMs = parsePositiveInteger(
    requireEnvironmentValue(environment, "IRIS_EMBEDDING_VERIFIER_TIMEOUT_MS"),
    "IRIS_EMBEDDING_VERIFIER_TIMEOUT_MS",
  );
  const modelRoot = environment.IRIS_EMBEDDING_MODEL_ROOT?.trim()
    || "/root/.ollama/models";

  return {
    baseUrl: new URL(baseUrl),
    model,
    dimensions,
    manifestSha256,
    modelRoot,
    normTolerance,
    timeoutMs,
  };
}

async function verifyModelCache(configuration) {
  const { modelName, modelTag } = splitModel(configuration.model);
  const manifestPath = join(
    configuration.modelRoot,
    "manifests",
    "registry.ollama.ai",
    "library",
    modelName,
    modelTag,
  );
  const manifestBytes = await readRequiredFile(manifestPath, "model manifest");
  const actualManifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  if (actualManifestSha256 !== configuration.manifestSha256) {
    throw new Error(
      `model manifest SHA256 mismatch: expected ${configuration.manifestSha256}, got ${actualManifestSha256}`,
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("model manifest is not valid JSON");
  }
  const digests = referencedDigests(manifest);
  for (const digest of digests) {
    const blobPath = join(configuration.modelRoot, "blobs", digest.replace(":", "-"));
    await assertBlobDigest(blobPath, digest);
  }
}

function referencedDigests(manifest) {
  if (
    manifest === null
    || typeof manifest !== "object"
    || manifest.config === null
    || typeof manifest.config !== "object"
    || !Array.isArray(manifest.layers)
    || manifest.layers.length === 0
  ) {
    throw new Error("model manifest must contain config.digest and at least one layer digest");
  }
  const digests = [
    manifest.config.digest,
    ...manifest.layers.map((layer) => layer?.digest),
  ];
  if (digests.some((digest) => typeof digest !== "string" || !digestPattern.test(digest))) {
    throw new Error("model manifest contains an invalid config or layer digest");
  }
  return digests;
}

async function assertBlobDigest(blobPath, expectedDigest) {
  let actualDigest;
  try {
    actualDigest = `sha256:${await sha256File(blobPath)}`;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new Error(`missing model blob ${expectedDigest}`);
    }
    throw error;
  }
  if (actualDigest !== expectedDigest) {
    throw new Error(`model blob SHA256 mismatch for ${expectedDigest}: got ${actualDigest}`);
  }
}

async function verifyKnownInputEmbedding(configuration) {
  const endpoint = new URL(
    `${configuration.baseUrl.pathname.replace(/\/+$/u, "")}/embeddings`,
    configuration.baseUrl,
  );
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      dimensions: configuration.dimensions,
      input: verifierInputs,
      model: configuration.model,
    }),
    signal: AbortSignal.timeout(configuration.timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`embedding endpoint returned HTTP ${response.status}`);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("embedding endpoint did not return valid JSON");
  }
  if (body?.model !== configuration.model) {
    throw new Error(`embedding response model must be exactly ${configuration.model}`);
  }
  if (!Array.isArray(body?.data) || body.data.length !== verifierInputs.length) {
    throw new Error(`embedding response must contain exactly ${verifierInputs.length} items`);
  }
  for (const [index, item] of body.data.entries()) {
    if (item?.index !== index) {
      throw new Error("embedding response indices must match request order");
    }
    const embedding = item?.embedding;
    if (!Array.isArray(embedding)) {
      throw new Error(`embedding response item ${index} must contain an embedding`);
    }
    if (embedding.length !== configuration.dimensions) {
      throw new Error(`embedding dimension must be exactly ${configuration.dimensions}`);
    }
    if (embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error("embedding values must be finite numbers");
    }

    const norm = Math.sqrt(embedding.reduce((sum, value) => sum + value * value, 0));
    if (!Number.isFinite(norm) || Math.abs(norm - 1) > configuration.normTolerance) {
      throw new Error(
        `embedding norm must be within ${configuration.normTolerance} of 1; got ${norm}`,
      );
    }
  }
}

async function readRequiredFile(path, label) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new Error(`missing ${label}: ${path}`);
    }
    throw error;
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function splitModel(model) {
  const separator = model.lastIndexOf(":");
  const modelName = model.slice(0, separator);
  const modelTag = model.slice(separator + 1);
  const componentPattern = /^[A-Za-z0-9._-]+$/u;
  if (
    separator <= 0
    || !componentPattern.test(modelName)
    || !componentPattern.test(modelTag)
  ) {
    throw new Error("IRIS_EMBEDDING_MODEL must be one safe name:tag");
  }
  return { modelName, modelTag };
}

function requireEnvironmentValue(environment, name) {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parsePositiveInteger(value, name) {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parsePositiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return parsed;
}
