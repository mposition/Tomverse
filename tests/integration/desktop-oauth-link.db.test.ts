import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, afterEach, beforeEach, test } from "node:test";
import { prisma } from "@/lib/prisma";
import {
  buildDesktopLinkProviderUrl,
  completeDesktopOAuthLink,
  OAuthLinkError,
  resolveDesktopOAuthLinkCallback,
} from "@/lib/oauthLink";

// Adding Google from Tomverse Desktop (lib/desktopSocialLoginCore.ts): the provider is faked at `fetch`, the account
// writes are real. What must hold is who may spend a code, and that nothing is written when they may not.

process.env.GOOGLE_ID = "google-test-client";
process.env.GOOGLE_SECRET = "google-test-secret";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY = "desktop-oauth-link-token-key-32-chars-minimum";

const callbackUri = "https://tomverse.test/api/user/login-methods/oauth/callback";
const redirectUri = "http://127.0.0.1:49152/desktop-login/callback";
const startRequest = new Request("https://tomverse.test/api/user/login-methods/oauth/desktop/start", { method: "POST" });
const finishRequest = new Request("https://tomverse.test/api/user/login-methods/oauth/desktop/complete", { method: "POST" });
const realFetch = globalThis.fetch;

type ProviderCall = { url: string; body?: URLSearchParams };
let providerCalls: ProviderCall[] = [];
let tokenStatus = 200;
let providerSubject = "";

beforeEach(async () => {
  process.env.EMAIL_SNAPSHOT_KEYS = "v1:test-snapshot-key";
  process.env.EMAIL_SNAPSHOT_KEY_VERSION = "v1";
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "EmailDelivery", "EmailEvent", "TemplateVersion", "EmailTemplate", "EmailPolicyVersion",
      "Session", "Account", "User" RESTART IDENTITY CASCADE
  `);
  providerCalls = [];
  tokenStatus = 200;
  providerSubject = `google-${randomUUID()}`;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    providerCalls.push({ url, body: init?.body instanceof URLSearchParams ? init.body : undefined });
    if (url === "https://oauth2.googleapis.com/token") {
      return tokenStatus === 200
        ? Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600, token_type: "Bearer" })
        : new Response("{}", { status: tokenStatus });
    }
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") return Response.json({ sub: providerSubject });
    throw new Error("Unexpected request " + url);
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });
after(async () => {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "EmailDelivery", "EmailEvent", "TemplateVersion", "EmailTemplate", "EmailPolicyVersion",
      "Session", "Account", "User" RESTART IDENTITY CASCADE
  `);
  await prisma.$disconnect();
});

const createUser = () => prisma.user.create({ data: { email: `${randomUUID()}@example.test`, emailLoginEnabled: true } });
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};
const start = (userId: string, challenge: string) =>
  buildDesktopLinkProviderUrl(startRequest, userId, "google", { redirectUri, codeChallenge: challenge });
const googleAccounts = (userId: string) => prisma.account.count({ where: { userId, provider: "google" } });
const notices = () => prisma.emailDelivery.count();

test("the authorize URL carries the Desktop challenge and the web callback, and the return goes to the signed loopback", () => {
  const { challenge } = pkce();
  const { url, linkState } = start("user-1", challenge);
  const authorize = new URL(url);
  assert.equal(authorize.origin + authorize.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(authorize.searchParams.get("redirect_uri"), callbackUri);
  assert.equal(authorize.searchParams.get("code_challenge"), challenge);
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorize.searchParams.get("state"), linkState);

  const returned = new Request(`${callbackUri}?code=provider-code&state=${encodeURIComponent(linkState)}`);
  const target = new URL(resolveDesktopOAuthLinkCallback(returned)!);
  assert.equal(target.origin + target.pathname, redirectUri);
  assert.equal(target.searchParams.get("code"), "provider-code");
  assert.equal(target.searchParams.get("state"), linkState);

  assert.equal(resolveDesktopOAuthLinkCallback(new Request(`${callbackUri}?code=c&state=dl1.forged.forged`)), null);
  assert.equal(resolveDesktopOAuthLinkCallback(new Request(`${callbackUri}?code=c`)), null);
});

