export type InternalComponentStatus = "healthy" | "disabled" | "degraded" | "stopped";
export type InternalAttentionSeverity = "none" | "info" | "warning" | "critical";

export function buildInternalStatusSnapshot<
  ComponentMap extends Record<string, { ok: boolean; enabled: boolean; running?: unknown }>,
  KnowledgeCardSnapshot extends {
    ok: boolean;
    enabled: boolean;
    running: boolean;
    queue?: {
      pending: number;
      processing: number;
      delayed: number;
      deadLetter: number;
    };
  } | undefined = undefined,
>(input: {
  components: ComponentMap;
  generatedAt: Date;
  knowledgeCards?: KnowledgeCardSnapshot;
}) {
  const components = addComponentStatuses(input.components);
  const componentEntries = Object.entries(components);
  const componentStatuses = Object.values(components);
  const healthyComponentCount = componentStatuses.filter(
    (component) => component.status === "healthy",
  ).length;
  const degradedComponents = Object.entries(components)
    .filter(([, component]) => isDegradedSummaryStatus(component.status))
    .map(([name]) => name);
  const disabledComponents = Object.entries(components)
    .filter(([, component]) => !component.enabled)
    .map(([name]) => name);
  const enabledRuntimeComponents = componentEntries.filter(
    ([, component]) => component.enabled && hasRunningStatus(component),
  );
  const stoppedEnabledRuntimeComponents = enabledRuntimeComponents
    .filter(([, component]) => hasRunningStatus(component) && component.running === false)
    .map(([name]) => name);
  const componentStatusCounts = countComponentStatuses(componentStatuses);
  const attentionComponents = buildAttentionComponents(components);
  const attentionComponentCount = attentionComponents.length;
  const requiresOperatorAttention = attentionComponentCount > 0;
  const primaryAttentionComponent = attentionComponents[0] ?? null;
  const attentionSeverity = getAttentionSeverity(primaryAttentionComponent);
  const ok = degradedComponents.length === 0;

  return {
    ok,
    status: ok ? "healthy" : "degraded",
    schemaVersion: 1,
    generatedAt: input.generatedAt.toISOString(),
    componentOrder: Object.keys(components),
    summary: {
      componentCount: componentStatuses.length,
      healthyComponentCount,
      degradedComponentCount: degradedComponents.length,
      degradedComponents,
      enabledComponentCount: componentStatuses.length - disabledComponents.length,
      disabledComponentCount: disabledComponents.length,
      disabledComponents,
      enabledRuntimeComponentCount: enabledRuntimeComponents.length,
      runningEnabledRuntimeComponentCount:
        enabledRuntimeComponents.length - stoppedEnabledRuntimeComponents.length,
      stoppedEnabledRuntimeComponentCount: stoppedEnabledRuntimeComponents.length,
      stoppedEnabledRuntimeComponents,
      componentStatusCounts,
      attentionComponents,
      attentionComponentCount,
      requiresOperatorAttention,
      primaryAttentionComponent,
      attentionSeverity,
    },
    components,
    ...(input.knowledgeCards === undefined
      ? {}
      : { knowledgeCards: cloneSnapshotValue(input.knowledgeCards) }),
  };
}

function addComponentStatuses<
  ComponentMap extends Record<string, { ok: boolean; enabled: boolean; running?: unknown }>,
>(components: ComponentMap) {
  return Object.fromEntries(
    Object.entries(components).map(([name, component]) => [
      name,
      { status: getInternalComponentStatus(component), ...cloneSnapshotValue(component) },
    ]),
  ) as {
    [Name in keyof ComponentMap]: ComponentMap[Name] & { status: InternalComponentStatus };
  };
}

function cloneSnapshotValue<Value>(value: Value): Value {
  if (value instanceof Date) {
    return new Date(value) as Value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneSnapshotValue(item)) as Value;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        cloneSnapshotValue(nestedValue),
      ]),
    ) as Value;
  }

  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function getInternalComponentStatus(component: {
  ok: boolean;
  enabled: boolean;
  running?: unknown;
}): InternalComponentStatus {
  if (!component.ok) {
    return "degraded";
  }
  if (!component.enabled) {
    return "disabled";
  }
  if (hasRunningStatus(component) && !component.running) {
    return "stopped";
  }

  return "healthy";
}

function countComponentStatuses(
  components: Array<{ status: InternalComponentStatus }>,
): Record<InternalComponentStatus, number> {
  return components.reduce<Record<InternalComponentStatus, number>>(
    (counts, component) => ({
      ...counts,
      [component.status]: counts[component.status] + 1,
    }),
    {
      healthy: 0,
      disabled: 0,
      degraded: 0,
      stopped: 0,
    },
  );
}

function buildAttentionComponents(
  components: Record<string, { status: InternalComponentStatus }>,
) {
  const priority: Record<InternalComponentStatus, number> = {
    degraded: 0,
    stopped: 1,
    disabled: 2,
    healthy: 3,
  };

  return Object.entries(components)
    .filter(([, component]) => component.status !== "healthy")
    .map(([name, component], index) => ({ name, status: component.status, index }))
    .sort(
      (left, right) =>
        priority[left.status] - priority[right.status] || left.index - right.index,
    )
    .map(({ name, status }) => ({ name, status }));
}

function getAttentionSeverity(
  primaryAttentionComponent: { status: InternalComponentStatus } | null,
): InternalAttentionSeverity {
  if (!primaryAttentionComponent) {
    return "none";
  }
  if (primaryAttentionComponent.status === "degraded") {
    return "critical";
  }
  if (primaryAttentionComponent.status === "stopped") {
    return "warning";
  }

  return "info";
}

function isDegradedSummaryStatus(status: InternalComponentStatus): boolean {
  return status === "degraded" || status === "stopped";
}

function hasRunningStatus(
  component: { enabled: boolean; running?: unknown },
): component is { enabled: boolean; running: boolean } {
  return typeof component.running === "boolean";
}
