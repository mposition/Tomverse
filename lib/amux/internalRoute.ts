import "server-only";

import { ApiSecurityError } from "@/lib/apiSecurity";
import type { z } from "zod";
import { AmuxDbBoundaryError } from "@/lib/amux/dbBoundary";
import { reportAmuxOperationalIncident } from "@/lib/amux/operationalError";

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

export const amuxInternalErrorResponse = (
  operation: string,
  error: unknown,
): Response => {
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

  if (
    (error instanceof AmuxDbBoundaryError &&
      error.code === "AMUX_DB_DEADLINE_EXCEEDED") ||
    databaseCode === "57014" ||
    databaseError.includes("57014")
  ) {
    return amuxJsonNoStore(
      {
        error: "AMUX database deadline exceeded.",
        reason: "amux_database_deadline_exceeded",
      },
      503,
    );
  }

  if (databaseCode === "P2028") {
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
