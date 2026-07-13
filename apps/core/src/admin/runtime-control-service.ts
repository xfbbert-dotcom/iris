import type { IrisCapability } from "../config/runtime-config.js";
import {
  normalizeRuntimeControlStateReplacement,
  runtimeCapabilityNames,
  runtimeControlUpdatedByMaxChars,
  type DurableRuntimeControlSnapshot,
  type RuntimeControlStateRepository,
} from "./runtime-control-state-repository.js";
import type {
  RuntimeController,
  RuntimeCapabilityName,
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

export type RuntimeControlInputField = "groupId" | "updatedBy" | "capabilities";

export class RuntimeControlInputError extends Error {
  readonly code = "invalid_runtime_control_input" as const;

  constructor(readonly field: RuntimeControlInputField) {
    super(`invalid runtime control input: ${field}`);
    this.name = "RuntimeControlInputError";
  }
}

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
  let disableIntentGeneration = 0;

  async function persist(
    buildNext: (
      current: RuntimeControllerSnapshot,
    ) => Omit<DurableRuntimeControlSnapshot, "revision" | "updatedAt">,
    afterPersist?: (persisted: DurableRuntimeControlSnapshot) => void,
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

      installDurableSnapshotIfNewer(controller, persisted);
      afterPersist?.(persisted);
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
        installDurableSnapshotIfNewer(controller, persisted);
        return statusFromController(controller, storage, true);
      } catch {
        return statusFromController(controller, storage, false);
      }
    },

    setGlobal(input) {
      if (!input.enabled) {
        ++disableIntentGeneration;
        controller.disableGlobal();
        const updatedBy = normalizeUpdatedBy(input.updatedBy);
        return persist(
          (current) => nextSnapshot(current, {
            desiredGlobalEnabled: false,
            updatedBy,
          }),
          undefined,
          true,
        );
      }

      const updatedBy = normalizeUpdatedBy(input.updatedBy);
      const observedDisableIntentGeneration = disableIntentGeneration;

      return persist(
        (current) => nextSnapshot(current, {
          desiredGlobalEnabled: true,
          updatedBy,
        }),
        (persisted) => {
          const current = controller.getSnapshot();
          if (
            observedDisableIntentGeneration === disableIntentGeneration &&
            current.revision >= persisted.revision &&
            current.desiredGlobalEnabled
          ) {
            controller.enableGlobal();
          }
        },
      );
    },

    setGroup(input) {
      const groupId = normalizeGroupId(input.groupId);
      const updatedBy = normalizeUpdatedBy(input.updatedBy);
      return persist((current) => {
        const disabledGroupIds = new Set(current.disabledGroupIds);
        if (input.enabled) {
          disabledGroupIds.delete(groupId);
        } else {
          disabledGroupIds.add(groupId);
        }

        return nextSnapshot(current, {
          disabledGroupIds: [...disabledGroupIds].sort(),
          updatedBy,
        });
      });
    },

    setCapabilities(input) {
      const updates = normalizeCapabilityUpdates(input.updates);
      const updatedBy = normalizeUpdatedBy(input.updatedBy);
      return persist((current) => nextSnapshot(current, {
        capabilities: { ...current.capabilities, ...updates },
        updatedBy,
      }));
    },
  };
}

function installDurableSnapshotIfNewer(
  controller: RuntimeController,
  snapshot: DurableRuntimeControlSnapshot,
): boolean {
  // Equal revisions are skipped: accepting different data for the revision already
  // installed would violate the repository's immutable-revision invariant.
  if (snapshot.revision <= controller.getSnapshot().revision) {
    return false;
  }

  controller.replaceDurablePolicy(snapshot);
  return true;
}

function normalizeGroupId(value: unknown): string {
  if (typeof value !== "string") {
    throw new RuntimeControlInputError("groupId");
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new RuntimeControlInputError("groupId");
  }
  return normalized;
}

function normalizeUpdatedBy(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new RuntimeControlInputError("updatedBy");
  }

  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > runtimeControlUpdatedByMaxChars
  ) {
    throw new RuntimeControlInputError("updatedBy");
  }
  return normalized;
}

function normalizeCapabilityUpdates(value: unknown): Partial<IrisCapability> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new RuntimeControlInputError("capabilities");
  }

  const normalized: Partial<IrisCapability> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (
      typeof key !== "string" ||
      !runtimeCapabilityNames.includes(key as RuntimeCapabilityName)
    ) {
      throw new RuntimeControlInputError("capabilities");
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "boolean"
    ) {
      throw new RuntimeControlInputError("capabilities");
    }
    normalized[key as RuntimeCapabilityName] = descriptor.value;
  }
  return normalized;
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
