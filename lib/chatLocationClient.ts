"use client";

import { CHAT_LOCATION_TIMEOUT_MS, createChatLocationSession, type ChatLocation } from "@tomverse/chat-core";

export const readBrowserChatLocation = (): Promise<ChatLocation> => {
  if (typeof navigator === "undefined" || !navigator.geolocation ||
    !globalThis.isSecureContext) return Promise.reject(new Error("unavailable"));
  return new Promise((resolve, reject) => {
    // Browser permission prompts are outside the API timeout on some engines.
    const deadline = setTimeout(() => reject(new Error("timeout")), CHAT_LOCATION_TIMEOUT_MS + 1_000);
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
