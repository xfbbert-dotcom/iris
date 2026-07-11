const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000;

type ShutdownSignal = "SIGINT" | "SIGTERM";

export interface GracefulShutdownTarget {
  close(): Promise<unknown>;
}

export interface ProcessSignalTarget {
  once(event: ShutdownSignal, listener: () => void): unknown;
  off(event: ShutdownSignal, listener: () => void): unknown;
  exit(code: number): unknown;
}

export interface GracefulShutdownOptions {
  processTarget?: ProcessSignalTarget;
  timeoutMs?: number;
  reportError?: (message: string, error: unknown) => void;
}

export function installGracefulShutdown(
  target: GracefulShutdownTarget,
  {
    processTarget = process,
    timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    reportError = (message, error) => console.error(message, error),
  }: GracefulShutdownOptions = {},
): void {
  let shuttingDown = false;

  const onSigint = () => startShutdown("SIGINT");
  const onSigterm = () => startShutdown("SIGTERM");

  function startShutdown(signal: ShutdownSignal): void {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    processTarget.off("SIGINT", onSigint);
    processTarget.off("SIGTERM", onSigterm);

    const timeout = setTimeout(() => {
      reportError(`Iris graceful shutdown timed out after ${timeoutMs}ms (${signal})`, undefined);
      processTarget.exit(1);
    }, timeoutMs);
    timeout.unref();

    void target.close().then(
      () => clearTimeout(timeout),
      (error: unknown) => {
        clearTimeout(timeout);
        reportError("Iris graceful shutdown failed", error);
        processTarget.exit(1);
      },
    );
  }

  processTarget.once("SIGINT", onSigint);
  processTarget.once("SIGTERM", onSigterm);
}
