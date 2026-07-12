import "server-only";

import type { Session } from "next-auth";

const parseCsv = (value: string | undefined) =>
  (value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

export const isAdminSession = (session: Session | null | undefined) => {
  const userId = session?.user?.id?.toLowerCase();
  const email = session?.user?.email?.toLowerCase();
  const adminUserIds = parseCsv(process.env.ADMIN_USER_IDS);
  const adminEmails = parseCsv(process.env.ADMIN_EMAILS);

  return (
    (!!userId && adminUserIds.includes(userId)) ||
    (!!email && adminEmails.includes(email))
  );
};

export type AdminRole = "owner" | "billing" | "support" | "ops" | "readonly";
export type AdminPermission =
  | "support:write"
  | "billing:write"
  | "ops:write"
  | "user:delete";

const roleEnvKey: Record<AdminRole, string> = {
  owner: "ADMIN_OWNER_EMAILS",
  billing: "ADMIN_BILLING_EMAILS",
  support: "ADMIN_SUPPORT_EMAILS",
  ops: "ADMIN_OPS_EMAILS",
  readonly: "ADMIN_READONLY_EMAILS",
};

export const getAdminRole = (
  session: Session | null | undefined
): AdminRole | null => {
  if (!isAdminSession(session)) return null;
  const email = session?.user?.email?.toLowerCase();
  if (!email) return "owner";

  for (const role of ["owner", "billing", "support", "ops", "readonly"] as const) {
    if (parseCsv(process.env[roleEnvKey[role]]).includes(email)) {
      return role;
    }
  }

  return "owner";
};

export const hasAdminPermission = (
  session: Session | null | undefined,
  permission: AdminPermission
) => {
  const role = getAdminRole(session);
  if (!role) return false;
  if (role === "owner") return true;
  if (role === "readonly") return false;
  if (permission === "support:write") return role === "support" || role === "billing";
  if (permission === "billing:write") return role === "billing";
  if (permission === "ops:write") return role === "ops";
  if (permission === "user:delete") return false;
  return false;
};
