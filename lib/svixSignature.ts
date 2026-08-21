import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Svix webhook signature verification, which is what Resend signs with.
 *
 * Contract: docs/policy/email-notifications.md §9.6, §13.5.
 * Scheme: https://docs.svix.com/receiving/verifying-payloads/how-manual
 * (confirmed 2026-08-21).
 *
 * Written out rather than pulled in as a dependency because the whole thing is
 * twenty lines of HMAC and the alternative is a package in the request path of
 * an unauthenticated endpoint. Pure and dependency-free so the vectors below
 * can be driven without a server.
 *
 * Three properties, and all three matter:
 *
 *  - **The raw body is signed, not the parsed one.** `JSON.parse` followed by
 *    `JSON.stringify` reorders keys and drops whitespace, so a re-serialised
 *    body verifies against nothing. The caller has to hand over the bytes it
 *    received.
 *  - **The comparison is constant-time.** A byte-by-byte early return leaks how
 *    much of a forged signature was right, which is enough to build one.
 *  - **The timestamp is checked.** Without it a signature captured once stays
 *    valid forever, and a replayed `email.complained` would suppress an address
 *    on demand.
 */

/** Svix's own tolerance, and a sensible one: five minutes either side. */
export const SVIX_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export type SvixHeaders = {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
};

export type SvixVerification =
  | { valid: true; id: string }
  | {
      valid: false;
      reason:
        | "headers_missing"
        | "secret_missing"
        | "timestamp_invalid"
        | "timestamp_out_of_tolerance"
        | "signature_mismatch";
    };

/**
 * Reads the three headers under either prefix.
 *
 * Svix sends `webhook-*` on paid plans and `svix-*` otherwise, and their own
 * libraries accept both. A receiver that only knows one prefix breaks on the
 * day the sender changes plan, which is a spectacular way to lose every bounce
 * notification at once.
 */
export const readSvixHeaders = (headers: Headers): SvixHeaders => ({
  id: headers.get("svix-id") ?? headers.get("webhook-id"),
  timestamp: headers.get("svix-timestamp") ?? headers.get("webhook-timestamp"),
  signature: headers.get("svix-signature") ?? headers.get("webhook-signature"),
});

/**
 * The signing key, decoded from the `whsec_`-prefixed secret.
 *
 * The prefix is a label, not part of the key: signing with it included
 * produces a signature that never matches, which presents as every webhook
 * being forged.
 */
const signingKey = (secret: string) => {
  const base64 = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  return Buffer.from(base64, "base64");
};

export const svixSignatureFor = (input: {
  id: string;
  timestamp: string;
  body: string;
  secret: string;
}) =>
  createHmac("sha256", signingKey(input.secret))
    .update(`${input.id}.${input.timestamp}.${input.body}`)
    .digest("base64");

const constantTimeEquals = (a: string, b: string) => {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // timingSafeEqual throws on a length mismatch, which would itself be a
  // length oracle, so the lengths are compared without branching on content.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
};

export const verifySvixSignature = (input: {
  headers: SvixHeaders;
  body: string;
  secret: string | undefined;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): SvixVerification => {
  const { id, timestamp, signature } = input.headers;
  if (!id || !timestamp || !signature) {
    return { valid: false, reason: "headers_missing" };
  }
  if (!input.secret) return { valid: false, reason: "secret_missing" };

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) {
    return { valid: false, reason: "timestamp_invalid" };
  }

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const tolerance = input.toleranceSeconds ?? SVIX_TIMESTAMP_TOLERANCE_SECONDS;
  if (Math.abs(now - sentAt) > tolerance) {
    return { valid: false, reason: "timestamp_out_of_tolerance" };
  }

  const expected = svixSignatureFor({
    id,
    timestamp,
    body: input.body,
    secret: input.secret,
  });

  // The header carries a space-delimited list so a secret can be rotated with
  // both keys live. Any one matching is enough; all are checked so the loop
  // does not exit early on a match either.
  let matched = false;
  for (const entry of signature.split(" ")) {
    const [version, value] = entry.split(",");
    if (version !== "v1" || !value) continue;
    if (constantTimeEquals(value, expected)) matched = true;
  }

  return matched ? { valid: true, id } : { valid: false, reason: "signature_mismatch" };
};
