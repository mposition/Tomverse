"use client";

import { CHAT_LOCATION_TIMEOUT_MS, createChatLocationSession, type ChatLocation } from "@tomverse/chat-core";
import { ROUTER_LOCATION_VERSION, ROUTER_LOCATION_VERSION_HEADER } from "./chatRouterLocationProtocol";

export const readBrowserChatLocation = (requestPermission = true): Promise<ChatLocation> => {
  if (typeof navigator === "undefined" || !navigator.geolocation ||
    !globalThis.isSecureContext) return Promise.reject(new Error("unavailable"));
  return new Promise((resolve, reject) => {
    // Initial opt-in waits for the user's permission decision. Later reads must
    // still settle when an engine silently dismisses a renewed permission prompt.
    const deadline = requestPermission ? undefined : setTimeout(
      () => reject(new Error("timeout")), CHAT_LOCATION_TIMEOUT_MS + 1_000,
    );
    navigator.geolocation.getCurrentPosition(
      ({ coords, timestamp }) => {
        clearTimeout(deadline);
        resolve({ latitude: coords.latitude, longitude: coords.longitude,
          accuracy: coords.accuracy, timestamp });
      },
      ({ code }) => {
        clearTimeout(deadline);
        reject(new Error(code === 1 ? "denied" : code === 3 ? "timeout" : "unavailable"));
      },
      { maximumAge: 0, timeout: CHAT_LOCATION_TIMEOUT_MS, enableHighAccuracy: false },
    );
  });
};

export const chatLocationSession = createChatLocationSession(readBrowserChatLocation);

export async function requireRouterLocationVersion(response: Response) {
  if (response.headers.get(ROUTER_LOCATION_VERSION_HEADER) === ROUTER_LOCATION_VERSION) return;
  await response.body?.cancel();
  throw new Error("Unsupported router location response");
}

/** An older deployment never ran Chat on this path. Only its initial 404 can
 * safely fall back to an ordinary saved-turn lookup and Chat request. */
export async function readRouterLocationRequest(response: Response) {
  if (response.status === 404 && !response.headers.has(ROUTER_LOCATION_VERSION_HEADER)) {
    await response.body?.cancel();
    return { requiresLocation: null, continuation: undefined };
  }
  await requireRouterLocationVersion(response);
  if (!response.ok || response.headers.get("X-Chat-Response-Mode") !== "router-location") return null;
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !("requiresLocation" in body) ||
      (body.requiresLocation !== null && body.requiresLocation !== true)) {
    throw new Error("Invalid router location decision");
  }
  const continuation = "continuation" in body ? body.continuation : undefined;
  if ((continuation !== undefined && (typeof continuation !== "string" || !continuation.trim())) ||
      (body.requiresLocation && !continuation)) throw new Error("Invalid router location continuation");
  return { requiresLocation: body.requiresLocation, continuation };
}
