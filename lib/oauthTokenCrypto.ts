import "server-only";

import { createCipheriv, createDecipheriv, createHash, createPrivateKey, randomBytes, sign, type KeyObject } from "node:crypto";

import type { NextAuthOptions } from "next-auth";
import AppleProvider from "next-auth/providers/apple";

export const OAUTH_TOKEN_ENCRYPTED_PREFIX = "enc:v1:";
const TOKEN_FIELDS = [
    "access_token",
    "refresh_token",
    "id_token",
    "session_state",
] as const;

const ACCOUNT_FIELDS = new Set([
    "id",
    "userId",
    "type",
    "provider",
    "providerAccountId",
    "refresh_token",
    "access_token",
    "expires_at",
    "token_type",
    "scope",
    "id_token",
    "session_state",
]);

const getEncryptionKey = () => {
    const secret = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
    if (!secret || secret.length < 32) {
        throw new Error(
            "A dedicated OAUTH_TOKEN_ENCRYPTION_KEY of at least 32 characters is required."
        );
    }
    return createHash("sha256").update(secret).digest();
};

export const assertOAuthTokenEncryptionConfigured = () => {
    getEncryptionKey();
};

const encryptString = (value: string) => {
    if (value.startsWith(OAUTH_TOKEN_ENCRYPTED_PREFIX)) return value;

    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
    const ciphertext = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return `${OAUTH_TOKEN_ENCRYPTED_PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString("base64url")}`;
};

export const isEncryptedOAuthToken = (value: string | null | undefined) =>
    Boolean(value?.startsWith(OAUTH_TOKEN_ENCRYPTED_PREFIX));

export const decryptOAuthToken = (value: string | null | undefined) => {
    if (!value?.startsWith(OAUTH_TOKEN_ENCRYPTED_PREFIX)) return value || null;

    const payload = Buffer.from(
        value.slice(OAUTH_TOKEN_ENCRYPTED_PREFIX.length),
        "base64url"
    );
    if (payload.length <= 28) throw new Error("Invalid encrypted OAuth token.");

    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const ciphertext = payload.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", getEncryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
    ]).toString("utf8");
};

export const encryptOAuthAccountTokens = <T extends object>(account: T) => {
    const encrypted = Object.fromEntries(
        Object.entries(account).filter(([key]) => ACCOUNT_FIELDS.has(key))
    );
    const writable = encrypted as Record<string, unknown>;
    for (const field of TOKEN_FIELDS) {
        const value = writable[field];
        if (typeof value === "string" && value.length > 0) {
            writable[field] = encryptString(value);
        }
    }
    return encrypted as T;
};

export type AppleCredentials = { clientId: string; teamId: string; keyId: string; privateKey: KeyObject };

export function appleCredentials(environment: Record<string, string | undefined> = process.env): AppleCredentials | null {
  const clientId = environment.APPLE_ID?.trim();
  const teamId = environment.APPLE_TEAM_ID?.trim();
  const keyId = environment.APPLE_KEY_ID?.trim();
  const pem = environment.APPLE_PRIVATE_KEY?.replaceAll("\\n", "\n");
  if (!clientId || !teamId || !keyId || !pem) return null;
  if (!/^[A-Za-z0-9.-]+$/.test(clientId) || !/^[A-Z0-9]{10}$/.test(teamId) || !/^[A-Z0-9]{10}$/.test(keyId)) return null;
  try {
    const privateKey = createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== "ec" || privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") return null;
    return { clientId, teamId, keyId, privateKey };
  } catch { return null; }
}

/** Fresh short-lived client authentication, never a secret embedded in the app. */
export function appleClientSecret(credentials: AppleCredentials, now = Date.now()) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const issuedAt = Math.floor(now / 1000);
  const unsigned = `${encode({ alg: "ES256", kid: credentials.keyId })}.${encode({
    iss: credentials.teamId, sub: credentials.clientId, aud: "https://appleid.apple.com", iat: issuedAt, exp: issuedAt + 3600,
  })}`;
  return `${unsigned}.${sign("sha256", Buffer.from(unsigned), { key: credentials.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

export function appleSignInProvider(environment: Record<string, string | undefined> = process.env) {
  if (environment.TOMVERSE_APPLE_SIGNIN_ENABLED !== "true") return null;
  const credentials = appleCredentials(environment);
  if (!credentials) return null;
  return AppleProvider({
    clientId: credentials.clientId,
    // NextAuth v4 resolves provider.options on each request. A getter avoids a
    // client-secret expiry tied to how long the application process has run.
    get clientSecret() { return appleClientSecret(credentials); },
    checks: ["state", "pkce", "nonce"],
    profile(profile) {
      if (profile.email && profile.email_verified !== true && profile.email_verified !== "true") throw new Error("APPLE_EMAIL_NOT_VERIFIED");
      return { id: profile.sub, name: profile.name ?? null, email: profile.email ?? null, image: null };
    },
  });
}

/** Apple posts its result cross-site. Only transient OAuth cookies use None. */
export function appleCallbackOptions(options: NextAuthOptions): NextAuthOptions {
  const transient = (name: string) => ({ name, options: { httpOnly: true, sameSite: "none" as const, secure: true, path: "/", maxAge: 900 } });
  return { ...options, cookies: {
    ...options.cookies,
    pkceCodeVerifier: transient("__Secure-next-auth.apple.pkce.code_verifier"),
    state: transient("__Secure-next-auth.apple.state"),
    nonce: transient("__Secure-next-auth.apple.nonce"),
    callbackUrl: transient("__Secure-next-auth.apple.callback-url"),
  } };
}

export async function revokeAppleToken(credentials: AppleCredentials, token: string, type: "refresh_token" | "access_token", fetcher: typeof fetch = fetch) {
  const response = await fetcher("https://appleid.apple.com/auth/revoke", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: credentials.clientId, client_secret: appleClientSecret(credentials), token, token_type_hint: type }),
    signal: AbortSignal.timeout(15000), redirect: "error",
  });
  // Apple's revocation is idempotent. Do not discard the encrypted token while
  // a network failure leaves revocation unconfirmed; deletion can be retried.
  if (!response.ok) throw new Error("APPLE_TOKEN_REVOCATION_FAILED");
  await response.body?.cancel();
}
