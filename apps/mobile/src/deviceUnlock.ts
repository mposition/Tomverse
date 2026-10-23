import type { MobileAuthBridge } from "./authBridgeContract";

/** A native lock refusal happens before dispatch; waiting never replays an HTTP request. */
export async function deviceAccessGrant(bridge: Pick<MobileAuthBridge, "getAccessToken" | "getDeviceSecurity">, options: Parameters<MobileAuthBridge["getAccessToken"]>[0], signal?: AbortSignal | null, events: EventTarget = window) {
  try { return await bridge.getAccessToken(options); }
  catch (error) {
    if ((error as { code?: string }).code !== "DEVICE_LOCKED") throw error;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { events.removeEventListener("tomverse-device-unlocked", check); signal?.removeEventListener("abort", abort); };
      const abort = () => { cleanup(); reject(new DOMException("Aborted", "AbortError")); };
      const check = () => { void bridge.getDeviceSecurity().then(value => { if (!value.locked) { cleanup(); resolve(); } }).catch(error => { cleanup(); reject(error); }); };
      if (signal?.aborted) { abort(); return; }
      events.addEventListener("tomverse-device-unlocked", check); signal?.addEventListener("abort", abort, { once: true });
      events.dispatchEvent(new Event("tomverse-device-security-changed")); check();
    });
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return bridge.getAccessToken(options);
  }
}
