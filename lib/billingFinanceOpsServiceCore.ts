/**
 * One run of the billing-finance-ops stage W trigger service
 * (docs/policy/billing-finance-ops.md §1.1–1.3, §3 item 6, §4).
 *
 * It holds the run secret, the dead-man signal URL and its deployment setting,
 * calls the app's run route once, and sends the external dead-man monitor one
 * value-less signal when -- and only when -- the app answered that today's
 * digest exists or that the operator switched the agent off. Every other
 * answer, a timeout or an exception sends nothing, so the monitor's silence
 * covers this service, Railway, the app and the database alike (§1.3).
 *
 * All judgement about the digest is the app's run route
 * (`POST /api/internal/agents/billing-finance-ops/runs`).
 * This side decides only whether it may start, where it may call, and whether
 * to signal. It never retries: the next day is the retry, and a repeat the
 * same day replays.
 *
 * Pure: the caller supplies the environment object and the two network ports.
 */

import { validateEnvironment } from "./deploymentEnvironment.ts";
import { QA_RELEASE_RAILWAY_VARIABLES, QA_RELEASE_RUNTIME_VARIABLES } from "./qaReleaseServiceEnvCore.ts";

/** The three names this service may hold besides the runtime's and Railway's own (§3 item 6). */
export const BILLING_FINANCE_OPS_SERVICE_VARIABLES = Object.freeze([
  "BILLING_FINANCE_OPS_AGENT_ENABLED",
  "BILLING_FINANCE_OPS_RUN_SECRET",
  "BILLING_FINANCE_OPS_DEADMAN_URL",
] as const);

/** The run route on each environment's app. The destination carries the secret, so it is code, not a variable. */
export const BILLING_FINANCE_OPS_RUN_ENDPOINTS = Object.freeze({
  staging: "https://staging.tomverse.app/api/internal/agents/billing-finance-ops/runs",
  production: "https://tomverse.app/api/internal/agents/billing-finance-ops/runs",
} as const);

/** The run answers that mean "today's digest exists" or "the operator turned it off" (§1.3 signal 1). */
const SIGNALLED = new Map<string, number>([
  ["created", 201],
  ["replayed", 200],
  ["conflict", 409],
  ["disabled", 200],
]);

const KNOWN_RESULTS = new Set([
  "unauthorized",
  "control_unreadable",
  "disabled",
  "body_not_allowed",
  "environment_not_eligible",
  "register_too_large",
  "payload_out_of_range",
  "created",
  "replayed",
  "conflict",
  "refused",
  "deadline_exceeded",
  "internal_error",
]);

export type BillingFinanceOpsServiceOutcome =
  | { exitCode: 0; outcome: "not_deployed" }
  | { exitCode: 0; outcome: "ran"; result: string; signalled: true }
  | { exitCode: 1; outcome: "ran"; result: string; signalled: false }
  | { exitCode: 1; outcome: "ran"; result: string; signalled: false; signal: "failed" }
  | {
      exitCode: 1;
      outcome: "refused_to_start" | "destination_unknown" | "run_outcome_unknown";
      status?: number;
    };

export type BillingFinanceOpsServicePorts = {
  /** POST with the given headers and no body. Rejects on network error or timeout. */
  post: (url: string, headers: Readonly<Record<string, string>>) => Promise<{ status: number; body: unknown }>;
  /** GET with nothing in the URL, headers or body beyond the URL itself. */
  signal: (url: string) => Promise<{ status: number }>;
};

/** Whether the process environment holds only this service's names and the runtime's. */
export function billingFinanceOpsServiceEnvAllowed(names: readonly string[]): boolean {
  const allowed = new Set<string>([
    ...BILLING_FINANCE_OPS_SERVICE_VARIABLES,
    ...QA_RELEASE_RUNTIME_VARIABLES,
    ...QA_RELEASE_RAILWAY_VARIABLES,
  ]);
  return names.every((name) => allowed.has(name));
}

/** The dead-man URL must be plain https with no credentials; anything else is not sent to. */
export function billingFinanceOpsSignalUrlUsable(candidate: string): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.username === "" && url.password === "" && url.hostname.length > 0;
}

export async function runBillingFinanceOpsService(
  env: Readonly<Record<string, string | undefined>>,
  ports: BillingFinanceOpsServicePorts,
): Promise<BillingFinanceOpsServiceOutcome> {
  const names = Object.keys(env).filter((name) => env[name] !== undefined);
  if (!billingFinanceOpsServiceEnvAllowed(names)) return { exitCode: 1, outcome: "refused_to_start" };

  // A deployment setting, not the switch (§1.2): unset means this service is
  // not meant to run here at all, so it calls nothing and signals nothing.
  if ((env.BILLING_FINANCE_OPS_AGENT_ENABLED ?? "").length === 0) return { exitCode: 0, outcome: "not_deployed" };

  const secret = env.BILLING_FINANCE_OPS_RUN_SECRET ?? "";
  const signalUrl = env.BILLING_FINANCE_OPS_DEADMAN_URL ?? "";
  if (secret.length < 32 || !billingFinanceOpsSignalUrlUsable(signalUrl)) {
    return { exitCode: 1, outcome: "refused_to_start" };
  }

  const environment = validateEnvironment(env.RAILWAY_ENVIRONMENT_NAME);
  if (environment !== "staging" && environment !== "production") return { exitCode: 1, outcome: "destination_unknown" };
  const url = BILLING_FINANCE_OPS_RUN_ENDPOINTS[environment];

  let answer: { status: number; body: unknown };
  try {
    answer = await ports.post(url, { authorization: `Bearer ${secret}` });
  } catch {
    return { exitCode: 1, outcome: "run_outcome_unknown" };
  }

  const result = (answer.body as { result?: unknown } | null)?.result;
  if (typeof result !== "string" || !KNOWN_RESULTS.has(result)) {
    return { exitCode: 1, outcome: "run_outcome_unknown", status: answer.status };
  }
  // A code with the wrong status is not believed: only the pair the route
  // answers counts as today's digest existing.
  if (SIGNALLED.get(result) !== answer.status) return { exitCode: 1, outcome: "ran", result, signalled: false };

  try {
    const signalled = await ports.signal(signalUrl);
    if (signalled.status < 200 || signalled.status >= 300) {
      return { exitCode: 1, outcome: "ran", result, signalled: false, signal: "failed" };
    }
  } catch {
    return { exitCode: 1, outcome: "ran", result, signalled: false, signal: "failed" };
  }
  return { exitCode: 0, outcome: "ran", result, signalled: true };
}
