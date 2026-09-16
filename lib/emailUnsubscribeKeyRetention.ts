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
 *
 * Writes happen on the send path and in the drain; the readiness check only
 * reads, so a probe can never make the thing it is checking true.
 */

const RETENTION_MS = UNSUBSCRIBE_KEY_RETENTION_DAYS * 24 * 60 * 60 * 1_000;

/**
 * Stores the canary for the version that is about to sign a real link, once.
 *
 * `createMany` with `skipDuplicates` so the steady state is one no-op insert
 * and a first send racing another first send cannot fail either of them. The
 * canary that wins is minted with the same key as the one that lost.
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

/** Mail with an unsubscribe link, in the window, with no recorded key version. */
const unattributedLastSentAt = async (now: Date) => {
  const unattributed = await prisma.emailDelivery.aggregate({
    where: {
      unsubscribeKeyVersion: null,
      sentAt: { gte: new Date(now.getTime() - RETENTION_MS) },
      templateVersion: { requiresUnsubscribe: true },
    },
    _max: { sentAt: true },
  });
  return unattributed._max.sentAt ?? null;
};

/**
 * Adopts the listed keyring as the guard for mail sent before key versions were
 * recorded. Once, ever, and only when such mail exists.
 *
 * Called by the drain. Nothing can verify which key signed that mail, so the
 * best available guard is "every version listed the first time anyone looked";
 * doing it here rather than in a readiness probe means the check never records
 * and passes on the same call. The singleton row makes a race between two
 * drains a no-op for the loser.
 */
export async function adoptUnsubscribeKeyringForUnattributedMail(
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env
): Promise<"adopted" | "not_needed" | "already_adopted" | "no_keyring"> {
  if (await prisma.emailUnsubscribeKeyAdoption.findFirst({ select: { id: true } })) {
    return "already_adopted";
  }
  if (!(await unattributedLastSentAt(now))) return "not_needed";

  let keyring: UnsubscribeKeyring | null = null;
  try {
    keyring = readUnsubscribeKeyring(env);
  } catch {
    keyring = null;
  }
  if (!keyring) return "no_keyring";

  const listed = keyring;
  const keyVersions = Object.keys(listed.secrets).sort();
  await prisma.$transaction([
    prisma.emailUnsubscribeKeyCanary.createMany({
      data: keyVersions.map((keyVersion) => ({
        keyVersion,
        token: mintUnsubscribeKeyCanary({ ...listed, activeVersion: keyVersion }),
      })),
      skipDuplicates: true,
    }),
    prisma.emailUnsubscribeKeyAdoption.createMany({
      data: [{ keyVersions }],
      skipDuplicates: true,
    }),
  ]);
  return "adopted";
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

  const [canaries, lastSent, unattributed, adoption] = await Promise.all([
    prisma.emailUnsubscribeKeyCanary.findMany({
      select: { keyVersion: true, token: true },
    }),
    prisma.emailDelivery.groupBy({
      by: ["unsubscribeKeyVersion"],
      where: { unsubscribeKeyVersion: { not: null }, sentAt: { not: null } },
      _max: { sentAt: true },
    }),
    unattributedLastSentAt(now),
    prisma.emailUnsubscribeKeyAdoption.findFirst({ select: { keyVersions: true } }),
  ]);

  return unsubscribeKeyRetentionVerdict({
    keyring,
    canaries,
    lastSentAt: Object.fromEntries(
      lastSent
        .filter((row) => row.unsubscribeKeyVersion)
        .map((row) => [row.unsubscribeKeyVersion as string, row._max.sentAt])
    ),
    unattributedLastSentAt: unattributed,
    adoptedKeyVersions: adoption?.keyVersions ?? null,
    now,
  });
}
