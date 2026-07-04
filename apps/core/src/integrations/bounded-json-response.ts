export type ReadBoundedJsonResponseInput = {
  response: Response;
  invalidJsonErrorMessage: string;
  maxResponseBytes?: number;
  responseSizeErrorMessage?: string;
};

export async function readBoundedJsonResponse({
  response,
  invalidJsonErrorMessage,
  maxResponseBytes,
  responseSizeErrorMessage,
}: ReadBoundedJsonResponseInput): Promise<unknown> {
  try {
    if (maxResponseBytes !== undefined && responseSizeErrorMessage !== undefined) {
      const boundedText = await readBoundedResponseText(
        response,
        maxResponseBytes,
        responseSizeErrorMessage,
      );
      if (boundedText !== undefined) {
        return JSON.parse(boundedText);
      }
    }

    return await response.json();
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    if (error instanceof ResponseSizeError) {
      throw error;
    }
    throw new Error(invalidJsonErrorMessage);
  }
}

async function readBoundedResponseText(
  response: Response,
  maxResponseBytes: number,
  errorMessage: string,
): Promise<string | undefined> {
  const body = response.body;
  if (body !== undefined && body !== null) {
    return readBoundedReadableStream(body, maxResponseBytes, errorMessage);
  }

  if (typeof response.text === "function") {
    const text = await response.text();
    const byteLength = new TextEncoder().encode(text).byteLength;
    if (byteLength > maxResponseBytes) {
      throw new ResponseSizeError(errorMessage);
    }
    return text;
  }

  return undefined;
}

async function readBoundedReadableStream(
  body: ReadableStream<Uint8Array>,
  maxResponseBytes: number,
  errorMessage: string,
): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }

      byteLength += value.byteLength;
      if (byteLength > maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseSizeError(errorMessage);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return new TextDecoder().decode(concatChunks(chunks, byteLength));
}

function concatChunks(chunks: Uint8Array[], byteLength: number): Uint8Array {
  const buffer = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return buffer;
}

class ResponseSizeError extends Error {}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
