export function isolateEnvVar(name: string): () => void {
  const originalValue = process.env[name];
  delete process.env[name];

  return () => {
    if (originalValue === undefined) {
      delete process.env[name];
      return;
    }

    process.env[name] = originalValue;
  };
}
