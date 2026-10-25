"use client";

import { CHAT_LOCATION_TIMEOUT_MS, createChatLocationSession, type ChatLocation } from "@tomverse/chat-core";

export const readBrowserChatLocation = (): Promise<ChatLocation> => {
  if (typeof navigator === "undefined" || !navigator.geolocation ||
    !globalThis.isSecureContext) return Promise.reject(new Error("unavailable"));
  return new Promise((resolve, reject) => {
    // The platform starts its timeout after the user answers the permission
    // prompt. Do not time out the user's decision with an outer wall clock.
    navigator.geolocation.getCurrentPosition(
      ({ coords, timestamp }) => {
        resolve({ latitude: coords.latitude, longitude: coords.longitude,
          accuracy: coords.accuracy, timestamp });
      },
      ({ code }) => {
        reject(new Error(code === 1 ? "denied" : code === 3 ? "timeout" : "unavailable"));
      },
      { maximumAge: 0, timeout: CHAT_LOCATION_TIMEOUT_MS, enableHighAccuracy: false },
    );
  });
};

export const chatLocationSession = createChatLocationSession(readBrowserChatLocation);
