import "server-only";

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getTrustedClientIp } from "@/lib/clientIp";
import { ChatAccessError } from "@/lib/chatSecurity";

type SiteverifyResponse = {
  success?: boolean;
  hostname?: string;
  action?: string;
};

// Guests were being asked to solve a fresh Turnstile challenge on every
// message (each panel independently), which Cloudflare's risk engine started
// escalating to a visible checkbox on nearly every send. Once a guest passes
// Turnstile once, this short-lived signed cookie lets subsequent requests
// skip re-verification for a while instead of re-running Turnstile every time.
const GUEST_TURNSTILE_GRANT_COOKIE = "tomverse_guest_verified";
const GUEST_TURNSTILE_GRANT_TTL_SECONDS = 60 * 30;

const getGrantSecret = () => {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new ChatAccessError(
      503,
      "SECURITY_NOT_CONFIGURED",
      "Guest verification is not configured."
    );
  }
  return secret;
};

const signGuestTurnstileGrant = (expiresAt: number) =>
  createHmac("sha256", getGrantSecret())
    .update(`guest_turnstile_grant:${expiresAt}`)
    .digest("base64url");

const readCookie = (request: Request, name: string) => {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
};

export const buildGuestTurnstileGrantCookie = () => {
  const expiresAt =
    Math.floor(Date.now() / 1000) + GUEST_TURNSTILE_GRANT_TTL_SECONDS;
  const signature = signGuestTurnstileGrant(expiresAt);
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${GUEST_TURNSTILE_GRANT_COOKIE}=${expiresAt}.${signature}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${GUEST_TURNSTILE_GRANT_TTL_SECONDS}; Priority=High${secure}`;
};

export const hasValidGuestTurnstileGrant = (request: Request) => {
  const token = readCookie(request, GUEST_TURNSTILE_GRANT_COOKIE);
  if (!token) return false;

  const [expiresValue, signature, ...extra] = token.split(".");
  const expiresAt = Number(expiresValue);
  if (
    extra.length > 0 ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Math.floor(Date.now() / 1000)
  ) {
    return false;
  }

  const expected = signGuestTurnstileGrant(expiresAt);
  const actualBuffer = Buffer.from(signature || "");
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
};

const isLocalDevelopmentRequest = (request: Request) => {
  if (process.env.NODE_ENV === "production") return false;
  const host = request.headers.get("host");
  if (!host) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname;
    return ["localhost", "127.0.0.1", "::1"].includes(hostname);
  } catch {
    return false;
  }
};

export async function verifyGuestTurnstile(
  request: Request,
  token: string | undefined,
  expectedAction = "guest_chat"
) {
  if (isLocalDevelopmentRequest(request)) return;

  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    if (process.env.NODE_ENV !== "production") return;
    throw new ChatAccessError(
      503,
      "TURNSTILE_NOT_CONFIGURED",
      "Guest verification is not configured."
    );
  }
  if (!token || token.length > 2_048) {
    throw new ChatAccessError(
      403,
      "TURNSTILE_REQUIRED",
      "Guest verification is required."
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret,
          response: token,
          remoteip: getTrustedClientIp(request),
          idempotency_key: randomUUID(),
        }),
        cache: "no-store",
        signal: controller.signal,
      }
    );
    if (!response.ok) {
      throw new ChatAccessError(
        503,
        "TURNSTILE_UNAVAILABLE",
        "Guest verification is temporarily unavailable."
      );
    }
    const result = (await response.json()) as SiteverifyResponse;
    const expectedHostname =
      process.env.TURNSTILE_EXPECTED_HOSTNAME ||
      (() => {
        try {
          return process.env.NEXTAUTH_URL
            ? new URL(process.env.NEXTAUTH_URL).hostname
            : undefined;
        } catch {
          return undefined;
        }
      })();
    if (
      !result.success ||
      result.action !== expectedAction ||
      (expectedHostname && result.hostname !== expectedHostname)
    ) {
      throw new ChatAccessError(
        403,
        "TURNSTILE_FAILED",
        "Guest verification failed."
      );
    }
  } catch (error) {
    if (error instanceof ChatAccessError) throw error;
    throw new ChatAccessError(
      503,
      "TURNSTILE_UNAVAILABLE",
      "Guest verification is temporarily unavailable."
    );
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Skips re-verification when the guest already has a valid grant from a
 * recent successful Turnstile pass; otherwise verifies as before and, on
 * success, returns a Set-Cookie value the caller should attach to its
 * response so the next request can skip Turnstile too.
 */
export async function ensureGuestVerified(
  request: Request,
  token: string | undefined,
  expectedAction = "guest_chat"
): Promise<string | undefined> {
  if (hasValidGuestTurnstileGrant(request)) return undefined;
  await verifyGuestTurnstile(request, token, expectedAction);
  return buildGuestTurnstileGrantCookie();
}
