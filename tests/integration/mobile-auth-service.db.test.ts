import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";

/**
 * The mobile session lifecycle against a real database.
 *
 * .github/audits/2026-08-31-native-mobile-auth-n2-design-approval.md D5, D7,
 * D8, D11 and section 4 option A, approved 2026-08-31.
 *
 * What only a database can settle, and what this file is therefore for:
 *
 *   - the conditional UPDATE really is atomic, so two requests racing on one
 *     refresh token produce one successor and one refusal rather than two
 *     usable tokens;
 *   - a replay revokes the family **and the revocation commits**, even though
 *     the caller is answered with a refusal (D8's commit contract);
 *   - a wrong secret on a consumed record leaves the family standing, so a
 *     leaked record id is not an unauthenticated way to end a session;
 *   - releasing one device reaches that device's families and nothing else.
 */

const ed25519 = () =>
  generateKeyPairSync("ed25519")
    .privateKey.export({ format: "der", type: "pkcs8" })
    .toString("base64");

before(() => {
  // Set on the process rather than injected: the service reads the ambient
  // environment, which is what production does, and a test that injected its
  // own would not exercise that path.
  process.env.MOBILE_AUTH_SIGNING_KEYS = `sign-1:${ed25519()}`;
  process.env.MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID = "sign-1";
  process.env.MOBILE_AUTH_REFRESH_PEPPERS = `pep-1:${randomBytes(32).toString("base64url")}`;
  process.env.MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID = "pep-1";
  process.env.MOBILE_AUTH_TOKEN_ISSUER = "https://tomverse.test";
  process.env.MOBILE_AUTH_TOKEN_AUDIENCE = "tomverse-mobile-api";
});

const service = () => import("@/lib/mobileAuthService");
const authorization = () => import("@/lib/mobileSessionAuthorization");
const accessToken = () => import("@/lib/mobileAccessToken");

