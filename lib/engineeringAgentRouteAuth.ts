/**
 * Authentication and responses for the engineering agent's internal routes
 * (docs/policy/engineering-agent.md §11).
 *
 * The runner and the publisher each hold their own route secret. A secret
 * shorter than 32 characters authenticates nothing, the comparison is between
 * SHA-256 digests in constant time, and the two secrets must differ: if the
 * two services shared one, each could call the other's routes, and the split
 * between the service that holds a model key and the one that holds the
 * publishing key would be gone.
 *
 * Responses are `no-store` JSON with a byte ceiling; errors carry an enum code
 * and never a message from a dependency.
 */

import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

import { ApiSecurityError } from "@/lib/apiSecurity";
import {
  EngineeringAgentStoreRefusedError,
  acceptEngineeringAgentRequest,
  moveEngineeringAgentRequest,
  runEngineeringAgentTransaction,
  type EngineeringAgentTransaction,
} from "@/lib/engineeringAgentStore";
import { prisma } from "@/lib/prisma";

export const ENGINEERING_AGENT_ROUTE_SECRET_ENV = {
  runner: "ENGINEERING_AGENT_RUNNER_SECRET",
  publisher: "ENGINEERING_AGENT_PUBLISHER_SECRET",
} as const;
export type EngineeringAgentRouteRole = keyof typeof ENGINEERING_AGENT_ROUTE_SECRET_ENV;

const MIN_SECRET_LENGTH = 32;

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** Whether the request carries this role's secret, and that secret is usable. */
export const isEngineeringAgentRouteAuthorized = (
  request: Request,
  role: EngineeringAgentRouteRole,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean => {
  const own = env[ENGINEERING_AGENT_ROUTE_SECRET_ENV[role]] ?? "";
  if (own.length < MIN_SECRET_LENGTH) return false;
  const otherRole: EngineeringAgentRouteRole = role === "runner" ? "publisher" : "runner";
  const other = env[ENGINEERING_AGENT_ROUTE_SECRET_ENV[otherRole]] ?? "";
  // A shared secret authenticates neither service.
  if (other.length > 0 && timingSafeEqual(digest(own), digest(other))) return false;

  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return false;
  const provided = authorization.slice("Bearer ".length);
  if (provided.length === 0) return false;
  return timingSafeEqual(digest(own), digest(provided));
};

/**
 * Larger than the widest answer any route gives: a claim carries a patch of up
 * to ENGINEERING_AGENT_PATCH_BODY_MAX_BYTES, and JSON writes each control
 * character as six bytes, so that patch alone can serialise to six times its
 * size. The idempotent runners also measure their result inside the work
 * transaction, so an answer that cannot be sent is rolled back, not committed.
 */
export const ENGINEERING_AGENT_RESPONSE_MAX_BYTES = 512 * 1024;

const serializedBytes = (body: unknown) =>
  Buffer.byteLength(
    JSON.stringify(body, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value)),
    "utf8",
  );

// What a route adds around the work's value: an envelope key and the braces.
const RESPONSE_ENVELOPE_BYTES = 1024;

/** Refuses, inside the work's transaction, a result the route could not send. */
export const requireSendableResult = (value: unknown) => {
  if (serializedBytes(value) + RESPONSE_ENVELOPE_BYTES > ENGINEERING_AGENT_RESPONSE_MAX_BYTES) {
    throw new EngineeringAgentStoreRefusedError("response_too_large");
  }
};

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
} as const;

