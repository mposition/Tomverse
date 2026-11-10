"use client";

import { requestFreshChatLocationIntent } from "@tomverse/api-client";
import { CHAT_LOCATION_TIMEOUT_MS, createChatLocationSession, type ChatLocation, type PreparedChatLocationIntent } from "@tomverse/chat-core";

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
      const neededAt = performance.now();
      const cancel = () => controller.abort();
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      try {
        const prepared = await pending;
        if (controller.signal.aborted) return false;
        if (!prepared || start === undefined || end === undefined) return null;
        const decision = prepared.read(currentScope, currentText);
        if (typeof decision !== "boolean") return false;
        record(end - start, outcome === "classified" ? Math.max(0, Math.min(end, neededAt) - start) : undefined);
        return outcome === "not_dispatched" ? null : decision;
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
  };
  return {
    handoff() { handedOff = true; return reader; },
    cancelUnlessHandedOff() { if (!handedOff) controller.abort(); },
  };
}
