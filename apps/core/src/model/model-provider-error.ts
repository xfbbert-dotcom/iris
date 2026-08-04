export class ModelProviderHttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "ModelProviderHttpError";
    this.statusCode = statusCode;
  }
}

export function isModelProviderCapacityError(
  error: unknown,
): error is ModelProviderHttpError {
  return error instanceof ModelProviderHttpError && error.statusCode === 429;
}
