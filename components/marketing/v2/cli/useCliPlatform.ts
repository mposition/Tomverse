import { useSyncExternalStore } from "react";
import { detectCliPlatform, type CliPlatform, type CliPlatformInput } from "./cliRelease";

type HighEntropy = { architecture?: string; bitness?: string };
type UserAgentData = NonNullable<CliPlatformInput["uaData"]> & {
  getHighEntropyValues?: (hints: string[]) => Promise<HighEntropy>;
};

// The browser's answer is read once and cached (a snapshot must be the same object until
// it changes); the exact CPU, which only Chromium can report and only asynchronously,
// replaces it when it arrives.
let high: HighEntropy | undefined;
let cached: CliPlatform | null = null;
let started = false;
const listeners = new Set<() => void>();

const userAgentData = () => (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData;

const read = (): CliPlatform => {
  const uaData = userAgentData();
  return detectCliPlatform({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    uaData: uaData ? { platform: uaData.platform, mobile: uaData.mobile, ...high } : null,
  });
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (!started) {
    started = true;
    userAgentData()?.getHighEntropyValues?.(["architecture", "bitness"])
      .then((values) => {
        high = values;
        cached = null;
        listeners.forEach((notify) => notify());
      })
      .catch(() => {});
  }
  return () => { listeners.delete(listener); };
};

const getSnapshot = () => (cached ??= read());
const getServerSnapshot = (): CliPlatform | null => null;

/**
 * The visitor's operating system and CPU, read in the browser. It is null on the server
 * render and during hydration (so the static page never differs from the first client
 * render), then the user agent's answer, then, in Chromium, the more exact one from
 * userAgentData.getHighEntropyValues (the only way to see Arm).
 */
export function useCliPlatform(): CliPlatform | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
