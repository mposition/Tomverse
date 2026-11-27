import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  desktopLinkLoopbackTarget,
  desktopLinkProviderConfigured,
  desktopLinkProviders,
  desktopLinkStateOwnedBy,
  desktopLinkVerifierMatches,
  desktopSocialLoginEnabled,
  issueDesktopLinkState,
  readDesktopLinkState,
} from "../lib/desktopSocialLoginCore.ts";

const secret = "desktop-link-test-secret-not-for-real-use-32-chars";
const redirectUri = "http://127.0.0.1:49152/desktop-login/callback";
const verifier = "v".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const now = Date.parse("2026-11-27T01:00:00.000Z");
const issue = (overrides: Partial<Parameters<typeof issueDesktopLinkState>[0]> = {}) =>
  issueDesktopLinkState({ secret, userId: "user-1", provider: "google", redirectUri, codeChallenge: challenge, now, ...overrides });

const switches = {
  TOMVERSE_DESKTOP_SOCIAL_LOGIN_ENABLED: "true",
  TOMVERSE_DESKTOP_AUTH_ENABLED: "true",
  TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_ENABLED: "true",
};
const credentials = {
  GOOGLE_ID: "g", GOOGLE_SECRET: "s", AZURE_AD_CLIENT_ID: "a", AZURE_AD_CLIENT_SECRET: "b", AZURE_AD_TENANT_ID: "tenant",
};

test("connecting a provider from Desktop is off unless its own switch and Desktop sign-in and settings are on", () => {
  assert.equal(desktopSocialLoginEnabled({}), false);
  assert.equal(desktopSocialLoginEnabled(switches), true);
  for (const missing of Object.keys(switches)) {
    assert.equal(desktopSocialLoginEnabled({ ...switches, [missing]: undefined }), false, missing);
  }
  for (const value of ["", "1", "TRUE", "True", " true"]) {
    assert.equal(desktopSocialLoginEnabled({ ...switches, TOMVERSE_DESKTOP_SOCIAL_LOGIN_ENABLED: value }), false, value);
  }
});

test("the capability offers only providers whose credentials this server holds, and nothing while the switch is off", () => {
  assert.deepEqual(desktopLinkProviders({ ...switches, ...credentials }), ["google", "azure-ad"]);
  assert.deepEqual(desktopLinkProviders({ ...switches, ...credentials, AZURE_AD_TENANT_ID: " " }), ["google"]);
  assert.deepEqual(desktopLinkProviders({ ...switches, GOOGLE_ID: "g" }), []);
  assert.deepEqual(desktopLinkProviders({ ...credentials }), []);
  assert.equal(desktopLinkProviderConfigured("azure-ad", { AZURE_AD_CLIENT_ID: "a", AZURE_AD_CLIENT_SECRET: "b" }), false);
});

test("a state reads back with its provider, loopback address and challenge, and never carries the user id", () => {
  const token = issue();
  assert.match(token, /^dl1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const payload = readDesktopLinkState(secret, token, now + 1_000);
  assert.equal(payload?.p, "google");
  assert.equal(payload?.r, redirectUri);
  assert.equal(payload?.c, challenge);
  assert.ok(!Buffer.from(token.split(".")[1], "base64url").toString("utf8").includes("user-1"));
  assert.ok(token.length < 1_024);
});

test("a state is refused when it is tampered with, signed with another secret, expired, or not ours", () => {
  const token = issue();
  const [prefix, body, signature] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), p: "azure-ad" })).toString("base64url");
  for (const bad of [
    `${prefix}.${forged}.${signature}`,
    `${prefix}.${body}.${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`,
    `${prefix}.${body}.${signature}.extra`,
    `${prefix}.${body}`,
    token.replace(/^dl1\./, "dl2."),
    "",
    null,
    undefined,
    "dl1." + "A".repeat(2_000),
  ]) {
    assert.equal(readDesktopLinkState(secret, bad as string, now), null, String(bad).slice(0, 40));
  }
  assert.equal(readDesktopLinkState("another-secret-another-secret-another-secret", token, now), null);
  assert.ok(readDesktopLinkState(secret, token, now + 9 * 60_000));
  assert.equal(readDesktopLinkState(secret, token, now + 10 * 60_000), null);
});

test("a state names a loopback address or nothing: a redirect that is not Desktop's is never signed into one that reads back", () => {
  for (const redirect of [
    "https://evil.example/desktop-login/callback",
    "http://localhost:49152/desktop-login/callback",
    "http://127.0.0.1:80/desktop-login/callback",
    "http://127.0.0.1:49152/other",
    "http://127.0.0.1:49152/desktop-login/callback?x=1",
  ]) {
    assert.equal(readDesktopLinkState(secret, issue({ redirectUri: redirect }), now), null, redirect);
  }
  assert.equal(readDesktopLinkState(secret, issue({ codeChallenge: "short" }), now), null);
});