export const engineeringAgentJson = (body: unknown, status = 200): Response => {
  const serialized = JSON.stringify(body, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  if (serializedBytes(body) > ENGINEERING_AGENT_RESPONSE_MAX_BYTES) {
    return new Response(JSON.stringify({ error: "response_too_large" }), { status: 500, headers: NO_STORE_HEADERS });
  }
  return new Response(serialized, { status, headers: NO_STORE_HEADERS });
};

export const engineeringAgentUnauthorized = () => engineeringAgentJson({ error: "unauthorized" }, 401);

/**
 * The response for a failure: a refusal the store decided (409, its code), a
 * body the route could not accept (400), or anything else (500, logged as an
 * enum with no message from the dependency).
 */
export const engineeringAgentErrorResponse = (operation: string, error: unknown): Response => {
  if (error instanceof EngineeringAgentStoreRefusedError) {
    return engineeringAgentJson({ refused: error.code }, 409);
  }
  if (
    error instanceof ApiSecurityError &&
    ["INVALID_JSON", "INVALID_REQUEST", "REQUEST_BODY_TOO_LARGE"].includes(error.code)
  ) {
    return engineeringAgentJson({ error: "invalid_request" }, 400);
  }
  const databaseCode =
    typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : null;
  console.error(
    JSON.stringify({
      event: "engineering_agent_route_failed",
      operation,
      databaseCode: databaseCode && /^[A-Z0-9]{1,10}$/.test(databaseCode) ? databaseCode : null,
    }),
  );
  return engineeringAgentJson({ error: "internal_error" }, 500);
};

export type IdempotentOutcome<T> =
  | { kind: "done"; value: T }
  /** The key was seen before: its recorded state is the answer, and nothing runs again. */
  | { kind: "replay"; state: string }
  | { kind: "conflict" };

/**
 * One internal request, idempotent by its key (§10). The request is recorded
 * and moved to `in_progress` in a transaction of its own, before any work;
 * the work and the move to `committed` share the next one. A work
 * transaction that fails has rolled back, so the request is then `aborted`.
 * If the caller loses the answer it asks the status route; a key already seen
 * returns its recorded state and never runs the work again.
 */
export async function runIdempotentEngineeringAgentRequest<T>(input: {
  route: string;
  requestKey: string;
  body: unknown;
  work: (tx: EngineeringAgentTransaction) => Promise<T>;
  /** The identifier a caller that lost the answer needs, recorded with the commit. */
  resultRef?: (result: T) => string | null;
}): Promise<IdempotentOutcome<T>> {
  const outcome = await runAttachedIdempotentEngineeringAgentRequest({
    ...input,
    work: (markCommitted) =>
      runEngineeringAgentTransaction(
        prisma,
        async (tx) => {
          const result = await input.work(tx);
          requireSendableResult(result);
          await markCommitted(tx, input.resultRef?.(result) ?? undefined);
          return result;
        },
        { timeout: 30_000 },
      ),
  });
  // The work above marks the request in its own transaction or throws.
  if (outcome.kind === "not_committed") throw new Error("engineering agent request left uncommitted");
  return outcome;
}

/**
 * The same, for work whose transaction is not ours to open: the engineering
 * adapter's, which runs inside an AMUX writer's own transaction. The work
 * calls `markCommitted` in that transaction, so the AMUX write, the
 * engineering rows and the request's `committed` are one commit. Work that
 * returns without calling it did nothing of ours -- the AMUX writer refused
 * before its attachment ran -- and the request is `aborted`.
 */
export async function runAttachedIdempotentEngineeringAgentRequest<T>(input: {
  route: string;
  requestKey: string;
  body: unknown;
  work: (markCommitted: (tx: EngineeringAgentTransaction, resultRef?: string) => Promise<void>) => Promise<T>;
}): Promise<IdempotentOutcome<T> | { kind: "not_committed"; value: T }> {
  const requestDigest = createHash("sha256").update(JSON.stringify(input.body), "utf8").digest("hex");
  const accepted = await runEngineeringAgentTransaction(prisma, async (tx) => {
    const acceptance = await acceptEngineeringAgentRequest(tx, {
      key: input.requestKey,
      route: input.route,
      requestDigest,
    });
    if (acceptance.outcome === "accepted") {
      await moveEngineeringAgentRequest(tx, { key: input.requestKey, from: "accepted", to: "in_progress" });
    }
    return acceptance;
  });
  if (accepted.outcome === "replay") return { kind: "replay", state: accepted.state };
  if (accepted.outcome === "conflict") return { kind: "conflict" };
  const abort = () =>
    runEngineeringAgentTransaction(prisma, (tx) =>
      moveEngineeringAgentRequest(tx, { key: input.requestKey, from: "in_progress", to: "aborted" }),
    ).catch(() => undefined);
  let committed = false;
  try {
    const value = await input.work(async (tx, resultRef) => {
      await moveEngineeringAgentRequest(tx, { key: input.requestKey, from: "in_progress", to: "committed", resultRef });
      committed = true;
    });
    if (!committed) {
      await abort();
      return { kind: "not_committed", value };
    }
    return { kind: "done", value };
  } catch (error) {
    await abort();
    throw error;
  }
}