const reset = async () => {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "MobileAuthEvent",
      "MobileRefreshRotation",
      "MobileTokenFamily",
      "MobileLoginGrant",
      "MobileDevice"
    RESTART IDENTITY CASCADE
  `);
  // The admission limit is per client and lives in ChatUsageBucket. Without
  // this, the test that deliberately exhausts a bucket would leave every later
  // test throttled -- which is how a 429 gets mistaken for the behaviour under
  // test.
  await prisma.chatUsageBucket.deleteMany({
    where: { OR: [
      { period: { startsWith: "api-mobile-" } }, { period: { startsWith: "api-desktop-" } },
      { period: { startsWith: "api-email-otp-" } }, { period: "email-otp-challenge-day" },
    ] },
  });
  const { resetMobileSessionSnapshotsForTesting } = await authorization();
  resetMobileSessionSnapshotsForTesting();
};

const request = () =>
  new Request("https://tomverse.test/api/auth/mobile/refresh", { method: "POST" });

const createUser = () =>
  prisma.user.create({ data: { email: `mobile-service-${randomUUID()}@example.test` } });

const issue = async (userId: string) => {
  const { issueMobileSession } = await service();
  const result = await issueMobileSession({
    request: request(),
    userId,
    deviceLabel: "Phone",
    platform: "ios",
    appVersion: "1.0.0",
  });
  return result.tokens;
};

test("Desktop settings credentials only authorize the same active Desktop session", async (t) => {
  const desktopAuth = process.env.TOMVERSE_DESKTOP_AUTH_ENABLED;
  const settingsEnabled = process.env.TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_ENABLED;
  const previousSecret = process.env.NEXTAUTH_SECRET;
  process.env.TOMVERSE_DESKTOP_AUTH_ENABLED = "true";
  process.env.NEXTAUTH_SECRET = "desktop-settings-local-fixture-secret";
  t.after(() => {
    for (const [name, value] of Object.entries({
      TOMVERSE_DESKTOP_AUTH_ENABLED: desktopAuth,
      TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_ENABLED: settingsEnabled,
      NEXTAUTH_SECRET: previousSecret,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const { POST } = await import("@/app/api/auth/desktop/settings-session/route");
  const requestSettings = (accessToken?: string) => POST(new Request("https://tomverse.test/api/auth/desktop/settings-session", {
    method: "POST", headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
  }));
  delete process.env.TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_ENABLED;
  assert.equal((await requestSettings()).status, 503);
  process.env.TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_ENABLED = "true";
  assert.equal((await requestSettings()).status, 401);
  const user = await createUser();
  const mobile = await issue(user.id);
  assert.equal((await requestSettings(mobile.accessToken)).status, 401);
  const { issueMobileSession, logoutMobileSession } = await service();
  const desktop = await issueMobileSession({ request: request(), userId: user.id, platform: "desktop", deviceLabel: "Desktop" });
  const accepted = await requestSettings(desktop.tokens.accessToken);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get("Cache-Control"), "no-store");
  const { token, expiresAt } = await accepted.json();
  const { decode } = await import("next-auth/jwt");
  const decoded = await decode({ token, secret: process.env.NEXTAUTH_SECRET });
  assert.equal(decoded?.id, user.id);
  assert.equal(decoded?.authenticatedAt, undefined);
  assert.equal(decoded?.absoluteExpiresAt, expiresAt);
  assert.ok(decoded?.desktopSettings);
  assert.ok(expiresAt > Date.now() && expiresAt <= Date.now() + 300_000);
  const { authOptions } = await import("@/lib/auth");
  const session = authOptions.callbacks?.session;
  assert.ok(session);
  const current = (claims = decoded) => session({
    session: { user: { name: user.name, email: user.email, id: user.id }, expires: new Date(expiresAt).toISOString() },
    token: claims, user: { id: user.id, email: user.email!, emailVerified: null },
    trigger: "update", newSession: undefined,
  });
  const currentId = async (claims = decoded) => {
    const { user: sessionUser } = await current(claims);
    return sessionUser && "id" in sessionUser ? sessionUser.id : undefined;
  };
  assert.equal(await currentId(), user.id);
  assert.equal(await currentId({ ...decoded, absoluteExpiresAt: Date.now() - 1 }), undefined);
  process.env.TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_ENABLED = "false";
  assert.equal(await currentId(), undefined);
  process.env.TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_ENABLED = "true";
  await logoutMobileSession({ request: request(), refreshToken: desktop.tokens.refreshToken, client: "desktop" });
  assert.equal((await requestSettings(desktop.tokens.accessToken)).status, 401);
  assert.equal(await currentId(), undefined);
  const second = await issueMobileSession({ request: request(), userId: user.id, platform: "desktop", deviceLabel: "Desktop" });
  const secondResponse = await requestSettings(second.tokens.accessToken);
  const secondClaims = await decode({ token: (await secondResponse.json()).token, secret: process.env.NEXTAUTH_SECRET });
  assert.ok(secondClaims?.desktopSettings);
  assert.equal(await currentId(secondClaims), user.id);
  await prisma.user.update({ where: { id: user.id }, data: { sessionsRevokedAt: new Date() } });
  const { invalidateMobileSessionSnapshots } = await authorization();
  const { invalidateSessionSecuritySnapshot } = await import("@/lib/sessionSecurity");
  invalidateMobileSessionSnapshots(user.id);
  invalidateSessionSecuritySnapshot(user.id);
  assert.equal((await requestSettings(second.tokens.accessToken)).status, 401);
  assert.equal(await currentId(secondClaims), undefined);
  const limitedUser = await createUser();
  const limited = await issueMobileSession({ request: request(), userId: limitedUser.id, platform: "desktop", deviceLabel: "Desktop" });
  for (let request = 0; request < 15; request += 1) {
    assert.equal((await requestSettings(limited.tokens.accessToken)).status, 200);
  }
  assert.equal((await requestSettings(limited.tokens.accessToken)).status, 429);
});

test("Desktop settings sessions carry the family sign-in time only when the recent sign-in switch is on", async (t) => {
  const keep = {
    TOMVERSE_DESKTOP_AUTH_ENABLED: process.env.TOMVERSE_DESKTOP_AUTH_ENABLED,
    TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_ENABLED: process.env.TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_ENABLED,
    TOMVERSE_DESKTOP_RECENT_AUTH_ENABLED: process.env.TOMVERSE_DESKTOP_RECENT_AUTH_ENABLED,
    NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
  };
  process.env.TOMVERSE_DESKTOP_AUTH_ENABLED = "true";
  process.env.TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_ENABLED = "true";
  process.env.NEXTAUTH_SECRET = "desktop-settings-local-fixture-secret";
  t.after(() => {
    for (const [name, value] of Object.entries(keep)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const { POST } = await import("@/app/api/auth/desktop/settings-session/route");
  const { decode } = await import("next-auth/jwt");
  const { issueMobileSession, rotateMobileSession, logoutMobileSession } = await service();
  const settingsClaims = async (accessToken: string) => {
    const response = await POST(new Request("https://tomverse.test/api/auth/desktop/settings-session", {
      method: "POST", headers: { Authorization: `Bearer ${accessToken}` },
    }));
    if (response.status !== 200) return { status: response.status, claims: null };
    const { token } = await response.json();
    return { status: 200, claims: await decode({ token, secret: process.env.NEXTAUTH_SECRET! }) };
  };

  const user = await createUser();
  const { tokens } = await issueMobileSession({ request: request(), userId: user.id, platform: "desktop", deviceLabel: "Desktop" });
  // Back-date the sign-in in the row, not in the tokens: a token minted three hours ago would already be expired.
  await prisma.mobileTokenFamily.updateMany({ where: { userId: user.id }, data: { createdAt: new Date(Date.now() - 3 * 60 * 60_000) } });
  const family = await prisma.mobileTokenFamily.findFirstOrThrow({ where: { userId: user.id } });

  delete process.env.TOMVERSE_DESKTOP_RECENT_AUTH_ENABLED;
  const off = await settingsClaims(tokens.accessToken);
  assert.equal(off.status, 200);
  assert.equal(off.claims?.desktopSettings?.authenticatedAt, undefined);
  assert.equal(off.claims?.authenticatedAt, undefined);

  process.env.TOMVERSE_DESKTOP_RECENT_AUTH_ENABLED = "true";
  const on = await settingsClaims(tokens.accessToken);
  assert.equal(on.claims?.desktopSettings?.authenticatedAt, family.createdAt.toISOString());
  assert.equal(on.claims?.authenticatedAt, undefined, "the administrator-visible claim stays absent");

  // A refresh rotates the family; it is not a sign-in and must not renew the time.
  const rotated = await rotateMobileSession({ request: request(), refreshToken: tokens.refreshToken, client: "desktop" });
  assert.ok(rotated.ok);
  const afterRefresh = await settingsClaims(rotated.tokens.accessToken);
  assert.equal(afterRefresh.claims?.desktopSettings?.authenticatedAt, family.createdAt.toISOString());
  const rotatedFamily = await prisma.mobileTokenFamily.findUniqueOrThrow({ where: { id: family.id } });
  assert.equal(rotatedFamily.createdAt.getTime(), family.createdAt.getTime());
  assert.ok(rotatedFamily.lastRotatedAt.getTime() >= family.lastRotatedAt.getTime());

  // The session callback hands the time to account routes and never to the admin field.
  const { authOptions } = await import("@/lib/auth");
  const session = authOptions.callbacks?.session;
  assert.ok(session);
  const resolved = await session({
    session: { user: { name: user.name, email: user.email, id: user.id }, expires: new Date(Date.now() + 300_000).toISOString() },
    token: afterRefresh.claims!, user: { id: user.id, email: user.email!, emailVerified: null },
    trigger: "update", newSession: undefined,
  });
  assert.equal(resolved.user && "desktopAuthenticatedAt" in resolved.user ? resolved.user.desktopAuthenticatedAt : undefined, family.createdAt.toISOString());
  assert.equal(resolved.user && "authenticatedAt" in resolved.user ? resolved.user.authenticatedAt : undefined, undefined);
  process.env.TOMVERSE_DESKTOP_RECENT_AUTH_ENABLED = "false";
  const switchedOff = await session({
    session: { user: { name: user.name, email: user.email, id: user.id }, expires: new Date(Date.now() + 300_000).toISOString() },
    token: afterRefresh.claims!, user: { id: user.id, email: user.email!, emailVerified: null },
    trigger: "update", newSession: undefined,
  });
  assert.equal(switchedOff.user && "desktopAuthenticatedAt" in switchedOff.user ? switchedOff.user.desktopAuthenticatedAt : undefined, undefined);
  process.env.TOMVERSE_DESKTOP_RECENT_AUTH_ENABLED = "true";

  // A second sign-in is a new family with its own, later time.
  const second = await issueMobileSession({ request: request(), userId: user.id, platform: "desktop", deviceLabel: "Desktop" });
  const secondClaims = await settingsClaims(second.tokens.accessToken);
  assert.ok(Date.parse(secondClaims.claims!.desktopSettings!.authenticatedAt!) > family.createdAt.getTime());

  // Another user's family is never read, and a revoked family issues nothing.
  const other = await createUser();
  const otherSession = await issueMobileSession({ request: request(), userId: other.id, platform: "desktop", deviceLabel: "Desktop" });
  const otherFamily = await prisma.mobileTokenFamily.findFirstOrThrow({ where: { userId: other.id } });
  const otherClaims = await settingsClaims(otherSession.tokens.accessToken);
  assert.equal(otherClaims.claims?.desktopSettings?.authenticatedAt, otherFamily.createdAt.toISOString());
  assert.notEqual(otherClaims.claims?.desktopSettings?.authenticatedAt, family.createdAt.toISOString());
  await logoutMobileSession({ request: request(), refreshToken: second.tokens.refreshToken, client: "desktop" });
  assert.equal((await settingsClaims(second.tokens.accessToken)).status, 401);
});

test("Desktop email verifies an existing single-use code without accepting browser requests", async (t) => {
  const settings = {
    TOMVERSE_DESKTOP_AUTH_ENABLED: process.env.TOMVERSE_DESKTOP_AUTH_ENABLED,
    TOMVERSE_DESKTOP_EMAIL_LOGIN_ENABLED: process.env.TOMVERSE_DESKTOP_EMAIL_LOGIN_ENABLED,
    EMAIL_AUDIT_HASH_KEY: process.env.EMAIL_AUDIT_HASH_KEY,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(settings)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.TOMVERSE_DESKTOP_AUTH_ENABLED = "true";
  delete process.env.TOMVERSE_DESKTOP_EMAIL_LOGIN_ENABLED;
  const { POST } = await import("@/app/api/auth/desktop/email/route");
  const user = await createUser();
  const code = "482917";
  assert.ok(user.email);
  const submit = (proof: string, headers: Record<string, string> = {}) => POST(new Request("https://tomverse.test/api/auth/desktop/email", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ action: "verify", email: user.email, code: proof, appVersion: "0.1.118" }),
  }));
  assert.equal((await submit(code)).status, 503);
  process.env.TOMVERSE_DESKTOP_EMAIL_LOGIN_ENABLED = "true";
  assert.equal((await submit(code, { Origin: "https://tomverse.test" })).status, 403);
  assert.equal((await submit(code, { Cookie: "next-auth.session-token=ignored" })).status, 403);
  const digest = (input: string) => createHmac("sha256", process.env.NEXTAUTH_SECRET!).update(input).digest("hex");
  await prisma.emailLoginAttempt.create({ data: {
    email: user.email, codeHash: digest(`email-login:code:${user.email}:${code}`),
    linkTokenHash: digest(`email-login:link:${randomUUID()}`), expiresAt: new Date(Date.now() + 60_000),
  } });
  assert.equal((await submit("111111")).status, 401);
  const accepted = await submit(code);
  assert.equal(accepted.status, 200);
  const { verifyMobileAccessTokenString } = await accessToken();
  const access = (await accepted.json()).accessToken;
  const verified = verifyMobileAccessTokenString(access, { client: "desktop" });
  assert.ok(verified.ok);
  assert.equal(verified.identity.subject, user.id);
  assert.equal(verifyMobileAccessTokenString(access).ok, false);
  assert.equal((await submit(code)).status, 401);
  process.env.EMAIL_AUDIT_HASH_KEY = "local-desktop-email-audit";
  process.env.RESEND_API_KEY = "local-desktop-email-fixture";
  const delivery = t.mock.method(globalThis, "fetch", async (url: URL | string | Request) => {
    const target = new URL(url instanceof Request ? url.url : url);
    assert.equal(target.origin, "https://api.resend.com");
    return Response.json({ id: `desktop-email-delivery-${randomUUID()}` });
  });
  const receiver = `desktop-request-${randomUUID()}@example.test`;
  const delivered = await POST(new Request("https://tomverse.test/api/auth/desktop/email", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "request", email: receiver }),
  }));
  assert.equal(delivered.status, 200);
  assert.equal(delivery.mock.callCount(), 1);
  assert.equal(await prisma.emailLoginAttempt.count({ where: { email: receiver } }), 1);
});

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

test("an exchange creates a device, a family and exactly one live rotation", async () => {
  const user = await createUser();
  const tokens = await issue(user.id);

  const device = await prisma.mobileDevice.findUniqueOrThrow({
    where: { id: tokens.deviceId },
  });
  assert.equal(device.userId, user.id);
  assert.equal(device.platform, "ios");
  assert.equal(device.revokedAt, null);

  const rotations = await prisma.mobileRefreshRotation.findMany();
  assert.equal(rotations.length, 1);
  assert.equal(rotations[0]?.consumedAt, null);
  // What the row holds is a digest. The token the device got must not appear.
  assert.ok(!tokens.refreshToken.includes(rotations[0]!.secretDigest));
  assert.ok(!rotations[0]!.secretDigest.includes(tokens.refreshToken.split(".")[1]!));

  const { verifyMobileAccessTokenString } = await accessToken();
  const verdict = verifyMobileAccessTokenString(tokens.accessToken);
  assert.equal(verdict.ok, true);
});

test("Desktop exchanges only the bound browser grant and keeps its credentials out of mobile routes", async () => {
  const { issueMobileLoginGrant, pkceChallengeFor, consumeMobileLoginGrant } = await import("@/lib/mobileLoginGrant");
  const exchange = await import("@/app/api/auth/desktop/exchange/route");
  const desktopSession = await import("@/app/api/auth/desktop/session/route");
  const { revokeMobileDevice, rotateMobileSession, logoutMobileSession } = await service();
  const { verifyMobileAccessTokenString } = await accessToken();
  const user = await createUser();
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = pkceChallengeFor(codeVerifier);
  const state = randomBytes(32).toString("base64url");
  const redirectUri = "http://127.0.0.1:52134/desktop-login/callback";
  const desktop = { state, redirectUri };
  const { grant } = await issueMobileLoginGrant({ userId: user.id, codeChallenge, desktop });
  const expired = await issueMobileLoginGrant({ userId: user.id, codeChallenge, desktop, now: new Date(Date.now() - 61_000) });
  const phone = await issueMobileLoginGrant({ userId: user.id, codeChallenge });
  const body = { clientId: "tomverse-desktop", state, redirectUri, codeVerifier, grant };
  const send = (overrides: Record<string, string> = {}, origin?: string) => exchange.POST(new Request(
    "https://tomverse.test/api/auth/desktop/exchange", {
      method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { origin } : {}) },
      body: JSON.stringify({ ...body, ...overrides }),
    },
  ));
  const session = (token: string) => desktopSession.GET(new Request("https://tomverse.test/api/auth/desktop/session", {
    headers: { Authorization: `Bearer ${token}` },
  }));
  const previous = process.env.TOMVERSE_DESKTOP_AUTH_ENABLED;
  try {
    delete process.env.TOMVERSE_DESKTOP_AUTH_ENABLED;
    assert.equal((await send()).status, 503);
    process.env.TOMVERSE_DESKTOP_AUTH_ENABLED = "true";
    assert.equal((await send({}, "https://tomverse.test")).status, 403);
    assert.equal((await send({ clientId: "other-client" })).status, 400);
    assert.equal((await send({ redirectUri: "https://example.test" })).status, 400);
    assert.equal((await send({ redirectUri: redirectUri.replace("52134", "52135") })).status, 401);
    assert.equal((await send({ state: randomBytes(32).toString("base64url") })).status, 401);
    assert.equal((await send({ codeVerifier: randomBytes(32).toString("base64url") })).status, 401);
    assert.equal((await send({ grant: expired.grant })).status, 401);
    assert.equal((await send({ grant: phone.grant })).status, 401);
    assert.equal((await consumeMobileLoginGrant({ grant, codeVerifier })).ok, false);
    const exchanges = await Promise.all([send(), send()]);
    assert.deepEqual(exchanges.map((response) => response.status).sort(), [200, 401]);
    const success = await exchanges.find((response) => response.ok)!.json();
    const { accessToken: access, refreshToken, deviceId } = success;
    assert.equal(success.expiresIn, 600);
    assert.equal(typeof refreshToken, "string");
    assert.equal(exchanges.find((response) => !response.ok)!.headers.get("cache-control"), "no-store");
    assert.equal((await send()).status, 401);
    assert.equal(verifyMobileAccessTokenString(access).ok, false);
    assert.equal(verifyMobileAccessTokenString(access, { client: "desktop" }).ok, true);
    const phoneSession = await issue(user.id);
    assert.equal((await session(phoneSession.accessToken)).status, 401);
    assert.equal((await rotateMobileSession({ request: request(), refreshToken: phoneSession.refreshToken, client: "desktop" })).ok, false);
    assert.equal((await rotateMobileSession({ request: request(), refreshToken })).ok, false);
    await logoutMobileSession({ request: request(), refreshToken });
    assert.equal((await session(access)).status, 200);
    const account = await session(access);
    assert.equal(account.status, 200);
    assert.deepEqual((await account.json()).account, { id: user.id, name: user.name, email: user.email });
    await prisma.userSettings.create({ data: { userId: user.id, language: "ko", defaultModel: "gpt-6-luna" } });
    assert.equal((await (await session(access)).json()).account.language, "ko");
    assert.equal((await prisma.mobileDevice.findUniqueOrThrow({ where: { id: deviceId } })).platform, "desktop");
    const family = await prisma.mobileTokenFamily.findFirstOrThrow({ where: { deviceId } });
    assert.equal(await prisma.mobileRefreshRotation.count({ where: { familyId: family.id } }), 1);
    assert.equal(await prisma.mobileAuthEvent.count({ where: { deviceId, event: "mobile_auth.exchanged" } }), 1);
    assert.ok(await prisma.chatUsageBucket.count({ where: { period: { startsWith: "api-desktop-exchange" } } }));
    await revokeMobileDevice({ userId: user.id, deviceId });
    assert.equal((await session(access)).status, 401);
    const inactive = await createUser();
    await prisma.user.update({ where: { id: inactive.id }, data: { accountStatus: "suspended" } });
    const inactiveGrant = await issueMobileLoginGrant({ userId: inactive.id, codeChallenge, desktop });
    assert.equal((await send({ grant: inactiveGrant.grant })).status, 401);
    assert.equal(await prisma.mobileDevice.count({ where: { userId: inactive.id } }), 0);
  } finally {
    if (previous === undefined) delete process.env.TOMVERSE_DESKTOP_AUTH_ENABLED;
    else process.env.TOMVERSE_DESKTOP_AUTH_ENABLED = previous;
  }
});

test("Desktop refresh and logout keep server replay detection and device revocation", async () => {
  const { issueMobileSession } = await service();
  const refresh = await import("@/app/api/auth/desktop/refresh/route");
  const logout = await import("@/app/api/auth/desktop/logout/route");
  const account = await import("@/app/api/auth/desktop/session/route");
  const user = await createUser();
  const issueDesktop = () => issueMobileSession({ request: request(), userId: user.id, platform: "desktop", deviceLabel: "Desktop" });
  const post = (endpoint: "refresh" | "logout", refreshToken: string, origin?: string) => new Request(
    `https://tomverse.test/api/auth/desktop/${endpoint}`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { origin } : {}) },
      body: JSON.stringify({ refreshToken }),
    });
  const session = (accessToken: string) => account.GET(new Request("https://tomverse.test/api/auth/desktop/session", {
    headers: { Authorization: `Bearer ${accessToken}` },
  }));
  const prior = process.env.TOMVERSE_DESKTOP_AUTH_ENABLED;
  process.env.TOMVERSE_DESKTOP_AUTH_ENABLED = "true";
  try {
    const issued = (await issueDesktop()).tokens;
    assert.equal((await refresh.POST(post("refresh", issued.refreshToken, "null"))).status, 403);
    const replies = await Promise.all([
      refresh.POST(post("refresh", issued.refreshToken)), refresh.POST(post("refresh", issued.refreshToken)),
    ]);
    assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 401]);
    const winner = await replies.find((reply) => reply.ok)!.json();
    assert.equal((await session(winner.accessToken)).status, 401);
    assert.equal(await prisma.mobileAuthEvent.count({ where: { deviceId: issued.deviceId, event: "mobile_auth.reuse_detected" } }), 1);
    const active = (await issueDesktop()).tokens;
    const refreshed = await refresh.POST(post("refresh", active.refreshToken));
    assert.equal(refreshed.status, 200);
    const next = await refreshed.json();
    assert.equal((await session(next.accessToken)).status, 200);
    assert.equal((await logout.POST(post("logout", next.refreshToken))).status, 204);
    assert.equal((await session(next.accessToken)).status, 401);
  } finally {
    if (prior === undefined) delete process.env.TOMVERSE_DESKTOP_AUTH_ENABLED;
    else process.env.TOMVERSE_DESKTOP_AUTH_ENABLED = prior;
  }
});

