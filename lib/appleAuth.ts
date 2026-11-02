import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import type { NextAuthOptions } from "next-auth";
import AppleProvider from "next-auth/providers/apple";

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
