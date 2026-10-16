import { createHash, timingSafeEqual } from "node:crypto";

import { isAmuxIdeaRequestId } from "./ideaRequestIdCore.ts";

export const AMUX_SESSION_INTAKE_CLIENT_SECRET_ENV =
  "TOMVERSE_AMUX_SESSION_INTAKE_CLIENT_SECRET";
export const AMUX_SESSION_INTAKE_READBACK_ENV =
  "TOMVERSE_AMUX_SESSION_INTAKE_READBACK";
export const AMUX_SESSION_INTAKE_READBACK_CODE_LATCH = true;

/** Bearer capabilities accepted by other internal routes, plus the owner
 * session secrets. Intake refuses a configured value shared with any of them. */
export const AMUX_SESSION_INTAKE_CONFLICTING_SECRET_ENVS = Object.freeze([
  "AUTH_SECRET",
  "AUTO_FIX_SYNC_SECRET",
  "BILLING_FINANCE_OPS_RUN_SECRET",
  "ENGINEERING_AGENT_PUBLISHER_SECRET",
  "ENGINEERING_AGENT_RUNNER_SECRET",
  "FEEDBACK_AUTOFIX_SYNC_SECRET",
  "MAINTENANCE_SECRET",
  "MARKETING_GENERATOR_SUBMIT_SECRET",
  "MARKETING_PUBLISH_SECRET",
  "MOBILE_AUTH_KEYRING_HEALTH_SECRET",
  "NEXTAUTH_SECRET",
  "OPS_OBSERVER_DIGEST_SECRET",
  "OPS_OBSERVER_SECRET",
  "PRODUCT_RESEARCH_INGEST_SECRET",
  "PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN",
  "PROVIDER_MODEL_CATALOG_SYNC_SECRET",
  "PROVIDER_PROBE_SECRET",
  "PROVIDER_USAGE_SYNC_SECRET",
  "QA_RELEASE_DIGEST_SECRET",
  "QA_RELEASE_MERGE_LANE_SECRET",
  "QA_RELEASE_MONITOR_SECRET",
  "REVIEW_ORCHESTRATOR_STATUS_SECRET",
  "SUPPORT_TRIAGE_HEARTBEAT_SECRET",
  "SUPPORT_TRIAGE_RETENTION_SECRET",
  "SUPPORT_TRIAGE_RUN_SECRET",
  "TOMVERSE_AMUX_SYNC_SECRET",
  "TOMVERSE_AMUX_V22_RECOVERY_CONTROLLER_SECRET",
  "TOMVERSE_AMUX_V22_RECOVERY_INSPECTOR_SECRET",
  "TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET",
  "TOMVERSE_AMUX_V4_COLLECTION_AGENT_SECRET",
  "TOMVERSE_AMUX_V4_CONTENT_RETENTION_SECRET",
] as const);

const SECRET = /^[A-Za-z0-9_-]{32,256}$/;

export const amuxSessionIntakeReadbackEnabled = (
  sessionIntakeReadback: string | undefined,
  ideaReadback: string | undefined,
): boolean => AMUX_SESSION_INTAKE_READBACK_CODE_LATCH &&
  sessionIntakeReadback === "enabled" && ideaReadback === "enabled";

/** This bearer grants only session intake/readback. A value shared with any
 * other known capability is refused rather than inheriting that capability. */
export function isAmuxSessionIntakeClientAuthorized(
  request: Request,
  configured: string | undefined,
  otherSecrets: readonly (string | undefined)[],
): boolean {
  if (typeof configured !== "string" || !SECRET.test(configured) ||
      otherSecrets.some((secret) => secret === configured)) return false;
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const provided = authorization.slice(7);
  if (!SECRET.test(provided)) return false;
  return timingSafeEqual(
    createHash("sha256").update(configured).digest(),
    createHash("sha256").update(provided).digest(),
  );
}

/** One exact request ID and no query extensions: readback cannot become a
 * listing or a broader lookup surface. */
export function amuxSessionIntakeReadbackRequestId(request: Request): string | null {
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some((key) => key !== "requestId")) return null;
  const requestIds = params.getAll("requestId");
  return requestIds.length === 1 && isAmuxIdeaRequestId(requestIds[0]!)
    ? requestIds[0]!
    : null;
}

export type AmuxSessionIntakeReadback =
  | { requestId: string; status: "absent" }
  | { requestId: string; status: "partial"; ideaId: string }
  | { requestId: string; status: "committed"; ideaId: string;
      hasExternalSources: boolean };

/** Closed response projection. Extra service fields, including encrypted or
 * plaintext content added by mistake, never reach the intake client. */
export function amuxSessionIntakeReadbackReply(
  expectedRequestId: string,
  readback: AmuxSessionIntakeReadback,
): {
  status: number;
  body: Record<string, unknown>;
} {
  if (readback.requestId !== expectedRequestId) {
    throw new Error("session intake readback request ID mismatch");
  }
  if (readback.status === "absent") {
    return { status: 404, body: { status: "absent", requestId: readback.requestId,
      retryWrite: false } };
  }
  if (readback.status === "partial") {
    return { status: 409, body: { status: "partial", requestId: readback.requestId,
      ideaId: readback.ideaId, retryWrite: false } };
  }
  return { status: 200, body: {
    status: "committed",
    requestId: readback.requestId,
    ideaId: readback.ideaId,
    hasExternalSources: readback.hasExternalSources,
    adminPath: `/admin/amux-backlog?tab=ideas&idea=${encodeURIComponent(readback.requestId)}`,
  } };
}
