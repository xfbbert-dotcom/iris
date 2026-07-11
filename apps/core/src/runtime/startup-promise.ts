export function observeStartupPromise<T>(promise: Promise<T>): Promise<T> {
  // Preserve lazy failures for later awaits while preventing process-level unhandled rejections.
  void promise.catch(() => undefined);
  return promise;
}
