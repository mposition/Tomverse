import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import type { NextAuthOptions } from "next-auth";
import type { AppleProfile } from "next-auth/providers/apple";
import { appleCallbackOptions, appleClientSecret, appleCredentials, appleSignInProvider, revokeAppleToken } from "../lib/appleAuth";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const environment = {
  TOMVERSE_APPLE_SIGNIN_ENABLED: "true", APPLE_ID: "app.tomverse.signin", APPLE_TEAM_ID: "ABCDEFGHIJ", APPLE_KEY_ID: "1234567890",
  APPLE_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};

test("Apple provider is absent by default and refuses incomplete or invalid signing credentials", () => {
  assert.equal(appleSignInProvider({}), null);
  assert.equal(appleSignInProvider({ ...environment, TOMVERSE_APPLE_SIGNIN_ENABLED: "false" }), null);
  assert.equal(appleSignInProvider({ ...environment, APPLE_PRIVATE_KEY: undefined }), null);
  assert.equal(appleSignInProvider({ ...environment, APPLE_PRIVATE_KEY: "invalid" }), null);
  assert.equal(appleCredentials({ ...environment, APPLE_TEAM_ID: "other" }), null);
  const wrongKey = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey;
  assert.equal(appleCredentials({ ...environment, APPLE_PRIVATE_KEY: wrongKey.export({ type: "pkcs8", format: "pem" }).toString() }), null);
});

test("Apple client authentication signs the exact service audience with a fresh one-hour expiry", () => {
  const credentials = appleCredentials(environment)!;
  const first = appleClientSecret(credentials, 1793620800000);
  const [header, payload, signature] = first.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "ES256", kid: "1234567890" });
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url").toString()), {
    iss: "ABCDEFGHIJ", sub: "app.tomverse.signin", aud: "https://appleid.apple.com", iat: 1793620800, exp: 1793624400,
  });
  assert.ok(verify("sha256", Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")));
  const later = JSON.parse(Buffer.from(appleClientSecret(credentials, 1793628000000).split(".")[1], "base64url").toString());
  assert.equal(later.iat, 1793628000);
  assert.equal(later.exp - later.iat, 3600);
});

test("Apple keeps state, PKCE and nonce checks and accepts a verified private relay address", async () => {
  const provider = appleSignInProvider(environment)!;
  const options = provider.options!;
  assert.deepEqual(options.checks, ["state", "pkce", "nonce"]);
  assert.ok(options.clientSecret);
  const profile = await options.profile!({ sub: "apple-subject", email: "private@privaterelay.appleid.com", email_verified: "true" } as AppleProfile, {});
  assert.equal(profile.id, "apple-subject");
  assert.equal(profile.email, "private@privaterelay.appleid.com");
  assert.throws(() => options.profile!({ sub: "subject", email: "unverified@example.com", email_verified: false } as unknown as AppleProfile, {}), /APPLE_EMAIL_NOT_VERIFIED/);
  assert.equal(options.allowDangerousEmailAccountLinking, undefined);
});

test("Apple form-post cookies isolate transient proofs without changing the session or CSRF cookies", () => {
  const sessionToken = { name: "existing-session", options: { sameSite: "lax" as const, secure: true, httpOnly: true } };
  const csrfToken = { name: "existing-csrf", options: { sameSite: "lax" as const, secure: true, httpOnly: true } };
  const original = { providers: [], cookies: { sessionToken, csrfToken } } satisfies NextAuthOptions;
  const configured = appleCallbackOptions(original);
  assert.equal(configured.cookies?.sessionToken, sessionToken);
  assert.equal(configured.cookies?.csrfToken, csrfToken);
  assert.equal(original.cookies?.sessionToken.options.sameSite, "lax");
  assert.equal(Object.keys(original.cookies).length, 2);
  for (const field of ["state", "nonce", "pkceCodeVerifier", "callbackUrl"] as const) {
    const cookie: { name: string; options: { httpOnly?: boolean; sameSite?: boolean | "none" | "lax" | "strict"; secure?: boolean; path?: string; maxAge?: number } } = configured.cookies![field]!;
    assert.match(cookie.name, /^__Secure-next-auth\.apple\./);
    assert.deepEqual(cookie.options, { httpOnly: true, sameSite: "none", secure: true, path: "/", maxAge: 900 });
  }
});

test("Apple revocation sends only to the exact provider and fails before discarding an unconfirmed token", async () => {
  let observed: { url: string; input: RequestInit } | undefined;
  const fetcher = (async (url, input) => { observed = { url: String(url), input: input! }; return new Response(null, { status: 200 }); }) as typeof fetch;
  await revokeAppleToken(appleCredentials(environment)!, "private-refresh-token", "refresh_token", fetcher);
  assert.equal(observed!.url, "https://appleid.apple.com/auth/revoke");
  assert.equal(observed!.input.redirect, "error");
  const body = observed!.input.body as URLSearchParams;
  assert.equal(body.get("client_id"), "app.tomverse.signin");
  assert.equal(body.get("token"), "private-refresh-token");
  assert.equal(body.get("token_type_hint"), "refresh_token");
  assert.ok(body.get("client_secret"));
  await assert.rejects(revokeAppleToken(appleCredentials(environment)!, "token", "access_token", (async () => new Response(null, { status: 503 })) as typeof fetch), /APPLE_TOKEN_REVOCATION_FAILED/);
  await assert.rejects(revokeAppleToken(appleCredentials(environment)!, "token", "access_token", (async () => { throw new Error("network"); }) as typeof fetch), /network/);
});