test("Desktop reads its own resources through the exact origin and route allowlist", async () => {
  const { issueMobileSession } = await service();
  const { resolveChatRouteSession } = await import("@/lib/chatRouteSession");
  const conversations = await import("@/app/api/conversations/[conversationId]/route");
  const history = await import("@/app/api/conversations/route");
  const search = await import("@/app/api/conversations/search/route");
  const continuation = await import("@/app/api/conversations/[conversationId]/continuation/route");
  const chatCreate = await import("@/app/api/products/chat/conversations/route");
  const artifacts = await import("@/app/api/artifacts/[artifactId]/route");
  const capabilities = await import("@/app/api/products/chat/capabilities/route");
  const keys = await import("@/app/api/user/api-keys/route");
  const user = await createUser();
  const other = await createUser();
  const own = await prisma.conversation.create({ data: { userId: user.id, title: "Owned Desktop conversation", selectedModels: "[]", productKey: "chat" } });
  const locked = await prisma.conversation.create({ data: { userId: user.id, title: "Locked Desktop conversation", selectedModels: "[]", productKey: "chat", password: "locked" } });
  const foreign = await prisma.conversation.create({ data: { userId: other.id, title: "Other user's conversation", selectedModels: "[]", productKey: "chat" } });
  const makeArtifact = async (userId: string, conversationId: string) => {
    const message = await prisma.message.create({ data: { conversationId, role: "assistant", content: "Fixture" } });
    return prisma.messageArtifact.create({ data: { userId, conversationId, messageId: message.id,
      format: "csv", filename: "fixture.csv", mediaType: "text/csv", byteSize: 3, objectKey: `desktop-test/${randomUUID()}.csv` } });
  };
  const ownArtifact = await makeArtifact(user.id, locked.id);
  const foreignArtifact = await makeArtifact(other.id, foreign.id);
  const phrase = "desktop-history-" + randomUUID();
  await prisma.message.createMany({ data: [own, locked, foreign].map((row) => ({
    conversationId: row.id, role: "user", content: phrase,
  })) });
  const { tokens } = await issueMobileSession({ request: request(), userId: user.id, platform: "desktop", deviceLabel: "Desktop" });
  const mobile = await issueMobileSession({ request: request(), userId: user.id, platform: "ios", deviceLabel: "iPhone" });
  const read = (path: string, from = "tomverse://desktop", headers: Record<string, string> = {}, method = "GET", payload?: unknown) =>
    new Request(`https://tomverse.test${path}`, { method, headers: {
      Authorization: `Bearer ${tokens.accessToken}`, ...(from ? { Origin: from } : {}), ...headers,
      ...(payload ? { "Content-Type": "application/json" } : {}),
    }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
  const conversation = (id: string, from?: string, headers?: Record<string, string>) =>
    conversations.GET(read(`/api/conversations/${id}`, from, headers), { params: Promise.resolve({ conversationId: id }) });
  const artifact = (id: string) =>
    artifacts.GET(read(`/api/artifacts/${id}`), { params: Promise.resolve({ artifactId: id }) });
  const old = process.env.TOMVERSE_DESKTOP_AUTH_ENABLED;
  const oldWrite = process.env.TOMVERSE_DESKTOP_CHAT_WRITE_ENABLED;
  try {
    delete process.env.TOMVERSE_DESKTOP_AUTH_ENABLED;
    delete process.env.TOMVERSE_DESKTOP_CHAT_WRITE_ENABLED;
    assert.equal((await conversation(own.id)).status, 503);
    process.env.TOMVERSE_DESKTOP_AUTH_ENABLED = "true";
    for (const origin of ["", "null", "*", "https://elsewhere.test", "tomverse://desktop.evil.test", "tomverse://desktop/", "tomverse://desktop:3000"]) {
      assert.equal((await conversation(own.id, origin)).ok, false, origin);
    }
    const authenticated = await conversation(own.id);
    assert.equal(authenticated.status, 200);
    assert.equal((await authenticated.json()).title, own.title);
    const list = await history.GET(read("/api/conversations"));
    assert.equal(list.status, 200);
    const listIds = (await list.json() as Array<{ id: string }>).map((row) => row.id);
    assert.deepEqual(listIds.sort(), [own.id, locked.id].sort());
    const searchPath = "/api/conversations/search?q=" + encodeURIComponent(phrase);
    const matches = await search.GET(read(searchPath));
    assert.equal(matches.status, 200);
    assert.deepEqual((await matches.json()).results.map((row: { conversationId: string }) => row.conversationId), [own.id]);
    assert.equal((await search.GET(read(searchPath, "null"))).ok, false);
    assert.equal((await history.GET(read("/api/conversations", undefined, { Authorization: `Bearer ${mobile.tokens.accessToken}` }))).status, 401);
    assert.equal((await conversation(foreign.id, undefined, { "x-tomverse-auth-subject": other.id })).status, 403);
    assert.equal((await conversation(own.id, undefined, { Cookie: "next-auth.session-token=ambient" })).status, 401);
    assert.equal((await conversation(locked.id, undefined, { "x-tomverse-conversation-unlocks": "unapproved" })).status, 401);
    assert.equal((await conversation(locked.id)).status, 423);
    assert.equal((await artifact(foreignArtifact.id)).status, 404);
    assert.equal((await artifact(ownArtifact.id)).status, 423);
    const imported = await prisma.externalImport.create({
      data: { userId: user.id, provider: "chatgpt", status: "completed", digestVersion: 1, parserVersion: "test" },
    });
    const source = await prisma.externalConversation.create({
      data: {
        userId: user.id, importId: imported.id, provider: "chatgpt", externalStableId: randomUUID(),
        title: "Desktop imported original", conversationDigest: randomUUID(), digestVersion: 1,
        messageCount: 1, contentBytes: BigInt(32), finalized: true,
      },
    });
    const sourceMessage = await prisma.externalMessage.create({
      data: {
        userId: user.id, externalConversationId: source.id, externalStableId: randomUUID(), role: "user",
        content: "Private imported Desktop evidence", contentDigest: randomUUID(), digestVersion: 1, ordinal: 0,
      },
    });
    const continuedReview = await prisma.conversation.create({ data: {
      userId: user.id, title: "Review with imported history", kind: "chat", selectedModels: "[]", productKey: "review",
    } });
    const foreignReview = await prisma.conversation.create({ data: {
      userId: other.id, title: "Another user's Review", kind: "chat", selectedModels: "[]", productKey: "review",
    } });
    await prisma.conversationContinuationBridge.createMany({
      data: [own, continuedReview].map(({ id: conversationId }) => ({
        userId: user.id, conversationId, externalConversationId: source.id, provider: "chatgpt",
        sourceImportedAt: imported.createdAt, sourceConversationDigest: source.conversationDigest,
        sourceDigestVersion: 1, sourceMessageCount: 1, seedFromOrdinal: 0, seedToOrdinal: 0,
        seedMessageCount: 1, seedTruncatedMessageCount: 0, seedOmittedMessageCount: 0,
        contextSeedVersion: "ext-seed-v1", idempotencyKey: randomUUID(),
      })),
    });
    const sourcePage = (id: string) => continuation.GET(read(`/api/conversations/${id}/continuation?offset=end`),
      { params: Promise.resolve({ conversationId: id }) });
    assert.equal((await sourcePage(foreign.id)).status, 404);
    assert.equal((await sourcePage(locked.id)).status, 423);
    const importedRead = await sourcePage(own.id);
    assert.equal(importedRead.status, 200);
    assert.equal((await importedRead.json()).source.messages[0].content, sourceMessage.content);
    const reviewSource = await sourcePage(continuedReview.id);
    assert.equal(reviewSource.status, 200, await reviewSource.clone().text());
    assert.equal((await reviewSource.json()).source.messages[0].content, sourceMessage.content);
    assert.equal((await sourcePage(foreignReview.id)).status, 404);
    await prisma.conversation.update({ where: { id: continuedReview.id }, data: { password: "fixture-locked" } });
    assert.equal((await sourcePage(continuedReview.id)).status, 423);
    await prisma.conversation.update({ where: { id: continuedReview.id }, data: { password: null } });
    await prisma.externalConversation.update({ where: { id: source.id }, data: { password: "fixture-locked" } });
    assert.deepEqual((await (await sourcePage(own.id)).json()).source, { status: "locked" });
    assert.deepEqual((await (await sourcePage(continuedReview.id)).json()).source, { status: "locked" });
    const orderBase = Date.now() + 1_000;
    const longHistory = Array.from({ length: 53 }, (_, index) => ({
      id: randomUUID(), conversationId: own.id, role: "user", content: "Desktop page " + index,
      createdAt: new Date(orderBase + index),
    }));
    await prisma.message.createMany({ data: longHistory });
    const pageContext = { params: Promise.resolve({ conversationId: own.id }) };
    const firstPage = await (await conversation(own.id)).json();
    assert.equal(firstPage.messages.length, 50);
    assert.ok(firstPage.messagePage.nextCursor);
    const lastPage = await (await conversations.GET(read(`/api/conversations/${own.id}?tail=1`), pageContext)).json();
    assert.deepEqual(lastPage.messages.map((message: { id: string }) => message.id), longHistory.slice(-50).map(({ id }) => id));
    assert.equal(lastPage.messagePage.nextCursor, null);
    const nextPage = await (await conversations.GET(
      read(`/api/conversations/${own.id}?cursor=${firstPage.messagePage.nextCursor}`), pageContext)).json();
    assert.equal(nextPage.messages.at(-1).id, longHistory.at(-1)!.id);
    assert.equal((await resolveChatRouteSession(read(`/api/conversations/${own.id}`, undefined, {}, "PATCH"))).response?.status, 401);
    assert.equal((await resolveChatRouteSession(read(`/api/conversations/${own.id}/messages`))).response?.status, 401);
    assert.equal((await keys.GET(read("/api/user/api-keys"))).status, 401);
    assert.equal((await keys.POST(read("/api/user/api-keys", undefined, {}, "POST"))).status, 401);
    const flags = await capabilities.GET(read("/api/products/chat/capabilities"));
    assert.equal(flags.status, 200);
    assert.equal(typeof (await flags.json()).autoSelection.offered, "boolean");
    process.env.TOMVERSE_DESKTOP_CHAT_WRITE_ENABLED = "true";
    const review = await prisma.conversation.create({ data: { userId: user.id, title: "Review fixture", selectedModels: "[]", productKey: "review" } });
    const rename = (id: string, payload: object, headers: Record<string, string> = {}) =>
      conversations.PATCH(read(`/api/conversations/${id}`, undefined, headers, "PATCH", payload), { params: Promise.resolve({ conversationId: id }) });
    const remove = (id: string) =>
      conversations.DELETE(read(`/api/conversations/${id}`, undefined, {}, "DELETE"), { params: Promise.resolve({ conversationId: id }) });
    const created = await chatCreate.POST(read("/api/products/chat/conversations", undefined, {}, "POST", { title: "New Desktop Chat" }));
    assert.equal(created.status, 200, await created.clone().text());
    const createdId = (await created.json()).id;
    assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: createdId } })).productKey, "chat");
    const { POST: saveMessage } = await import("@/app/api/conversations/[conversationId]/messages/route");
    for (const attachments of [{ attachmentReferences: [] }, { attachmentUploadIds: [] }]) {
      const saved = await saveMessage(read(`/api/conversations/${createdId}/messages`, undefined, {}, "POST", {
        messages: [{ clientRequestId: randomUUID(), role: "user", content: "A question without attachments", ...attachments }],
      }), { params: Promise.resolve({ conversationId: createdId }) });
      assert.equal(saved.status, 200, await saved.clone().text());
    }
    assert.equal((await rename(createdId, { title: "Renamed in Desktop" })).status, 200);
    assert.equal((await (await conversation(createdId)).json()).title, "Renamed in Desktop");
    const composerFlag = "TOMVERSE_DESKTOP_COMPOSER_TOOLS_ENABLED";
    const reviewFlag = "TOMVERSE_DESKTOP_REVIEW_ENABLED";
    const previousComposer = process.env[composerFlag];
    const previousReview = process.env[reviewFlag];
    try {
      const options = { webSearchMode: "always", memoryMode: "off", assistantProfileId: null };
      delete process.env[composerFlag];
      assert.equal((await rename(createdId, options)).status, 400);
      assert.equal((await (await capabilities.GET(read("/api/products/chat/capabilities"))).json()).desktopComposerTools, false);
      process.env[composerFlag] = "true";
      process.env[reviewFlag] = "true";
      assert.equal((await (await capabilities.GET(read("/api/products/chat/capabilities"))).json()).desktopComposerTools, true);
      assert.equal((await rename(foreign.id, options)).status, 403);
      // A Desktop Review takes the composer options as a Chat does.
      assert.equal((await rename(review.id, options)).status, 200);
      assert.equal((await (await conversation(review.id)).json()).webSearchMode, "always");
      assert.equal((await rename(locked.id, options)).status, 423);
      assert.equal((await rename(createdId, options, { Cookie: "session=ambient" })).status, 401);
      assert.equal((await rename(createdId, { ...options, password: "will-not-change" })).status, 400);
      const updated = await rename(createdId, options);
      assert.equal(updated.status, 200, await updated.clone().text());
      const savedOptions = await (await conversation(createdId)).json();
      assert.equal(savedOptions.webSearchMode, "always");
      assert.equal(savedOptions.memoryMode, "off");
      assert.equal(savedOptions.assistantProfile, null);
    } finally {
      if (previousComposer === undefined) delete process.env[composerFlag]; else process.env[composerFlag] = previousComposer;
      if (previousReview === undefined) delete process.env[reviewFlag]; else process.env[reviewFlag] = previousReview;
    }
    assert.equal((await rename(createdId, { password: "will-not-change" })).status, 400);
    assert.equal((await rename(createdId, { title: "Ambient cookie" }, { Cookie: "session=ambient" })).status, 401);
    assert.equal((await rename(foreign.id, { title: "Wrong owner" })).status, 403);
    assert.equal((await rename(review.id, { title: "Wrong product" })).status, 403);
    assert.equal((await remove(locked.id)).status, 423);
    assert.equal((await remove(foreign.id)).status, 403);
    assert.equal((await remove(review.id)).status, 403);
    assert.equal((await remove(createdId)).status, 200);
    assert.equal(await prisma.conversation.findUnique({ where: { id: createdId } }), null);
  } finally {
    if (old === undefined) delete process.env.TOMVERSE_DESKTOP_AUTH_ENABLED;
    else process.env.TOMVERSE_DESKTOP_AUTH_ENABLED = old;
    if (oldWrite === undefined) delete process.env.TOMVERSE_DESKTOP_CHAT_WRITE_ENABLED;
    else process.env.TOMVERSE_DESKTOP_CHAT_WRITE_ENABLED = oldWrite;
  }
});

