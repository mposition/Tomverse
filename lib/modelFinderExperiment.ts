import "server-only";

export type ModelFinderVariant = "control" | "finder";

const DEFAULT_LAUNCH_AT = "2026-07-15T00:00:00.000Z";

const boundedPercentage = (value: string | undefined) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 50;
  return Math.max(0, Math.min(100, Math.trunc(parsed)));
};

const stableBucket = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100;
};

export const getModelFinderVariant = (userId: string): ModelFinderVariant =>
  stableBucket(userId) <
  boundedPercentage(process.env.MODEL_FINDER_EXPERIMENT_PERCENT)
    ? "finder"
    : "control";

export const isModelFinderNewUser = (createdAt: Date | null | undefined) => {
  if (!createdAt) return false;
  const configuredLaunchAt =
    process.env.MODEL_FINDER_LAUNCH_AT || DEFAULT_LAUNCH_AT;
  const launchAt = new Date(configuredLaunchAt);
  if (!Number.isFinite(launchAt.getTime())) {
    return createdAt.getTime() >= new Date(DEFAULT_LAUNCH_AT).getTime();
  }
  return createdAt.getTime() >= launchAt.getTime();
};
