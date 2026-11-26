export type AdminRole = "owner" | "billing" | "support" | "ops" | "readonly";
export type AdminPermission =
  | "support:write"
  | "billing:write"
  | "ops:write"
  | "marketing:write"
  | "engineering-agent:write"
  | "sre-agent:write"
  // The trust-safety observer: its activation switch, and the digest section
  // that shows what it counted. Both are the owner's alone
  // (docs/policy/trust-safety-compliance-agent.md §6), which is what the
  // default in `roleHasPermission` gives them -- adding another role to that
  // branch is an amendment of that policy, in its own words.
  | "trust-safety:write"
  | "trust-safety:read"
  | "user:delete";
export type AdminSessionAccessState =
  | "authorized"
  | "reauthentication-required"
  | "not-authorized";

export const ADMIN_ROLE_ORDER: AdminRole[] = [
  "owner",
  "billing",
  "support",
  "ops",
  "readonly",
];

export const normalizeAdminList = (value: string | undefined) =>
  (value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

export const resolveConfiguredAdminRole = ({
  isAdmin,
  email,
  roleEmails,
}: {
  isAdmin: boolean;
  email?: string | null;
  roleEmails: Record<AdminRole, string[]>;
}): AdminRole | null => {
  if (!isAdmin) return null;
  const normalizedEmail = email?.trim().toLowerCase();
  if (!normalizedEmail) return "readonly";
  return (
    ADMIN_ROLE_ORDER.find((role) =>
      roleEmails[role].includes(normalizedEmail)
    ) || "readonly"
  );
};

export const roleHasPermission = (
  role: AdminRole | null,
  permission: AdminPermission
) => {
  if (!role || role === "readonly") return false;
  if (role === "owner") return true;
  if (permission === "support:write") return role === "support";
  if (permission === "billing:write") return role === "billing";
  if (permission === "ops:write") return role === "ops";
  // Marketing approvals, pauses, graduation and switches: owner and ops only
  // (docs/policy/marketing-automation.md §6). Routes still check step-up
  // themselves; this decides the role half.
  if (permission === "marketing:write") return role === "ops";
  // The engineering agent's T2 decisions, acknowledgements, mode and freeze:
  // owner and ops (docs/policy/engineering-agent.md §11). Routes check step-up.
  if (permission === "engineering-agent:write") return role === "ops";
  return false; // Also "sre-agent:write": the owner's alone (docs/policy/sre-ops.md §8).
};

export const configuredAdminAccessExpiry = (
  identity: string | null | undefined,
  raw: string | undefined,
  now = new Date()
) => {
  if (!identity || !raw?.trim()) return { expiresAt: null, active: true };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = parsed[identity.trim().toLowerCase()];
    if (value === undefined) return { expiresAt: null, active: true };
    if (typeof value !== "string") return { expiresAt: null, active: false };
    const expiresAt = new Date(value);
    if (Number.isNaN(expiresAt.getTime())) return { expiresAt: null, active: false };
    return { expiresAt: expiresAt.toISOString(), active: expiresAt > now };
  } catch {
    return { expiresAt: null, active: false };
  }
};

export const resolveAdminSessionAccessState = ({
  userId,
  email,
  authenticatedAt,
  adminUserIds,
  adminEmails,
  accessExpiryJson,
  sessionMaxAgeMs,
  now = new Date(),
}: {
  userId?: string | null;
  email?: string | null;
  authenticatedAt?: string | null;
  adminUserIds: string[];
  adminEmails: string[];
  accessExpiryJson?: string;
  sessionMaxAgeMs: number;
  now?: Date;
}): AdminSessionAccessState => {
  const normalizedUserId = userId?.trim().toLowerCase() || null;
  const normalizedEmail = email?.trim().toLowerCase() || null;
  const authorizedById = Boolean(
    normalizedUserId && adminUserIds.includes(normalizedUserId)
  );
  const authorizedByEmail = Boolean(
    normalizedEmail && adminEmails.includes(normalizedEmail)
  );
  if (!authorizedById && !authorizedByEmail) return "not-authorized";

  const identity = authorizedByEmail ? normalizedEmail : normalizedUserId;
  if (
    !configuredAdminAccessExpiry(identity, accessExpiryJson, now).active
  ) {
    return "not-authorized";
  }

  const authenticatedAtMs = Date.parse(authenticatedAt || "");
  const nowMs = now.getTime();
  if (
    !Number.isFinite(authenticatedAtMs) ||
    authenticatedAtMs > nowMs + 60_000 ||
    nowMs - authenticatedAtMs > sessionMaxAgeMs
  ) {
    return "reauthentication-required";
  }

  return "authorized";
};

// Recent-authentication helpers of the Desktop account-settings session (lib/desktopSettingsSessionCore.ts describes the
// claim). They are here, at the end of a file already in the Prompt Refiner's pinned runtime source closure, because
// lib/auth.ts and lib/adminReauthentication.ts read them and a new imported file would change that sealed list.

const CANONICAL_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Default off: with it unset the settings session carries no claim at all. */
export const desktopRecentAuthEnabled = (env: Record<string, string | undefined> = process.env) =>
  env.TOMVERSE_DESKTOP_RECENT_AUTH_ENABLED === "true";

/** What the session callback may expose: a canonical timestamp, and only while the switch is on. */
export function readDesktopAuthenticatedAt(
  claim: { authenticatedAt?: unknown } | null | undefined,
  enabled: boolean,
): string | undefined {
  if (!enabled || !claim) return undefined;
  const value = claim.authenticatedAt;
  if (typeof value !== "string" || !CANONICAL_ISO.test(value) || !Number.isFinite(Date.parse(value))) return undefined;
  return value;
}

/** The sign-in time an account-sensitive action checks: the web's, else a Desktop device's. */
export const resolveAccountAuthenticatedAt = (
  user: { authenticatedAt?: string | null; desktopAuthenticatedAt?: string | null } | null | undefined,
) => user?.authenticatedAt || user?.desktopAuthenticatedAt || undefined;
