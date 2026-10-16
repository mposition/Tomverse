/**
 * The generator's budget requests, read and answered (S3 plan, S3c3a).
 *
 * One route, five actions. Each request is authenticated by the generator's
 * bearer secret, bounded to 4 KB, parsed by its action's strict schema, and
 * signed: the budget HMAC covers the action, the deadline and every field, so
 * a captured request cannot be replayed with a later deadline or another
 * call's fields. Each action runs in a transaction of its own, which is what
 * the ledger store expects.
 *
 * The handler takes its environment as an argument so tests can give it a
 * price pin; the route passes the build's, in which no model is pinned yet.
 */

import "server-only";

import { timingSafeEqual } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

import { marketingLlmBudgetSignature, MARKETING_LLM_PURPOSES } from "@/lib/marketingLlmBudgetCore";
import {
  dispatchMarketingLlmCall,
  releaseMarketingLlmCall,
  reportMarketingLlmCallUnknown,
  reserveMarketingLlmCall,
  settleMarketingLlmCall,
  type MarketingLlmBudgetEnvironment,
  type MarketingLlmOutcome,
} from "@/lib/marketingLlmBudgetStore";
import {
  marketingGeneratorAuthorized,
  marketingGeneratorSecret,
  parseMarketingGeneratorJson,
  readMarketingGeneratorBody,
} from "@/lib/marketingGeneratorAuth";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";

export const MARKETING_LLM_BUDGET_MAX_BODY_BYTES = 4 * 1024;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const callId = z.string().regex(/^[a-z0-9]{20,40}$/);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const signed = {
  deadlineAt: z.string().datetime({ offset: false }),
  signature: hex64,
};

export const marketingLlmBudgetRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("reserve"),
      ...signed,
      requestKey: uuid,
      generatorRunId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
      purpose: z.enum(MARKETING_LLM_PURPOSES),
      model: z.string().regex(/^[A-Za-z0-9._:/-]{1,128}$/),
      adapterProfile: z.string().regex(/^[a-z0-9-]{1,32}$/),
    })
    .strict(),
  z
    .object({
      action: z.literal("dispatch"),
      ...signed,
      callId,
      requestKey: uuid,
      dispatchIntentId: uuid,
      adapterConfigDigest: hex64,
    })
    .strict(),
  z
    .object({
      action: z.literal("settle"),
      ...signed,
      callId,
      dispatchIntentId: uuid,
      observationId: uuid,
      reportedModel: z.string().regex(/^[A-Za-z0-9._:/-]{1,128}$/),
      reportedServiceTier: z.string().regex(/^[a-z_]{1,32}$/),
      reportedInputTokens: z.number().int().min(0).max(100_000_000),
      reportedOutputTokens: z.number().int().min(0).max(100_000_000),
    })
    .strict(),
  z.object({ action: z.literal("unknown"), ...signed, callId, dispatchIntentId: uuid }).strict(),
  z.object({ action: z.literal("release"), ...signed, callId }).strict(),
]);

export type MarketingLlmBudgetRequest = z.infer<typeof marketingLlmBudgetRequestSchema>;

/** Whether the request's signature is the budget HMAC over everything else in it. */
export const marketingLlmBudgetRequestSigned = (secret: string, request: MarketingLlmBudgetRequest): boolean => {
  const { action, deadlineAt, signature, ...fields } = request;
  const expected = Buffer.from(marketingLlmBudgetSignature(secret, { action, deadlineAt, fields }), "hex");
  const provided = Buffer.from(signature, "hex");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
};

export type MarketingLlmBudgetResponse = { readonly status: number; readonly body: Record<string, unknown> };

const answer = (outcome: MarketingLlmOutcome<object>): MarketingLlmBudgetResponse => {
  if (outcome.status === "ok") return { status: 200, body: { status: "ok", replay: outcome.replay, ...outcome.value } };
  if (outcome.status === "conflict") return { status: 409, body: { status: "conflict" } };
  return { status: 200, body: { status: "refused", code: outcome.code } };
};