test("Desktop Review and Images require their server switch and keep product and owner boundaries", async () => {
  const { issueMobileSession } = await service();
  const review = await import("@/app/api/products/review/conversations/route");
  const images = await import("@/app/api/images/generations/route");
  const download = await import("@/app/api/images/generations/[generationId]/download/route");
  const preflight = await import("@/app/api/chat/preflight/route");
  const deleteConversation = (await import("@/app/api/conversations/[conversationId]/route")).DELETE;
  const user = await createUser();
  const other = await createUser();
  const foreign = await prisma.conversation.create({
    data: { userId: other.id, title: "Foreign review", selectedModels: "[]", productKey: "review" },
  });
  const ownChat = await prisma.conversation.create({
    data: { userId: user.id, title: "Own Chat", selectedModels: "[]", productKey: "chat" },
  });
  const { tokens } = await issueMobileSession({ request: request(), userId: user.id, platform: "desktop", deviceLabel: "Desktop" });
  const make = (path: string, method = "GET", payload?: object) => new Request("https://tomverse.test" + path, {
    method,
    headers: { Authorization: "Bearer " + tokens.accessToken, Origin: "tomverse://desktop", "Content-Type": "application/json" },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const names = ["TOMVERSE_DESKTOP_AUTH_ENABLED", "TOMVERSE_DESKTOP_CHAT_WRITE_ENABLED", "TOMVERSE_DESKTOP_REVIEW_ENABLED"] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.TOMVERSE_DESKTOP_AUTH_ENABLED = "true";
    process.env.TOMVERSE_DESKTOP_CHAT_WRITE_ENABLED = "true";
    delete process.env.TOMVERSE_DESKTOP_REVIEW_ENABLED;
    const create = () => review.POST(make("/api/products/review/conversations", "POST", { title: "New desktop review" }));
    assert.equal((await create()).status, 401);
    assert.equal((await images.GET(make("/api/images/generations?requestKey=not-found"))).status, 401);
    process.env.TOMVERSE_DESKTOP_REVIEW_ENABLED = "true";
    const created = await create();
    assert.equal(created.status, 200, await created.clone().text());
    const id = (await created.json()).id;
    assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id } })).productKey, "review");
    assert.equal((await deleteConversation(make(`/api/conversations/${id}`, "DELETE"),
      { params: Promise.resolve({ conversationId: id }) })).status, 403);
    for (const conversationId of [foreign.id, ownChat.id]) {
      const result = await preflight.POST(make("/api/chat/preflight", "POST", {
        comparisonId: Date.now().toString(), conversationId, modelIds: ["gpt-6-luna", "gpt-5-6-luna"],
        prompt: "Local fixture", attachments: [],
      }));
      assert.equal(result.status, 403);
    }
    assert.equal((await images.GET(make("/api/images/generations?requestKey=not-found"))).status, 404);
    assert.equal((await images.POST(make("/api/images/generations", "POST", { prompt: "" }))).status, 400);
    const image = await prisma.conversation.create({ data: { userId: user.id, title: "Locked image", selectedModels: "[]",
      kind: "image", productKey: "studio", password: "locked" } });
    const key = randomUUID();
    await prisma.imageGenerationGroup.create({ data: { userId: user.id, conversationId: image.id, groupIdempotencyKey: key } });
    const generate = (conversationId?: string) => images.POST(make("/api/images/generations", "POST", {
      prompt: "A local image fixture", size: "1024x1024", quality: "low", idempotencyKey: key, conversationId,
    }));
    assert.equal((await generate()).status, 423);
    assert.equal((await generate(image.id)).status, 423);
    assert.equal((await generate(foreign.id)).status, 404);
    assert.equal((await generate(ownChat.id)).status, 409);
    assert.equal((await images.GET(make(`/api/images/generations?requestKey=${key}`))).status, 423);
    const absentId = "missing-desktop-image";
    assert.equal((await download.GET(make(`/api/images/generations/${absentId}/download?preview=1`),
      { params: Promise.resolve({ generationId: absentId }) })).status, 404);
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("Desktop can write legacy Review conversations only during the configured transition", async () => {
  const { issueMobileSession } = await service();
  const conversations = await import("@/app/api/conversations/[conversationId]/route");
  const messages = await import("@/app/api/conversations/[conversationId]/messages/route");
  const preflight = await import("@/app/api/chat/preflight/route");
  const chat = await import("@/app/api/chat/route");
  const user = await createUser();
  const other = await createUser();
  await prisma.user.update({ where: { id: user.id }, data: { plan: "Pro" } });
  const create = (userId: string, password?: string) => prisma.conversation.create({
    data: { userId, title: "Legacy Review", kind: "chat", productKey: null, selectedModels: "[]", password },
  });
  const own = await create(user.id);
  const locked = await create(user.id, "locked");
  const foreign = await create(other.id);
  const { tokens } = await issueMobileSession({ request: request(), userId: user.id, platform: "desktop", deviceLabel: "Desktop" });
  const make = (path: string, method = "GET", payload?: object) => new Request("https://tomverse.test" + path, {
    method,
    headers: { Authorization: "Bearer " + tokens.accessToken, Origin: "tomverse://desktop", "Content-Type": "application/json" },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const params = (conversationId: string) => ({ params: Promise.resolve({ conversationId }) });
  const modelIds = ["gpt-6-luna", "gpt-5-6-luna"];
  const prompt = "A follow-up to my previous Review";
  const detail = () => conversations.GET(make("/api/conversations/" + own.id), params(own.id));
  const configure = (id: string) => conversations.PATCH(make("/api/conversations/" + id, "PATCH",
    { title: "Legacy Review updated", selectedModels: modelIds, selectionMode: "manual" }), params(id));
  const append = (id: string) => messages.POST(make("/api/conversations/" + id + "/messages", "POST",
    { messages: [{ clientRequestId: randomUUID(), role: "user", content: prompt }] }), params(id));
  const admit = (id: string) => preflight.POST(make("/api/chat/preflight", "POST", {
    comparisonId: Date.now().toString(), conversationId: id, modelIds, prompt, attachments: [],
  }));
  const names = ["TOMVERSE_DESKTOP_AUTH_ENABLED", "TOMVERSE_DESKTOP_CHAT_WRITE_ENABLED", "TOMVERSE_DESKTOP_REVIEW_ENABLED",
    "PRODUCT_KEY_READ_MODE", "PRODUCT_KEY_LEGACY_FALLBACK_EXPIRES_AT", "PRODUCT_KEY_EXPAND_DEPLOYED_AT",
    "TOMVERSE_REASONING_EFFORT_ENABLED"] as const;
  const previous = names.map((name) => process.env[name]);
  const day = 86_400_000;
  const now = Date.now();
  try {
    process.env.TOMVERSE_DESKTOP_AUTH_ENABLED = "true";
    process.env.TOMVERSE_DESKTOP_CHAT_WRITE_ENABLED = "true";
    process.env.TOMVERSE_DESKTOP_REVIEW_ENABLED = "true";
    process.env.PRODUCT_KEY_READ_MODE = "legacy_fallback";
    process.env.PRODUCT_KEY_EXPAND_DEPLOYED_AT = new Date(now - 2 * day).toISOString();
    process.env.PRODUCT_KEY_LEGACY_FALLBACK_EXPIRES_AT = new Date(now + day).toISOString();
    process.env.TOMVERSE_REASONING_EFFORT_ENABLED = "false";

    const writable = await detail();
    assert.equal(writable.status, 200);
    assert.equal((await writable.json()).desktopReviewWritable, true);
    const patched = await configure(own.id);
    assert.equal(patched.status, 200, await patched.clone().text());
    const current = await prisma.conversation.findUniqueOrThrow({ where: { id: own.id } });
    assert.equal(current.title, "Legacy Review updated");
    assert.deepEqual(JSON.parse(current.selectedModels), modelIds);
    assert.equal(current.productKey, null);

    const saved = await append(own.id);
    assert.equal(saved.status, 200, await saved.clone().text());
    const sourceId = (await saved.json()).messageMappings[0].messageId;
    assert.equal((await prisma.message.findUniqueOrThrow({ where: { id: sourceId } })).content, prompt);
    const turn = (conversationId = own.id) => chat.POST(make("/api/chat", "POST", {
      modelId: modelIds[0], conversationId, sourceUserMessageId: sourceId, assistantMessageId: randomUUID(),
      messages: [{ id: sourceId, role: "user", content: prompt }], reasoningEffort: "high",
    }));
    // An intentionally unavailable request option proves the chat route has
    // accepted the workspace boundary without contacting a model provider.
    const refusedOption = await turn();
    assert.equal(refusedOption.status, 409, await refusedOption.clone().text());
    assert.equal((await refusedOption.json()).code, "REASONING_EFFORT_UNAVAILABLE");
    const admitted = await admit(own.id);
    assert.equal(admitted.status, 200, await admitted.clone().text());
    assert.ok((await admitted.json()).admissionToken);

    assert.equal((await configure(foreign.id)).status, 403);
    assert.equal((await append(foreign.id)).status, 403);
    assert.equal((await admit(foreign.id)).status, 403);
    assert.equal((await configure(locked.id)).status, 423);
    assert.equal((await append(locked.id)).status, 423);
    assert.equal((await admit(locked.id)).status, 423);
    assert.equal((await turn(locked.id)).status, 423);
    assert.equal((await conversations.DELETE(make("/api/conversations/" + own.id, "DELETE"), params(own.id))).status, 403);
    for (const mode of ["strict", "expired", "unconfigured", "disabled"]) {
      process.env.PRODUCT_KEY_READ_MODE = mode === "strict" ? "strict" : "legacy_fallback";
      process.env.PRODUCT_KEY_LEGACY_FALLBACK_EXPIRES_AT =
        mode === "expired" ? new Date(now - day).toISOString() : new Date(now + day).toISOString();
      if (mode === "unconfigured") delete process.env.PRODUCT_KEY_LEGACY_FALLBACK_EXPIRES_AT;
      if (mode === "disabled") process.env.TOMVERSE_DESKTOP_REVIEW_ENABLED = "false";
      assert.equal((await (await detail()).json()).desktopReviewWritable, false, mode);
      assert.equal((await configure(own.id)).status, 403, mode);
      assert.equal((await append(own.id)).status, 403, mode);
      assert.equal((await admit(own.id)).status, mode === "disabled" ? 401 : 403, mode);
      const refusedTurn = await turn();
      assert.equal(refusedTurn.status, 403, mode);
      assert.equal((await refusedTurn.json()).code, "CONVERSATION_ACCESS_DENIED", mode);
    }
    assert.equal(await prisma.message.count({ where: { conversationId: own.id } }), 1);
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
});

test("Desktop binds only an active Code key belonging to the current eligible account", async () => {
  const { issueMobileSession } = await service();
  const { generateExternalApiKey } = await import("@/lib/externalApiKeyCore");
  const { POST } = await import("@/app/api/auth/desktop/code-key/route");
  const user = await createUser();
  const other = await createUser();
  await prisma.user.updateMany({ where: { id: { in: [user.id, other.id] } }, data: { plan: "Pro" } });
  const seedKey = async (userId: string, options: { expiresAt?: Date; revokedAt?: Date } = {}) => {
    const generated = generateExternalApiKey();
    await prisma.externalApiKey.create({ data: { userId, name: "Desktop fixture", keyPrefix: generated.keyPrefix,
      secretDigest: generated.secretDigest, ...options } });
    return generated;
  };
  const own = await seedKey(user.id);
  const foreign = await seedKey(other.id);
  const expired = await seedKey(user.id, { expiresAt: new Date(Date.now() - 10_000) });
  const revoked = await seedKey(user.id, { revokedAt: new Date() });
  const { tokens } = await issueMobileSession({ request: request(), userId: user.id, platform: "desktop", deviceLabel: "Desktop" });
  const validate = (key: string, headers: Record<string, string> = {}) => POST(new Request("https://tomverse.test/api/auth/desktop/code-key", {
    method: "POST", headers: { Authorization: `Bearer ${tokens.accessToken}`, "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ key }),
  }));
  const switches = ["TOMVERSE_DESKTOP_AUTH_ENABLED", "EXTERNAL_API_ENABLED", "EXTERNAL_API_ALLOWED_USER_IDS"] as const;
  const previous = Object.fromEntries(switches.map((name) => [name, process.env[name]]));
  try {
    process.env.TOMVERSE_DESKTOP_AUTH_ENABLED = "true";
    process.env.EXTERNAL_API_ALLOWED_USER_IDS = "*";
    delete process.env.EXTERNAL_API_ENABLED;
    assert.equal((await validate(own.key)).status, 503);
    process.env.EXTERNAL_API_ENABLED = "true";
    for (const key of [foreign.key, expired.key, revoked.key, own.keyPrefix, "arbitrary-clipboard-text"]) {
      assert.equal((await validate(key)).status, 403);
    }
    assert.equal((await validate(own.key, { Origin: "tomverse://desktop" })).status, 403);
    assert.equal((await validate(own.key, { Cookie: "next-auth.session-token=ambient" })).status, 403);
    const accepted = await validate(own.key);
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { ok: true, keyPrefix: own.keyPrefix });
    await prisma.user.update({ where: { id: user.id }, data: { plan: "Free" } });
    assert.equal((await validate(own.key)).status, 403);
  } finally {
    for (const name of switches) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("a refresh consumes its token, mints a successor, and links the chain", async () => {
  const { rotateMobileSession } = await service();
  const user = await createUser();
  const first = await issue(user.id);

  const rotated = await rotateMobileSession({
    request: request(),
    refreshToken: first.refreshToken,
  });
  assert.equal(rotated.ok, true);
  assert.notEqual(rotated.tokens.refreshToken, first.refreshToken);

  const rows = await prisma.mobileRefreshRotation.findMany({ orderBy: { createdAt: "asc" } });
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0]?.consumedAt, null);
  assert.equal(rows[0]?.supersededById, rows[1]?.id);
  assert.equal(rows[1]?.consumedAt, null);
});

test("V10 -- two requests racing on one token: one successor, and the family is revoked", async () => {
  // Section 4 option A, strict single use, and the assertion this test used to
  // get wrong. It previously pinned the family *surviving*, on the reasoning
  // that the loser had presented a legitimate token which merely arrived
  // second. That is not option A: A draws no distinction between a token
  // consumed a microsecond ago by a sibling and one consumed an hour ago by an
  // attacker, and V10 says one 200, one 401, family revoked.
  //
  // The old behaviour was also non-deterministic -- whether the family survived
  // depended on whether the loser's read landed before or after the winner's
  // commit. This asserts the outcome that no longer depends on that.
  const { rotateMobileSession } = await service();
  const user = await createUser();
  const first = await issue(user.id);

  const [left, right] = await Promise.all([
    rotateMobileSession({ request: request(), refreshToken: first.refreshToken }),
    rotateMobileSession({ request: request(), refreshToken: first.refreshToken }),
  ]);

  const winners = [left, right].filter((result) => result.ok);
  assert.equal(winners.length, 1, "exactly one rotation may win");

  const family = await prisma.mobileTokenFamily.findFirstOrThrow();
  assert.notEqual(family.revokedAt, null, "option A revokes on the second use");
  assert.equal(family.revokedReason, "reuse_detected");
  assert.equal(family.epoch, 1);

  const events = await prisma.mobileAuthEvent.findMany({ select: { event: true } });
  assert.ok(events.some((row) => row.event === "mobile_auth.reuse_detected"));
});

test("V10 -- the race outcome does not depend on which side read first", async () => {
  // The property the old branch lacked. Whichever interleaving the database
  // produces, the pair of answers and the family's fate are the same -- which
  // is what makes this option A rather than a fourth thing.
  const { rotateMobileSession } = await service();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await reset();
    const user = await createUser();
    const first = await issue(user.id);

    const results = await Promise.all([
      rotateMobileSession({ request: request(), refreshToken: first.refreshToken }),
      rotateMobileSession({ request: request(), refreshToken: first.refreshToken }),
    ]);

    assert.equal(
      results.filter((result) => result.ok).length,
      1,
      `attempt ${attempt}: exactly one winner`
    );
    const loser = results.find((result) => !result.ok);
    assert.equal(loser?.reason, "reuse_detected", `attempt ${attempt}: the loser's reason`);

    const family = await prisma.mobileTokenFamily.findFirstOrThrow();
    assert.equal(family.revokedReason, "reuse_detected", `attempt ${attempt}`);
  }
});

test("a replayed token destroys the family, and the revocation commits", async () => {
  // D8's commit contract. An implementation that threw would roll the
  // revocation back with the response and leave replay detection doing nothing.
  const { rotateMobileSession } = await service();
  const user = await createUser();
  const first = await issue(user.id);
  await rotateMobileSession({ request: request(), refreshToken: first.refreshToken });

  const replay = await rotateMobileSession({
    request: request(),
    refreshToken: first.refreshToken,
  });
  assert.equal(replay.ok, false);

  const family = await prisma.mobileTokenFamily.findFirstOrThrow();
  assert.notEqual(family.revokedAt, null);
  assert.equal(family.revokedReason, "reuse_detected");
  assert.equal(family.epoch, 1);

  const live = await prisma.mobileRefreshRotation.count({
    where: { consumedAt: null, invalidatedAt: null },
  });
  assert.equal(live, 0);

  const events = await prisma.mobileAuthEvent.findMany({ select: { event: true } });
  assert.ok(events.some((row) => row.event === "mobile_auth.reuse_detected"));
});

test("a wrong secret on a consumed record leaves the family standing", async () => {
  // The premise of D5's order, end to end: the record id is the front half of
  // the token and is not a secret, so knowing one must not be a way to end a
  // session.
  const { rotateMobileSession } = await service();
  const user = await createUser();
  const first = await issue(user.id);
  await rotateMobileSession({ request: request(), refreshToken: first.refreshToken });

  const [recordId] = first.refreshToken.split(".");
  const forged = `${recordId}.${randomBytes(32).toString("base64url")}`;
  const result = await rotateMobileSession({ request: request(), refreshToken: forged });
  assert.equal(result.ok, false);

  const family = await prisma.mobileTokenFamily.findFirstOrThrow();
  assert.equal(family.revokedAt, null, "a wrong secret must not revoke anything");
});

test("a revoked family stops authorizing, inside the access token's own lifetime", async () => {
  // The gate in proxy checks signature and expiry; this is the layer that makes
  // a revocation observable before the token expires (D12).
  const { logoutMobileSession } = await service();
  const { authorizeMobileSession } = await authorization();
  const { verifyMobileAccessTokenString } = await accessToken();
  const user = await createUser();
  const tokens = await issue(user.id);

  const before = verifyMobileAccessTokenString(tokens.accessToken);
  assert.equal(before.ok, true);
  assert.equal((await authorizeMobileSession(before.identity)).ok, true);

  await logoutMobileSession({ request: request(), refreshToken: tokens.refreshToken });

  // The token itself is untouched and still verifies. What changed is whether
  // it authorizes anything.
  assert.equal(verifyMobileAccessTokenString(tokens.accessToken).ok, true);
  const after = await authorizeMobileSession(before.identity);
  assert.equal(after.ok, false);
  assert.equal(after.refusal, "family_revoked");
});

test("logout with a wrong secret revokes nothing", async () => {
  const { logoutMobileSession } = await service();
  const user = await createUser();
  const tokens = await issue(user.id);
  const [recordId] = tokens.refreshToken.split(".");

  await logoutMobileSession({
    request: request(),
    refreshToken: `${recordId}.${randomBytes(32).toString("base64url")}`,
  });

  const family = await prisma.mobileTokenFamily.findFirstOrThrow();
  assert.equal(family.revokedAt, null);
});

test("releasing one device ends its families and leaves the other device alone", async () => {
  // D11's narrowest scope. Losing one phone must not sign the other devices out.
  const { revokeMobileDevice } = await service();
  const { authorizeMobileSession } = await authorization();
  const { verifyMobileAccessTokenString } = await accessToken();
  const user = await createUser();
  const phone = await issue(user.id);
  const tablet = await issue(user.id);

  const result = await revokeMobileDevice({ userId: user.id, deviceId: phone.deviceId });
  assert.equal(result.ok, true);

  const phoneIdentity = verifyMobileAccessTokenString(phone.accessToken);
  const tabletIdentity = verifyMobileAccessTokenString(tablet.accessToken);
  assert.equal(phoneIdentity.ok, true);
  assert.equal(tabletIdentity.ok, true);

  const phoneVerdict = await authorizeMobileSession(phoneIdentity.identity);
  assert.equal(phoneVerdict.ok, false);
  assert.equal((await authorizeMobileSession(tabletIdentity.identity)).ok, true);
});

test("another account's device is not found rather than refused", async () => {
  const { revokeMobileDevice } = await service();
  const owner = await createUser();
  const stranger = await createUser();
  const tokens = await issue(owner.id);

  const result = await revokeMobileDevice({
    userId: stranger.id,
    deviceId: tokens.deviceId,
  });
  assert.deepEqual(result, { ok: false, reason: "not_found" });

  const device = await prisma.mobileDevice.findUniqueOrThrow({
    where: { id: tokens.deviceId },
  });
  assert.equal(device.revokedAt, null);
});

test("a global sign-out reaches tokens minted before it and not after", async () => {
  const { authorizeMobileSession, invalidateMobileSessionSnapshots } = await authorization();
  const { verifyMobileAccessTokenString } = await accessToken();
  const user = await createUser();
  const tokens = await issue(user.id);
  const identity = verifyMobileAccessTokenString(tokens.accessToken);
  assert.equal(identity.ok, true);

  await prisma.user.update({
    where: { id: user.id },
    data: { sessionsRevokedAt: new Date(Date.now() + 60_000) },
  });
  invalidateMobileSessionSnapshots(user.id);

  const verdict = await authorizeMobileSession(identity.identity);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.refusal, "sessions_revoked");
});

test("a forced sign-out stops the refresh token too, not only the access token", async () => {
  // The failure this exists to catch: stamping `sessionsRevokedAt` alone stops
  // the access tokens, whose `iat` predates it, and leaves the refresh tokens
  // working -- so the very next refresh mints an access token dated *after* the
  // sign-out and the session quietly comes back. D11 says the widest row takes
  // every family, and this is what proves it does.
  const { rotateMobileSession } = await service();
  const { revokeAllUserSessions } = await import("@/lib/sessionSecurity");
  const user = await createUser();
  const tokens = await issue(user.id);

  await revokeAllUserSessions(user.id);

  const family = await prisma.mobileTokenFamily.findFirstOrThrow();
  assert.notEqual(family.revokedAt, null);
  assert.equal(family.revokedReason, "logout");

  const refreshed = await rotateMobileSession({
    request: request(),
    refreshToken: tokens.refreshToken,
  });
  assert.equal(refreshed.ok, false, "a refresh must not resurrect a signed-out session");
});

test("a forced sign-out keeps the person's list of their own phones", async () => {
  // Ending the sessions is not a decision to forget which devices exist. Only
  // account deletion is, and that removes them by cascade.
  const { revokeAllUserSessions } = await import("@/lib/sessionSecurity");
  const user = await createUser();
  const tokens = await issue(user.id);

  await revokeAllUserSessions(user.id);

  const device = await prisma.mobileDevice.findUniqueOrThrow({
    where: { id: tokens.deviceId },
  });
  assert.equal(device.revokedAt, null);
});

test("a login grant is single use and bound to the verifier that started it", async () => {
  const { consumeMobileLoginGrant, issueMobileLoginGrant, pkceChallengeFor } = await import(
    "@/lib/mobileLoginGrant"
  );
  const user = await createUser();
  const verifier = randomBytes(32).toString("base64url");
  const { grant } = await issueMobileLoginGrant({
    userId: user.id,
    codeChallenge: pkceChallengeFor(verifier),
  });

  // The wrong verifier is refused, and -- because the binding is checked before
  // the state -- it does not spend the grant either.
  const wrong = await consumeMobileLoginGrant({
    grant,
    codeVerifier: randomBytes(32).toString("base64url"),
  });
  assert.deepEqual(wrong, { ok: false, reason: "binding_mismatch" });

  const first = await consumeMobileLoginGrant({ grant, codeVerifier: verifier });
  assert.deepEqual(first, { ok: true, userId: user.id });

  const second = await consumeMobileLoginGrant({ grant, codeVerifier: verifier });
  assert.deepEqual(second, { ok: false, reason: "consumed" });
});

test("an expired grant is refused, and an unknown one says so without a lookup key", async () => {
  const { consumeMobileLoginGrant, issueMobileLoginGrant, pkceChallengeFor } = await import(
    "@/lib/mobileLoginGrant"
  );
  const user = await createUser();
  const verifier = randomBytes(32).toString("base64url");
  const { grant } = await issueMobileLoginGrant({
    userId: user.id,
    codeChallenge: pkceChallengeFor(verifier),
    now: new Date(Date.now() - 120_000),
  });

  assert.deepEqual(await consumeMobileLoginGrant({ grant, codeVerifier: verifier }), {
    ok: false,
    reason: "expired",
  });
  assert.deepEqual(
    await consumeMobileLoginGrant({ grant: "not-a-grant", codeVerifier: verifier }),
    { ok: false, reason: "unknown" }
  );
});

test("V12 -- logging one device out leaves the web session standing", async () => {
  // The policy's third revocation argument, and the half the earlier scope test
  // did not reach: losing one phone must not end the browser session. The two
  // signals that would say otherwise are `sessionsRevokedAt` and the Session
  // rows, so both are checked rather than inferred from the family's state.
  const { logoutMobileSession } = await service();
  const user = await createUser();
  const tokens = await issue(user.id);
  await prisma.session.create({
    data: {
      userId: user.id,
      sessionToken: `web_${randomUUID()}`,
      expires: new Date(Date.now() + 86_400_000),
    },
  });

  await logoutMobileSession({ request: request(), refreshToken: tokens.refreshToken });

  const after = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { sessionsRevokedAt: true },
  });
  assert.equal(after.sessionsRevokedAt, null, "a device logout is not a global sign-out");
  assert.equal(await prisma.session.count({ where: { userId: user.id } }), 1);
});

