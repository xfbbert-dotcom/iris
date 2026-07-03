export function readPositiveSafeInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value <= 0 || !Number.isSafeInteger(value)) {
    throw new Error(`${fieldName} must be a positive safe integer`);
  }

  return value;
}
