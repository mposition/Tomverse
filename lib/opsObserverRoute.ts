/**
 * The shared shape of the ops-observer internal routes
 * (docs/policy/sre-ops.md §3 rules 4 and 7, §6, §7, §8).
 *
 * In order, and the order matters: who is calling (no usable secret is 404 on
 * every route; a wrong bearer 401; the digest service on a page-only route
 * 403), then the body under its byte cap, then the closed parse, then the
 * store. Nothing reads the body before the caller is known.
 *
 * Responses are `no-store` JSON carrying enums and the store's own closed
 * result. A run past its deadline -- refused by the arming function or by the
 * post-commit check -- is 409 `late`, so the service sends nothing and stops.
 * Anything else is a 500 with no detail; the log line carries the route, the
 * error's name and its code, never a message or the body.
 */

import "server-only";

import { ApiSecurityError, readLimitedText } from "@/lib/apiSecurity";
import { OpsObserverLateError, isBudgetInsufficient } from "@/lib/opsObserverTransaction";
import { REQUEST_BODY_MAX_BYTES } from "@/scripts/ops-observer/request-schema-core.mjs";
import { opsObserverCaller } from "@/scripts/ops-observer/route-auth-core.mjs";

export type OpsObserverRouteName = "state" | "advance" | "confirm" | "digest";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
} as const;

export const opsObserverJson = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: NO_STORE_HEADERS });

const CALLER_REFUSALS: Readonly<Record<number, string>> = Object.freeze({
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
});

/**
 * Runs one ops-observer route. `handle` gets the raw body text, the caller's
 * service and the request time, and returns the store's result as JSON
 * (or a refusal it decided itself).
 */
export async function runOpsObserverRoute(
  route: OpsObserverRouteName,
  request: Request,
  handle: (body: string, service: "page" | "digest", nowMs: number) => Promise<Response>,
): Promise<Response> {
  const caller = opsObserverCaller({
    route,
    authorization: request.headers.get("authorization"),
    env: process.env,
  }) as { service?: "page" | "digest"; status?: number };
  if (!caller.service) {
    const status = caller.status ?? 404;
    return opsObserverJson({ error: CALLER_REFUSALS[status] ?? "not_found" }, status);
  }

  let body: string;
  try {
    body = await readLimitedText(request, REQUEST_BODY_MAX_BYTES);
  } catch (error) {
    if (error instanceof ApiSecurityError && error.code === "REQUEST_BODY_TOO_LARGE") {
      return opsObserverJson({ refused: "too_large" }, 413);
    }
    return opsObserverJson({ refused: "invalid_request" }, 400);
  }

  try {
    return await handle(body, caller.service, Date.now());
  } catch (error) {
    if (error instanceof OpsObserverLateError || isBudgetInsufficient(error)) {
      return opsObserverJson({ error: "late" }, 409);
    }
    const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : null;
    console.error(
      JSON.stringify({
        event: "ops_observer_route_failed",
        route,
        errorName: error instanceof Error ? error.name : "unknown",
        // A database or ceiling code only when it looks like one, never a message.
        errorCode: code && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : null,
      }),
    );
    return opsObserverJson({ error: "internal" }, 500);
  }
}
