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

const readStored = async (userId: string) =>
  (
    await prisma.ga4UserId.findUnique({
      where: { userId },
      select: { analyticsUserId: true },
    })
  )?.analyticsUserId ?? null;

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
 * Withdrawal of analytics consent: one GA4 deletion request naming the stored
 * id, then the id is deleted whatever that request returned -- a failure is
 * the request's own incident and never keeps the id. Nothing stored, nothing
 * asked. Not gated on the switch: an id created while it was on must still be
 * withdrawable after it is turned off.
 */
export async function withdrawGa4UserId(userId: string): Promise<{ withdrawn: boolean }> {
  const analyticsUserId = await readStored(userId);
  if (!analyticsUserId) return { withdrawn: false };
  await requestGa4UserIdDeletion(analyticsUserId, "consent_withdrawal").catch(
    () => undefined
  );
  // Only the id that was named: an id created after the read stays until it
  // is withdrawn itself, rather than disappearing without a request.
  await prisma.ga4UserId.deleteMany({ where: { userId, analyticsUserId } });
  return { withdrawn: true };
}
