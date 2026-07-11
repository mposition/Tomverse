import "server-only";

import { randomUUID } from "node:crypto";
import { getTrustedClientIp } from "@/lib/clientIp";
import { ChatAccessError } from "@/lib/chatSecurity";

type SiteverifyResponse = {
  success?: boolean;
  hostname?: string;
  action?: string;
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
  token: string | undefined
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
      result.action !== "guest_chat" ||
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
