/**
 * Authentication and responses for the product-research agent's one internal
 * route (docs/policy/product-research-agent.md §3, §6).
 *
 * Both halves of the switch are read here. The app switch decides whether the
 * route exists at all: unset means 404, not 401 -- a disabled feature should
 * not confirm that an endpoint is there for someone holding the wrong secret.
 * The secret then decides who may call it: shorter than 32 characters
 * authenticates nothing, and the comparison is between SHA-256 digests in
 * constant time.
 *
 * Responses are `no-store` JSON carrying an enum, never a message from a
 * dependency and never anything from the submitted payload.
 */

import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

export const PRODUCT_RESEARCH_SWITCH_ENV = "PRODUCT_RESEARCH_AGENT_ENABLED";
export const PRODUCT_RESEARCH_INGEST_SECRET_ENV = "PRODUCT_RESEARCH_INGEST_SECRET";

const MIN_SECRET_LENGTH = 32;

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/**
 * Whether the app side is switched on.
 *
 * Fail-closed and unset by default: an operator setting the variable is the
 * only way this becomes true, and the execution service's own switch is a
 * separate variable in a separate project. Both unset is the full stop.
 */
export const isProductResearchRouteEnabled = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean => (env[PRODUCT_RESEARCH_SWITCH_ENV] ?? "").length > 0;

/** Whether the request carries the submission secret, and that secret is usable. */
export const isProductResearchRouteAuthorized = (
  request: Request,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean => {
  const own = env[PRODUCT_RESEARCH_INGEST_SECRET_ENV] ?? "";
  if (own.length < MIN_SECRET_LENGTH) return false;
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return false;
  const provided = authorization.slice("Bearer ".length);
  if (provided.length === 0) return false;
  return timingSafeEqual(digest(own), digest(provided));
};

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
} as const;

export const productResearchJson = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: NO_STORE_HEADERS });

/**
 * The response a caller gets when the route is off.
 *
 * Deliberately indistinguishable from a path that does not exist: a 503 naming
 * the feature tells an unauthenticated caller that this agent is deployed here.
 */
export const productResearchNotFound = () => productResearchJson({ error: "not_found" }, 404);

export const productResearchUnauthorized = () =>
  productResearchJson({ error: "unauthorized" }, 401);

/**
 * Logs a failure as an enum and answers 500.
 *
 * The database's own error code is passed through only when it looks like one;
 * nothing from the payload, the issue titles or the dependency's message is
 * logged, because the log is read by whoever is diagnosing a silent slot.
 */
export const productResearchInternalError = (operation: string, error: unknown): Response => {
  const databaseCode =
    typeof (error as { code?: unknown })?.code === "string"
      ? (error as { code: string }).code
      : null;
  console.error(
    JSON.stringify({
      event: "product_research_route_failed",
      operation,
      databaseCode: databaseCode && /^[A-Z0-9]{1,10}$/.test(databaseCode) ? databaseCode : null,
    }),
  );
  return productResearchJson({ error: "internal_error" }, 500);
};
