import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

import { ApiSecurityError, readLimitedText } from "@/lib/apiSecurity";
import { recordAgentDigestItem } from "@/lib/agentDigestStore";
import {
  BILLING_FINANCE_OPS_AGENT_KEY,
  BILLING_FINANCE_OPS_DIGEST_KIND,
  BILLING_FINANCE_OPS_DIGEST_SCHEMA_VERSION,
  BILLING_FINANCE_OPS_ENVIRONMENTS,
  type BillingFinanceOpsEnvironment,
  billingFinanceOpsIdempotencyKey,
  buildBillingFinanceOpsPayload,
} from "@/lib/billingFinanceOpsDigest";
import { readBillingFinanceOpsControl } from "@/lib/billingFinanceOpsControl";
import { resolveDeploymentEnvironment } from "@/lib/deploymentEnvironment";
import { AVAILABLE_MODELS } from "@/lib/models";
import { PENDING_VERIFIED_PRICE_REGISTER } from "@/lib/modelPricing";
import { prisma } from "@/lib/prisma";

/**
 * The stage W run (docs/policy/billing-finance-ops.md §1.1). The route is a
 * thin answer around this; every judgement is here.
 *
 * Order: the secret, then the app switch, then the body (there must be none),
 * then the database clock, the environment, the payload and the single writer.
 * Nothing the caller sends reaches the payload: the register is this
 * deployment's tracked source, the environment is this deployment's own, and
 * the date and deadline come from the database clock.
 *
 * The answer is a fixed code and a status. `disabled` is answered only after
 * the secret, so the trigger service can tell the operator's off from a
 * fault and keep its liveness signal; `control_unreadable` is a fault and is
 * never answered as `disabled` (§1.2).
 */

export const BILLING_FINANCE_OPS_RUN_SECRET_ENV = "BILLING_FINANCE_OPS_RUN_SECRET";
const MIN_SECRET_LENGTH = 32;

/** How long a run has, from its first database clock read (§1.1 item 2). */
export const BILLING_FINANCE_OPS_RUN_DEADLINE_MS = 45_000;

export type BillingFinanceOpsRunCode =
  | "unauthorized"
  | "control_unreadable"
  | "disabled"
  | "body_not_allowed"
  | "environment_not_eligible"
  | "register_too_large"
  | "payload_out_of_range"
  | "created"
  | "replayed"
  | "conflict"
  | "refused"
  | "deadline_exceeded";

export type BillingFinanceOpsRunAnswer = { status: number; body: { result: BillingFinanceOpsRunCode } };

const STATUS: Readonly<Record<BillingFinanceOpsRunCode, number>> = Object.freeze({
  unauthorized: 401,
  control_unreadable: 503,
  disabled: 200,
  body_not_allowed: 400,
  environment_not_eligible: 503,
  register_too_large: 409,
  payload_out_of_range: 409,
  created: 201,
  replayed: 200,
  conflict: 409,
  refused: 422,
  deadline_exceeded: 409,
});

const answer = (result: BillingFinanceOpsRunCode): BillingFinanceOpsRunAnswer => ({
  status: STATUS[result],
  body: { result },
});

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** Bearer secret, at least 32 characters, compared as SHA-256 digests in constant time. */
export const isBillingFinanceOpsRunAuthorized = (
  authorization: string | null,
  env: Readonly<Record<string, string | undefined>>,
): boolean => {
  const own = env[BILLING_FINANCE_OPS_RUN_SECRET_ENV] ?? "";
  if (own.length < MIN_SECRET_LENGTH) return false;
  if (!authorization?.startsWith("Bearer ")) return false;
  const provided = authorization.slice("Bearer ".length);
  if (provided.length === 0) return false;
  return timingSafeEqual(digest(own), digest(provided));
};

/** The database refused the commit because the run's deadline had passed. */
export const isBillingFinanceOpsDeadlineError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes("billing_finance_ops_deadline_passed");

