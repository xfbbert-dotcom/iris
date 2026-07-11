const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function readPositiveSafeInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value <= 0 || !Number.isSafeInteger(value)) {
    throw new Error(`${fieldName} must be a positive safe integer`);
  }
  if (value > MAX_TIMER_DELAY_MS) {
    throw new Error(`${fieldName} must not exceed ${MAX_TIMER_DELAY_MS}`);
  }

  return value;
}
