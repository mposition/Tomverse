import assert from "node:assert/strict";
import test from "node:test";

process.env.NEXTAUTH_SECRET ||= "guest-turnstile-grant-test-secret-000000";

import {
  buildGuestTurnstileGrantCookie,
  GUEST_TURNSTILE_ACTIONS,
  hasValidGuestTurnstileGrant,
  type GuestTurnstileAction,
} from "../lib/turnstile.ts";

/**
 * SEC-004. The Turnstile grant cookie used to be signed over nothing but its
 * own expiry, which made it both transferable and universal:
 *
 *   * transferable -- the signature named no client, so one scripted solve
 *     produced a 30-minute bearer token usable from any address;
 *   * universal -- the signature named no action, so passing the cheapest
 *     challenge (`guest_chat`) also bought thirty minutes of `guest_ai_review`
 *     (an 8-credit AI cross-review) and `guest_attachment` (a worker-isolated
 *     file parse).
 *
 * The client already mints an action-bound token per surface. These assert the
 * server stopped collapsing them.
 */

const cookieValue = (setCookie: string) => setCookie.split(";")[0];

const requestWith = (
  cookies: string[],
  ip = "203.0.113.5",
  userAgent = "grant-test-agent"
) =>
  new Request("https://tomverse.app/api/chat", {
    method: "POST",
    headers: {
      "x-real-ip": ip,
      "user-agent": userAgent,
      ...(cookies.length ? { cookie: cookies.join("; ") } : {}),
    },
  });

const grantFor = (
  action: GuestTurnstileAction,
  ip = "203.0.113.5",
  userAgent = "grant-test-agent"
) => cookieValue(buildGuestTurnstileGrantCookie(requestWith([], ip, userAgent), action));

test("a fresh grant satisfies the action it was earned for", () => {
  for (const action of GUEST_TURNSTILE_ACTIONS) {
    const request = requestWith([grantFor(action)]);
    assert.equal(
      hasValidGuestTurnstileGrant(request, action),
      true,
      `${action} must accept its own grant`
    );
  }
});

test("a grant does not satisfy a different, more expensive action", () => {
  const chatGrant = grantFor("guest_chat");
  const request = requestWith([chatGrant]);

  for (const action of ["guest_ai_review", "guest_attachment", "guest_quick_summary", "support_request"] as const) {
    assert.equal(
      hasValidGuestTurnstileGrant(request, action),
      false,
      `a guest_chat grant must not buy ${action}`
    );
  }
});

test("no action's grant unlocks every other action", () => {
  for (const earned of GUEST_TURNSTILE_ACTIONS) {
    const request = requestWith([grantFor(earned)]);
    const unlocked = GUEST_TURNSTILE_ACTIONS.filter((action) =>
      hasValidGuestTurnstileGrant(request, action)
    );
    assert.ok(
      unlocked.length < GUEST_TURNSTILE_ACTIONS.length,
      `a ${earned} grant must not unlock everything`
    );
    assert.ok(unlocked.includes(earned));
  }
});

test("a chat grant still covers the background title generation", () => {
  // The title call is fired once per conversation right after a successful
  // guest answer, sends no token of its own, and must never be the reason a
  // challenge appears.
  const request = requestWith([grantFor("guest_chat")]);
  assert.equal(
    hasValidGuestTurnstileGrant(request, "guest_conversation_title"),
    true
  );
  // ...but a title grant does not work backwards into a chat turn.
  const titleOnly = requestWith([grantFor("guest_conversation_title")]);
  assert.equal(hasValidGuestTurnstileGrant(titleOnly, "guest_chat"), false);
});

test("a grant lifted from another client is refused", () => {
  const stolen = grantFor("guest_chat", "203.0.113.5", "victim-agent");

  assert.equal(
    hasValidGuestTurnstileGrant(
      requestWith([stolen], "203.0.113.5", "victim-agent"),
      "guest_chat"
    ),
    true,
    "the original client keeps its grant"
  );
  assert.equal(
    hasValidGuestTurnstileGrant(
      requestWith([stolen], "198.51.100.9", "victim-agent"),
      "guest_chat"
    ),
    false,
    "replaying the cookie from another address must fail"
  );
});

test("grants for several actions coexist rather than evicting each other", () => {
  const request = requestWith([
    grantFor("guest_chat"),
    grantFor("guest_attachment"),
  ]);
  assert.equal(hasValidGuestTurnstileGrant(request, "guest_chat"), true);
  assert.equal(hasValidGuestTurnstileGrant(request, "guest_attachment"), true);
  assert.equal(hasValidGuestTurnstileGrant(request, "guest_ai_review"), false);
});

test("a tampered expiry, signature or action is refused", () => {
  const grant = grantFor("guest_ai_review");
  const [name, value] = grant.split("=");
  const [expiresAt, signature] = value.split(".");

  const cases = [
    `${name}=${Number(expiresAt) + 86_400}.${signature}`,
    `${name}=${expiresAt}.${signature.slice(0, -1)}x`,
    `${name}=${expiresAt}.`,
    `${name}=${expiresAt}`,
    `${name}=${expiresAt}.${signature}.extra`,
    `${name}=notanumber.${signature}`,
    // The same signature moved onto a different action's cookie name.
    `tomverse_guest_verified_guest_attachment=${expiresAt}.${signature}`,
  ];
  for (const tampered of cases) {
    const request = requestWith([tampered]);
    const accepted = GUEST_TURNSTILE_ACTIONS.some((action) =>
      hasValidGuestTurnstileGrant(request, action)
    );
    assert.equal(accepted, false, `must reject: ${tampered}`);
  }
});

test("an expired grant is refused", () => {
  const grant = grantFor("guest_chat");
  const [name, value] = grant.split("=");
  const [, signature] = value.split(".");
  const past = Math.floor(Date.now() / 1000) - 10;
  assert.equal(
    hasValidGuestTurnstileGrant(
      requestWith([`${name}=${past}.${signature}`]),
      "guest_chat"
    ),
    false
  );
});

test("no grant at all means no grant", () => {
  const request = requestWith([]);
  for (const action of GUEST_TURNSTILE_ACTIONS) {
    assert.equal(hasValidGuestTurnstileGrant(request, action), false);
  }
});

test("the cookie is HttpOnly, path-scoped and short-lived", () => {
  const cookie = buildGuestTurnstileGrantCookie(requestWith([]), "guest_chat");
  assert.match(cookie, /^tomverse_guest_verified_guest_chat=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)?.[1]);
  assert.ok(maxAge > 0 && maxAge <= 60 * 30, "the grant must stay short-lived");
});
