import {
  createPostgresRuntimeControlStateRepository,
} from "../admin/postgres-runtime-control-state-repository.js";
import {
  createRuntimeControlService,
  type RuntimeControlService,
} from "../admin/runtime-control-service.js";
import { RuntimeController } from "../admin/runtime-controller.js";
import { createDefaultRuntimeConfig } from "../config/runtime-config.js";
import { readDatabaseConfig } from "../database/database-config.js";
import {
  closePostgresPool,
  createPostgresPool,
} from "../database/postgres.js";

export type RuntimeControlRuntime = {
  runtimeControl: {
    controller: RuntimeController;
    service: RuntimeControlService;
  };
  close(): Promise<void>;
};

export async function createRuntimeControlRuntime(input: {
  env?: NodeJS.ProcessEnv;
  createPool?: typeof createPostgresPool;
} = {}): Promise<RuntimeControlRuntime> {
  const databaseConfig = readDatabaseConfig(input.env ?? process.env);
  const pool = (input.createPool ?? createPostgresPool)(databaseConfig);
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= closePostgresPool(pool);
    return closePromise;
  };

  try {
    const repository = createPostgresRuntimeControlStateRepository({ queryable: pool });
    const durableSnapshot = await repository.getSnapshot();
    const controller = new RuntimeController(
      createDefaultRuntimeConfig({ IRIS_RUNTIME_GLOBAL_ENABLED: "false" }),
    );
    controller.replaceDurablePolicy(durableSnapshot);
    const service = createRuntimeControlService({ controller, repository });

    return {
      runtimeControl: { controller, service },
      close,
    };
  } catch (startupError) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        "Iris runtime-control startup failed and pool cleanup failed",
      );
    }
    throw startupError;
  }
}