test("V13 -- releasing one device leaves the web session standing too", async () => {
  const { revokeMobileDevice } = await service();
  const user = await createUser();
  const phone = await issue(user.id);
  await prisma.session.create({
    data: {
      userId: user.id,
      sessionToken: `web_${randomUUID()}`,
      expires: new Date(Date.now() + 86_400_000),
    },
  });

  await revokeMobileDevice({ userId: user.id, deviceId: phone.deviceId });

  const after = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { sessionsRevokedAt: true },
  });
  assert.equal(after.sessionsRevokedAt, null);
  assert.equal(await prisma.session.count({ where: { userId: user.id } }), 1);
});

test("V5 -- the device list is scoped to the account that asked", async () => {
  const { listMobileDevices } = await service();
  const owner = await createUser();
  const stranger = await createUser();
  const owned = await issue(owner.id);
  await issue(stranger.id);

  const devices = await listMobileDevices(owner.id);
  assert.deepEqual(
    devices.map((device) => device.id),
    [owned.deviceId]
  );
  // Another account's device is absent rather than refused: the query is
  // scoped by userId, so there is no branch that could report the difference.
  assert.equal((await listMobileDevices(stranger.id)).length, 1);
});

test("the device list drops a released device and keeps no IP of any kind", async () => {
  // Approved decision 8: no IP is shown or stored, truncated or otherwise.
  const { listMobileDevices, revokeMobileDevice } = await service();
  const user = await createUser();
  const phone = await issue(user.id);
  const tablet = await issue(user.id);

  await revokeMobileDevice({ userId: user.id, deviceId: phone.deviceId });

  const devices = await listMobileDevices(user.id);
  assert.deepEqual(
    devices.map((device) => device.id),
    [tablet.deviceId]
  );
  const fields = Object.keys(devices[0] ?? {});
  assert.deepEqual(fields.sort(), [
    "appVersion",
    "createdAt",
    "id",
    "label",
    "lastSeenAt",
    "platform",
  ]);
});