async function run(
  prisma: PrismaClient,
  request: MarketingLlmBudgetRequest,
  env: MarketingLlmBudgetEnvironment,
): Promise<MarketingLlmOutcome<object>> {
  const deadlineAt = new Date(request.deadlineAt);
  const options = { maxWait: 5_000, timeout: 15_000 };
  switch (request.action) {
    case "reserve":
      return prisma.$transaction(
        (tx) =>
          reserveMarketingLlmCall(
            tx,
            {
              payload: {
                requestKey: request.requestKey,
                generatorRunId: request.generatorRunId,
                purpose: request.purpose,
                model: request.model,
                adapterProfile: request.adapterProfile,
              },
              deadlineAt,
            },
            env,
          ),
        options,
      );
    case "dispatch":
      return prisma.$transaction(
        (tx) =>
          dispatchMarketingLlmCall(
            tx,
            {
              callId: request.callId,
              requestKey: request.requestKey,
              dispatchIntentId: request.dispatchIntentId,
              adapterConfigDigest: request.adapterConfigDigest,
              deadlineAt,
            },
            env,
          ),
        options,
      );
    case "settle":
      return prisma.$transaction(
        (tx) =>
          settleMarketingLlmCall(
            tx,
            {
              callId: request.callId,
              dispatchIntentId: request.dispatchIntentId,
              observation: {
                observationId: request.observationId,
                reportedModel: request.reportedModel,
                reportedServiceTier: request.reportedServiceTier,
                reportedInputTokens: request.reportedInputTokens,
                reportedOutputTokens: request.reportedOutputTokens,
              },
              deadlineAt,
            },
            env,
          ),
        options,
      );
    case "unknown":
      return prisma.$transaction(
        (tx) =>
          reportMarketingLlmCallUnknown(
            tx,
            { callId: request.callId, dispatchIntentId: request.dispatchIntentId, deadlineAt },
            env,
          ),
        options,
      );
    case "release":
      return prisma.$transaction(
        (tx) => releaseMarketingLlmCall(tx, { callId: request.callId, deadlineAt }, env),
        options,
      );
  }
}

/**
 * Authenticate, bound, parse, verify, act. A failure inside the transaction
 * rolls everything back, so the answer is "unavailable" and the generator may
 * send the same request again: every action is keyed, and a repeat reads back
 * whatever did commit.
 *
 * The failure is reported as an operational incident with the action and the
 * error class only -- no body, no key, no secret -- so a database outage and
 * a defect both leave a record rather than a silent 503.
 */
export async function handleMarketingLlmBudgetRequest(
  request: Request,
  deps: {
    readonly prisma: PrismaClient;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly budget: MarketingLlmBudgetEnvironment;
    readonly report?: typeof reportOperationalIncident;
  },
): Promise<MarketingLlmBudgetResponse> {
  const secret = marketingGeneratorSecret(deps.env);
  if (!secret || !marketingGeneratorAuthorized(request, secret)) {
    return { status: 401, body: { error: "Unauthorized" } };
  }
  const raw = await readMarketingGeneratorBody(request, MARKETING_LLM_BUDGET_MAX_BODY_BYTES).catch(
    () => undefined,
  );
  if (raw === undefined) return { status: 400, body: { code: "invalid_request" } };
  if (raw === null) return { status: 413, body: { code: "body_too_large" } };
  const parsed = marketingLlmBudgetRequestSchema.safeParse(parseMarketingGeneratorJson(raw));
  if (!parsed.success) return { status: 400, body: { code: "invalid_request" } };
  if (!marketingLlmBudgetRequestSigned(secret, parsed.data)) {
    return { status: 401, body: { code: "signature_invalid" } };
  }
  try {
    return answer(await run(deps.prisma, parsed.data, deps.budget));
  } catch (error) {
    await (deps.report ?? reportOperationalIncident)({
      code: "MARKETING_LLM_BUDGET_LEDGER_UNAVAILABLE",
      title: "Marketing LLM budget request could not be recorded",
      error,
      severity: "error",
      cooldownMs: 30 * 60 * 1_000,
      context: { component: "marketing-llm-budget", action: parsed.data.action },
    }).catch((reportError: unknown) => {
      console.error("Marketing LLM budget incident could not be reported:", reportError);
    });
    return { status: 503, body: { code: "ledger_unavailable" } };
  }
}
