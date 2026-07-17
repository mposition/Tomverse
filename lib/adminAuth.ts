import "server-only";

import type { Session } from "next-auth";
import {
  ADMIN_ROLE_ORDER,
  normalizeAdminList,
  configuredAdminAccessExpiry,
  resolveConfiguredAdminRole,
  roleHasPermission,
  type AdminPermission,
  type AdminRole,
} from "@/lib/adminAuthCore";
import { prisma } from "@/lib/prisma";

export type { AdminPermission, AdminRole } from "@/lib/adminAuthCore";

const adminSessionMaxAgeMs = () => {
  const configured = Number(process.env.ADMIN_SESSION_MAX_HOURS);
  const hours = Number.isFinite(configured)
    ? Math.min(24, Math.max(1, configured))
    : 8;
  return hours * 60 * 60 * 1_000;
};

export const isAdminSession = (session: Session | null | undefined) => {
  const userId = session?.user?.id?.toLowerCase();
  const email = session?.user?.email?.toLowerCase();
  const adminUserIds = normalizeAdminList(process.env.ADMIN_USER_IDS);
  const adminEmails = normalizeAdminList(process.env.ADMIN_EMAILS);

  const authorizedById = !!userId && adminUserIds.includes(userId);
  const authorizedByEmail = !!email && adminEmails.includes(email);
  if (!authorizedById && !authorizedByEmail) return false;
  const authenticatedAt = Date.parse(session?.user?.authenticatedAt || "");
  if (
    !Number.isFinite(authenticatedAt) ||
    authenticatedAt > Date.now() + 60_000 ||
    Date.now() - authenticatedAt > adminSessionMaxAgeMs()
  ) {
    return false;
  }
  const identity = authorizedByEmail ? email : userId;
  return configuredAdminAccessExpiry(
    identity,
    process.env.ADMIN_ACCESS_EXPIRY_JSON
  ).active;
};

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
  const roleEmails = Object.fromEntries(
    ADMIN_ROLE_ORDER.map((role) => [
      role,
      normalizeAdminList(process.env[roleEnvKey[role]]),
    ])
  ) as Record<AdminRole, string[]>;
  return resolveConfiguredAdminRole({
    isAdmin: isAdminSession(session),
    email: session?.user?.email,
    roleEmails,
  });
};

export const hasAdminPermission = (
  session: Session | null | undefined,
  permission: AdminPermission
) => {
  return roleHasPermission(getAdminRole(session), permission);
};

export type ConfiguredAdminAccess = {
  identity: string;
  identityType: "email" | "userId";
  role: AdminRole | "not-authorized";
  accessEnabled: boolean;
  expiresAt: string | null;
  expired: boolean;
  lastLoginAt?: string | null;
  lastActivityAt?: string | null;
};

export const getConfiguredAdminAccess = (): ConfiguredAdminAccess[] => {
  const adminEmails = normalizeAdminList(process.env.ADMIN_EMAILS);
  const roleEmails = Object.fromEntries(
    ADMIN_ROLE_ORDER.map((role) => [
      role,
      normalizeAdminList(process.env[roleEnvKey[role]]),
    ])
  ) as Record<AdminRole, string[]>;
  const allEmails = Array.from(
    new Set([...adminEmails, ...ADMIN_ROLE_ORDER.flatMap((role) => roleEmails[role])])
  );
  const emailRows: ConfiguredAdminAccess[] = allEmails.map((email) => {
    const expiry = configuredAdminAccessExpiry(email, process.env.ADMIN_ACCESS_EXPIRY_JSON);
    return {
      identity: email,
      identityType: "email",
      accessEnabled: adminEmails.includes(email) && expiry.active,
      role: adminEmails.includes(email)
        ? resolveConfiguredAdminRole({ isAdmin: true, email, roleEmails }) || "readonly"
        : "not-authorized",
      expiresAt: expiry.expiresAt,
      expired: !expiry.active,
    };
  });
  const userIdRows: ConfiguredAdminAccess[] = normalizeAdminList(
    process.env.ADMIN_USER_IDS
  ).map((userId) => {
    const expiry = configuredAdminAccessExpiry(userId, process.env.ADMIN_ACCESS_EXPIRY_JSON);
    return {
      identity: userId,
      identityType: "userId" as const,
      accessEnabled: expiry.active,
      role: "readonly" as const,
      expiresAt: expiry.expiresAt,
      expired: !expiry.active,
    };
  });
  return [...emailRows, ...userIdRows].sort((a, b) =>
    a.identity.localeCompare(b.identity)
  );
};

export const getConfiguredAdminAccessWithActivity = async () => {
  const rows = getConfiguredAdminAccess();
  const emails = rows.filter((row) => row.identityType === "email").map((row) => row.identity);
  const userIds = rows.filter((row) => row.identityType === "userId").map((row) => row.identity);
  const [users, activity] = await Promise.all([
    prisma.user.findMany({
      where: { OR: [{ email: { in: emails } }, { id: { in: userIds } }] },
      select: { id: true, email: true, lastLoginAt: true },
    }),
    prisma.adminAuditLog.findMany({
      where: { OR: [{ actorEmail: { in: emails } }, { actorUserId: { in: userIds } }] },
      orderBy: { createdAt: "desc" },
      take: Math.max(100, rows.length * 20),
      select: { actorUserId: true, actorEmail: true, createdAt: true },
    }),
  ]);
  return rows.map((row) => {
    const user = users.find((candidate) =>
      row.identityType === "email"
        ? candidate.email?.toLowerCase() === row.identity
        : candidate.id.toLowerCase() === row.identity
    );
    const latestActivity = activity.find((entry) =>
      row.identityType === "email"
        ? entry.actorEmail?.toLowerCase() === row.identity
        : entry.actorUserId?.toLowerCase() === row.identity
    );
    return {
      ...row,
      lastLoginAt: user?.lastLoginAt?.toISOString() || null,
      lastActivityAt: latestActivity?.createdAt.toISOString() || null,
    };
  });
};
