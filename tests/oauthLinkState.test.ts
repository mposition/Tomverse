import assert from "node:assert/strict";
import test from "node:test";

// buildOAuthLinkAuthorizeRedirect validates full provider OAuth config
// (client id/secret) before it ever gets to the state-cookie signing this
// suite actually exercises -- fill in placeholders so tests don't depend on
// real credentials being present in the environment they run in.
process.env.NEXTAUTH_SECRET ||= "oauth-link-test-secret-not-for-real-use-32-chars";
process.env.GOOGLE_ID ||= "test-google-client-id";
process.env.GOOGLE_SECRET ||= "test-google-client-secret";
process.env.AZURE_AD_CLIENT_ID ||= "test-azure-client-id";
process.env.AZURE_AD_CLIENT_SECRET ||= "test-azure-client-secret";
process.env.AZURE_AD_TENANT_ID ||= "test-azure-tenant-id";

import {
  buildOAuthLinkAuthorizeRedirect,
  resolveOAuthLinkProviderFromState,
} from "../lib/oauthLink.ts";

// Regression coverage for an incident where re-linking (or first-time
// linking) a Google/Microsoft login method always failed with
// INVALID_CALLBACK in production: the callback route required a
// "?provider=..." URL query param that Google/Microsoft never actually
// send back (only the redirect_uri we registered, which carries no such
// param), so every real callback was rejected before completeOAuthLink()
// ever ran. The fix reads the provider from the signed OAuth state cookie
// instead of the callback URL.

const STATE_COOKIE_NAME = "tomverse_oauth_link_state";

const extractStateCookieValue = (setCookieHeader: string) => {
  const match = setCookieHeader.match(new RegExp(`${STATE_COOKIE_NAME}=([^;]+)`));
  if (!match) throw new Error("state cookie not found in Set-Cookie header");
  return match[1];
};

const requestWithCookie = (cookieValue: string | null) =>
  new Request("https://tomverse.test/api/user/login-methods/oauth/callback?code=abc&state=xyz", {
    headers: cookieValue ? { cookie: `${STATE_COOKIE_NAME}=${cookieValue}` } : {},
  });

test("resolves the provider from a freshly issued state cookie", () => {
  const startRequest = new Request("https://tomverse.test/api/user/login-methods/oauth/start?provider=google");
  const { cookie } = buildOAuthLinkAuthorizeRedirect(startRequest, "user-1", "google");
  const cookieValue = extractStateCookieValue(cookie);

  const provider = resolveOAuthLinkProviderFromState(requestWithCookie(cookieValue));
  assert.equal(provider, "google");
});

test("ignores a conflicting provider claimed in the callback URL query string", () => {
  const startRequest = new Request("https://tomverse.test/api/user/login-methods/oauth/start?provider=google");
  const { cookie } = buildOAuthLinkAuthorizeRedirect(startRequest, "user-1", "google");
  const cookieValue = extractStateCookieValue(cookie);

  const spoofedRequest = new Request(
    "https://tomverse.test/api/user/login-methods/oauth/callback?provider=azure-ad&code=abc&state=xyz",
    { headers: { cookie: `${STATE_COOKIE_NAME}=${cookieValue}` } }
  );
  assert.equal(resolveOAuthLinkProviderFromState(spoofedRequest), "google");
});

test("returns null when no state cookie is present", () => {
  assert.equal(resolveOAuthLinkProviderFromState(requestWithCookie(null)), null);
});

test("returns null when the state cookie signature has been tampered with", () => {
  const startRequest = new Request("https://tomverse.test/api/user/login-methods/oauth/start?provider=azure-ad");
  const { cookie } = buildOAuthLinkAuthorizeRedirect(startRequest, "user-1", "azure-ad");
  const cookieValue = extractStateCookieValue(cookie);
  const tampered = cookieValue.slice(0, -1) + (cookieValue.endsWith("A") ? "B" : "A");

  assert.equal(resolveOAuthLinkProviderFromState(requestWithCookie(tampered)), null);
});
