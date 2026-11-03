import "server-only";

import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { requestGa4UserIdDeletion } from "@/lib/ga4UserDeletion";
import {
  GA4_USER_ID_PRIVACY_NOTICE_PUBLISHED,
  isGa4UserIdSwitchOn,
} from "@/lib/ga4UserIdPolicy";

/**
 * The analytics-only User-ID for an account
 * (docs/policy/marketing-automation.md §10.2): 128 random bits, stored in
 * `Ga4UserId`, with no relation to the account id. Stored rather than derived
 * so it can be cut off from the account one account at a time: withdrawing
 * consent asks GA4 to delete what it holds under the value and then deletes
 * the value, after which nothing in Tomverse names it (operator decision
 * 2026-11-02, replacing an HMAC of the account id that only a key rotation for
 * everyone could have unlinked).
 */

/** 128 bits from the CSPRNG, as lowercase hex (`isAnalyticsUserId`). */
export const newAnalyticsUserId = () => randomBytes(16).toString("hex");

/**
 * Whether the server will create or hand out an id: notice and switch.
 * Consent is the browser's, stated by the request that asks for one.
 */
export const ga4UserIdServerEnabled = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  noticePublished: boolean = GA4_USER_ID_PRIVACY_NOTICE_PUBLISHED
) =>
  noticePublished === true &&
  isGa4UserIdSwitchOn(env.NEXT_PUBLIC_GA4_USER_ID_ENABLED);

/**
 * A locking read. A withdrawal holds the row FOR UPDATE until it has named the
 * id to GA4 and deleted it, so this waits for one in progress and then finds
 * no row: an id being withdrawn is never handed out again, and the consent
 * that follows gets a new one.
 */
const readStored = async (userId: string) => {
  const rows = await prisma.$queryRaw<Array<{ analyticsUserId: string }>>`
    SELECT "analyticsUserId" FROM "Ga4UserId" WHERE "userId" = ${userId} FOR SHARE`;
  return rows[0]?.analyticsUserId ?? null;
};

/**
 * The account's id, created on the first call. Only the route that answers
 * an explicit consent calls this. Two first calls at once get the same id:
 * the insert skips a conflicting row and both read whichever one landed.
 */
export async function ensureGa4UserId(userId: string): Promise<string | null> {
  const existing = await readStored(userId);
  if (existing) return existing;
  await prisma.ga4UserId.createMany({
    data: [{ userId, analyticsUserId: newAnalyticsUserId() }],
    skipDuplicates: true,
  });
  return readStored(userId);
}

/**
 * Bounds the withdrawal transaction: the GA4 request (two calls of at most
 * 5 s each) and, when it is not submitted, the incident alert (5 s).
 */
const WITHDRAWAL_TRANSACTION_TIMEOUT_MS = 30_000;

/**
 * Withdrawal of analytics consent: one GA4 deletion request naming the stored
 * id, then the id is deleted whatever that request returned -- a failure is
 * the request's own incident and never keeps the id. Nothing stored, nothing
 * asked. Not gated on the switch: an id created while it was on must still be
 * withdrawable after it is turned off.
 *
 * The row stays locked from the read to the delete, the GA4 request included,
 * so `ensureGa4UserId` cannot hand the id out in between (it waits, then
 * creates a new one). Should the transaction fail, the row and its link to the
 * account stay as they were, so account deletion can still name it.
 */
export async function withdrawGa4UserId(userId: string): Promise<{ withdrawn: boolean }> {
  return prisma.$transaction(
    async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ analyticsUserId: string }>>`
        SELECT "analyticsUserId" FROM "Ga4UserId" WHERE "userId" = ${userId} FOR UPDATE`;
      if (!row) return { withdrawn: false };
      await requestGa4UserIdDeletion(row.analyticsUserId, "consent_withdrawal").catch(
        () => undefined
      );
      await tx.ga4UserId.delete({ where: { userId } });
      return { withdrawn: true };
    },
    { maxWait: 10_000, timeout: WITHDRAWAL_TRANSACTION_TIMEOUT_MS }
  );
}