test("V11 -- a lost response is indistinguishable from a replay, and that is option A", async () => {
  // Recorded rather than worked around. Under strict single use the server
  // cannot tell "the client never received my answer" from "somebody is
  // replaying a token", because the two requests are byte-identical. The
  // consequence is that a client which retries instead of single-flighting
  // loses its session -- which is why native single-flight is an approved
  // implementation requirement rather than an optimisation.
  const { rotateMobileSession } = await service();
  const user = await createUser();
  const first = await issue(user.id);

  const rotated = await rotateMobileSession({
    request: request(),
    refreshToken: first.refreshToken,
  });
  assert.equal(rotated.ok, true);

  // The client never saw that response and retries with the token it still has.
  const retry = await rotateMobileSession({
    request: request(),
    refreshToken: first.refreshToken,
  });
  assert.equal(retry.ok, false);

  const family = await prisma.mobileTokenFamily.findFirstOrThrow();
  assert.equal(family.revokedReason, "reuse_detected");
});

test("V14 -- deleting the account takes every mobile row and leaves one nameless record", async () => {
  // Approved decision 9: deletion removes the rows and identifiers naming the
  // person, their devices and their families, and only a de-identified
  // aggregate may remain. The cascade does the first half; this is the second.
  const { deleteTomverseAccount } = await import("@/lib/accountDeletion");
  const user = await createUser();
  await issue(user.id);
  await issue(user.id);

  const result = await deleteTomverseAccount(user.id, { cancelSubscription: false });
  assert.equal(result.deleted, true);

  assert.equal(await prisma.mobileDevice.count(), 0);
  assert.equal(await prisma.mobileTokenFamily.count(), 0);
  assert.equal(await prisma.mobileRefreshRotation.count(), 0);

  const remaining = await prisma.mobileAuthEvent.findMany();
  assert.equal(remaining.length, 1, "one aggregate row, and only one");
  assert.equal(remaining[0]?.event, "mobile_auth.revoked_on_account_deletion");
  // It survives because it names nobody. A row naming the account would have
  // been taken by the same cascade a moment later.
  assert.equal(remaining[0]?.userId, null);
  assert.equal(remaining[0]?.deviceId, null);
  assert.equal(remaining[0]?.familyId, null);
});