test("the user who started the link and holds the verifier links the account, and the provider got that verifier", async () => {
  const user = await createUser();
  const { verifier, challenge } = pkce();
  const { linkState } = start(user.id, challenge);

  const provider = await completeDesktopOAuthLink(finishRequest, user.id, { linkState, code: "provider-code", codeVerifier: verifier });
  assert.equal(provider, "google");

  const account = await prisma.account.findFirstOrThrow({ where: { userId: user.id, provider: "google" } });
  assert.equal(account.providerAccountId, providerSubject);
  assert.ok(account.access_token?.startsWith("enc:v1:"), "tokens are stored encrypted");
  const exchange = providerCalls.find((call) => call.url === "https://oauth2.googleapis.com/token")!;
  assert.equal(exchange.body?.get("code"), "provider-code");
  assert.equal(exchange.body?.get("code_verifier"), verifier);
  assert.equal(exchange.body?.get("redirect_uri"), callbackUri);
  assert.equal(await notices(), 1, "the person is told a login method was added");
});

test("a state started by one user cannot be completed by another, and nothing reaches the provider", async () => {
  const [owner, other] = [await createUser(), await createUser()];
  const { verifier, challenge } = pkce();
  const { linkState } = start(owner.id, challenge);

  await assert.rejects(
    completeDesktopOAuthLink(finishRequest, other.id, { linkState, code: "code", codeVerifier: verifier }),
    (error) => error instanceof OAuthLinkError && error.code === "INVALID_STATE",
  );
  assert.equal(providerCalls.length, 0);
  assert.equal(await googleAccounts(owner.id) + await googleAccounts(other.id), 0);
  assert.equal(await notices(), 0);
});

test("a verifier other than the one behind the challenge is refused before the provider is called", async () => {
  const user = await createUser();
  const { challenge } = pkce();
  const { linkState } = start(user.id, challenge);
  for (const codeVerifier of [pkce().verifier, challenge, "short"]) {
    await assert.rejects(
      completeDesktopOAuthLink(finishRequest, user.id, { linkState, code: "code", codeVerifier }),
      (error) => error instanceof OAuthLinkError && error.code === "INVALID_STATE",
    );
  }
  assert.equal(providerCalls.length, 0);
  assert.equal(await googleAccounts(user.id), 0);
});

test("a state that this server did not sign is refused", async () => {
  const user = await createUser();
  const { verifier } = pkce();
  await assert.rejects(
    completeDesktopOAuthLink(finishRequest, user.id, { linkState: "dl1.e30.e30", code: "code", codeVerifier: verifier }),
    (error) => error instanceof OAuthLinkError && error.code === "INVALID_STATE",
  );
  assert.equal(providerCalls.length, 0);
});

test("a provider account that already belongs to another Tomverse account is not taken over", async () => {
  const [holder, user] = [await createUser(), await createUser()];
  await prisma.account.create({ data: { userId: holder.id, type: "oauth", provider: "google", providerAccountId: providerSubject } });
  const { verifier, challenge } = pkce();
  const { linkState } = start(user.id, challenge);

  await assert.rejects(
    completeDesktopOAuthLink(finishRequest, user.id, { linkState, code: "code", codeVerifier: verifier }),
    (error) => error instanceof OAuthLinkError && error.code === "ALREADY_LINKED_ELSEWHERE",
  );
  assert.equal(await googleAccounts(user.id), 0);
  assert.equal(await googleAccounts(holder.id), 1);
  assert.equal(await notices(), 0);
});

test("a provider that refuses the code links nothing", async () => {
  const user = await createUser();
  const { verifier, challenge } = pkce();
  const { linkState } = start(user.id, challenge);
  tokenStatus = 400;
  await assert.rejects(
    completeDesktopOAuthLink(finishRequest, user.id, { linkState, code: "spent", codeVerifier: verifier }),
    (error) => error instanceof OAuthLinkError && error.code === "TOKEN_EXCHANGE_FAILED",
  );
  assert.equal(await googleAccounts(user.id), 0);
  assert.equal(await notices(), 0);
});

test("completing the same link twice leaves one account and one notice", async () => {
  const user = await createUser();
  const { verifier, challenge } = pkce();
  const { linkState } = start(user.id, challenge);
  const input = { linkState, code: "provider-code", codeVerifier: verifier };
  await completeDesktopOAuthLink(finishRequest, user.id, input);
  await completeDesktopOAuthLink(finishRequest, user.id, input);
  assert.equal(await googleAccounts(user.id), 1);
  assert.equal(await notices(), 1);
});
