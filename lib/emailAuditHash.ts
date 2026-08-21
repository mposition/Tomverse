import "server-only";

import { createHmac } from "node:crypto";

/**
 * The hash recorded against a sent message.
 *
 * Contract: docs/policy/email-notifications.md §10.3-6, §10.3-7.
 *
 * Keyed, not a plain digest. A login code body hashed with bare SHA-256 is a
 * million guesses away from the code itself, which would make the audit column
 * the most valuable thing in the table. lib/emailLogin.ts already establishes
 * the pattern with `createHmac("sha256", secret())`.
 *
 * Applied on every lane rather than only where a credential is expected: a rule
 * that depends on classifying the message correctly fails on the day the
 * classification is wrong, and that is exactly the day it would matter.
 *
 * Lives here rather than beside either lane because both write it, and the
 * standard lane importing it from the credential lane put the general thing
 * inside the special case.
 */

const auditHashKey = () => {
  const value =
    process.env.EMAIL_AUDIT_HASH_KEY || process.env.NEXTAUTH_SECRET || "";
  if (!value) throw new Error("EMAIL_AUDIT_HASH_KEY is not configured.");
  return value;
};

/**
 * Which key produced a hash, stored beside it.
 *
 * Rotation adds a version and never retires one: a keyed hash nobody can name
 * the key for cannot be verified, which makes it indistinguishable from no hash
 * at all. §13.2 keeps legal-class records for seven years, so that is the floor
 * for how long a version has to stay readable.
 */
export const EMAIL_AUDIT_HASH_KEY_VERSION =
  process.env.EMAIL_AUDIT_HASH_KEY_VERSION || "v1";

export const renderedBodyHash = (parts: {
  subject: string;
  html: string;
  text: string;
}) =>
  createHmac("sha256", auditHashKey())
    .update(`${parts.subject}\n${parts.html}\n${parts.text}`)
    .digest("hex");
