export async function closeRuntimeResources(
  cleanupSteps: Array<() => Promise<unknown>>,
): Promise<void> {
  const errors: unknown[] = [];

  for (const cleanupStep of cleanupSteps) {
    try {
      await cleanupStep();
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Iris runtime resource cleanup failed");
  }
}
