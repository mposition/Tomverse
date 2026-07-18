import "server-only";

import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";

export class AdminReauthenticationRequiredError extends Error {
  constructor() {
    super("Sign in again before performing this high-risk administrator action.");
    this.name = "AdminReauthenticationRequiredError";
  }
}

const recentAuthMinutes = () => {
  const parsed = Number(process.env.ADMIN_RECENT_AUTH_MINUTES || 30);
  return Number.isFinite(parsed)
    ? Math.min(240, Math.max(5, Math.trunc(parsed)))
    : 30;
};

const sessionTokenFromRequest = (request: Request | undefined) => {
  if (!request) return null;
  const cookieHeader = request.headers.get("cookie") || "";
  const cookies = new Map(
    cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        const name = separator >= 0 ? part.slice(0, separator) : part;
        const value = separator >= 0 ? part.slice(separator + 1) : "";
        try {
          return [name, decodeURIComponent(value)] as const;
        } catch {
          return [name, value] as const;
        }
      })
  );
  return (
    cookies.get("__Secure-next-auth.session-token") ||
    cookies.get("next-auth.session-token") ||
    null
  );
};

export async function assertRecentAdminAuthentication(
  request: Request | undefined,
  session: Session
) {
  const userId = session.user?.id;
  const sessionToken = sessionTokenFromRequest(request);
  if (!userId || !sessionToken) throw new AdminReauthenticationRequiredError();
  const currentSession = await prisma.session.findUnique({
    where: { sessionToken },
    select: { userId: true, createdAt: true, expires: true },
  });
  const cutoff = Date.now() - recentAuthMinutes() * 60_000;
  if (
    !currentSession ||
    currentSession.userId !== userId ||
    currentSession.expires.getTime() <= Date.now() ||
    currentSession.createdAt.getTime() < cutoff
  ) {
    throw new AdminReauthenticationRequiredError();
  }
}

export const isAdminReauthenticationError = (error: unknown) =>
  error instanceof AdminReauthenticationRequiredError;
