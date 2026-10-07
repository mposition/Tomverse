/**
 * The Support Triage Retention service's decisions (docs/policy/support-triage.md §3, §5).
 *
 * The service is a Railway cron: a supervisor starts a child, the child POSTs
 * the retention route once, and the supervisor kills the child with SIGKILL
 * at its deadline. It holds the retention route secret and nothing else; the
 * destination is code, chosen by the Railway environment name, because it is
 * where the secret goes. Nothing retries: a run whose outcome is unknown
 * ends with exit 1 and the next cron tick starts fresh.
 *
 * The order of the three deadlines is fixed: supervisor (5 min) > child
 * request (4 min) > the route's own run budget (100 s, enforced in the app).
 *
 * Pure except `postWithTimeout`, which is the child's network port.
 */
import { validateEnvironment } from "./deploymentEnvironment.ts";
import { QA_RELEASE_RAILWAY_VARIABLES, QA_RELEASE_RUNTIME_VARIABLES } from "./qaReleaseServiceEnvCore.ts";

/** The one name this service holds besides the runtime's and Railway's own. */
export const SUPPORT_TRIAGE_RETENTION_SERVICE_VARIABLES = Object.freeze(["SUPPORT_TRIAGE_RETENTION_SECRET"] as const);

export const SUPPORT_TRIAGE_RETENTION_ENDPOINTS = Object.freeze({
  staging: "https://staging.tomverse.app/api/internal/support-triage/retention",
  production: "https://tomverse.app/api/internal/support-triage/retention",
} as const);

export const SUPPORT_TRIAGE_RETENTION_SUPERVISOR_DEADLINE_MS = 5 * 60_000;
export const SUPPORT_TRIAGE_RETENTION_CHILD_REQUEST_TIMEOUT_MS = 4 * 60_000;
/** The route's run budget, the app's `LANE_TIMEOUTS.retention.deadlineMs`. */
export const SUPPORT_TRIAGE_RETENTION_ROUTE_BUDGET_MS = 100_000;

/** Each result the route answers, with the one status it comes with. */
const RESULT_STATUS = new Map<string, number>([
  ["ok", 200],
  ["SUPPORT_TRIAGE_RETENTION_NOT_PROGRESSING", 503],
  ["transaction_refused", 503],
  ["daily_cap_exceeded", 429],
  ["unauthorized", 401],
  ["internal_error", 500],
]);

export type SupportTriageRetentionServiceOutcome =
  | { readonly exitCode: 0; readonly outcome: "ran"; readonly result: "ok" }
  | { readonly exitCode: 1; readonly outcome: "ran"; readonly result: string; readonly status: number }
  | {
      readonly exitCode: 1;
      readonly outcome: "refused_to_start" | "destination_unknown" | "run_outcome_unknown";
      readonly status?: number;
    };

export type SupportTriageRetentionPost = (
  url: string,
  headers: Readonly<Record<string, string>>
) => Promise<{ status: number; body: unknown }>;

/** Whether the process environment holds only this service's name and the runtime's. */
export function supportTriageRetentionServiceEnvAllowed(names: readonly string[]): boolean {
  const allowed = new Set<string>([
    ...SUPPORT_TRIAGE_RETENTION_SERVICE_VARIABLES,
    ...QA_RELEASE_RUNTIME_VARIABLES,
    ...QA_RELEASE_RAILWAY_VARIABLES,
  ]);
  return names.every((name) => allowed.has(name));
}

/** What the supervisor checks before it starts a child; the child checks it again. */
export function supportTriageRetentionStartRefusal(
  env: Readonly<Record<string, string | undefined>>
): SupportTriageRetentionServiceOutcome | null {
  const names = Object.keys(env).filter((name) => env[name] !== undefined);
  if (!supportTriageRetentionServiceEnvAllowed(names)) return { exitCode: 1, outcome: "refused_to_start" };
  if ((env.SUPPORT_TRIAGE_RETENTION_SECRET ?? "").length < 32) return { exitCode: 1, outcome: "refused_to_start" };
  const environment = validateEnvironment(env.RAILWAY_ENVIRONMENT_NAME);
  if (environment !== "staging" && environment !== "production") return { exitCode: 1, outcome: "destination_unknown" };
  return null;
}

/** One run: POST the retention route once, and read only its result code and status. */
export async function runSupportTriageRetentionService(
  env: Readonly<Record<string, string | undefined>>,
  post: SupportTriageRetentionPost
): Promise<SupportTriageRetentionServiceOutcome> {
  const refusal = supportTriageRetentionStartRefusal(env);
  if (refusal) return refusal;
  const environment = validateEnvironment(env.RAILWAY_ENVIRONMENT_NAME) as "staging" | "production";
  let answer: { status: number; body: unknown };
  try {
    answer = await post(SUPPORT_TRIAGE_RETENTION_ENDPOINTS[environment], {
      authorization: `Bearer ${env.SUPPORT_TRIAGE_RETENTION_SECRET}`,
    });
  } catch {
    return { exitCode: 1, outcome: "run_outcome_unknown" };
  }
  const result = (answer.body as { result?: unknown } | null)?.result;
  // A code with the wrong status is not believed.
  if (typeof result !== "string" || RESULT_STATUS.get(result) !== answer.status) {
    return { exitCode: 1, outcome: "run_outcome_unknown", status: answer.status };
  }
  if (result === "ok") return { exitCode: 0, outcome: "ran", result: "ok" };
  return { exitCode: 1, outcome: "ran", result, status: answer.status };
}

/** The child's port: POST with no body, no redirect, aborted at the timeout. */
export const postWithTimeout =
  (timeoutMs: number): SupportTriageRetentionPost =>
  async (url, headers) => {
    const response = await fetch(url, {
      method: "POST",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  };
