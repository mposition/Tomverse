import "server-only";

import {
  mintUnsubscribeKeyCanary,
  UNSUBSCRIBE_KEY_RETENTION_DAYS,
  unsubscribeKeyRetentionVerdict,
} from "@/lib/emailUnsubscribeKeyRetentionCore";
import { prisma } from "@/lib/prisma";
import { readUnsubscribeKeyring, type UnsubscribeKeyring } from "@/lib/unsubscribeToken";

/**
 * The database side of the unsubscribe key retention check.
 *
 * Contract: docs/policy/email-notifications.md §11.4.
 */

/**
 * Stores the canary for the version that is about to sign a real link, once.
 *
 * `createMany` with `skipDuplicates` so the steady state is one no-op insert
 * and a first send racing another first send cannot fail either of them. The
 * canary that wins is minted with the same key as the one that lost, so which
 * one is kept does not matter.
 */
export async function ensureUnsubscribeKeyCanary(keyring: UnsubscribeKeyring) {
  await prisma.emailUnsubscribeKeyCanary.createMany({
    data: [
      {
        keyVersion: keyring.activeVersion,
        token: mintUnsubscribeKeyCanary(keyring),
      },
    ],
    skipDuplicates: true,
  });
}

export async function getUnsubscribeKeyRetentionReadiness(
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env
) {
  // An unparseable keyring is the keyring check's error to report; here it is
  // treated as absent, which is what it is to every link.
  let keyring: UnsubscribeKeyring | null = null;
  try {
    keyring = readUnsubscribeKeyring(env);
  } catch {
    keyring = null;
  }

  const since = new Date(now.getTime() - UNSUBSCRIBE_KEY_RETENTION_DAYS * 24 * 60 * 60 * 1_000);
  const unattributed = await prisma.emailDelivery.aggregate({
    where: {
      unsubscribeKeyVersion: null,
      sentAt: { gte: since },
      templateVersion: { requiresUnsubscribe: true },
    },
    _max: { sentAt: true },
  });
  const unattributedLastSentAt = unattributed._max.sentAt ?? null;

  // Mail sent before versions were recorded depends on a key nobody wrote down.
  // Every version listed now is adopted as a candidate, once: a version dropped
  // before this ran cannot be detected by anything, but from here on dropping or
  // editing any of them is refused until that mail ages out. Over-holding a
  // version that never signed such mail costs at most the window.
  if (keyring && unattributedLastSentAt) {
    const listed = keyring;
    await prisma.emailUnsubscribeKeyCanary.createMany({
      data: Object.keys(listed.secrets).map((keyVersion) => ({
        keyVersion,
        token: mintUnsubscribeKeyCanary({ ...listed, activeVersion: keyVersion }),
      })),
      skipDuplicates: true,
    });
  }

  const [canaries, lastSent] = await Promise.all([
    prisma.emailUnsubscribeKeyCanary.findMany({
      select: { keyVersion: true, token: true },
    }),
    prisma.emailDelivery.groupBy({
      by: ["unsubscribeKeyVersion"],
      where: { unsubscribeKeyVersion: { not: null }, sentAt: { not: null } },
      _max: { sentAt: true },
    }),
  ]);

  return unsubscribeKeyRetentionVerdict({
    keyring,
    canaries,
    lastSentAt: Object.fromEntries(
      lastSent
        .filter((row) => row.unsubscribeKeyVersion)
        .map((row) => [row.unsubscribeKeyVersion as string, row._max.sentAt])
    ),
    unattributedLastSentAt,
    now,
  });
}
