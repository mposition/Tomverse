import "server-only";

import { prisma } from "@/lib/prisma";
import { invalidateSessionSecuritySnapshot } from "@/lib/sessionSecurity";

export type LoginMethodProvider = "google" | "azure-ad" | "email";
export type RemoveLoginMethodOutcome = "removed" | "already-removed" | "blocked";

// Atomic under a per-user advisory lock so two near-simultaneous removal
// requests (a double-click, a slow-network retry, or two browser tabs) can't
// both read "more than one method enabled" before either writes and both
// proceed -- without the lock, a user with exactly two login methods could
// have both removed in the same race window, locking the account out
// entirely. Session revocation happens inside the same transaction as the
// removal so no request can observe "method removed" without the
// invalidation also having happened, and vice versa. Redundant calls for an
// already-removed method return "already-removed" without re-revoking
// sessions or re-triggering the notification email.
export async function removeLoginMethod(
  userId: string,
  method: LoginMethodProvider
): Promise<RemoveLoginMethodOutcome> {
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"login-methods:" + userId}))`;

    const [accounts, user] = await Promise.all([
      tx.account.findMany({
        where: { userId },
        select: { provider: true },
      }),
      tx.user.findUnique({
        where: { id: userId },
        select: { emailLoginEnabled: true, email: true },
      }),
    ]);
    const linkedProviders = new Set(accounts.map((account) => account.provider));
    const removingEnabledMethod =
      method === "email" ? Boolean(user?.emailLoginEnabled) : linkedProviders.has(method);

    if (!removingEnabledMethod) {
      return "already-removed" as const;
    }

    const enabledCount = linkedProviders.size + (user?.emailLoginEnabled && user.email ? 1 : 0);
    if (enabledCount <= 1) {
      return "blocked" as const;
    }

    if (method === "email") {
      await tx.user.update({
        where: { id: userId },
        data: { emailLoginEnabled: false },
      });
    } else {
      await tx.account.deleteMany({
        where: { userId, provider: method },
      });
    }
    await tx.session.deleteMany({ where: { userId } });
    // `sessionsRevokedAt` is the epoch lib/sessionRevocationCore.ts actually
    // checks on every session resolution. `sessionsInvalidatedAt` predates it
    // and is stamped alongside so a rollback to the previous checker still
    // revokes; writing only the older column would make this unlink a no-op.
    await tx.user.update({
      where: { id: userId },
      data: { sessionsInvalidatedAt: new Date(), sessionsRevokedAt: new Date() },
    });

    return "removed" as const;
  });

  // The snapshot cache is keyed per user and holds for SNAPSHOT_TTL_MS; without
  // this the unlinked user keeps a working session until it lapses.
  if (outcome === "removed") invalidateSessionSecuritySnapshot(userId);
  return outcome;
}
