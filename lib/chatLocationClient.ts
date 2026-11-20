"use client";

import { requestFreshChatLocationIntent } from "@tomverse/api-client";
import { CHAT_LOCATION_TIMEOUT_MS, createChatLocationSession, type ChatLocation, type PreparedChatLocationIntent } from "@tomverse/chat-core";
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

export type RouterLocationTurn = { scope: "fresh" | "existing"; isCurrent: () => boolean };

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
  if ("locationRateLimited" in body) {
    if (body.locationRateLimited !== true || body.requiresLocation !== null || continuation !== undefined) {
      throw new Error("Invalid router location rate limit");
    }
    return { requiresLocation: false as const, continuation: undefined };
  }
  if ((continuation !== undefined && (typeof continuation !== "string" || !continuation.trim())) ||
      (body.requiresLocation && !continuation)) throw new Error("Invalid router location continuation");
  return { requiresLocation: body.requiresLocation, continuation };
}

type SavedTurnLocationReader = {
  readForSavedTurn: (scope: string | null, text: string, signal: AbortSignal,
    record: (durationMs: number, overlapMs?: number) => void) => Promise<boolean | null>;
};
export type ChatPanelLocationIntent = PreparedChatLocationIntent | SavedTurnLocationReader;
export type FreshChatLocationPreparation = ReturnType<typeof prepareFreshChatLocationIntent>;

/** Travels with the frozen first-send owner until its saved question reaches the panel. */
export function prepareFreshChatLocationIntent(scope: string, accountId: string, text: string) {
  const controller = new AbortController();
  let handedOff = false;
  let start: number | undefined;
  let end: number | undefined;
  let outcome: Awaited<ReturnType<typeof requestFreshChatLocationIntent>>["outcome"] = "unknown";
  const pending = chatLocationSession.prepareIntent(scope, text, async () => {
    if (controller.signal.aborted) return false;
    start = performance.now();
    try {
      const result = await requestFreshChatLocationIntent(text, accountId, controller.signal, fetch);
      outcome = result.outcome;
      return result.requiresLocation;
    } finally {
      end = performance.now();
    }
  });
  const reader: SavedTurnLocationReader = {
    async readForSavedTurn(currentScope, currentText, signal, record) {
      if (controller.signal.aborted || currentScope !== scope) return false;
      const neededAt = performance.now();
      // Once saved, readForTurn owns per-consumer cancellation. Keep the
      // shared semantic decision available to a reconnect on this message.
      const prepared = await pending;
      if (controller.signal.aborted) return false;
      if (!prepared || start === undefined || end === undefined) return null;
      const decision = prepared.read(currentScope, text);
      if (typeof decision !== "boolean") return false;
      // With the owner and generation confirmed, a different saved question
      // can use its own lookup without repeating the original classifier.
      if (currentText !== text) return null;
      if (!signal.aborted) {
        record(end - start, outcome === "classified" ? Math.max(0, Math.min(end, neededAt) - start) : undefined);
      }
      return outcome === "not_dispatched" ? null : decision;
    },
  };
  return {
    handoff() { handedOff = true; return reader; },
    cancelUnlessHandedOff() { if (!handedOff) controller.abort(); },
  };
}
