import "server-only";

import { ApiSecurityError } from "@/lib/apiSecurity";
import type { z } from "zod";
import {
  AmuxDbBoundaryError,
  admitAmuxOrchestratorWrite,
  amuxRouteOrchestratorReceiptsMayHaveCommitted,
} from "@/lib/amux/dbBoundary";
import {
  AMUX_ORCHESTRATOR_DUPLICATE_REQUEST_REASON,
  type AmuxOrchestratorCallKind,
  type AmuxOrchestratorWriteIdentity,
} from "@/lib/amux/orchestratorHaltCore";
import { reportAmuxOperationalIncident } from "@/lib/amux/operationalError";
import {
  AMUX_DATABASE_BUSY_REASON,
  AMUX_DATABASE_BUSY_RETRY_AFTER_SECONDS,
  amuxTransactionNotStartedCode,
  amuxTransientDatabaseCode,
  isAmuxDbBusyCode,
} from "@/lib/amux/readFailureCore";

export const AMUX_INTERNAL_RESPONSE_MAX_BYTES = 512 * 1_024;
export class AmuxResponseCapacityError extends Error {
  constructor() {
    super("AMUX internal response exceeds byte ceiling");
    this.name = "AmuxResponseCapacityError";
  }
}
const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
} as const;

export const isAmuxInputError = (error: unknown): error is ApiSecurityError =>
  error instanceof ApiSecurityError &&
  ["INVALID_JSON", "INVALID_REQUEST", "REQUEST_BODY_TOO_LARGE"].includes(
    error.code,
  );

export const amuxJsonNoStore = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: NO_STORE_HEADERS,
  });

/**
 * Orchestration policy version 20, section 4: the admission of one
 * orchestrator write call, as the first thing its route does inside its
 * budget. A request without the two identity headers comes from an
 * orchestrator built before version 20 and is served exactly as before,
 * with no admission (`null`). A second admission of the same request id is
 * refused with 409 `duplicate_request`, which is not a known answer. An
 * admission that cannot be committed throws the not-started error, which
 * `amuxInternalErrorResponse` answers 503 `amux_database_busy`.
 */
export async function admitAmuxOrchestratorRequest(
  identity: AmuxOrchestratorWriteIdentity,
  callKind: AmuxOrchestratorCallKind,
): Promise<Response | null> {
  if (identity.kind !== "admitted") return null;
  const admission = await admitAmuxOrchestratorWrite({
    requestId: identity.requestId,
    instanceId: identity.instanceId,
    callKind,
  });
  return admission.admitted
    ? null
    : amuxJsonNoStore(
        {
          error: "Duplicate request.",
          reason: AMUX_ORCHESTRATOR_DUPLICATE_REQUEST_REASON,
        },
        409,
      );
}

/** The answer to a write whose identity headers are present but malformed. */
export const amuxInvalidOrchestratorIdentityResponse = (): Response =>
  amuxJsonNoStore({ error: "Invalid request." }, 400);

export const amuxBoundedJsonNoStore = (
  body: unknown,
  status = 200,
  schema?: z.ZodType,
): Response => {
  const serialized = JSON.stringify(schema ? schema.parse(body) : body);
  if (
    Buffer.byteLength(serialized, "utf8") > AMUX_INTERNAL_RESPONSE_MAX_BYTES
  ) {
    throw new AmuxResponseCapacityError();
  }

  return new Response(serialized, {
    status,
    headers: NO_STORE_HEADERS,
  });
};

const amuxOutcomeUnknownResponse = (
  operation: string,
  error: unknown,
): Response => {
  const incident = reportAmuxOperationalIncident(operation, error);
  return new Response(
    JSON.stringify({
      error: "AMUX database outcome is unknown.",
      reason: "amux_outcome_unknown",
      incident_id: incident.incidentId,
    }),
    {
      status: 503,
      headers: {
        ...NO_STORE_HEADERS,
        "X-AMUX-Incident-ID": incident.incidentId,
      },
    },
  );
};

