/**
 * The Admin console's own theme, separate from the product theme.
 *
 * The console was dark-only. An operator may now pick Light, and the choice
 * is a console preference like the console language: its own cookie, read by
 * the layout so the first paint is already right, and never written into the
 * product's `tomverse_theme`.
 *
 * Panels keep writing dark classes only (docs/ui-contracts/admin-console-ia.md):
 * Light is one stylesheet, `app/(site)/(application)/admin/admin-theme.css`,
 * that remaps the palette under `data-admin-theme="light"`.
 */
export const ADMIN_THEMES = ["dark", "light"] as const;
export type AdminTheme = (typeof ADMIN_THEMES)[number];

export const ADMIN_THEME_COOKIE = "tomverse_admin_theme";
export const ADMIN_THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Anything but an explicit "light" is the console's original dark. */
export const resolveAdminTheme = (cookie: string | null | undefined): AdminTheme =>
  cookie === "light" ? "light" : "dark";

export const adminThemeCookieValue = (theme: AdminTheme) =>
  `${ADMIN_THEME_COOKIE}=${theme}; Path=/; Max-Age=${ADMIN_THEME_COOKIE_MAX_AGE}; SameSite=Lax`;
