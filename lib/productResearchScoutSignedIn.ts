/**
 * The walker's way in as the test account (docs/policy/product-research-agent.md
 * §14): a short-lived session for the one account an owner named in
 * PRODUCT_RESEARCH_SCOUT_TEST_ACCOUNT_EMAIL, and today's generation permits.
 *
 * The walker holds no password and no long-lived token, so nothing needs
 * rotating and unsetting the variable ends the access on the next run. The
 * account must be an ordinary one: an administrator's identity is refused, so
 * this path can never hand out the Admin console.
 */
import "server-only";

import { encode } from "next-auth/jwt";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import { getAdminSessionAccessState } from "@/lib/adminAuth";
import { effectivePlanForAccess, STORE_ENTITLEMENT_SELECT } from "@/lib/foundingTesterPassCore";
import { prisma } from "@/lib/prisma";
import { reserveScoutGenerations } from "@/lib/productResearchScoutSettings";
import { SESSION_COOKIE_NAMES } from "@/lib/sessionRevocationCore";

export const SCOUT_TEST_ACCOUNT_ENV = "PRODUCT_RESEARCH_SCOUT_TEST_ACCOUNT_EMAIL";
/** Longer than the walker's own 45-minute deadline, and no longer than it has to be. */
export const SCOUT_TEST_SESSION_SECONDS = 60 * 60;

/** The configured test account's address, or null when there is none. */
export const scoutTestAccountEmail = (env: Readonly<Record<string, string | undefined>> = process.env): string | null =>
  env[SCOUT_TEST_ACCOUNT_ENV]?.trim().toLowerCase() || null;

export type ScoutSignedInRefusal = "test_account_missing" | "test_account_inactive" | "test_account_is_admin" | "session_secret_missing";

export type ScoutSignedInAccess =
  | { readonly refused: ScoutSignedInRefusal }
  | {
      readonly session: { readonly name: string; readonly value: string; readonly expiresAt: string };
      readonly permits: readonly string[];
    };

export async function issueScoutSignedInAccess(
  email: string,
  requestedGenerations: readonly string[],
  now: Date = new Date(),
): Promise<ScoutSignedInAccess> {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) return { refused: "session_secret_missing" };
  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      name: true,
      plan: true,
      createdAt: true,
      accountStatus: true,
      subscriptionStatus: true,
      subscriptionCurrentPeriodEnd: true,
      ...STORE_ENTITLEMENT_SELECT,
    },
  });
  if (!user) return { refused: "test_account_missing" };
  if (user.accountStatus !== "active") return { refused: "test_account_inactive" };
  const adminAccess = getAdminSessionAccessState({
    expires: new Date(now.getTime() + SCOUT_TEST_SESSION_SECONDS * 1_000).toISOString(),
    user: { id: user.id, email: user.email, authenticatedAt: now.toISOString() },
  });
  if (adminAccess !== "not-authorized") return { refused: "test_account_is_admin" };

  // The same claims a sign-in writes in lib/auth.ts; the session callback then
  // applies the same revocation and account checks to it on every request.
  const value = await encode({
    secret,
    maxAge: SCOUT_TEST_SESSION_SECONDS,
    token: {
      sub: user.id,
      id: user.id,
      name: user.name,
      email: user.email,
      plan: effectivePlanForAccess(user, now),
      createdAt: user.createdAt?.toISOString(),
      authenticatedAt: now.toISOString(),
      sessionIssuedAt: now.getTime(),
    },
  });
  const permits = await reserveScoutGenerations(requestedGenerations, (tx, granted) =>
    writeSystemAuditLog({
      tx,
      systemActor: "product-research-scout",
      action: "product_research.scout.test_session_issued",
      targetType: "User",
      targetId: user.id,
      summary: "Scout test account session issued",
      metadata: { sessionSeconds: SCOUT_TEST_SESSION_SECONDS, generationPermits: granted.length },
    }),
  );
  const secure = process.env.NEXTAUTH_URL?.startsWith("https://") ?? false;
  return {
    session: {
      name: SESSION_COOKIE_NAMES[secure ? 0 : 1],
      value,
      expiresAt: new Date(now.getTime() + SCOUT_TEST_SESSION_SECONDS * 1_000).toISOString(),
    },
    permits,
  };
}
