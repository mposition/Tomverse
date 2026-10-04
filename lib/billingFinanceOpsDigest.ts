/**
 * The billing-finance-ops stage W digest: its identity on the shared
 * AgentDigestItem table, its closed payload schema, and the pure builder that
 * turns the deadline judgement into that payload
 * (docs/policy/billing-finance-ops.md §1.1).
 *
 * The judgement is the report's own (scripts/report-pending-price-deadlines-core.mjs),
 * so the digest and `npm run report:pending-price-deadlines` cannot disagree
 * about a register. Free text never enters the payload: no owner, no ticket,
 * and a value that failed the report's encoding rule appears only as its index
 * and field name.
 *
 * Pure: no database, no clock, no environment.
 */

import { z } from "zod";

import type { findPendingPriceRegisterProblems, PendingVerifiedPriceEntry } from "./modelPricing";
import { judgePendingPriceDeadlines as judgeUntyped } from "../scripts/report-pending-price-deadlines-core.mjs";

export const BILLING_FINANCE_OPS_AGENT_KEY = "billing-finance-ops" as const;
export const BILLING_FINANCE_OPS_DIGEST_KIND = "price_deadline_digest" as const;
export const BILLING_FINANCE_OPS_DIGEST_SCHEMA_VERSION = 1 as const;

/** Item ceiling (policy §1.1): a longer register is refused, never truncated. */
export const BILLING_FINANCE_OPS_MAX_ITEMS = 60;
/** Four rejectable fields per item. */
export const BILLING_FINANCE_OPS_MAX_REJECTED_FIELDS = BILLING_FINANCE_OPS_MAX_ITEMS * 4;
/** The day-count range the schema closes; a value outside it refuses the run. */
export const BILLING_FINANCE_OPS_REMAINING_DAYS_LIMIT = 36_500;

export const BILLING_FINANCE_OPS_ENVIRONMENTS = ["production", "staging"] as const;
export type BillingFinanceOpsEnvironment = (typeof BILLING_FINANCE_OPS_ENVIRONMENTS)[number];

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const billingFinanceOpsDigestSchema = z
  .object({
    environment: z.enum(BILLING_FINANCE_OPS_ENVIRONMENTS),
    computedAtDate: z.string().regex(DATE),
    verdict: z.enum(["quiet", "notice", "register_invalid"]),
    items: z
      .array(
        z
          .object({
            modelId: z.string().max(100).regex(/^[a-z0-9][a-z0-9._/-]{0,99}$/),
            registeredAt: z.string().regex(DATE),
            expiresAt: z.string().regex(DATE),
            remainingDays: z
              .number()
              .int()
              .min(-BILLING_FINANCE_OPS_REMAINING_DAYS_LIMIT)
              .max(BILLING_FINANCE_OPS_REMAINING_DAYS_LIMIT)
              .nullable(),
            mark: z.enum(["none", "30", "14", "7", "1", "expired"]),
          })
          .strict(),
      )
      .max(BILLING_FINANCE_OPS_MAX_ITEMS),
    rejectedFields: z
      .array(
        z
          .object({
            index: z.number().int().min(0).max(BILLING_FINANCE_OPS_MAX_ITEMS - 1),
            field: z.enum(["modelId", "registeredAt", "expiresAt", "ticket"]),
          })
          .strict(),
      )
      .max(BILLING_FINANCE_OPS_MAX_REJECTED_FIELDS),
  })
  .strict();

export type BillingFinanceOpsDigestPayload = z.infer<typeof billingFinanceOpsDigestSchema>;

/** One digest per environment per UTC day (policy §1.1 item 3). */
export const billingFinanceOpsIdempotencyKey = (
  environment: BillingFinanceOpsEnvironment,
  computedAtDate: string,
) => `${BILLING_FINANCE_OPS_AGENT_KEY}:price-deadline:${environment}:${computedAtDate}`;

export type BillingFinanceOpsPayloadResult =
  | { ok: true; payload: BillingFinanceOpsDigestPayload }
  | { ok: false; reason: "register_too_large" | "payload_out_of_range" };

type Mark = "none" | "30" | "14" | "7" | "1" | "expired";
type RejectableField = "modelId" | "registeredAt" | "expiresAt" | "ticket";
type JudgedEntry =
  | {
      kind: "deadline";
      index: number;
      modelId: string;
      registeredAt: string;
      expiresAt: string;
      remainingDays: number | null;
      mark: Mark;
      ticket: string;
    }
  | { kind: "rejected"; index: number; fields: RejectableField[] };
type JudgeInput = {
  register: readonly PendingVerifiedPriceEntry[];
  models: Parameters<typeof findPendingPriceRegisterProblems>[0]["models"];
  now: Date;
};

/** The report core's judgement, with the shape it returns written down for TypeScript. */
const judgePendingPriceDeadlines = judgeUntyped as unknown as (input: JudgeInput) => {
  entries: JudgedEntry[];
  verdict: "quiet" | "notice" | "register_invalid";
};

/**
 * The payload for one run. `environment` and `computedAtDate` come from the
 * server (the route), never from a caller.
 */
export const buildBillingFinanceOpsPayload = ({
  environment,
  computedAtDate,
  register,
  models,
  now,
}: {
  environment: BillingFinanceOpsEnvironment;
  computedAtDate: string;
  register: JudgeInput["register"];
  models: JudgeInput["models"];
  now: Date;
}): BillingFinanceOpsPayloadResult => {
  if (register.length > BILLING_FINANCE_OPS_MAX_ITEMS) return { ok: false, reason: "register_too_large" };

  const { entries, verdict } = judgePendingPriceDeadlines({ register, models, now });
  const candidate = {
    environment,
    computedAtDate,
    verdict,
    items: entries.flatMap((entry) =>
      entry.kind === "deadline"
        ? [
            {
              modelId: entry.modelId,
              registeredAt: entry.registeredAt,
              expiresAt: entry.expiresAt,
              remainingDays: entry.remainingDays,
              mark: entry.mark,
            },
          ]
        : [],
    ),
    rejectedFields: entries.flatMap((entry) =>
      entry.kind === "rejected" ? entry.fields.map((field) => ({ index: entry.index, field })) : [],
    ),
  };
  const parsed = billingFinanceOpsDigestSchema.safeParse(candidate);
  // The only values the judgement produces that the schema can refuse are a
  // day count beyond its range; anything else would be a defect in the core.
  if (!parsed.success) return { ok: false, reason: "payload_out_of_range" };
  return { ok: true, payload: parsed.data };
};
