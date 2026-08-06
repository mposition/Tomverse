const FALLBACK_ADMIN_PATH = "/admin/overview";
const PUBLIC_ORIGIN = "https://tomverse.app";

export const resolveRecentAuthMinutes = (raw: string | undefined) => {
  const parsed = Number(raw || 30);
  return Number.isFinite(parsed)
    ? Math.min(240, Math.max(5, Math.trunc(parsed)))
    : 30;
};

/**
 * Decides whether a step-up (re-authentication) prompt is required.
 *
 * `authenticatedAt` comes from the NextAuth JWT (`callbacks.jwt` stamps it on
 * every real sign-in). The previous implementation looked the value up in the
 * `Session` table, which is never populated under `session.strategy = "jwt"`,
 * so it failed closed for every caller and permanently blocked both
 * dual-control admin actions and user-initiated account deletion.
 */
export const isRecentAdminAuthentication = ({
  authenticatedAt,
  recentAuthMinutes,
  now,
}: {
  authenticatedAt: string | null | undefined;
  recentAuthMinutes: number;
  now: Date;
}) => {
  const authenticatedAtMs = Date.parse(authenticatedAt || "");
  if (!Number.isFinite(authenticatedAtMs)) return false;
  const nowMs = now.getTime();
  // Reject clocks from the future beyond a small skew allowance so a forged or
  // corrupted claim cannot buy an indefinite step-up window.
  if (authenticatedAtMs > nowMs + 60_000) return false;
  return nowMs - authenticatedAtMs <= recentAuthMinutes * 60_000;
};

export const normalizeAdminCallbackPath = (value: unknown) => {
  if (typeof value !== "string" || !value.trim()) {
    return FALLBACK_ADMIN_PATH;
  }

  try {
    const parsed = new URL(value, PUBLIC_ORIGIN);
    if (
      parsed.origin !== PUBLIC_ORIGIN ||
      (parsed.pathname !== "/admin" && !parsed.pathname.startsWith("/admin/"))
    ) {
      return FALLBACK_ADMIN_PATH;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return FALLBACK_ADMIN_PATH;
  }
};

export const adminReauthenticationHref = (callbackPath: unknown) => {
  const url = new URL("/auth/admin-reauthenticate", PUBLIC_ORIGIN);
  url.searchParams.set("callbackUrl", normalizeAdminCallbackPath(callbackPath));
  return `${url.pathname}${url.search}`;
};

/**
 * The `reason` the sign-in page reads to offer an account chooser.
 *
 * Distinct from `admin-session-expired`: that one asks the *same* administrator
 * to authenticate again, this one says the previous session was ended on
 * purpose because the visitor needs a different account.
 */
export const ACCOUNT_SWITCH_REASON = "switch-account";

/**
 * Whether a request path belongs to the admin console's URL space.
 *
 * Used by the 404 page to decide whether to offer account switching, so it has
 * to answer the same way for every visitor: it reads the path only, never the
 * session, and never whether the path resolves to a real route. A signed-in
 * non-administrator, a signed-out visitor and a typo under `/admin/` therefore
 * all get one identical page, which is what keeps the 404 from confirming that
 * anything is behind these URLs.
 */
export const isAdminPathname = (value: unknown) => {
  if (typeof value !== "string" || !value.startsWith("/")) return false;
  try {
    const parsed = new URL(value, PUBLIC_ORIGIN);
    // `//evil.example/admin` also starts with a slash and parses as a
    // protocol-relative URL onto another origin; the origin check is what
    // rejects it.
    if (parsed.origin !== PUBLIC_ORIGIN) return false;
    return parsed.pathname === "/admin" || parsed.pathname.startsWith("/admin/");
  } catch {
    return false;
  }
};

/**
 * Where the "sign out and use another account" button sends the browser once
 * the session cookie is gone.
 *
 * The destination is normalized by `normalizeAdminCallbackPath`, so an external
 * origin, a protocol-relative host or a `javascript:` scheme can never survive
 * into the `callbackUrl` the sign-in page later navigates to -- they all fall
 * back to `/admin/overview`.
 */
export const accountSwitchSignInHref = (callbackPath: unknown) => {
  const url = new URL("/auth/signin", PUBLIC_ORIGIN);
  url.searchParams.set("callbackUrl", normalizeAdminCallbackPath(callbackPath));
  url.searchParams.set("reason", ACCOUNT_SWITCH_REASON);
  return `${url.pathname}${url.search}`;
};
