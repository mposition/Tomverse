import type { AdminSessionAccessState } from "@/lib/adminAuthCore";

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
 * Which of the two administrator clocks ran out.
 *
 * They are different windows with different environment variables, and the
 * console used to send both to the same URL, which is what made the step-up
 * case unrecoverable:
 *
 * - `admin-session` is console *access*: `ADMIN_SESSION_MAX_HOURS`, 8 hours by
 *   default, decided by `resolveAdminSessionAccessState`. While it is expired
 *   the console is unreachable, so the reauthentication page can tell from the
 *   access state alone.
 * - `recent-auth` is the step-up window a high-risk write requires:
 *   `ADMIN_RECENT_AUTH_MINUTES`, 30 minutes by default, decided by
 *   `isRecentAdminAuthentication`. The console session is still perfectly
 *   valid while this one is expired -- which is why a page that only looked at
 *   the access state sent the operator straight back to the screen that had
 *   just answered 428.
 *
 * Neither number is read here. Both come from the environment at the point of
 * decision so a production override is the value in force.
 */
export type AdminReauthenticationReason = "admin-session" | "recent-auth";

export const ADMIN_REAUTHENTICATION_MODE_PARAM = "mode";

/** The `mode` value that asks for the step-up window, not console access. */
export const ADMIN_RECENT_AUTH_MODE = "recent";

/**
 * Reads the `mode` query parameter.
 *
 * Anything that is not exactly the step-up mode -- absent, repeated, a typo,
 * an array -- means the console-session flow, which is the older and stricter
 * of the two: it shows the card whenever the session is expired and otherwise
 * hands the visitor back to the console.
 */
export const normalizeAdminReauthenticationMode = (
  value: unknown
): AdminReauthenticationReason => {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === ADMIN_RECENT_AUTH_MODE ? "recent-auth" : "admin-session";
};

/**
 * Where a high-risk action sends the operator after a 428.
 *
 * Deliberately a second helper rather than a flag on
 * `adminReauthenticationHref()`: that one is the admin *layout*'s redirect for
 * an expired console session, and mixing the two is how a step-up failure
 * ended up on a page that could only reason about console access.
 */
export const adminRecentAuthenticationHref = (callbackPath: unknown) => {
  const url = new URL("/auth/admin-reauthenticate", PUBLIC_ORIGIN);
  url.searchParams.set("callbackUrl", normalizeAdminCallbackPath(callbackPath));
  url.searchParams.set(
    ADMIN_REAUTHENTICATION_MODE_PARAM,
    ADMIN_RECENT_AUTH_MODE
  );
  return `${url.pathname}${url.search}`;
};

/** The `reason` the sign-in page reads for an expired console session. */
export const ADMIN_SESSION_EXPIRED_REASON = "admin-session-expired";

/** The `reason` for an expired step-up window; the console session survived. */
export const ADMIN_STEP_UP_EXPIRED_REASON = "admin-step-up-expired";

export const adminReauthenticationSignInReason = (
  reason: AdminReauthenticationReason
) =>
  reason === "recent-auth"
    ? ADMIN_STEP_UP_EXPIRED_REASON
    : ADMIN_SESSION_EXPIRED_REASON;

export const adminReauthenticationSignInHref = (
  callbackPath: unknown,
  reason: AdminReauthenticationReason
) => {
  const url = new URL("/auth/signin", PUBLIC_ORIGIN);
  url.searchParams.set("callbackUrl", normalizeAdminCallbackPath(callbackPath));
  url.searchParams.set("reason", adminReauthenticationSignInReason(reason));
  return `${url.pathname}${url.search}`;
};

/** True for either of the two administrator reauthentication notices. */
export const isAdminReauthenticationSignInReason = (value: unknown) =>
  value === ADMIN_SESSION_EXPIRED_REASON ||
  value === ADMIN_STEP_UP_EXPIRED_REASON;

export type AdminReauthenticationView =
  | { kind: "sign-in"; href: string }
  | { kind: "not-found" }
  | { kind: "reauthenticate"; reason: AdminReauthenticationReason; callbackUrl: string }
  | { kind: "callback"; href: string };

/**
 * What `/auth/admin-reauthenticate` should do, decided without a session, a
 * clock or an environment so the whole matrix is unit-testable.
 *
 * `hasRecentAuthentication` is supplied by the caller rather than derived here
 * on purpose: the step-up policy has exactly one implementation
 * (`isRecentAdminAuthentication`, read through
 * `hasRecentAdminAuthentication()` in `lib/adminReauthentication.ts`), and a
 * second copy of it inside a view helper is how the page and the API endpoint
 * would drift into disagreeing about whether the same session is recent.
 *
 * Order matters and is the whole security property:
 *
 * 1. A signed-out visitor goes to sign-in carrying a normalized admin
 *    callback -- normalized *before* it is handed back, so nothing off `/admin`
 *    can ride through.
 * 2. A non-administrator gets 404, and gets it before anything about the two
 *    windows is considered, so the answer cannot vary with the visitor's own
 *    clock and confirm that the console exists.
 * 3. An expired console session gets the card, whatever mode was asked for:
 *    it is the stronger failure and the console is unreachable anyway.
 * 4. Only then does the step-up mode matter -- and it shows the card exactly
 *    when the window is spent, instead of bouncing back to the screen that
 *    raised the 428.
 */
export const resolveAdminReauthenticationView = ({
  signedIn,
  accessState,
  mode,
  hasRecentAuthentication,
  callbackUrl,
}: {
  signedIn: boolean;
  accessState: AdminSessionAccessState;
  mode: AdminReauthenticationReason;
  hasRecentAuthentication: boolean;
  callbackUrl: unknown;
}): AdminReauthenticationView => {
  const callback = normalizeAdminCallbackPath(callbackUrl);
  if (!signedIn) {
    return {
      kind: "sign-in",
      href: `/auth/signin?callbackUrl=${encodeURIComponent(callback)}`,
    };
  }
  if (accessState === "not-authorized") return { kind: "not-found" };
  if (accessState === "reauthentication-required") {
    return { kind: "reauthenticate", reason: "admin-session", callbackUrl: callback };
  }
  if (mode === "recent-auth" && !hasRecentAuthentication) {
    return { kind: "reauthenticate", reason: "recent-auth", callbackUrl: callback };
  }
  return { kind: "callback", href: callback };
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
