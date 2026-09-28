import { createHash } from "node:crypto";

import { normalizeEmailAddress } from "@/lib/emailSuppressionCore";

/**
 * The one way an email address becomes a digest.
 *
 * Used by the approval cohort, which compares a mailbox without keeping a
 * second copy of it, and by the in-product notice, whose refusal key is scoped
 * to the address. Two callers with different reasons, and they do not have to
 * agree -- but a second implementation would be one more place for the
 * normalisation step to be forgotten.
 *
 * Normalised first, always. Digesting a raw address makes
 * `Someone@example.com` and `someone@example.com` two different values, and
 * only one of them would ever match.
 *
 * Its own module because `node:crypto` cannot go in
 * `lib/emailSuppressionCore.ts`: that file is pure, is imported by decisions
 * that run in no particular environment, and sits inside the sealed Prompt
 * Refiner runtime closure.
 */
export const emailAddressDigest = (emailAddress: string): string =>
  createHash("sha256").update(normalizeEmailAddress(emailAddress)).digest("hex");
