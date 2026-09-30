import "server-only";

import { randomUUID } from "node:crypto";
import { safeErrorMetadata } from "@/lib/providerErrorClassification";

export type AmuxOperationalIncident = {
  incidentId: string;
  errorClass: string;
  errorCode: string;
};

export const reportAmuxOperationalIncident = (
  operation: string,
  error: unknown,
): AmuxOperationalIncident => {
  const incidentId = randomUUID();
  const metadata = safeErrorMetadata(error);
  const errorClass = /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(metadata.name)
    ? metadata.name
    : "UnknownError";
  const errorCode = metadata.code || "AMUX_INTERNAL_OPERATION_FAILED";

  console.error(
    JSON.stringify({
      subsystem: "amux",
      event: "internal_route_failure",
      operation,
      incident_id: incidentId,
      error_class: errorClass,
      error_code: errorCode,
      status_code: metadata.statusCode ?? null,
      retryable: metadata.isRetryable ?? null,
    }),
  );

  return { incidentId, errorClass, errorCode };
};