type RunDependencies = {
  env?: Readonly<Record<string, string | undefined>>;
  db?: typeof prisma;
  register?: Parameters<typeof buildBillingFinanceOpsPayload>[0]["register"];
  models?: Parameters<typeof buildBillingFinanceOpsPayload>[0]["models"];
  /** Tests shorten or expire the deadline; the route never passes it. */
  deadlineMs?: number;
};

export async function runBillingFinanceOpsDeadline(
  request: Request,
  {
    env = process.env,
    db = prisma,
    register = PENDING_VERIFIED_PRICE_REGISTER,
    models = AVAILABLE_MODELS,
    deadlineMs = BILLING_FINANCE_OPS_RUN_DEADLINE_MS,
  }: RunDependencies = {},
): Promise<BillingFinanceOpsRunAnswer> {
  if (!isBillingFinanceOpsRunAuthorized(request.headers.get("authorization"), env)) return answer("unauthorized");

  const control = await readBillingFinanceOpsControl(db);
  if (control.state === "unreadable") return answer("control_unreadable");
  if (control.state === "disabled") return answer("disabled");

  // The trigger sends no body; anything at all is refused before it is read.
  if (request.body !== null) {
    try {
      if ((await readLimitedText(request, 0)).length > 0) return answer("body_not_allowed");
    } catch (error) {
      if (error instanceof ApiSecurityError) return answer("body_not_allowed");
      throw error;
    }
  }

  // One database clock read: the date (and so the idempotency key) and the
  // deadline both come from it, never from this process's clock. It is read
  // as epoch milliseconds, not as a timestamptz: Prisma returns a raw
  // timestamptz as the session's wall-clock time labelled UTC, so on a
  // database whose TimeZone is not UTC the instant came back hours off -- on a
  // +10:00 session a run already past its deadline was recorded as a success.
  const [{ startedAtMs }] = await db.$queryRaw<{ startedAtMs: number }[]>`
    SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::float8 AS "startedAtMs"`;
  const startedAt = new Date(Number(startedAtMs));
  const computedAtDate = startedAt.toISOString().slice(0, 10);
  // Passed back as an ISO instant with its Z: a JS Date parameter would be
  // read in the session's time zone.
  const deadlineIso = new Date(startedAt.getTime() + deadlineMs).toISOString();

  const deployment = resolveDeploymentEnvironment(env as NodeJS.ProcessEnv);
  if (!(BILLING_FINANCE_OPS_ENVIRONMENTS as readonly string[]).includes(deployment)) {
    return answer("environment_not_eligible");
  }
  const environment = deployment as BillingFinanceOpsEnvironment;

  const built = buildBillingFinanceOpsPayload({ environment, computedAtDate, register, models, now: startedAt });
  if (!built.ok) return answer(built.reason);

  try {
    const result = await recordAgentDigestItem(
      {
        agentKey: BILLING_FINANCE_OPS_AGENT_KEY,
        kind: BILLING_FINANCE_OPS_DIGEST_KIND,
        schemaVersion: BILLING_FINANCE_OPS_DIGEST_SCHEMA_VERSION,
        idempotencyKey: billingFinanceOpsIdempotencyKey(environment, computedAtDate),
        payload: built.payload,
      },
      db,
      undefined,
      // The transaction's last statement: the database refuses the commit
      // when its own clock is past the deadline, rolling back the row and its
      // audit entry together (§1.1 item 4).
      async (tx) => {
        await tx.$executeRaw`SELECT billing_finance_ops_assert_deadline(${deadlineIso}::timestamptz)`;
        return null;
      },
    );
    switch (result.status) {
      case "created":
      case "replayed":
      case "conflict":
        return answer(result.status);
      case "refused":
      case "not_admitted":
        return answer("refused");
    }
  } catch (error) {
    if (isBillingFinanceOpsDeadlineError(error)) return answer("deadline_exceeded");
    throw error;
  }
}