test("V14 -- an account with no mobile session leaves no mobile record at all", async () => {
  // A row on every deletion would count deletions rather than mobile sessions
  // ended, and an operator reading it would draw the wrong number.
  const { deleteTomverseAccount } = await import("@/lib/accountDeletion");
  const user = await createUser();

  await deleteTomverseAccount(user.id, { cancelSubscription: false });

  assert.equal(await prisma.mobileAuthEvent.count(), 0);
});

test("V28 -- logout works when the access token has already expired", async () => {
  // The correction rev.2 made to D14: the most common moment to log out is
  // after the access token has lapsed, so an access-authenticated logout would
  // fail exactly when it is wanted. Nothing here presents one.
  const { logoutMobileSession } = await service();
  const user = await createUser();
  const tokens = await issue(user.id);

  await logoutMobileSession({
    // No Authorization header at all, which is the point.
    request: new Request("https://tomverse.test/api/auth/mobile/logout", {
      method: "POST",
    }),
    refreshToken: tokens.refreshToken,
  });

  const family = await prisma.mobileTokenFamily.findFirstOrThrow();
  assert.notEqual(family.revokedAt, null);
  assert.equal(family.revokedReason, "logout");
});

test("a broken signing key spends no credential -- the route refuses first", async () => {
  // The ordering finding, driven through the real handler rather than the
  // service, because the ordering is the handler's. A base64 string of the
  // right length passes every shape check and cannot sign; before the
  // self-test existed, this request consumed the grant, spent a rate-limit
  // unit and wrote a device and a family before failing.
  const { POST } = await import("@/app/api/auth/mobile/exchange/route");
  const { issueMobileLoginGrant, pkceChallengeFor } = await import(
    "@/lib/mobileLoginGrant"
  );
  const { resetMobileSigningSelfTestForTesting } = await import(
    "@/lib/mobileAccessToken"
  );

  const user = await createUser();
  const verifier = randomBytes(32).toString("base64url");
  const { grant } = await issueMobileLoginGrant({
    userId: user.id,
    codeChallenge: pkceChallengeFor(verifier),
  });

  const goodKeys = process.env.MOBILE_AUTH_SIGNING_KEYS;
  process.env.MOBILE_AUTH_SIGNING_KEYS = `sign-1:${Buffer.from(
    "x".repeat(64),
    "utf8"
  ).toString("base64")}`;
  resetMobileSigningSelfTestForTesting();

  try {
    const response = await POST(
      new Request("https://tomverse.test/api/auth/mobile/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant,
          codeVerifier: verifier,
          platform: "ios",
          deviceLabel: "Phone",
        }),
      })
    );

    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "NOT_AVAILABLE");
  } finally {
    process.env.MOBILE_AUTH_SIGNING_KEYS = goodKeys;
    resetMobileSigningSelfTestForTesting();
  }

  assert.equal(await prisma.mobileDevice.count(), 0, "no device was created");
  assert.equal(await prisma.mobileTokenFamily.count(), 0, "no family was created");
  assert.equal(await prisma.mobileRefreshRotation.count(), 0);

  // And the grant is still spendable, so the person can simply try again once
  // the key is fixed rather than having to start the sign-in over.
  const stillThere = await prisma.mobileLoginGrant.findFirstOrThrow();
  assert.equal(stillThere.consumedAt, null);
});

test("with a working key the same request succeeds, so the refusal above was the key", async () => {
  // The other half. Without this, "503 and no rows" would also be what a
  // broken handler produces.
  const { POST } = await import("@/app/api/auth/mobile/exchange/route");
  const { issueMobileLoginGrant, pkceChallengeFor } = await import(
    "@/lib/mobileLoginGrant"
  );

  const user = await createUser();
  const verifier = randomBytes(32).toString("base64url");
  const { grant } = await issueMobileLoginGrant({
    userId: user.id,
    codeChallenge: pkceChallengeFor(verifier),
  });

  const response = await POST(
    new Request("https://tomverse.test/api/auth/mobile/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant,
        codeVerifier: verifier,
        platform: "ios",
        deviceLabel: "Phone",
      }),
    })
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.accessToken && body.refreshToken && body.deviceId);
  assert.equal(await prisma.mobileDevice.count(), 1);
});

test("an unparseable refresh token writes no row, and the endpoint is rate limited first", async () => {
  // Review finding 3. Before this, every malformed request wrote a
  // MobileAuthEvent with no subject and nothing bounding the rate, on a path
  // that is a mutation-origin exception and therefore reachable by anyone.
  const { rotateMobileSession } = await service();
  const { MOBILE_AUTH_PRE_AUTH_RATE_LIMIT } = await import("@/lib/mobileAuthContract");
  const { POST } = await import("@/app/api/auth/mobile/refresh/route");

  for (const bad of ["", "no-dot", "a.b.c", "..", "x."]) {
    const result = await rotateMobileSession({ request: request(), refreshToken: bad });
    assert.equal(result.ok, false, bad);
  }
  assert.equal(await prisma.mobileAuthEvent.count(), 0, "a malformed token names nobody");

  // And the handler admits before it reads the body, so the refusal above is
  // not free to repeat without limit.
  const send = () =>
    POST(
      new Request("https://tomverse.test/api/auth/mobile/refresh", {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": "203.0.113.9" },
        body: JSON.stringify({ refreshToken: "no-dot" }),
      })
    );

  let limited: Response | null = null;
  // A burst can begin just before a UTC minute boundary. Use two complete
  // minute allowances plus one request so one of the at-most-two buckets must
  // cross the limit; 80 allowed a 22:16:59 -> 22:17:00 split to evade it.
  const burstAttempts = MOBILE_AUTH_PRE_AUTH_RATE_LIMIT.minute * 2 + 1;
  for (let attempt = 0; attempt < burstAttempts && !limited; attempt += 1) {
    const response = await send();
    if (response.status === 429) limited = response;
  }
  assert.ok(limited, "the pre-auth limit must eventually refuse");

  // The body, not only the status. Checking the status alone is what let the
  // contract and the wire disagree: every limit in the app throws the shared
  // API_RATE_LIMITED, and D15 names MOBILE_RATE_LIMITED for these endpoints.
  const body = await limited.json();
  assert.equal(body.code, "MOBILE_RATE_LIMITED");
  assert.equal(body.ok, false);
  assert.ok(limited.headers.get("Retry-After"), "a rate-limit answer must say when");
});

