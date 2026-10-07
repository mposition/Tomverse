/**
 * Where the QA-release digest service may send its submission.
 *
 * The submission carries the service's secret, so the destination is not a
 * variable: it is one of two origins fixed in code and reviewed with it, chosen
 * by the deployment environment Railway reports. Anything else -- an unknown
 * environment, a different origin, credentials or a query in the URL -- stops
 * the run before a request is built.
 *
 * The origins are the ones the rest of the app already uses for each
 * environment. Confirming them against the live services is an operational
 * check before S1 (policy section 9).
 *
 * Pure; reads only the environment object it is given.
 */
import { validateEnvironment } from "./deploymentEnvironment.ts";

export const QA_RELEASE_DIGEST_ENDPOINTS = Object.freeze({
  staging: "https://staging.tomverse.app",
  production: "https://tomverse.app",
} as const);

export const QA_RELEASE_DIGEST_PATHNAME = "/api/internal/agents/qa-release/digest";

export type QaReleaseDigestEnvironment = keyof typeof QA_RELEASE_DIGEST_ENDPOINTS;

/**
 * The environment, from Railway's own name only. `APP_ENV` and `NODE_ENV` are
 * not consulted: a service that cannot say it is staging or production does
 * not submit anywhere.
 */
export function qaReleaseDigestEnvironment(env: Record<string, string | undefined>): QaReleaseDigestEnvironment {
  const resolved = validateEnvironment(env.RAILWAY_ENVIRONMENT_NAME);
  if (resolved === "staging" || resolved === "production") return resolved;
  throw new Error("qa_release_digest_environment_unknown");
}

export function qaReleaseDigestEndpoint(env: Record<string, string | undefined>): string {
  const origin = QA_RELEASE_DIGEST_ENDPOINTS[qaReleaseDigestEnvironment(env)];
  const url = `${origin}${QA_RELEASE_DIGEST_PATHNAME}`;
  assertQaReleaseDigestEndpoint(url);
  return url;
}

/**
 * Refuses any URL that is not exactly one fixed origin plus the fixed path.
 * Called again immediately before the request is built.
 */
export function assertQaReleaseDigestEndpoint(candidate: string): void {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("qa_release_digest_endpoint_invalid");
  }
  // Compared as written, before any normalisation: `/digest/../digest` parses
  // to the right path, and a check that accepted it would accept other shapes.
  const allowedUrls: readonly string[] = Object.values(QA_RELEASE_DIGEST_ENDPOINTS).map(
    (origin) => `${origin}${QA_RELEASE_DIGEST_PATHNAME}`,
  );
  const exact = allowedUrls.includes(candidate) && url.href === candidate && url.protocol === "https:";
  if (!exact) throw new Error("qa_release_digest_endpoint_not_allowed");
}

export const QA_RELEASE_MONITOR_PATHNAME = "/api/internal/agents/qa-release/monitor";

/**
 * The Monitor service's one destination: the same fixed origins and Railway
 * name rule as the digest, its own exact path, and the same written-form
 * comparison before the request is built.
 */
export function qaReleaseMonitorEndpoint(env: Record<string, string | undefined>): string {
  const origin = QA_RELEASE_DIGEST_ENDPOINTS[qaReleaseDigestEnvironment(env)];
  const url = `${origin}${QA_RELEASE_MONITOR_PATHNAME}`;
  assertQaReleaseMonitorEndpoint(url);
  return url;
}

export function assertQaReleaseMonitorEndpoint(candidate: string): void {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("qa_release_monitor_endpoint_invalid");
  }
  const allowedUrls: readonly string[] = Object.values(QA_RELEASE_DIGEST_ENDPOINTS).map(
    (origin) => `${origin}${QA_RELEASE_MONITOR_PATHNAME}`,
  );
  const exact = allowedUrls.includes(candidate) && url.href === candidate && url.protocol === "https:";
  if (!exact) throw new Error("qa_release_monitor_endpoint_not_allowed");
}

export const QA_RELEASE_MERGE_LANE_PATHNAMES = Object.freeze({
  state: "/api/internal/agents/qa-release/merge-lane/state",
  instruction: "/api/internal/agents/qa-release/merge-lane/instruction",
  consume: "/api/internal/agents/qa-release/merge-lane/consume",
  report: "/api/internal/agents/qa-release/merge-lane/report",
} as const);

export type QaReleaseMergeLaneCall = keyof typeof QA_RELEASE_MERGE_LANE_PATHNAMES;

/**
 * The merge lane service's four destinations: the same fixed origins and
 * Railway name rule as the digest, one exact path per call, and the same
 * written-form comparison before each request is built.
 */
export function qaReleaseMergeLaneEndpoint(env: Record<string, string | undefined>, call: QaReleaseMergeLaneCall): string {
  const origin = QA_RELEASE_DIGEST_ENDPOINTS[qaReleaseDigestEnvironment(env)];
  const url = `${origin}${QA_RELEASE_MERGE_LANE_PATHNAMES[call]}`;
  assertQaReleaseMergeLaneEndpoint(url, call);
  return url;
}

export function assertQaReleaseMergeLaneEndpoint(candidate: string, call: QaReleaseMergeLaneCall): void {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("qa_release_merge_lane_endpoint_invalid");
  }
  const allowedUrls: readonly string[] = Object.values(QA_RELEASE_DIGEST_ENDPOINTS).map(
    (origin) => `${origin}${QA_RELEASE_MERGE_LANE_PATHNAMES[call]}`,
  );
  const exact = allowedUrls.includes(candidate) && url.href === candidate && url.protocol === "https:";
  if (!exact) throw new Error("qa_release_merge_lane_endpoint_not_allowed");
}
