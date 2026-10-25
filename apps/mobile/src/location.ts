import type { GeolocationPlugin } from "@capacitor/geolocation";
import { CHAT_LOCATION_TIMEOUT_MS, type ChatLocationReader } from "@tomverse/chat-core";

/** Injected so the exact native permission and acquisition path can be tested. */
export const createNativeLocationReader = (
  geolocation: Pick<GeolocationPlugin, "checkPermissions" | "requestPermissions" | "getCurrentPosition">,
  isNative: boolean,
): ChatLocationReader => async (requestPermission) => {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    if (isNative) {
      let permission = await geolocation.checkPermissions();
      if (permission.coarseLocation !== "granted" && requestPermission) {
        permission = await geolocation.requestPermissions({ permissions: ["coarseLocation"] });
      }
      if (permission.coarseLocation !== "granted") throw new Error("denied");
    }
    const acquisition = geolocation.getCurrentPosition({
      maximumAge: 0, timeout: CHAT_LOCATION_TIMEOUT_MS, enableHighAccuracy: false,
    });
    // Native authorization is complete before the acquisition deadline starts.
    // Web permission prompts are owned by the browser's own timeout semantics.
    const { coords, timestamp } = await (isNative ? Promise.race([
      acquisition,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("timeout")), CHAT_LOCATION_TIMEOUT_MS + 1_000);
      }),
    ]) : acquisition);
    return { latitude: coords.latitude, longitude: coords.longitude,
      accuracy: coords.accuracy, timestamp };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "OS-PLUG-GLOC-0003" || code === 1) throw new Error("denied");
    if (code === "OS-PLUG-GLOC-0010" || code === 3) throw new Error("timeout");
    throw error;
  } finally {
    clearTimeout(deadline);
  }
};
