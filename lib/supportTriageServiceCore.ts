/**
 * The Support Triage cron services' decisions (docs/policy/support-triage.md §3, §5).
 *
 * Two Railway crons share this shape: `Support Triage` POSTs the worker's run
 * route and `Support Triage Retention` the retention route. Each is a
 * supervisor that starts a child; the child POSTs its route once, and the
 * supervisor kills the child with SIGKILL at its deadline. A service holds its
 * own route secret and nothing else; the destination is code, chosen by the
 * Railway environment name, because it is where the secret goes. Nothing
 * retries: a run whose outcome is unknown ends with exit 1 and the next cron
 * tick starts fresh.
 *
 * Per service the order of the three deadlines is fixed: supervisor > child
 * request > the route's own run budget (enforced in the app).
 *
 * Pure except `postWithTimeout`, the children's network port.
 */
import { validateEnvironment } from "./deploymentEnvironment.ts";
import { QA_RELEASE_RAILWAY_VARIABLES, QA_RELEASE_RUNTIME_VARIABLES } from "./qaReleaseServiceEnvCore.ts";

export const SUPPORT_TRIAGE_SERVICE_KINDS = Object.freeze(["worker", "retention"] as const);
export type SupportTriageServiceKind = (typeof SUPPORT_TRIAGE_SERVICE_KINDS)[number];

type ServiceDefinition = {
  /** The one name this service holds besides the runtime's and Railway's own. */
  readonly secretVariable: string;
  readonly endpoints: Readonly<Record<"staging" | "production", string>>;
  readonly supervisorDeadlineMs: number;
  readonly childRequestTimeoutMs: number;
  /** The route's run budget, the app's `LANE_TIMEOUTS[lane].deadlineMs`. */
  readonly routeBudgetMs: number;
  /** Each result the route answers, with the one status it comes with. */
  readonly resultStatus: ReadonlyMap<string, number>;
};

export const SUPPORT_TRIAGE_SERVICES: Readonly<Record<SupportTriageServiceKind, ServiceDefinition>> = Object.freeze({
  worker: Object.freeze({
    secretVariable: "SUPPORT_TRIAGE_RUN_SECRET",
    endpoints: Object.freeze({
      staging: "https://staging.tomverse.app/api/internal/support-triage/run",
      production: "https://tomverse.app/api/internal/support-triage/run",
    }),
    supervisorDeadlineMs: 10 * 60_000,
    childRequestTimeoutMs: 9 * 60_000,
    routeBudgetMs: 5 * 60_000,
    resultStatus: new Map<string, number>([
      // Also answered while triage is switched off: the service ran, nothing was due.
      ["ok", 200],
      ["transaction_refused", 503],
      ["daily_cap_exceeded", 429],
      ["unauthorized", 401],
      ["internal_error", 500],
    ]),
  }),
  retention: Object.freeze({
    secretVariable: "SUPPORT_TRIAGE_RETENTION_SECRET",
    endpoints: Object.freeze({
      staging: "https://staging.tomverse.app/api/internal/support-triage/retention",
      production: "https://tomverse.app/api/internal/support-triage/retention",
    }),
    supervisorDeadlineMs: 5 * 60_000,
    childRequestTimeoutMs: 4 * 60_000,
    routeBudgetMs: 100_000,
    resultStatus: new Map<string, number>([
      ["ok", 200],
      ["SUPPORT_TRIAGE_RETENTION_NOT_PROGRESSING", 503],
      ["transaction_refused", 503],
      ["daily_cap_exceeded", 429],
      ["unauthorized", 401],
      ["internal_error", 500],
    ]),
  }),
});