test("a state belongs to the user who started it and to nobody else", () => {
  const payload = readDesktopLinkState(secret, issue(), now)!;
  assert.equal(desktopLinkStateOwnedBy(secret, payload, "user-1"), true);
  assert.equal(desktopLinkStateOwnedBy(secret, payload, "user-2"), false);
  assert.equal(desktopLinkStateOwnedBy(secret, payload, ""), false);
  // Two states for the same user do not vouch for each other.
  const other = readDesktopLinkState(secret, issue(), now)!;
  assert.equal(desktopLinkStateOwnedBy(secret, { ...payload, n: other.n }, "user-1"), false);
});

test("only the verifier whose S256 challenge the state carries completes the link", () => {
  assert.equal(desktopLinkVerifierMatches(challenge, verifier), true);
  assert.equal(desktopLinkVerifierMatches(challenge, "w".repeat(43)), false);
  assert.equal(desktopLinkVerifierMatches(challenge, challenge), false);
  assert.equal(desktopLinkVerifierMatches(challenge, "short"), false);
  assert.equal(desktopLinkVerifierMatches(challenge, ""), false);
});

test("the provider's return is forwarded to the signed loopback address with the state and one answer", () => {
  const token = issue();
  const payload = readDesktopLinkState(secret, token, now)!;
  const forward = (query: string) => new URL(desktopLinkLoopbackTarget(payload, token, new URLSearchParams(query)));

  const granted = forward("code=abc&state=ignored&scope=openid");
  assert.equal(granted.origin + granted.pathname, redirectUri);
  assert.deepEqual([...granted.searchParams.keys()].sort(), ["code", "state"]);
  assert.equal(granted.searchParams.get("state"), token);
  assert.equal(granted.searchParams.get("code"), "abc");

  const denied = forward("error=access_denied&error_description=No&state=x");
  assert.deepEqual([...denied.searchParams.keys()].sort(), ["error", "state"]);
  assert.equal(denied.searchParams.get("error"), "access_denied");

  // An error wins over a code, and anything odd becomes a plain invalid request.
  assert.equal(forward("code=abc&error=access_denied").searchParams.get("code"), null);
  assert.equal(forward("error=%3Cscript%3E").searchParams.get("error"), "invalid_request");
  assert.equal(forward("").searchParams.get("error"), "invalid_request");
  assert.equal(forward("code=" + "a".repeat(4_097)).searchParams.get("error"), "invalid_request");
});

// The routes cannot be driven without a session and a database; these read what each one must do, and in which order.
const read = (path: string) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("both Desktop link routes refuse while the switch is off, before a session is read, and ask for a recent sign-in", () => {
  for (const route of ["start", "complete"]) {
    const source = read(`app/api/user/login-methods/oauth/desktop/${route}/route.ts`);
    assert.ok(source.indexOf("desktopSocialLoginEnabled()") > 0, route);
    assert.ok(source.indexOf("desktopSocialLoginEnabled()") < source.indexOf("getServerSession(authOptions)"), route);
    assert.ok(source.indexOf("await consumeApiRateLimit(") < source.indexOf("assertRecentAccountAuthentication(session)"), route);
    assert.ok(source.indexOf("assertRecentAccountAuthentication(session)") < source.indexOf("await readLimitedJson("), route);
    assert.match(source, /\.strict\(\)/, route);
    assert.match(source, /"Cache-Control": "no-store"/, route);
  }
  // The start route offers a provider only when the capability would: same switch, same credentials.
  assert.match(read("app/api/user/login-methods/oauth/desktop/start/route.ts"), /desktopLinkProviders\(\)\.includes\(body\.provider\)/);
});

test("the shared callback hands a Desktop state to the loopback before it asks for a web session, and only while the switch is on", () => {
  const source = read("app/api/user/login-methods/oauth/callback/route.ts");
  const desktop = source.indexOf("DESKTOP_LINK_STATE_PREFIX)) return desktopLinkReturn(req)");
  assert.ok(desktop > 0 && desktop < source.indexOf("getServerSession(authOptions)"));
  assert.ok(source.indexOf("desktopSocialLoginEnabled()") < source.indexOf("resolveDesktopOAuthLinkCallback(req)"));
  assert.match(source, /"Referrer-Policy": "no-referrer"/);
  // It never links anything: the link needs the settings session of the second call.
  const handler = source.slice(source.indexOf("function desktopLinkReturn"), source.indexOf("export async function GET"));
  assert.doesNotMatch(handler, /completeOAuthLink|completeDesktopOAuthLink|prisma/);
});

test("the capability names the providers from the same function the start route checks", () => {
  assert.match(read("app/api/products/chat/capabilities/route.ts"), /desktopSocialLink: desktopLinkProviders\(\)/);
});
