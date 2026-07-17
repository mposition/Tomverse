export type AdminRole = "owner" | "billing" | "support" | "ops" | "readonly";
export type AdminPermission =
  | "support:write"
  | "billing:write"
  | "ops:write"
  | "user:delete";

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
  return false;
};

export const configuredAdminAccessExpiry = (
  identity: string | null | undefined,
  raw: string | undefined
) => {
  if (!identity || !raw?.trim()) return { expiresAt: null, active: true };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = parsed[identity.trim().toLowerCase()];
    if (value === undefined) return { expiresAt: null, active: true };
    if (typeof value !== "string") return { expiresAt: null, active: false };
    const expiresAt = new Date(value);
    if (Number.isNaN(expiresAt.getTime())) return { expiresAt: null, active: false };
    return { expiresAt: expiresAt.toISOString(), active: expiresAt > new Date() };
  } catch {
    return { expiresAt: null, active: false };
  }
};