/** The variables each service's IaC entry declares; the start check accepts exactly these. */
export const supportTriageServiceVariables = (kind: SupportTriageServiceKind): readonly string[] =>
  Object.freeze([SUPPORT_TRIAGE_SERVICES[kind].secretVariable]);

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
export const SUPPORT_TRIAGE_SERVICE_IMAGE_VARIABLES = Object.freeze([
  "CI",
  "NEXT_TELEMETRY_DISABLED",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const);
export const SUPPORT_TRIAGE_SERVICE_IMAGE_PREFIXES = Object.freeze(["RAILPACK_", "MISE_", "__MISE_"] as const);

/** Names Windows adds to every child process; only for exercising a service on a developer machine. */
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

export type SupportTriageServiceRefusalReason =
  | "env_not_allowed"
  | "env_holds_connection_string"
  | "secret_missing_or_short";

export type SupportTriageServiceOutcome =
  | { readonly exitCode: 0; readonly outcome: "ran"; readonly result: "ok" }
  | { readonly exitCode: 1; readonly outcome: "ran"; readonly result: string; readonly status: number }
  | {
      readonly exitCode: 1;
      readonly outcome: "refused_to_start";
      readonly reason: SupportTriageServiceRefusalReason;
      /** Variable names only, never a value. */
      readonly names?: readonly string[];
    }
  | {
      readonly exitCode: 1;
      readonly outcome: "destination_unknown" | "run_outcome_unknown";
      readonly status?: number;
    };

export type SupportTriageServicePost = (
  url: string,
  headers: Readonly<Record<string, string>>
) => Promise<{ status: number; body: unknown }>;

/** The names in this environment that the service does not expect, sorted. */
export function supportTriageServiceUnexpectedNames(
  kind: SupportTriageServiceKind,
  names: readonly string[],
  platform: string = process.platform
): string[] {
  const allowed = new Set<string>([
    ...supportTriageServiceVariables(kind),
    ...QA_RELEASE_RUNTIME_VARIABLES,
    ...QA_RELEASE_RAILWAY_VARIABLES,
    ...SUPPORT_TRIAGE_SERVICE_IMAGE_VARIABLES,
    ...(platform === "win32" ? WINDOWS_PROCESS_VARIABLES : []),
  ]);
  return names
    .filter((name) => !allowed.has(name) && !SUPPORT_TRIAGE_SERVICE_IMAGE_PREFIXES.some((prefix) => name.startsWith(prefix)))
    .sort();
}

/** What the supervisor checks before it starts a child; the child checks it again. */
export function supportTriageServiceStartRefusal(
  kind: SupportTriageServiceKind,
  env: Readonly<Record<string, string | undefined>>
): SupportTriageServiceOutcome | null {
  const names = Object.keys(env).filter((name) => env[name] !== undefined);
  const unexpected = supportTriageServiceUnexpectedNames(kind, names);
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
  if ((env[SUPPORT_TRIAGE_SERVICES[kind].secretVariable] ?? "").length < 32) {
    return { exitCode: 1, outcome: "refused_to_start", reason: "secret_missing_or_short" };
  }
  const environment = validateEnvironment(env.RAILWAY_ENVIRONMENT_NAME);
  if (environment !== "staging" && environment !== "production") return { exitCode: 1, outcome: "destination_unknown" };
  return null;
}

/** One run: POST the service's route once, and read only its result code and status. */
export async function runSupportTriageService(
  kind: SupportTriageServiceKind,
  env: Readonly<Record<string, string | undefined>>,
  post: SupportTriageServicePost
): Promise<SupportTriageServiceOutcome> {
  const refusal = supportTriageServiceStartRefusal(kind, env);
  if (refusal) return refusal;
  const service = SUPPORT_TRIAGE_SERVICES[kind];
  const environment = validateEnvironment(env.RAILWAY_ENVIRONMENT_NAME) as "staging" | "production";
  let answer: { status: number; body: unknown };
  try {
    answer = await post(service.endpoints[environment], {
      authorization: `Bearer ${env[service.secretVariable]}`,
    });
  } catch {
    return { exitCode: 1, outcome: "run_outcome_unknown" };
  }
  const result = (answer.body as { result?: unknown } | null)?.result;
  // A code with the wrong status is not believed.
  if (typeof result !== "string" || service.resultStatus.get(result) !== answer.status) {
    return { exitCode: 1, outcome: "run_outcome_unknown", status: answer.status };
  }
  if (result === "ok") return { exitCode: 0, outcome: "ran", result: "ok" };
  return { exitCode: 1, outcome: "ran", result, status: answer.status };
}

/** A child's port: POST with no body, no redirect, aborted at the timeout. */
export const postWithTimeout =
  (timeoutMs: number): SupportTriageServicePost =>
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
