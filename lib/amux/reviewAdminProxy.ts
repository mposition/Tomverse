import "server-only";

import { isAmuxAgentApprovalEnabled } from "@/lib/amux/reviewApprovalCore";

const unavailable = () =>
  Response.json(
    {
      success: false,
      code: "AMUX_AGENT_APPROVAL_UNAVAILABLE",
      error: "AMUX agent review approval is not active.",
    },
    { status: 409, headers: { "Cache-Control": "no-store" } },
  );

const transportUnresolved = () =>
  Response.json(
    { success: false, code: "AMUX_REVIEW_TRANSPORT_UNRESOLVED" },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );

const proxyConfigurationError = (code: string) =>
  Response.json(
    { success: false, code },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );

/**
 * Admin cookies never reach the browser-facing internal credential. Only the
 * server forwards the request to the canonical /api/internal/amux boundary,
 * which independently rechecks the administrator session and step-up window.
 */
export async function forwardAmuxAdminReviewCommand(
  request: Request,
  command: Record<string, unknown>,
): Promise<Response> {
  if (
    command.action !== "acknowledge" &&
    command.action !== "decision_status" &&
    !isAmuxAgentApprovalEnabled(process.env.TOMVERSE_AMUX_AGENT_APPROVAL_ENABLED)
  ) {
    return unavailable();
  }

  const secret = process.env.TOMVERSE_AMUX_SYNC_SECRET ?? "";
  const configuredOrigin = process.env.NEXTAUTH_URL;
  if (secret.length < 32 || !configuredOrigin)
    return proxyConfigurationError("AMUX_REVIEW_PROXY_CONFIG_INVALID");

  let internalUrl: URL;
  try {
    internalUrl = new URL("/api/internal/amux/review", configuredOrigin);
    if (new URL(request.url).origin !== internalUrl.origin)
      return proxyConfigurationError("AMUX_REVIEW_PROXY_ORIGIN_MISMATCH");
    if (
      internalUrl.protocol !== "https:" &&
      !(internalUrl.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(internalUrl.hostname))
    ) {
      return proxyConfigurationError("AMUX_REVIEW_PROXY_CONFIG_INVALID");
    }
  } catch {
    return proxyConfigurationError("AMUX_REVIEW_PROXY_CONFIG_INVALID");
  }

  const cookie = request.headers.get("cookie");
  if (!cookie) return proxyConfigurationError("AMUX_REVIEW_PROXY_COOKIE_UNAVAILABLE");
  try {
    const headers = new Headers({
      Authorization: `Bearer ${secret}`,
      Cookie: cookie,
      "Content-Type": "application/json",
    });
    // Preserve the original request's trusted-proxy evidence for the audit
    // writer. It still validates the Cloudflare origin secret itself.
    for (const name of ["cf-connecting-ip", "x-tomverse-origin-verify", "x-real-ip", "user-agent"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const response = await fetch(internalUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(command),
      cache: "no-store",
      redirect: "manual",
      // One protected detail may require three bounded GitHub reads (PR, diff, PR).
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status >= 300 && response.status < 400)
      return proxyConfigurationError("AMUX_REVIEW_PROXY_REDIRECT_REFUSED");
    return new Response(response.body, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("content-type") ?? "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    // A timed-out resolve can have committed. Do not claim it was disabled or
    // that no decision was made; freeze further writes and query decision ID
    // plus subject digest before any operator retries.
    return transportUnresolved();
  }
}
