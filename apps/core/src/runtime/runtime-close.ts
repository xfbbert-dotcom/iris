export async function closeRuntimeResources(
  cleanupSteps: Array<() => Promise<unknown>>,
): Promise<void> {
  let firstError: unknown;

  for (const cleanupStep of cleanupSteps) {
    try {
      await cleanupStep();
    } catch (error) {
      firstError ??= error;
    }
  }

  if (firstError !== undefined) {
    throw firstError;
  }
}
