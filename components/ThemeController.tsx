"use client";

import { useEffect } from "react";
import {
  isThemePreference,
  observeThemePreference,
  readStoredThemePreference,
  THEME_PREFERENCE_CHANGED_EVENT,
  type ThemePreference,
} from "@/lib/theme";

export function ThemeController() {
  useEffect(() => {
    let stopObserving = () => {};
    const activate = (theme: ThemePreference) => {
      stopObserving();
      stopObserving = observeThemePreference(theme);
    };

    activate(readStoredThemePreference() ?? "system");

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
