import "server-only";

import { createHmac } from "node:crypto";
import {
  GA4_USER_ID_PRIVACY_NOTICE_PUBLISHED,
  isGa4UserIdSwitchOn,
} from "@/lib/ga4UserIdPolicy";

/**
 * The analytics-only User-ID for an account (§10.2): HMAC-SHA256 of the
 * account id under a key used for nothing else, cut to 128 bits.
 *
 * Derived, not stored. Storing a random value would need a new column on a
 * Prompt Refiner closure file (prisma/schema.prisma); a keyed derivation gives
 * the property the policy asks for -- GA4 receives a value it cannot turn back
 * into the account id -- with nothing to delete beyond the GA4 deletion
 * request itself (§12.2). The account deletion path derives the same value
 * once more, while the account id still exists, and asks GA4 to delete it
 * (lib/ga4UserDeletion.ts).
 *
 * **Do not rotate `GA4_USER_ID_KEY`.** Every id already sent was derived
 * under it; after a rotation a deleted account's old id could no longer be
 * named in a deletion request.
 */
export const GA4_USER_ID_KEY_ENV = "GA4_USER_ID_KEY";

/** The environment these read: `process.env`, or a plain map in a test. */
export type Ga4Env = Readonly<Record<string, string | undefined>>;

const MIN_KEY_LENGTH = 32;

export const ga4UserIdKey = (env: Ga4Env = process.env) => {
  const value = env[GA4_USER_ID_KEY_ENV]?.trim();
  return value && value.length >= MIN_KEY_LENGTH ? value : null;
};

export const analyticsUserIdFor = (userId: string, key: string | null) =>
  key
    ? createHmac("sha256", key)
        .update(`tomverse-ga4-user-id:v1:${userId}`)
        .digest("hex")
        .slice(0, 32)
    : null;

/**
 * Whether any account's User-ID can ever have reached GA4, which is the only
 * case in which an account deletion may name one to Google. Never before the
 * notice is published, never without the key, and never while the feature
 * has not been switched on: pre-provisioned credentials alone send nothing.
 * Once the switch has been on, turning it off must not stop deletions of what
 * was already sent -- `GA4_USER_ID_PREVIOUSLY_ENABLED=true` is what the
 * operator sets when switching it off, and it keeps those requests going.
 */
export const GA4_USER_ID_PREVIOUSLY_ENABLED_ENV = "GA4_USER_ID_PREVIOUSLY_ENABLED";

export const ga4UserIdMayHaveBeenSent = (
  env: Ga4Env = process.env,
  noticePublished: boolean = GA4_USER_ID_PRIVACY_NOTICE_PUBLISHED
) =>
  noticePublished === true &&
  ga4UserIdKey(env) !== null &&
  (isGa4UserIdSwitchOn(env.NEXT_PUBLIC_GA4_USER_ID_ENABLED) ||
    isGa4UserIdSwitchOn(env[GA4_USER_ID_PREVIOUSLY_ENABLED_ENV]));

/** Whether the server will hand an id out: notice, switch and key. Consent is the browser's. */
export const ga4UserIdServerEnabled = (
  env: Ga4Env = process.env,
  noticePublished: boolean = GA4_USER_ID_PRIVACY_NOTICE_PUBLISHED
) =>
  noticePublished === true &&
  isGa4UserIdSwitchOn(env.NEXT_PUBLIC_GA4_USER_ID_ENABLED) &&
  ga4UserIdKey(env) !== null;
