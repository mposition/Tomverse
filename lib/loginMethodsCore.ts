import "server-only";

import { prisma } from "@/lib/prisma";
import {
  enqueueLoginMethodNotice,
  loginMethodNoticeLanguage,
  prepareLoginMethodNotice,
} from "@/lib/loginMethodNotice";
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
  // Before the transaction, so registering a template version is never part of
  // whether a login method may be removed (lib/loginMethodNotice.ts).
  // Read once and used for both, so the version prepared is the version the
  // queued row asks for.
  const language = await loginMethodNoticeLanguage(userId);
  await prepareLoginMethodNotice({ action: "unlinked", language });

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

    // In the same transaction as the removal, so the notice cannot be lost
    // while the change stands. It used to be sent after the request and a
    // failure left an incident: the account holder was signed out of every
    // device and told nothing (section 7.4, C36).
    await enqueueLoginMethodNotice(tx, {
      userId,
      action: "unlinked",
      method,
      language,
    });

    return "removed" as const;
  });

  // The snapshot cache is keyed per user and holds for SNAPSHOT_TTL_MS; without
  // this the unlinked user keeps a working session until it lapses.
  if (outcome === "removed") invalidateSessionSecuritySnapshot(userId);
  return outcome;
}

export type EnableEmailLoginOutcome = "enabled" | "already-enabled";

/**
 * Turns email login on, and queues the notice only if it was off.
 *
 * Here rather than in the route so the decision can be exercised against a
 * database. `update` succeeds on a row that is already `true`, so the route
 * queued "a login method was added" for a replayed verification or two racing
 * requests -- the same false security notice the OAuth callback was fixed for
 * (independent review, 2026-09-18). The count from a conditional write is what
 * decides.
 */
export async function enableEmailLoginMethod(
  userId: string
): Promise<EnableEmailLoginOutcome> {
  // Read once and used for both, so the version prepared is the version the
  // queued row asks for.
  const language = await loginMethodNoticeLanguage(userId);
  await prepareLoginMethodNotice({ action: "linked", language });

  return prisma.$transaction(async (tx) => {
    const changed = await tx.user.updateMany({
      where: { id: userId, emailLoginEnabled: false },
      data: { emailLoginEnabled: true },
    });
    if (changed.count === 0) return "already-enabled" as const;

    // In the same transaction as the change, so the notice cannot be lost
    // while the new login method stands (section 7.4, C36).
    await enqueueLoginMethodNotice(tx, {
      userId,
      action: "linked",
      method: "email",
      language,
    });
    return "enabled" as const;
  });
}
