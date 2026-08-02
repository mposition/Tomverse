export const THEME_PREFERENCES = ["dark", "light", "system"] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export const isThemePreference = (value: unknown): value is ThemePreference =>
  typeof value === "string" &&
  THEME_PREFERENCES.includes(value as ThemePreference);

const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";
export const THEME_STORAGE_KEY = "tomverse_theme_preference";
export const THEME_PREFERENCE_CHANGED_EVENT = "tomverse:theme-preference-changed";

/**
 * UI-001. The cookie is the authority on an explicit theme choice, because it
 * is the only store a server render can see. `localStorage` predates it and
 * still holds the choice for everyone who set one before this shipped, so it
 * is read exactly once, as a migration source, and written back to the cookie.
 *
 * One priority order, stated once, used by the pre-paint bootstrap, the proxy
 * and the client alike:
 *
 *   1. `tomverse_theme` cookie      -- an explicit choice this browser made
 *   2. `tomverse_theme_preference`  -- the same choice, from before the cookie
 *   3. "system"                     -- no choice; CSS `prefers-color-scheme`
 *
 * A signed-in account's stored preference is *not* in this list. It is applied
 * by writing the cookie (see `syncAccountThemePreference`), so it arrives
 * through step 1 on the next document request instead of changing the theme
 * under the user after hydration.
 */
export const THEME_COOKIE_NAME = "tomverse_theme";
/**
 * How the resolved choice reaches the root layout, mirroring
 * DOCUMENT_LANGUAGE_HEADER. Set by the proxy on dynamic routes only: a
 * `force-static` marketing response is prerendered once and cached publicly,
 * so a per-visitor value must never enter its HTML.
 */
export const THEME_HEADER = "x-tomverse-theme";
/** A year. The cookie is a preference, not a session. */
export const THEME_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export const resolveThemePreference = ({
  cookie,
  stored,
}: {
  cookie?: string | null;
  stored?: string | null;
}): ThemePreference => {
  if (isThemePreference(cookie)) return cookie;
  if (isThemePreference(stored)) return stored;
  return "system";
};

/**
 * `SameSite=Lax` rather than `Strict`: the theme has to be right on the first
 * paint of a page reached from an external link, which is exactly the visit
 * `Strict` would strip the cookie from. Not `HttpOnly` -- the pre-paint
 * bootstrap has to read it before any script of ours has run.
 */
export const themeCookieValue = (theme: ThemePreference) =>
  `${THEME_COOKIE_NAME}=${theme}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;

/** Which classes `<html>` carries for a preference. "system" carries neither. */
export const themeDocumentClass = (theme: ThemePreference) =>
  theme === "dark" ? "dark" : theme === "light" ? "light" : "";

export const applyThemePreference = (
  theme: ThemePreference,
  systemPrefersDark =
    typeof window !== "undefined" &&
    window.matchMedia(SYSTEM_DARK_QUERY).matches
) => {
  if (typeof document === "undefined") return;

  const useDarkTheme = theme === "dark" || (theme === "system" && systemPrefersDark);
  const root = document.documentElement;
  // UI-001. Both classes are written, and "system" writes neither: the CSS in
  // app/globals.css distinguishes "explicitly light" from "no choice" by their
  // absence, and collapsing the two would let the OS override a choice the
  // user actually made.
  root.classList.toggle("dark", theme === "dark");
  root.classList.toggle("light", theme === "light");
  root.dataset.theme = theme;
  // Left inline for "system" as well, because the media query in the
  // stylesheet cannot answer for `color-scheme` on an element whose class was
  // just removed by a preference change.
  root.style.colorScheme = useDarkTheme ? "dark" : "light";
};

export const observeThemePreference = (theme: ThemePreference) => {
  if (typeof window === "undefined") return () => {};

  const media = window.matchMedia(SYSTEM_DARK_QUERY);
  const apply = () => applyThemePreference(theme, media.matches);
  apply();

  if (theme !== "system") return () => {};

  media.addEventListener("change", apply);
  return () => media.removeEventListener("change", apply);
};

export const readStoredThemePreference = (): ThemePreference | null => {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : null;
  } catch {
    return null;
  }
};

export const storeAndApplyThemePreference = (theme: ThemePreference) => {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Theme application should continue when storage is unavailable.
    }
    // UI-001. The cookie is what the next document request will be rendered
    // from, so it is written alongside the local copy rather than instead of
    // it: a browser that blocks cookies still gets the pre-paint bootstrap's
    // localStorage path, and one that blocks storage still gets the cookie.
    try {
      document.cookie = themeCookieValue(theme);
    } catch {
      // Same reasoning; neither store is required for the theme to apply now.
    }
  }

  applyThemePreference(theme);

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<ThemePreference>(THEME_PREFERENCE_CHANGED_EVENT, {
        detail: theme,
      })
    );
  }
};