/**
 * Whether `amuxInternalErrorResponse` would answer this error with one of the
 * three 503 reasons that say "this request committed nothing" (orchestration
 * policy version 20, section 1): busy, deadline exceeded, call ceiling
 * exceeded. Mirrors the branch order below.
 */
const isKnownDeadlineFailure = (
  error: unknown,
  databaseCode: string | null,
  databaseError: string,
): boolean => {
  if (error instanceof AmuxDbBoundaryError) {
    return error.code === "AMUX_DB_DEADLINE_EXCEEDED";
  }
  // A running transaction's P2028 is still outcome-unknown, even if its
  // nested adapter cause mentions a statement timeout.
  if (error && typeof error === "object" && "code" in error && error.code === "P2028") {
    return false;
  }
  return (
    databaseCode === "57014" ||
    databaseError.includes("57014") ||
    amuxTransientDatabaseCode(error) === "57014"
  );
};

const answersNothingCommitted = (error: unknown): boolean => {
  if (error instanceof AmuxDbBoundaryError && isAmuxDbBusyCode(error.code)) {
    return true;
  }
  const candidate = error as {
    code?: unknown;
    meta?: { code?: unknown; database_error?: unknown };
  };
  const databaseCode =
    typeof candidate?.meta?.code === "string"
      ? candidate.meta.code
      : typeof candidate?.code === "string"
        ? candidate.code
        : null;
  const databaseError =
    typeof candidate?.meta?.database_error === "string"
      ? candidate.meta.database_error
      : "";
  if (isKnownDeadlineFailure(error, databaseCode, databaseError)) {
    return true;
  }
  return (
    databaseCode !== "P2028" &&
    error instanceof AmuxDbBoundaryError &&
    error.code === "AMUX_DB_PRISMA_CALL_CEILING_EXCEEDED"
  );
};

