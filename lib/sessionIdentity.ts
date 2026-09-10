type SessionIdentity = {
  user?: {
    id?: unknown;
  } | null;
};

/**
 * NextAuth marks every truthy session payload as authenticated. Revoked JWTs
 * deliberately keep a minimal session object so server-side authorization can
 * fail on the missing user id, therefore presentation code must apply the same
 * identity boundary instead of relying on object presence alone.
 */
export const hasAuthenticatedSessionUser = (
  session: SessionIdentity | null | undefined
): boolean =>
  typeof session?.user?.id === "string" && session.user.id.trim().length > 0;
