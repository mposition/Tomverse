import { z } from "zod";

/**
 * Managed Code credits: Desktop's view of the server's credit-reservation path (POST /api/code/managed).
 *
 * A reservation holds credits the person approved before any paid call; the server then makes the model calls itself,
 * settles each one from the provider's verified usage, and returns the unused part on release or expiry. Desktop adds no
 * price or credit rule: every number shown here is a server receipt value. The renderer names an action; the main process
 * sends the matching request with the account session and parses the answer with the schemas below.
 *
 * Nothing here runs a task. The path is a metered, server-made structured completion, not a place that runs a project.
 */

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;
/** The server's own request bound for one approval; the server still decides whether the account can fund it. */
export const MANAGED_MAX_APPROVED_CREDITS = 1_000_000;

export const managedModelId = z.string().regex(MODEL_ID);
const credits = z.number().int().nonnegative();

export const desktopManagedCodeInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read") }).strict(),
  z.object({
    action: z.literal("reserve"), executorModelId: managedModelId, reviewerModelId: managedModelId,
    approvedCredits: z.number().int().positive().max(MANAGED_MAX_APPROVED_CREDITS),
  }).strict(),
  // The person ends a reservation. `completed` and `cancelled` are the two reasons a person can give.
  z.object({ action: z.literal("release"), reason: z.enum(["completed", "cancelled"]) }).strict(),
  z.object({ action: z.literal("dismiss") }).strict(),
]);
export type DesktopManagedCodeInput = z.infer<typeof desktopManagedCodeInput>;

/** The five reasons the server accepts on release. A person only ever picks the first two. */
export const managedTerminalReason = z.enum(["completed", "rejected", "cancelled", "interrupted", "failed"]);
export type ManagedTerminalReason = z.infer<typeof managedTerminalReason>;

const pairModel = z.object({ modelId: managedModelId, name: z.string().max(200), provider: z.string().max(60) });
export const managedBilling = z.object({
  reservedCredits: credits, settledCredits: credits, releasedCredits: credits,
  heldCredits: credits, unknownHeldCredits: credits, availableCredits: credits,
});
export type ManagedBilling = z.infer<typeof managedBilling>;

/** What the server returns for reserve, heartbeat, release and status. Other fields are dropped. */
export const managedReceipt = z.object({
  reservationId: z.uuid(),
  state: z.string().max(40),
  leaseExpiresAt: z.string().max(64),
  heartbeatIntervalMs: z.number().int().positive(),
  modelPair: z.object({ executor: pairModel, reviewer: pairModel }),
  billing: managedBilling,
});
export type ManagedReceipt = z.infer<typeof managedReceipt>;

export const managedCallResult = managedReceipt.extend({
  callId: z.uuid().optional(),
  callCredits: credits,
  value: z.unknown(),
});

export type ManagedReservationState = "active" | "interrupted" | "closed" | "outcome_unknown" | "other";
export const reservationState = (state: string): ManagedReservationState =>
  state === "active" || state === "interrupted" || state === "closed" || state === "outcome_unknown" ? state : "other";

/** Why the server (or this app, before sending) did not give or keep a reservation. Each has its own sentence in the person's language. */
export const managedRefusal = z.enum([
  "disabled", "insufficientCredits", "dailyLimit", "taskCap", "callCeiling", "costGuardrail", "concurrency", "rateLimited",
  "plan", "catalog", "sameProvider", "account", "notFound", "notActive", "conflict", "outcomeUnknown", "origin",
  "unreachable", "alreadyReserved", "unavailable",
]);
export type ManagedRefusal = z.infer<typeof managedRefusal>;

