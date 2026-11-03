import type { AppUpdates, AppUpdateState } from "./appUpdates";

export interface AppStoreUpdateBridge {
  check(): Promise<{ installedVersion: string; systemVersion: string; lookup: unknown }>;
  start(): Promise<{ accepted: boolean }>;
}
const none = (): AppUpdateState => ({ state: "none", versionCode: 0 });
function versionNumber(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{1,4}(\.\d{1,4}){0,2}$/.test(value)) return null;
  const [major, minor = 0, patch = 0] = value.split(".").map(Number);
  return major * 100_000_000 + minor * 10_000 + patch;
}

export function appStoreUpdateState(info: Awaited<ReturnType<AppStoreUpdateBridge["check"]>>): AppUpdateState {
  const current = versionNumber(info.installedVersion);
  const system = versionNumber(info.systemVersion);
  const response = info.lookup as { results?: unknown } | null;
  if (current === null || system === null || !Array.isArray(response?.results)) return none();
  const listing = response.results.find((item): item is Record<string, unknown> => Boolean(item)
    && typeof item === "object" && item.trackId === 6827148073 && item.bundleId === "app.tomverse.shell");
  const latest = versionNumber(listing?.version);
  const minimum = versionNumber(listing?.minimumOsVersion);
  return latest !== null && minimum !== null && latest > current && system >= minimum
    ? { state: "available", versionCode: latest } : none();
}

export function createAppStoreUpdates(bridge: AppStoreUpdateBridge, now = Date.now): AppUpdates {
  let checkedAt = -Infinity;
  let cached: Promise<AppUpdateState> | null = null;
  return {
    check: () => {
      if (!cached || now() - checkedAt >= 300_000) {
        checkedAt = now();
        cached = bridge.check().then(appStoreUpdateState).catch(none);
      }
      return cached;
    },
    start: async () => {
      const result = await bridge.start();
      if (result.accepted) { checkedAt = now(); cached = Promise.resolve(none()); }
      return result;
    },
    // App Store owns download and installation. The shared banner checks again
    // on foreground/online; iOS never advertises an in-app restart operation.
    complete: async () => {},
    addListener: async () => ({ remove: async () => {} }),
  };
}
