export type RuntimeEmbeddingProfileInput = {
  provider: "openai-compatible";
  model: string;
  dimensions: number;
};

export function createEmbeddingProfileId(input: RuntimeEmbeddingProfileInput): string {
  return `${input.provider}:${input.model}:${input.dimensions}`;
}

export function assertSupportedRuntimeEmbeddingDimension(dimension: number): void {
  if (dimension !== 6 && dimension !== 768 && dimension !== 1024 && dimension !== 1536) {
    throw new Error(`Unsupported embedding dimension: ${dimension}`);
  }
}