const codeRefusals: Record<string, ManagedRefusal> = {
  CODE_MANAGED_DISABLED: "disabled",
  CREDIT_BALANCE_INSUFFICIENT: "insufficientCredits", ADDON_CREDITS_INSUFFICIENT: "insufficientCredits",
  ADDON_COST_ALLOWANCE_INSUFFICIENT: "insufficientCredits",
  PLAN_DAILY_CREDIT_LIMIT_REACHED: "dailyLimit",
  CODE_TASK_CAP_EXCEEDED: "taskCap",
  CODE_TASK_CALL_CEILING_REACHED: "callCeiling",
  OPERATIONAL_COST_GUARDRAIL_TRIGGERED: "costGuardrail", PROVIDER_COST_BUDGET_EXCEEDED: "costGuardrail",
  CODE_PROVIDER_BUDGET_UNAVAILABLE: "costGuardrail",
  CODE_TASK_CONCURRENCY_EXCEEDED: "concurrency", CODE_CALL_CONCURRENCY_EXCEEDED: "concurrency",
  CODE_RATE_LIMITED: "rateLimited",
  CODE_MODEL_PLAN_FORBIDDEN: "plan",
  CODE_MODEL_UNAVAILABLE: "catalog", CODE_CATALOG_CHANGED: "catalog", CODE_CATALOG_STALE: "catalog", CODE_CATALOG_INVALID: "catalog",
  CODE_CATALOG_PRICING_CHANGED: "catalog", CODE_PROVIDER_COST_UNBOUNDED: "catalog", CODE_MODEL_PIN_MISMATCH: "catalog",
  CODE_REVIEWER_PROVIDER_NOT_INDEPENDENT: "sameProvider",
  CODE_ACCOUNT_UNAVAILABLE: "account",
  CODE_RESERVATION_NOT_FOUND: "notFound",
  CODE_TASK_NOT_ACTIVE: "notActive",
  CODE_TASK_IDEMPOTENCY_CONFLICT: "conflict", CODE_CALL_IDEMPOTENCY_CONFLICT: "conflict",
  CODE_TASK_OUTCOME_UNKNOWN: "outcomeUnknown", CODE_CALL_OUTCOME_UNKNOWN: "outcomeUnknown", CODE_SETTLEMENT_OUTCOME_UNKNOWN: "outcomeUnknown",
  CODE_ORIGIN_FORBIDDEN: "origin",
};
export const managedRefusalFor = (code: string | undefined): ManagedRefusal => (code && codeRefusals[code]) || "unavailable";

/** The coding catalogue the reservation is pinned to. Desktop reads it only to list the models; the server re-checks every one. */
export const managedCatalogSnapshot = z.object({
  version: z.number().int().positive(),
  contentHash: z.string().min(1).max(128),
  models: z.array(z.object({
    modelId: managedModelId, name: z.string().max(200), provider: z.string().max(60),
    minimumPlan: z.enum(["Free", "Pro", "Max"]).catch("Free"),
    channels: z.array(z.string()).default(["code"]),
    capabilities: z.object({ structuredOutput: z.string() }).partial().default({}),
  })).max(500),
});
export type ManagedCatalogSnapshot = z.infer<typeof managedCatalogSnapshot>;

export type ManagedCodeModel = { id: string; name: string; provider: string; minimumPlan: "Free" | "Pro" | "Max" };
export type ManagedReservationView = {
  id: string;
  state: ManagedReservationState;
  executor: { id: string; name: string; provider: string };
  reviewer: { id: string; name: string; provider: string };
  billing: ManagedBilling;
  /** Whether the app's keep-alive messages are reaching the server. `lost` after two misses in a row. */
  heartbeat: "ok" | "lost";
  /** The reason the person gave when ending it; absent when the server ended it. */
  endedBy?: ManagedTerminalReason;
};
export type ManagedCodeView = {
  /** null: not read yet. */
  catalog: { version: number; models: ManagedCodeModel[] } | null;
  reservation: ManagedReservationView | null;
  refusal: ManagedRefusal | null;
};
export const emptyManagedCodeView: ManagedCodeView = { catalog: null, reservation: null, refusal: null };
