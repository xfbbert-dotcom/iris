export type DocumentChunk = {
  chunkIndex: number;
  text: string;
};

export type DocumentChunkerOptions = {
  maxChunkChars?: number;
  minChunkChars?: number;
};

export interface DocumentChunker {
  chunkText(text: string): DocumentChunk[];
}

export function createDocumentChunker(options: DocumentChunkerOptions = {}): DocumentChunker {
  const maxChunkChars = options.maxChunkChars ?? 1200;
  const minChunkChars = options.minChunkChars ?? 80;

  if (maxChunkChars < 1) {
    throw new Error("maxChunkChars must be greater than 0");
  }
  if (minChunkChars < 1) {
    throw new Error("minChunkChars must be greater than 0");
  }
  if (minChunkChars > maxChunkChars) {
    throw new Error("minChunkChars must be less than or equal to maxChunkChars");
  }

  return {
    chunkText(text) {
      const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
      if (normalized.length === 0) {
        return [];
      }

      const blocks = normalized
        .split(/\n[ \t]*\n+/)
        .map((block) => block.trim())
        .filter((block) => block.length > 0);

      const chunkTexts = mergeBlocks(blocks, { maxChunkChars, minChunkChars }).flatMap((block) =>
        hardSplit(block, maxChunkChars),
      );

      return chunkTexts.map((chunk, index) => ({
        chunkIndex: index,
        text: chunk,
      }));
    },
  };
}

function mergeBlocks(
  blocks: string[],
  options: { maxChunkChars: number; minChunkChars: number },
): string[] {
  const merged: string[] = [];
  let current = "";
  const shortTrailingBlockChars = Math.ceil(options.minChunkChars / 2);

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex] ?? "";
    const isTrailingBlock = blockIndex === blocks.length - 1;

    if (current.length === 0) {
      current = block;
      continue;
    }

    const candidate = `${current}\n\n${block}`;
    if (
      candidate.length <= options.maxChunkChars &&
      (current.length < options.minChunkChars ||
        (isTrailingBlock && block.length < shortTrailingBlockChars))
    ) {
      current = candidate;
      continue;
    }
    merged.push(current);
    current = block;
  }

  if (current.length > 0) {
    merged.push(current);
  }

  return merged;
}

function hardSplit(text: string, maxChunkChars: number): string[] {
  if (text.length <= maxChunkChars) {
    return [text];
  }

  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += maxChunkChars) {
    const chunk = text.slice(index, index + maxChunkChars).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
  }
  return chunks;
}
