import type { IrisCapability } from "../config/runtime-config.js";
import {
  normalizeRuntimeControlStateReplacement,
  type DurableRuntimeControlSnapshot,
  type RuntimeControlStateRepository,
} from "./runtime-control-state-repository.js";
import type {
  RuntimeController,
  RuntimeControllerSnapshot,
} from "./runtime-controller.js";

export type RuntimeControlPersistence = {
  storage: "postgres" | "in_memory";
  ok: boolean;
  error?: "runtime_control_persistence_failed";
};

export type RuntimeControlStatus = RuntimeControllerSnapshot & {
  persistence: RuntimeControlPersistence;
};

export type RuntimeControlMutationResult =
  | { kind: "success"; durable: true; status: RuntimeControlStatus }
  | { kind: "conflict" }
  | { kind: "persistence_failed" }
  | { kind: "disable_not_persisted"; status: RuntimeControlStatus };

export interface RuntimeControlService {
  getStatus(): Promise<RuntimeControlStatus>;
  setGlobal(input: {
    enabled: boolean;
    updatedBy?: string;
  }): Promise<RuntimeControlMutationResult>;
  setGroup(input: {
    groupId: string;
    enabled: boolean;
    updatedBy?: string;
  }): Promise<RuntimeControlMutationResult>;
  setCapabilities(input: {
    updates: Partial<IrisCapability>;
    updatedBy?: string;
  }): Promise<RuntimeControlMutationResult>;
}

export function createRuntimeControlService({
  controller,
  repository,
}: {
  controller: RuntimeController;
  repository: RuntimeControlStateRepository;
}): RuntimeControlService {
  return createService({ controller, repository, storage: "postgres" });
}

export function createInMemoryRuntimeControlService(
  controller: RuntimeController,
  now: () => Date,
): RuntimeControlService {
  return createService({
    controller,
    repository: createInMemoryRepository(controller.getSnapshot(), now),
    storage: "in_memory",
  });
}

function createService({
  controller,
  repository,
  storage,
}: {
  controller: RuntimeController;
  repository: RuntimeControlStateRepository;
  storage: RuntimeControlPersistence["storage"];
}): RuntimeControlService {
  async function persist(
    buildNext: (
      current: RuntimeControllerSnapshot,
    ) => Omit<DurableRuntimeControlSnapshot, "revision" | "updatedAt">,
    afterPersist?: () => void,
    memoryFirstDisable = false,
  ): Promise<RuntimeControlMutationResult> {
    const current = controller.getSnapshot();

    try {
      const persisted = await repository.replaceSnapshot({
        expectedRevision: current.revision,
        next: buildNext(current),
      });
      if (persisted === "conflict") {
        return memoryFirstDisable
          ? disableNotPersisted(controller, storage)
          : { kind: "conflict" };
      }

      controller.replaceDurablePolicy(persisted);
      afterPersist?.();
      return {
        kind: "success",
        durable: true,
        status: statusFromController(controller, storage, true),
      };
    } catch {
      return memoryFirstDisable
        ? disableNotPersisted(controller, storage)
        : { kind: "persistence_failed" };
    }
  }

  return {
    async getStatus() {
      try {
        const persisted = await repository.getSnapshot();
        controller.replaceDurablePolicy(persisted);
        return statusFromController(controller, storage, true);
      } catch {
        return statusFromController(controller, storage, false);
      }
    },

    setGlobal(input) {
      if (!input.enabled) {
        controller.disableGlobal();
      }
      return persist(
        (current) => nextSnapshot(current, {
          desiredGlobalEnabled: input.enabled,
          updatedBy: input.updatedBy,
        }),
        input.enabled ? () => controller.enableGlobal() : undefined,
        !input.enabled,
      );
    },

    setGroup(input) {
      const groupId = input.groupId.trim();
      if (groupId.length === 0) {
        return Promise.resolve({ kind: "persistence_failed" });
      }
      return persist((current) => {
        const disabledGroupIds = new Set(current.disabledGroupIds);
        if (input.enabled) {
          disabledGroupIds.delete(groupId);
        } else {
          disabledGroupIds.add(groupId);
        }

        return nextSnapshot(current, {
          disabledGroupIds: [...disabledGroupIds].sort(),
          updatedBy: input.updatedBy,
        });
      });
    },

    setCapabilities(input) {
      return persist((current) => nextSnapshot(current, {
        capabilities: { ...current.capabilities, ...input.updates },
        updatedBy: input.updatedBy,
      }));
    },
  };
}

function nextSnapshot(
  current: RuntimeControllerSnapshot,
  changes: Partial<
    Omit<DurableRuntimeControlSnapshot, "revision" | "updatedAt">
  >,
): Omit<DurableRuntimeControlSnapshot, "revision" | "updatedAt"> {
  return {
    desiredGlobalEnabled:
      changes.desiredGlobalEnabled ?? current.desiredGlobalEnabled,
    disabledGroupIds: [
      ...(changes.disabledGroupIds ?? current.disabledGroupIds),
    ],
    capabilities: { ...(changes.capabilities ?? current.capabilities) },
    ...(changes.updatedBy === undefined ? {} : { updatedBy: changes.updatedBy }),
  };
}

function statusFromController(
  controller: RuntimeController,
  storage: RuntimeControlPersistence["storage"],
  ok: boolean,
): RuntimeControlStatus {
  return {
    ...controller.getSnapshot(),
    persistence: {
      storage,
      ok,
      ...(ok ? {} : { error: "runtime_control_persistence_failed" as const }),
    },
  };
}

function disableNotPersisted(
  controller: RuntimeController,
  storage: RuntimeControlPersistence["storage"],
): RuntimeControlMutationResult {
  return {
    kind: "disable_not_persisted",
    status: statusFromController(controller, storage, false),
  };
}

function createInMemoryRepository(
  initial: RuntimeControllerSnapshot,
  now: () => Date,
): RuntimeControlStateRepository {
  let current: DurableRuntimeControlSnapshot = {
    revision: initial.revision,
    desiredGlobalEnabled: initial.desiredGlobalEnabled,
    disabledGroupIds: [...initial.disabledGroupIds],
    capabilities: { ...initial.capabilities },
    updatedAt: new Date(initial.updatedAt),
    ...(initial.updatedBy === undefined ? {} : { updatedBy: initial.updatedBy }),
  };

  return {
    async getSnapshot() {
      return cloneDurableSnapshot(current);
    },

    async replaceSnapshot(input) {
      const replacement = normalizeRuntimeControlStateReplacement(input);
      if (replacement.expectedRevision !== current.revision) {
        return "conflict";
      }

      current = {
        revision: current.revision + 1,
        desiredGlobalEnabled: replacement.next.desiredGlobalEnabled,
        disabledGroupIds: [...replacement.next.disabledGroupIds],
        capabilities: { ...replacement.next.capabilities },
        updatedAt: new Date(now()),
        ...(replacement.next.updatedBy === undefined
          ? {}
          : { updatedBy: replacement.next.updatedBy }),
      };
      return cloneDurableSnapshot(current);
    },
  };
}

function cloneDurableSnapshot(
  snapshot: DurableRuntimeControlSnapshot,
): DurableRuntimeControlSnapshot {
  return {
    revision: snapshot.revision,
    desiredGlobalEnabled: snapshot.desiredGlobalEnabled,
    disabledGroupIds: [...snapshot.disabledGroupIds],
    capabilities: { ...snapshot.capabilities },
    updatedAt: new Date(snapshot.updatedAt),
    ...(snapshot.updatedBy === undefined ? {} : { updatedBy: snapshot.updatedBy }),
  };
}
