import "server-only";

import type { Session } from "next-auth";
import {
  isRecentAdminAuthentication,
  resolveRecentAuthMinutes,
} from "@/lib/adminReauthenticationCore";

export class AdminReauthenticationRequiredError extends Error {
  constructor() {
    super("Sign in again before performing this high-risk administrator action.");
    this.name = "AdminReauthenticationRequiredError";
  }
}

export async function assertRecentAdminAuthentication(
  _request: Request | undefined,
  session: Session
) {
  if (!session.user?.id) throw new AdminReauthenticationRequiredError();
  if (
    !isRecentAdminAuthentication({
      authenticatedAt: session.user.authenticatedAt,
      recentAuthMinutes: resolveRecentAuthMinutes(
        process.env.ADMIN_RECENT_AUTH_MINUTES
      ),
      now: new Date(),
    })
  ) {
    throw new AdminReauthenticationRequiredError();
  }
}

export const isAdminReauthenticationError = (error: unknown) =>
  error instanceof AdminReauthenticationRequiredError;
