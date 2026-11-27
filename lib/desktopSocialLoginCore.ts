import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { DESKTOP_AUTH_VALUE, isDesktopRedirect } from "./desktopAuthContract";

/**
 * Adding Google or Microsoft as a login method from Tomverse Desktop.
 *
 * The web flow keeps its PKCE verifier and the user id in a signed cookie of the browser that started it. Desktop
 * starts from its settings session and finishes in the system browser, which has no such session, so the state here
 * is one signed token instead of a cookie:
 *
 * - the provider's `state` is the token itself (provider, loopback redirect, PKCE challenge, nonce, expiry, and a
 *   keyed hash that ties it to the user who started it, never the user id itself);
 * - the verifier never leaves the Desktop app until it is spent: Desktop makes the PKCE pair, the server puts the
 *   challenge in the authorize URL, and the same verifier comes back in the final call, where the server hands it to
 *   the provider's token endpoint;
 * - the provider returns to the already registered callback, which only forwards `code` to the loopback address that
 *   is signed inside the token; the link itself is made by a second call from the Desktop settings session, so an
 *   anonymous browser can never attach an account.
 *
 * Default off: `TOMVERSE_DESKTOP_SOCIAL_LOGIN_ENABLED`, on top of Desktop sign-in and account settings.
 */

export const DESKTOP_LINK_PROVIDERS = ["google", "azure-ad"] as const;
export type DesktopLinkProvider = typeof DESKTOP_LINK_PROVIDERS[number];

export const DESKTOP_LINK_STATE_PREFIX = "dl1.";
export const DESKTOP_LINK_STATE_MAX_LENGTH = 1_024;
export const DESKTOP_LINK_STATE_TTL_MS = 10 * 60_000;
export const DESKTOP_LINK_CODE_MAX_LENGTH = 4_096;
export const DESKTOP_LINK_VERIFIER = /^[A-Za-z0-9_-]{43,128}$/;

type Env = Record<string, string | undefined>;

export const desktopSocialLoginEnabled = (env: Env = process.env) =>
  env.TOMVERSE_DESKTOP_SOCIAL_LOGIN_ENABLED === "true" &&
  env.TOMVERSE_DESKTOP_AUTH_ENABLED === "true" &&
  env.TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_ENABLED === "true";

/** Mirrors the credentials `lib/oauthLink.ts` needs for each provider. */
export function desktopLinkProviderConfigured(provider: DesktopLinkProvider, env: Env = process.env) {
  if (provider === "google") return Boolean(env.GOOGLE_ID && env.GOOGLE_SECRET);
  return Boolean(env.AZURE_AD_CLIENT_ID && env.AZURE_AD_CLIENT_SECRET && env.AZURE_AD_TENANT_ID?.trim());
}

/** What the capability signal offers: nothing while the switch is off, otherwise only providers this server can reach. */
export const desktopLinkProviders = (env: Env = process.env): DesktopLinkProvider[] =>
  desktopSocialLoginEnabled(env) ? DESKTOP_LINK_PROVIDERS.filter((provider) => desktopLinkProviderConfigured(provider, env)) : [];

export type DesktopLinkState = { p: DesktopLinkProvider; r: string; c: string; n: string; u: string; e: number };

const sign = (secret: string, body: string) =>
  createHmac("sha256", secret).update(`desktop-oauth-link-state:${body}`).digest("base64url");

const userBinding = (secret: string, userId: string, nonce: string) =>
  createHmac("sha256", secret).update(`desktop-oauth-link-user:${nonce}:${userId}`).digest("base64url");

const sameText = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function issueDesktopLinkState(input: {
  secret: string; userId: string; provider: DesktopLinkProvider; redirectUri: string; codeChallenge: string; now: number;
}): string {
  const nonce = randomBytes(16).toString("base64url");
  const payload: DesktopLinkState = {
    p: input.provider, r: input.redirectUri, c: input.codeChallenge, n: nonce,
    u: userBinding(input.secret, input.userId, nonce), e: input.now + DESKTOP_LINK_STATE_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${DESKTOP_LINK_STATE_PREFIX}${body}.${sign(input.secret, body)}`;
}

/** Signature, shape and lifetime only. Who it belongs to is `desktopLinkStateOwnedBy`. */
export function readDesktopLinkState(secret: string, token: string | null | undefined, now: number): DesktopLinkState | null {
  if (!token || token.length > DESKTOP_LINK_STATE_MAX_LENGTH || !token.startsWith(DESKTOP_LINK_STATE_PREFIX)) return null;
  const [body, signature, extra] = token.slice(DESKTOP_LINK_STATE_PREFIX.length).split(".");
  if (!body || !signature || extra !== undefined || !sameText(signature, sign(secret, body))) return null;
  let payload: Partial<DesktopLinkState>;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const { p, r, c, n, u, e } = payload;
  if (!DESKTOP_LINK_PROVIDERS.includes(p as DesktopLinkProvider) || typeof r !== "string" || !isDesktopRedirect(r) ||
      typeof c !== "string" || !DESKTOP_AUTH_VALUE.test(c) || typeof n !== "string" || typeof u !== "string" ||
      typeof e !== "number" || !Number.isFinite(e) || e <= now) return null;
  return { p: p as DesktopLinkProvider, r, c, n, u, e };
}

export const desktopLinkStateOwnedBy = (secret: string, payload: DesktopLinkState, userId: string) =>
  sameText(payload.u, userBinding(secret, userId, payload.n));

/** The Desktop app proves it started the link by returning the verifier whose S256 challenge the state carries. */
export const desktopLinkVerifierMatches = (challenge: string, verifier: string) =>
  DESKTOP_LINK_VERIFIER.test(verifier) && sameText(createHash("sha256").update(verifier).digest("base64url"), challenge);

/** Where the provider's return goes: the signed loopback address, carrying the state and either `code` or `error`. */
export function desktopLinkLoopbackTarget(payload: DesktopLinkState, token: string, query: URLSearchParams): string {
  const target = new URL(payload.r);
  target.searchParams.set("state", token);
  const code = query.get("code");
  const error = query.get("error");
  if (!error && code && code.length <= DESKTOP_LINK_CODE_MAX_LENGTH) target.searchParams.set("code", code);
  else target.searchParams.set("error", error && /^[a-z_]{1,64}$/.test(error) ? error : "invalid_request");
  return target.href;
}
