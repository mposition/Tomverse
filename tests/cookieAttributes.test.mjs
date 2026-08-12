import assert from "node:assert/strict";
import test from "node:test";

// Every cookie this application sets, held to one policy.
//
// There are five builders and each writes its attributes as a hand-typed
// string. Nothing compared them, so the guarantees rested on five people
// having typed the same thing -- and they had not: the OAuth link-state
// clear omitted `Secure` while the setter that created it included it.
//
// A credential cookie here has to be:
//
//   HttpOnly      no script of ours reads it, so nothing injected can either;
//   SameSite      a cross-site request must not carry it;
//   Path=/        the grant applies to the whole application;
//   Secure        in production only, because the development server is HTTP
//                 and a Secure cookie would simply never be stored there.
//
// The theme cookie is the one deliberate exception and it is stated below
// rather than skipped: an exception nobody wrote down is indistinguishable
// from an omission.

process.env.NEXTAUTH_SECRET ||= "cookie-attribute-test-secret-0000000000";

const load = async (path) => import(path);

const attributes = (cookie) => {
  const [, ...rest] = cookie.split(";").map((part) => part.trim());
  return new Set(rest.map((part) => part.split("=")[0]));
};

const name = (cookie) => cookie.split("=")[0];

/**
 * Builds every cookie under one NODE_ENV.
 *
 * Rebuilt per environment rather than captured once, because `Secure` is
 * decided when the string is made and the whole point is to check both.
 */
const buildAll = async (nodeEnv) => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = nodeEnv;
  try {
    const conversationLock = await load("../lib/conversationLock.ts");
    const oauthLink = await load("../lib/oauthLink.ts");
    const turnstile = await load("../lib/turnstile.ts");
    return {
      unlockGrant: conversationLock.createConversationUnlockCookie(
        "user-1",
        "conversation-1",
        "stored-password-hash"
      ),
      unlockClear: conversationLock.clearConversationUnlockCookie("conversation-1"),
      oauthStateClear: oauthLink.clearOAuthLinkStateCookie(),
      turnstileGrant: turnstile.buildGuestTurnstileGrantCookie(
        new Request("https://tomverse.app/api/feedback", {
          headers: { "user-agent": "test", "x-forwarded-for": "203.0.113.5" },
        }),
        "feedback"
      ),
    };
  } finally {
    process.env.NODE_ENV = previous;
  }
};

test("every credential cookie is HttpOnly, SameSite and Path=/", async () => {
  const cookies = await buildAll("production");
  for (const [label, cookie] of Object.entries(cookies)) {
    const has = attributes(cookie);
    assert.ok(has.has("HttpOnly"), `${label} is not HttpOnly`);
    assert.ok(has.has("SameSite"), `${label} has no SameSite`);
    assert.ok(has.has("Path"), `${label} has no Path`);
  }
});

test("every credential cookie is Secure in production", async () => {
  const cookies = await buildAll("production");
  for (const [label, cookie] of Object.entries(cookies)) {
    assert.ok(
      attributes(cookie).has("Secure"),
      `${label} is not Secure in production`
    );
  }
});

// Not cosmetic: the development server is plain HTTP, and a Secure cookie sent
// over it is simply not stored, so every grant would silently fail to persist.
test("no credential cookie is Secure outside production", async () => {
  const cookies = await buildAll("development");
  for (const [label, cookie] of Object.entries(cookies)) {
    assert.equal(
      attributes(cookie).has("Secure"),
      false,
      `${label} is Secure in development, where it would never be stored`
    );
  }
});

// The drift this test exists for: a clear that does not mirror its setter.
test("a clearing cookie carries the same attributes as its setter", async () => {
  for (const nodeEnv of ["production", "development"]) {
    const conversationLock = await load("../lib/conversationLock.ts");
    const oauthLink = await load("../lib/oauthLink.ts");
    const built = await buildAll(nodeEnv);

    assert.deepEqual(
      [...attributes(built.unlockClear)].sort(),
      [...attributes(built.unlockGrant)].sort(),
      `the unlock clear and setter disagree in ${nodeEnv}`
    );
    assert.equal(name(built.unlockClear), name(built.unlockGrant));

    // The OAuth state setter is not exported, so its attributes are asserted
    // against the policy directly rather than against the setter's string.
    const clearAttributes = attributes(built.oauthStateClear);
    for (const required of ["HttpOnly", "SameSite", "Path"]) {
      assert.ok(
        clearAttributes.has(required),
        `the OAuth state clear has no ${required} in ${nodeEnv}`
      );
    }
    assert.equal(
      clearAttributes.has("Secure"),
      nodeEnv === "production",
      `the OAuth state clear disagrees with its setter about Secure in ${nodeEnv}`
    );
    assert.ok(conversationLock && oauthLink);
  }
});

test("a clear expires the cookie rather than merely emptying it", async () => {
  const cookies = await buildAll("production");
  for (const label of ["unlockClear", "oauthStateClear"]) {
    assert.match(cookies[label], /Max-Age=0\b/, `${label} does not expire`);
  }
});

// Stated, not skipped. The theme is not a credential and the pre-paint
// bootstrap has to read it before any script of ours runs, so it is the one
// cookie that is deliberately not HttpOnly.
test("the theme cookie is the one documented exception", async () => {
  const { themeCookieValue } = await load("../lib/theme.ts");
  const cookie = themeCookieValue("dark");
  const has = attributes(cookie);

  assert.equal(has.has("HttpOnly"), false, "the exception has stopped being one");
  assert.ok(has.has("SameSite"), "even the theme cookie must not travel cross-site");
  assert.ok(has.has("Path"));
  // It carries no credential and no account data -- a preference readable by
  // the page that already renders it.
  assert.match(cookie, /^[\w.-]+=dark;/);
});
