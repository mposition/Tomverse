export const AMUX_RESOURCE_SCOPES = ["project", "team"] as const;
export type AmuxResourceScope = (typeof AMUX_RESOURCE_SCOPES)[number];

export type AmuxResourceRef = {
  scope: AmuxResourceScope;
  key: string;
};

export type AmuxTaskPlanningSnapshot = {
  projectKey: string | null;
  teamKey: string | null;
  effortPoints: number;
  estimatedCostMicrousd: bigint | null;
};

export const amuxResourceRefs = (
  task: Pick<AmuxTaskPlanningSnapshot, "projectKey" | "teamKey">,
): AmuxResourceRef[] =>
  [
    task.projectKey
      ? { scope: "project" as const, key: task.projectKey }
      : null,
    task.teamKey ? { scope: "team" as const, key: task.teamKey } : null,
  ]
    .filter((item): item is AmuxResourceRef => item !== null)
    .sort((left, right) =>
      left.scope === right.scope
        ? left.key.localeCompare(right.key)
        : left.scope.localeCompare(right.scope),
    );

export const amuxCapacityWeight = (
  observations: readonly { capacity: number; used: number }[],
) => {
  if (observations.length === 0) return 0;
  const bottleneck = Math.min(
    ...observations.map(({ capacity, used }) =>
      Math.max(0, Math.min(1, (capacity - used) / capacity)),
    ),
  );
  return Math.max(0, Math.min(20, Math.round(bottleneck * 20)));
};
