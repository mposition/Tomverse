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
