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

function hasRunningStatus(
  component: { enabled: boolean; running?: unknown },
): component is { enabled: boolean; running: boolean } {
  return typeof component.running === "boolean";
}
