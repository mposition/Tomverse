import "server-only";

/**
 * The one-time grant that carries an authorisation from the browser to the app.
 *
 * Contract: .github/audits/2026-08-31-native-mobile-auth-n2-design-approval.md
 * D14.1, with a sixty-second lifetime, PKCE S256 client binding, single use and
 * no plaintext storage (approved decision 14).
 *
 * ## Why this is not `lib/oauthLink.ts`
 *
 * The packet's rev.2 correction, and it is worth repeating here because the two
 * do look alike. `oauthLink` connects a provider to an account that is *already
 * signed in*: its start route calls `getServerSession` and then insists on a
 * recent authentication. There is no session at a first mobile sign-in, so
 * nothing in that flow can be the server half of one. What is reusable is the
 * shape -- PKCE S256, a single-use record, a short expiry -- and that is what
 * this file borrows.
 *
 * ## The binding, and what it is for
 *
 * The browser generates a PKCE verifier, keeps it, and sends only its S256
 * challenge when asking for a grant. The app presents the verifier when it
 * exchanges. So a grant intercepted on its way back to the device is useless
 * without the verifier that never left the instance that started the flow.
 *
 * Neither the grant secret nor the verifier is stored. What the row holds is a
 * digest of each, under the same pepper ring as refresh tokens -- both are
 * one-time bearer secrets with the same rule, and a second ring would be a
 * second rotation schedule for one property.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { MOBILE_LOGIN_GRANT_TTL_SECONDS } from "@/lib/mobileAuthContract";
import { mobileOneTimeSecretDigest } from "@/lib/mobileRefreshToken";
import { prisma } from "@/lib/prisma";

const GRANT_SECRET_BYTES = 32;

/** S256, the only code challenge method this accepts. */
export const pkceChallengeFor = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

/**
 * A code challenge has to look like one before it is stored.
 *
 * Base64url, and the length SHA-256 produces. Without this a caller could store
 * an empty string as its binding and then satisfy it with anything.
 */
export const isPkceChallenge = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);

/** RFC 7636's verifier alphabet and length range. */
export const isPkceVerifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9._~-]{43,128}$/.test(value);

export const issueMobileLoginGrant = async (input: {
  userId: string;
  codeChallenge: string;
  now?: Date;
}): Promise<{ grant: string; expiresIn: number }> => {
  const now = input.now ?? new Date();
  const secret = randomBytes(GRANT_SECRET_BYTES).toString("base64url");

  await prisma.mobileLoginGrant.create({
    data: {
      userId: input.userId,
      secretDigest: mobileOneTimeSecretDigest(secret),
      clientBindingDigest: mobileOneTimeSecretDigest(input.codeChallenge),
      createdAt: now,
      expiresAt: new Date(now.getTime() + MOBILE_LOGIN_GRANT_TTL_SECONDS * 1000),
    },
  });

  return { grant: secret, expiresIn: MOBILE_LOGIN_GRANT_TTL_SECONDS };
};

export type MobileLoginGrantConsumption =
  | { ok: true; userId: string }
  | { ok: false; reason: "unknown" | "expired" | "consumed" | "binding_mismatch" };

/**
 * Spends a grant, once.
 *
 * Looked up by digest rather than by an id the caller names, which is what lets
 * this be a single query: the row is found only by presenting the secret, so
 * there is no "does this id exist" question to answer separately. A pepper
 * rotation between issue and exchange makes the lookup miss and the sign-in
 * retry -- for at most the sixty seconds a grant lives.
 *
 * Consumption is a conditional UPDATE, so two exchanges racing on one grant
 * cannot both win: the loser affects zero rows and is refused.
 */
export const consumeMobileLoginGrant = async (input: {
  grant: string;
  codeVerifier: string;
  now?: Date;
}): Promise<MobileLoginGrantConsumption> => {
  const now = input.now ?? new Date();
  const row = await prisma.mobileLoginGrant.findUnique({
    where: { secretDigest: mobileOneTimeSecretDigest(input.grant) },
    select: {
      id: true,
      userId: true,
      clientBindingDigest: true,
      expiresAt: true,
      consumedAt: true,
    },
  });
  if (!row) return { ok: false, reason: "unknown" };

  // The binding is checked before the state, for the same reason D5 compares
  // the refresh secret before judging one: a caller who has the grant but not
  // the verifier must not be able to learn anything about the grant's state,
  // and must not be able to consume it.
  const expected = Buffer.from(row.clientBindingDigest, "utf8");
  const presented = Buffer.from(
    mobileOneTimeSecretDigest(pkceChallengeFor(input.codeVerifier)),
    "utf8"
  );
  if (
    expected.length !== presented.length ||
    !timingSafeEqual(expected, presented)
  ) {
    return { ok: false, reason: "binding_mismatch" };
  }

  if (row.consumedAt) return { ok: false, reason: "consumed" };
  if (row.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }

  const consumed = await prisma.mobileLoginGrant.updateMany({
    where: { id: row.id, consumedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now },
  });
  if (consumed.count !== 1) return { ok: false, reason: "consumed" };

  return { ok: true, userId: row.userId };
};