test("every client-facing code in the contract is one a route actually returns", async () => {
  // The finding this covers: MOBILE_RATE_LIMITED was declared and never
  // reached execution, because the shared responder returned its own code.
  // A constant nothing emits is a contract nobody keeps, so each of the four
  // is taken off the wire here rather than read out of the source.
  const { MOBILE_AUTH_ERROR_CODES, MOBILE_AUTH_PRE_AUTH_RATE_LIMIT } = await import(
    "@/lib/mobileAuthContract"
  );
  const refresh = (await import("@/app/api/auth/mobile/refresh/route")).POST;
  const devices = (await import("@/app/api/auth/mobile/devices/route")).GET;
  const seen = new Set<string>();

  // MOBILE_TOKEN_INVALID -- no bearer at all.
  const noBearer = await devices(
    new Request("https://tomverse.test/api/auth/mobile/devices")
  );
  assert.equal(noBearer.status, 401);
  seen.add((await noBearer.json()).code);

  // MOBILE_TOKEN_EXPIRED -- a real token, past its life.
  const { mintMobileAccessToken } = await import("@/lib/mobileAccessToken");
  const user = await createUser();
  const tokens = await issue(user.id);
  const expired = mintMobileAccessToken({
    userId: user.id,
    deviceId: tokens.deviceId,
    familyId: (await prisma.mobileTokenFamily.findFirstOrThrow()).id,
    now: new Date(Date.now() - 3_600_000),
  });
  const stale = await devices(
    new Request("https://tomverse.test/api/auth/mobile/devices", {
      headers: { authorization: `Bearer ${expired.token}` },
    })
  );
  assert.equal(stale.status, 401);
  seen.add((await stale.json()).code);

  // MOBILE_REFRESH_REJECTED -- a syntactically fine token that is not one.
  const rejected = await refresh(
    new Request("https://tomverse.test/api/auth/mobile/refresh", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "198.51.100.7" },
      body: JSON.stringify({ refreshToken: "abc.def" }),
    })
  );
  assert.equal(rejected.status, 401);
  const rejectedBody = await rejected.json();
  seen.add(rejectedBody.code);
  assert.equal(rejectedBody.reauthenticate, true);

  // MOBILE_RATE_LIMITED, from a real 429 rather than from the constant.
  //
  // Injecting it here is what the previous version did, and the test name --
  // "one a route actually returns" -- was then untrue of a quarter of the map.
  // A different client address, so this is this test's own bucket.
  const spend = () =>
    refresh(
      new Request("https://tomverse.test/api/auth/mobile/refresh", {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": "192.0.2.44" },
        body: JSON.stringify({ refreshToken: "no-dot" }),
      })
    );
  let limited: Response | null = null;
  // Keep this proof stable when the burst straddles a UTC minute boundary.
  // The admission ceiling is 60, so 121 requests cannot fit into two buckets.
  const burstAttempts = MOBILE_AUTH_PRE_AUTH_RATE_LIMIT.minute * 2 + 1;
  for (let attempt = 0; attempt < burstAttempts && !limited; attempt += 1) {
    const response = await spend();
    if (response.status === 429) limited = response;
  }
  assert.ok(limited, "the admission limit must be reachable from the route");
  seen.add((await limited.json()).code);

  assert.deepEqual(
    [...seen].sort(),
    Object.values(MOBILE_AUTH_ERROR_CODES).sort(),
    "a code the contract declares and no route emits is a promise nobody keeps"
  );
});

test("no audit row carries a token, a digest or a record id", async () => {
  // D15's forbidden list, checked against what was actually written rather
  // than against the schema's intent.
  const { rotateMobileSession } = await service();
  const user = await createUser();
  const first = await issue(user.id);
  await rotateMobileSession({ request: request(), refreshToken: first.refreshToken });
  await rotateMobileSession({ request: request(), refreshToken: first.refreshToken });

  const events = await prisma.mobileAuthEvent.findMany();
  assert.ok(events.length >= 3);
  const serialized = JSON.stringify(events);
  const [recordId, secret] = first.refreshToken.split(".");
  for (const forbidden of [first.refreshToken, first.accessToken, recordId!, secret!]) {
    assert.ok(!serialized.includes(forbidden), "an audit row carried a credential");
  }
});

test("Desktop Chat prepares signed memory only for its current saved question and available model", async () => {
  const { issueMobileSession } = await service();
  const context = await import("@/app/api/chat/context/route");
  const { verifyChatContextBundle } = await import("@/lib/chatContextBundleService");
  const { MEMORY_INJECTION_FLAG_KEY } = await import("@/lib/memoryAccess");
  const { memoryRetrievalTerms, MEMORY_RETRIEVAL_VERSION } = await import("@/lib/memoryRetrievalTerms");
  const { prepareMemoryHistoryContext } = await import("@/lib/memoryHistorySnapshot");
  const user = await createUser();
  const other = await createUser();
  const modelId = "gpt-6-luna";
  const createChat = (userId: string, productKey = "chat", password: string | null = null) =>
    prisma.conversation.create({ data: { userId, productKey, password, title: "Desktop memory fixture", selectedModels: JSON.stringify([modelId]) } });
  const own = await createChat(user.id);
  const foreign = await createChat(other.id);
  const locked = await createChat(user.id, "chat", "locked");
  const review = await createChat(user.id, "review");
  const statement = "The user prefers decaffeinated coffee.";
  const now = Date.now();
  const save = (conversationId: string, content: string, offset = 0) =>
    prisma.message.create({ data: { conversationId, role: "user", content, createdAt: new Date(now + offset) } });
  const older = await save(own.id, "An earlier question about coffee.", -2_000);
  const previous = await save(own.id, "Which coffee makers are practical?", -1_000);
  const saved = await save(own.id, "Recommend a decaffeinated coffee.");
  const foreignQuestion = await save(foreign.id, "Another account's question.");
  const { tokens } = await issueMobileSession({ request: request(), userId: user.id, platform: "desktop", deviceLabel: "Desktop" });
  const mobile = await issue(user.id);
  const payload = { conversationId: own.id, sourceUserMessageId: saved.id, modelId };
  const prepare = (body: object, overrides: Record<string, string> = {}, method = "POST") => new Request("https://tomverse.test/api/chat/context", {
    method, headers: { Authorization: `Bearer ${tokens.accessToken}`, "Content-Type": "application/json",
      Origin: "tomverse://desktop", ...overrides },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
  const flags = ["TOMVERSE_DESKTOP_AUTH_ENABLED", "TOMVERSE_DESKTOP_CHAT_WRITE_ENABLED", "TOMVERSE_DESKTOP_REVIEW_ENABLED",
    "MEMORY_RELEVANCE_CONTEXT_ENABLED"] as const;
  const originals = flags.map((key) => process.env[key]);
  process.env.TOMVERSE_DESKTOP_AUTH_ENABLED = "true";
  process.env.TOMVERSE_DESKTOP_CHAT_WRITE_ENABLED = "true";
  process.env.TOMVERSE_DESKTOP_REVIEW_ENABLED = "true";
  process.env.MEMORY_RELEVANCE_CONTEXT_ENABLED = "true";
  try {
    await prisma.appSetting.create({ data: { key: MEMORY_INJECTION_FLAG_KEY, value: "true" } });
    await prisma.memoryItem.create({ data: { userId: user.id, kind: "preference", statement, status: "active",
      confidence: 0.9, approvedAt: new Date(), retrievalVersion: MEMORY_RETRIEVAL_VERSION, searchTerms: memoryRetrievalTerms(statement) } });
    const response = await context.POST(prepare(payload));
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.equal(body.memoryUsedCount, 1);
    const verification = verifyChatContextBundle(body.contextBundle, { subjectKey: user.id, conversationId: own.id, modelId });
    assert.ok(verification.ok && verification.payload.memoryTokens > 0);
    assert.ok(!JSON.stringify(verification.payload).includes(statement));
    assert.equal(verifyChatContextBundle(body.contextBundle, { subjectKey: other.id, conversationId: own.id, modelId }).ok, false);
    const history = await prepareMemoryHistoryContext({ request: prepare(payload), userId: user.id, conversationId: own.id,
      query: saved.content, modelIds: [modelId], currentQuestionId: saved.id })?.();
    assert.deepEqual(history?.history.map(({ id }) => id), [older.id, previous.id]);
    assert.equal((await context.POST(prepare({ ...payload, prompt: "A renderer-supplied query" }))).status, 400);
    assert.equal((await context.POST(prepare({ ...payload, conversationId: foreign.id, sourceUserMessageId: foreignQuestion.id }))).status, 403);
    // A Review is a writable Desktop conversation now; the question belongs to another conversation, so it is a conflict, not a refusal.
    assert.equal((await context.POST(prepare({ ...payload, conversationId: review.id }))).status, 409);
    assert.equal((await context.POST(prepare({ ...payload, conversationId: locked.id }))).status, 423);
    assert.equal((await context.POST(prepare({ ...payload, sourceUserMessageId: older.id }))).status, 409);
    assert.equal((await context.POST(prepare({ ...payload, modelId: "another-model" }))).status, 409);
    assert.equal((await context.POST(prepare(payload, { Cookie: "session=ambient" }))).status, 401);
    assert.equal((await context.POST(prepare(payload, { Authorization: `Bearer ${mobile.accessToken}` }))).status, 401);
    assert.equal((await context.POST(prepare({ ...payload, previousContextBundle: "fabricated" }))).status, 400);
    await prisma.conversation.update({ where: { id: own.id }, data: { selectedModels: "[]" } });
    assert.deepEqual(await (await context.POST(prepare(payload))).json(), { ok: true, contextBundle: null, memoryUsedCount: 0 });
    const retiredModel = "llama-3-1";
    const replacementModel = "deepseek-v4-flash";
    const replacementPayload = { ...payload, modelId: replacementModel };
    await prisma.conversation.update({ where: { id: own.id }, data: {
      selectedModels: JSON.stringify(JSON.stringify([retiredModel])), selectionMode: "auto",
    } });
    const replacement = await context.POST(prepare(replacementPayload));
    assert.equal(replacement.status, 200, await replacement.clone().text());
    const replacementBody = await replacement.json();
    assert.equal(replacementBody.memoryUsedCount, 1);
    assert.ok(verifyChatContextBundle(replacementBody.contextBundle,
      { subjectKey: user.id, conversationId: own.id, modelId: replacementModel }).ok);
    assert.equal((await context.POST(prepare({ ...payload, modelId: retiredModel }))).status, 409);
    await prisma.conversation.update({ where: { id: own.id }, data: {
      disabledPanels: JSON.stringify(JSON.stringify([retiredModel])),
    } });
    assert.equal((await context.POST(prepare(replacementPayload))).status, 409);
    await prisma.conversation.update({ where: { id: own.id }, data: {
      selectedModels: JSON.stringify([replacementModel]),
    } });
    assert.equal((await context.POST(prepare(replacementPayload))).status, 409);
    await prisma.conversation.update({ where: { id: own.id }, data: {
      selectedModels: JSON.stringify([modelId]), disabledPanels: "[]", selectionMode: "manual",
    } });
    await prisma.userMemorySettings.upsert({ where: { userId: user.id },
      create: { userId: user.id, masterEnabled: false }, update: { masterEnabled: false } });
    const stopped = await context.POST(prepare({ ...payload, previousContextBundle: body.contextBundle }));
    assert.equal(stopped.status, 200);
    assert.deepEqual(await stopped.json(), { ok: true, contextBundle: null, memoryUsedCount: 0, reason: "account_off" });
    process.env.TOMVERSE_DESKTOP_CHAT_WRITE_ENABLED = "false";
    assert.equal((await context.POST(prepare(payload))).status, 401);
  } finally {
    await prisma.appSetting.deleteMany({ where: { key: MEMORY_INJECTION_FLAG_KEY } });
    flags.forEach((key, index) => {
      if (originals[index] === undefined) delete process.env[key];
      else process.env[key] = originals[index];
    });
  }
});
