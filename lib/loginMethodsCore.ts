import "server-only";

import { prisma } from "@/lib/prisma";

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
  return prisma.$transaction(async (tx) => {
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
    await tx.user.update({
      where: { id: userId },
      data: { sessionsInvalidatedAt: new Date() },
    });

    return "removed" as const;
  });
}
