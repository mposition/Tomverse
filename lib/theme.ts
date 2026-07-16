export const THEME_PREFERENCES = ["dark", "light", "system"] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export const isThemePreference = (value: unknown): value is ThemePreference =>
  typeof value === "string" &&
  THEME_PREFERENCES.includes(value as ThemePreference);

const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";
const THEME_STORAGE_KEY = "tomverse_theme_preference";
export const THEME_PREFERENCE_CHANGED_EVENT = "tomverse:theme-preference-changed";

export const applyThemePreference = (
  theme: ThemePreference,
  systemPrefersDark =
    typeof window !== "undefined" &&
    window.matchMedia(SYSTEM_DARK_QUERY).matches
) => {
  if (typeof document === "undefined") return;

  const useDarkTheme = theme === "dark" || (theme === "system" && systemPrefersDark);
  const root = document.documentElement;
  root.classList.toggle("dark", useDarkTheme);
  root.dataset.theme = theme;
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
