"use client";

import { useEffect } from "react";
import {
  isThemePreference,
  observeThemePreference,
  readStoredThemePreference,
  resolveThemePreference,
  THEME_COOKIE_NAME,
  THEME_PREFERENCE_CHANGED_EVENT,
  type ThemePreference,
} from "@/lib/theme";

/**
 * UI-001. The same priority the pre-paint bootstrap and the proxy use: the
 * cookie is the explicit choice, `localStorage` is the pre-cookie copy of it.
 * Reading only the local copy here would let a stale value fight the cookie
 * the server just rendered from, which is a theme that changes after
 * hydration -- the defect this work removes.
 */
const readCookieThemePreference = (): ThemePreference | null => {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(
    new RegExp(`(?:^|;\\s*)${THEME_COOKIE_NAME}=([^;]*)`)
  );
  const value = match?.[1];
  return isThemePreference(value) ? value : null;
};

export function ThemeController() {
  useEffect(() => {
    let stopObserving = () => {};
    const activate = (theme: ThemePreference) => {
      stopObserving();
      stopObserving = observeThemePreference(theme);
    };

    activate(
      resolveThemePreference({
        cookie: readCookieThemePreference(),
        stored: readStoredThemePreference(),
      })
    );

    const handlePreferenceChange = (event: Event) => {
      const theme = (event as CustomEvent<unknown>).detail;
      if (isThemePreference(theme)) activate(theme);
    };
    const handleStorage = (event: StorageEvent) => {
      if (isThemePreference(event.newValue)) activate(event.newValue);
    };

    window.addEventListener(THEME_PREFERENCE_CHANGED_EVENT, handlePreferenceChange);
    window.addEventListener("storage", handleStorage);
    return () => {
      stopObserving();
      window.removeEventListener(THEME_PREFERENCE_CHANGED_EVENT, handlePreferenceChange);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  return null;
}
