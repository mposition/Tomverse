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

/**
 * What the deployed Agents image puts in every process environment, measured
 * on 2026-10-03 (lib/productResearchObservationRunnerCore.mjs records the same
 * measurement). Exact names where the name was measured; the builder's and
 * toolchain's families by prefix, because their members are many and change
 * with Railpack. RAILWAY_ is not a prefix here: the platform's names are the
 * exact list in QA_RELEASE_RAILWAY_VARIABLES, so a variable merely starting
 * with RAILWAY_ is refused. A family that newly appears refuses the start and
 * is named in the log; the fix is to measure again.
 */
export const SUPPORT_TRIAGE_RETENTION_IMAGE_VARIABLES = Object.freeze([
  "CI",
  "NEXT_TELEMETRY_DISABLED",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const);
export const SUPPORT_TRIAGE_RETENTION_IMAGE_PREFIXES = Object.freeze(["RAILPACK_", "MISE_", "__MISE_"] as const);

/** Names Windows adds to every child process; only for exercising the service on a developer machine. */
const WINDOWS_PROCESS_VARIABLES = [
  "COMSPEC",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "PATHEXT",
  "SYSTEMDRIVE",
  "SystemDrive",
  "SYSTEMROOT",
  "SystemRoot",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
];

/** A value that is a database connection string or carries a database password. */
const DATABASE_URL_SHAPE =
  /^(postgres(ql)?|mysql|mariadb|mongodb(\+srv)?|redis(s)?|prisma(\+postgres)?|jdbc|libsql):/i;
// libpq keyword form. A password or password file is enough on its own:
// libpq defaults the host, and `service=` reads the rest from pg_service.conf,
// so no second keyword is needed for the value to connect.
// A word boundary, not whitespace: libpq accepts a keyword right after a
// quoted value's closing quote (host='db'password=x).
const CONNINFO_SHAPE = /\b(?:password|passfile|sslpassword)\s*=/i;

export type SupportTriageRetentionRefusalReason =
  | "env_not_allowed"
  | "env_holds_connection_string"
  | "secret_missing_or_short";

export type SupportTriageRetentionServiceOutcome =
  | { readonly exitCode: 0; readonly outcome: "ran"; readonly result: "ok" }
  | { readonly exitCode: 1; readonly outcome: "ran"; readonly result: string; readonly status: number }
  | {
      readonly exitCode: 1;
      readonly outcome: "refused_to_start";
      readonly reason: SupportTriageRetentionRefusalReason;
      /** Variable names only, never a value. */
      readonly names?: readonly string[];
    }
  | {
      readonly exitCode: 1;
      readonly outcome: "destination_unknown" | "run_outcome_unknown";
      readonly status?: number;
    };

export type SupportTriageRetentionPost = (
  url: string,
  headers: Readonly<Record<string, string>>
) => Promise<{ status: number; body: unknown }>;

/** The names in this environment that the service does not expect, sorted. */
export function supportTriageRetentionUnexpectedNames(
  names: readonly string[],
  platform: string = process.platform
): string[] {
  const allowed = new Set<string>([
    ...SUPPORT_TRIAGE_RETENTION_SERVICE_VARIABLES,
    ...QA_RELEASE_RUNTIME_VARIABLES,
    ...QA_RELEASE_RAILWAY_VARIABLES,
    ...SUPPORT_TRIAGE_RETENTION_IMAGE_VARIABLES,
    ...(platform === "win32" ? WINDOWS_PROCESS_VARIABLES : []),
  ]);
  return names
    .filter((name) => !allowed.has(name) && !SUPPORT_TRIAGE_RETENTION_IMAGE_PREFIXES.some((prefix) => name.startsWith(prefix)))
    .sort();
}

/** What the supervisor checks before it starts a child; the child checks it again. */
export function supportTriageRetentionStartRefusal(
  env: Readonly<Record<string, string | undefined>>
): SupportTriageRetentionServiceOutcome | null {
  const names = Object.keys(env).filter((name) => env[name] !== undefined);
  const unexpected = supportTriageRetentionUnexpectedNames(names);
  if (unexpected.length > 0) {
    return { exitCode: 1, outcome: "refused_to_start", reason: "env_not_allowed", names: unexpected };
  }
  // A connection string pasted into any variable, whatever its name.
  const shaped = names
    .filter((name) => {
      const value = (env[name] ?? "").trim();
      return DATABASE_URL_SHAPE.test(value) || CONNINFO_SHAPE.test(value);
    })
    .sort();
  if (shaped.length > 0) {
    return { exitCode: 1, outcome: "refused_to_start", reason: "env_holds_connection_string", names: shaped };
  }
  if ((env.SUPPORT_TRIAGE_RETENTION_SECRET ?? "").length < 32) {
    return { exitCode: 1, outcome: "refused_to_start", reason: "secret_missing_or_short" };
  }
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
