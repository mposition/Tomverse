import "server-only";

import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { DecisionMakerBodyWriteError } from "@/lib/amux/decisionMakerBodyStore";
import { DecisionMakerDigestKeyError } from "@/lib/amux/decisionMakerDigestKeys";
import {
  DecisionMakerRequestWriteError,
  recordDecisionMakerValidationLatch,
} from "@/lib/amux/decisionMakerRequestStore";
import {
  amuxInternalErrorResponse,
  amuxJsonNoStore,
  isAmuxInputError,
} from "@/lib/amux/internalRoute";

/**
 * What the AMUX Decision Maker's internal routes for the bridge and the broker
 * (app/api/internal/amux/decision-maker/**, stage S2 of
 * docs/policy/amux-decision-maker.md §12) share: the operator's enable switch,
 * the answer to a refusal, the mapping of a store's thrown error to an
 * answer, and -- since 2026-10-17 -- the one store operation a route runs
 * after its own transaction, §8's validation latch. Nothing here decides
 * anything about a request -- every decision is the store's, made on reads it
 * takes under its own locks -- and nothing here names a table.
 *
 * No card text, DM output, digest or key reaches a log line from here: the
 * only lines written are the key ring loader's error code and the latch's.
 */

/**
 * The operator's switch for every Decision Maker route the bridge calls. Until
 * it is exactly `enabled` each route answers 409 `dm_routing_disabled` before
 * it reads the body or opens a transaction: the bridge path is stage S2, and
 * until it is approved and running nothing is written to the ledger, whatever
 * the Decision Maker switches say.
 */
export const AMUX_DM_ROUTING_ENV = "TOMVERSE_AMUX_DM_ROUTING";

export const dmInternalRoutesEnabled = (): boolean => process.env[AMUX_DM_ROUTING_ENV] === "enabled";

/**
 * The code of an error from the latch's boundary or stores, read by the name
 * each class sets on itself, as the maintenance sweep reads it; anything else
 * is null. No message, which could carry a value, reaches the log.
 */
const LATCH_ERROR_NAMES: ReadonlySet<string> = new Set([
  "AmuxDbBoundaryError",
  "DecisionMakerRequestWriteError",
  "DecisionMakerSwitchWriteError",
]);
const latchErrorCode = (error: unknown): string | null => {
  if (!(error instanceof Error) || !LATCH_ERROR_NAMES.has(error.name)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : null;
};

export type DmValidationLatchSettlement = "latched" | "not_due" | "unsettled";

/**
 * §8, once a validation failure the result route recorded has committed: the
 * request store's validation latch, in a boundary transaction of its own --
 * the result's own transaction is already at §9's 12 statements. It never
 * changes the result's answer, which is the ledger's whatever this does. A
 * latch that could not be written is logged by its code and stays owed: the
 * check finds any run of three since the instance's newest switch event, so
 * the next one writes it -- after the instance's next validation failure, or
 * the maintenance sweep's within fifteen minutes. Never throws.
 */
export const settleDmValidationLatch = async (instance: unknown): Promise<DmValidationLatchSettlement> => {
  try {
    const write = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerValidationLatch, (tx) =>
      recordDecisionMakerValidationLatch(tx, { instance }),
    );
    return write.latched ? "latched" : "not_due";
  } catch (error) {
    console.warn(JSON.stringify({ subsystem: "amux", event: "dm_validation_latch_unsettled", code: latchErrorCode(error) }));
    return "unsettled";
  }
};

/** A refusal: nothing was written, and `reason` says why. */
export type DmRouteRefusal = (status: number, reason: string) => Response;

/** The refusal answer under one envelope key (`recorded`, `submitted`, `found`). */
export const dmRouteRefusal =
  (envelope: string): DmRouteRefusal =>
  (status, reason) =>
    amuxJsonNoStore({ [envelope]: false, reason }, status);

/**
 * The status of a refusal a store returned rather than threw. In every case
 * the store wrote nothing. An unknown request is 404; a period key the ring or
 * registry cannot use, and switch rows the switch store could not have
 * written, are conditions outside the request and are 503; every other
 * reason is the ledger's answer about the request itself and is 409.
 */
export const dmReturnedRefusalStatus = (reason: string): 404 | 409 | 503 => {
  if (reason === "unknown_request") return 404;
  if (reason === "digest_key_unavailable" || reason === "settings_unreadable") return 503;
  return 409;
};

/**
 * The answer to an error thrown before or inside the route's transaction.
 * The input and store errors each have their own answer, as the routing route
 * gives them (app/api/internal/amux/decision-maker/requests/route.ts); a
 * transaction that rolled back wrote nothing. Anything else -- a boundary
 * deadline, an outcome the database left unknown, a database error -- is the
 * shared AMUX internal answer for this operation, which never claims a write
 * that may have committed.
 */
export const dmRouteErrorResponse = (operation: string, error: unknown, refused: DmRouteRefusal): Response => {
  if (isAmuxInputError(error)) return refused(400, "invalid_request");
  if (error instanceof DecisionMakerDigestKeyError) {
    // The code only: never the variable's value.
    console.error(JSON.stringify({ subsystem: "amux", event: "dm_digest_keys_unavailable", code: error.code }));
    return refused(503, "dm_digest_keys_unavailable");
  }
  if (error instanceof DecisionMakerRequestWriteError) {
    switch (error.code) {
      case "invalid_input":
        return refused(400, "invalid_input");
      case "key_period_changed":
        return refused(409, "dm_key_period_changed");
      case "digest_key_unavailable":
        return refused(503, "dm_digest_key_unavailable");
      case "settings_unreadable":
        return refused(503, "dm_settings_unreadable");
      case "state_unreadable":
        return refused(503, "dm_state_unreadable");
    }
  }
  if (error instanceof DecisionMakerBodyWriteError) {
    switch (error.code) {
      case "invalid_input":
        return refused(400, "invalid_input");
      case "digest_key_unavailable":
        return refused(503, "dm_digest_key_unavailable");
      case "state_unreadable":
        return refused(503, "dm_state_unreadable");
      case "no_operator":
        // A person's operation only; none of these routes calls one.
        break;
    }
  }
  return amuxInternalErrorResponse(operation, error);
};
