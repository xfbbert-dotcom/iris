export type InternalComponentStatus = "healthy" | "disabled" | "degraded" | "stopped";

export function buildInternalStatusSnapshot<
  ComponentMap extends Record<string, { ok: boolean; enabled: boolean; running?: unknown }>,
>(input: { components: ComponentMap; generatedAt: Date }) {
  const components = addComponentStatuses(input.components);
  const componentStatuses = Object.values(components);
  const healthyComponentCount = componentStatuses.filter((component) => component.ok).length;
  const degradedComponents = Object.entries(components)
    .filter(([, component]) => !component.ok)
    .map(([name]) => name);
  const disabledComponents = Object.entries(components)
    .filter(([, component]) => !component.enabled)
    .map(([name]) => name);
  const enabledRuntimeComponents = Object.entries(components).filter(
    ([, component]) => component.enabled && hasRunningStatus(component),
  );
  const stoppedEnabledRuntimeComponents = enabledRuntimeComponents
    .filter(([, component]) => hasRunningStatus(component) && component.running === false)
    .map(([name]) => name);
  const componentStatusCounts = countComponentStatuses(componentStatuses);
  const attentionComponents = buildAttentionComponents(components);
  const primaryAttentionComponent = attentionComponents[0] ?? null;
  const ok = healthyComponentCount === componentStatuses.length;

  return {
    ok,
    status: ok ? "healthy" : "degraded",
    schemaVersion: 1,
    generatedAt: input.generatedAt.toISOString(),
    componentOrder: Object.keys(components),
    summary: {
      componentCount: componentStatuses.length,
      healthyComponentCount,
      degradedComponentCount: componentStatuses.length - healthyComponentCount,
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
      primaryAttentionComponent,
    },
    components,
  };
}

function addComponentStatuses<
  ComponentMap extends Record<string, { ok: boolean; enabled: boolean; running?: unknown }>,
>(components: ComponentMap) {
  return Object.fromEntries(
    Object.entries(components).map(([name, component]) => [
      name,
      { status: getInternalComponentStatus(component), ...component },
    ]),
  ) as {
    [Name in keyof ComponentMap]: ComponentMap[Name] & { status: InternalComponentStatus };
  };
}

function getInternalComponentStatus(component: {
  ok: boolean;
  enabled: boolean;
  running?: unknown;
}): InternalComponentStatus {
  if (!component.enabled) {
    return "disabled";
  }
  if (!component.ok) {
    return "degraded";
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

function hasRunningStatus(
  component: { enabled: boolean; running?: unknown },
): component is { enabled: boolean; running: boolean } {
  return typeof component.running === "boolean";
}