export const amuxInternalErrorResponse = (
  operation: string,
  error: unknown,
): Response => {
  // Orchestration policy version 20, section 1: once a receipt of this
  // admitted request may have committed, the three answers that say "nothing
  // was committed" are no longer true, so none of them is sent. The answer is
  // an unknown outcome, which the orchestrator halts on and never
  // acknowledges.
  if (
    answersNothingCommitted(error) &&
    amuxRouteOrchestratorReceiptsMayHaveCommitted()
  ) {
    console.warn(
      JSON.stringify({
        subsystem: "amux",
        event: "orchestrator_receipt_committed_before_refusal",
        operation,
      }),
    );
    return amuxOutcomeUnknownResponse(operation, error);
  }

  // A state-changing transaction of an admitted write found its admission
  // missing, acknowledged or resolved under the row lock, and rolled back
  // before changing anything. Someone else has closed the request, so it is
  // not answered as a known outcome.
  if (
    error instanceof AmuxDbBoundaryError &&
    error.code === "AMUX_DB_ADMISSION_CLOSED"
  ) {
    return amuxOutcomeUnknownResponse(operation, error);
  }

  // A read that the database could not take just then, or a transaction that
  // never started, in a route that had written nothing (decided once, in
  // amuxDbBoundaryFailure). Nothing was written, so this is never an unknown
  // outcome and opens no incident; the caller asks again on its next tick. A
  // warning keeps the rate visible, with the pool's counts at the time.
  if (error instanceof AmuxDbBoundaryError && isAmuxDbBusyCode(error.code)) {
    const notStarted = error.code === "AMUX_DB_NOT_STARTED";
    console.warn(
      JSON.stringify({
        subsystem: "amux",
        event: "internal_route_database_busy",
        operation,
        path: notStarted ? "not_started" : "read",
        error_code:
          (notStarted
            ? amuxTransactionNotStartedCode(error.cause)
            : amuxTransientDatabaseCode(error.cause)) ?? "unknown",
        connection_wait_ms: error.connectionWaitMs ?? null,
        pool_total: error.poolUsage?.total ?? null,
        pool_idle: error.poolUsage?.idle ?? null,
        pool_waiting: error.poolUsage?.waiting ?? null,
      }),
    );
    return new Response(
      JSON.stringify({
        error: "AMUX database is busy.",
        reason: AMUX_DATABASE_BUSY_REASON,
      }),
      {
        status: 503,
        headers: {
          ...NO_STORE_HEADERS,
          "Retry-After": String(AMUX_DATABASE_BUSY_RETRY_AFTER_SECONDS),
        },
      },
    );
  }

  const candidate = error as {
    code?: unknown;
    meta?: { code?: unknown; database_error?: unknown };
  };
  const databaseCode =
    typeof candidate?.meta?.code === "string"
      ? candidate.meta.code
      : typeof candidate?.code === "string"
        ? candidate.code
        : null;
  const databaseError =
    typeof candidate?.meta?.database_error === "string"
      ? candidate.meta.database_error
      : "";

  if (isKnownDeadlineFailure(error, databaseCode, databaseError)) {
    return amuxJsonNoStore(
      {
        error: "AMUX database deadline exceeded.",
        reason: "amux_database_deadline_exceeded",
      },
      503,
    );
  }

  // A mutation that failed after its callback returned (anything but the
  // commit deadline trigger's AX001, which is a deadline refusal above) may or
  // may not have committed: the same answer as a Prisma transaction timeout.
  // A P2028 still reaches here from a mutation boundary whose callback had
  // begun (its own interactive-transaction timeout), and from any transaction
  // that failed after its route had started a mutation, or outside a route. A
  // busy or never-started transaction of a route that wrote nothing was
  // answered above.
  if (
    databaseCode === "P2028" ||
    (error instanceof AmuxDbBoundaryError &&
      error.code === "AMUX_DB_OUTCOME_UNKNOWN")
  ) {
    const incident = reportAmuxOperationalIncident(operation, error);
    return new Response(
      JSON.stringify({
        error: "AMUX database outcome is unknown.",
        reason: "amux_outcome_unknown",
        incident_id: incident.incidentId,
      }),
      {
        status: 503,
        headers: {
          ...NO_STORE_HEADERS,
          "X-AMUX-Incident-ID": incident.incidentId,
        },
      },
    );
  }

  if (
    error instanceof AmuxDbBoundaryError &&
    error.code === "AMUX_DB_PRISMA_CALL_CEILING_EXCEEDED"
  ) {
    return amuxJsonNoStore(
      {
        error: "AMUX database call ceiling exceeded.",
        reason: "amux_database_call_ceiling_exceeded",
      },
      503,
    );
  }

  // The fence found no commit deadline trigger that will fire and rolled the
  // transaction back rather than commit without the check. Nothing was
  // written, but the database is missing its migration, which an operator has
  // to see: an incident, with a reason of its own.
  if (
    error instanceof AmuxDbBoundaryError &&
    error.code === "AMUX_DB_COMMIT_CHECK_MISSING"
  ) {
    const incident = reportAmuxOperationalIncident(operation, error);
    return new Response(
      JSON.stringify({
        error: "AMUX database commit check is missing.",
        reason: "amux_commit_check_missing",
        incident_id: incident.incidentId,
      }),
      {
        status: 503,
        headers: {
          ...NO_STORE_HEADERS,
          "X-AMUX-Incident-ID": incident.incidentId,
        },
      },
    );
  }

  const incident = reportAmuxOperationalIncident(operation, error);
  return new Response(
    JSON.stringify({
      error: "Internal server error.",
      incident_id: incident.incidentId,
    }),
    {
      status: 500,
      headers: {
        ...NO_STORE_HEADERS,
        "X-AMUX-Incident-ID": incident.incidentId,
      },
    },
  );
};
