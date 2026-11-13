// The admin console's image billing measurement (image-generation policy
// section 12.1): an operator approves a plan with a maximum cost, the server
// sends that many real generation requests and records each response's usage
// -- never the image -- and the operator decides whether the terms the samples
// support are confirmed. Paid provider calls, so:
//
//   - off unless IMAGE_BILLING_MEASUREMENT_ENABLED is set (owner decision);
//   - the approved maximum is taken from the provider budget before the first
//     request and the unspent part returned at the end;
//   - a sample is sent only while spend so far plus its ceiling fits the
//     maximum, and one that bills past its ceiling stops the run;
//   - no user, credit or conversation is touched, and nothing is stored but
//     the counts.
//
// Confirmation is a separate operator action: the stored samples are judged
// again on the server, the sources must be the provider's own documentation,
// and the terms row commits with its audit entry. A measurement never confirms
// itself.
import "server-only";

import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import { z } from "zod";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { incrementUsageBucket, usagePeriodStart } from "@/lib/chatSecurity";
import {
  imageBillingMeasurementEnabled,
  MEASUREMENT_PROMPT,
  MEASUREMENT_STALE_MS,
  type MeasurementPlan,
  measurementPlanSchema,
  type MeasurementSample,
  measurementVerdict,
  planProblem,
  planWorstCaseMicroUsd,
  sampleCeilingMicroUsd,
  sampleCostMicroUsd,
  sampleRequests,
} from "@/lib/imageBillingMeasurementCore";
import { chargeProviderBudgetOverage, refundProviderBudget } from "@/lib/imageGenerationService";
import {
  IMAGE_MODEL_REGISTRY,
  type ConfirmedImageBillingTerms,
  type ImageModelProfile,
} from "@/lib/imageModelRegistry";
import { imageProviderBudgetBucketKey, resolveImageProviderBudget } from "@/lib/imageProviderBudget";
import { generateImageForMeasurement, ImageProviderError } from "@/lib/imageProviderAdapter";
import { invalidateImageModelCatalog } from "@/lib/modelCatalog";
import { billingTermsKey, isOfficialSourceUrl, latestBillingTerms } from "@/lib/modelCatalogCore";
import { prisma } from "@/lib/prisma";

export class MeasurementRefusal extends Error {
  constructor(
    readonly code: string,
    readonly reasons: readonly string[] = [],
    readonly status = 409
  ) {
    super(code);
  }
}

/** The terms in force for one provider model, or null. */
export const confirmedBillingTermsFor = async (
  provider: string,
  apiModelId: string,
  client: Pick<Prisma.TransactionClient, "imageModelBillingTerms"> = prisma
): Promise<ConfirmedImageBillingTerms | null> => {
  const rows = await client.imageModelBillingTerms.findMany({
    where: { provider, apiModelId },
    select: { id: true, provider: true, apiModelId: true, terms: true, createdAt: true },
  });
  return latestBillingTerms(rows).get(billingTermsKey(provider, apiModelId)) ?? null;
};

/**
 * The profile a measurement calls: the provider's request shape with the
 * plan's parameters, unpriced. Google gets the planned output limit and no
 * thinking level (the request the confirmed terms will describe) and asks
 * for JPEG, the only type its API delivers.
 */
export const measurementCandidate = (plan: MeasurementPlan): ImageModelProfile => {
  const requests = sampleRequests(plan);
  return {
    id: `measurement:${plan.apiModelId}`,
    provider: plan.provider,
    apiModelId: plan.apiModelId,
    name: plan.apiModelId,
    lifecycle: "preview",
    disabledReason: null,
    sizes: [...new Set(requests.map((request) => request.size))],
    qualities: [...new Set(requests.map((request) => request.quality))],
    prices: [],
    latencyClass: "balanced",
    provenance: [],
    outputMimeTypes:
      plan.provider === "openai" ? ["image/png"] : ["image/jpeg", "image/png", "image/webp"],
    ...(plan.provider === "google" ? { deliveryMimeType: "image/jpeg", maxOutputTokens: plan.maxOutputTokens } : {}),
    pricingVersion: "measurement",
    priceVerification: { verifiedAt: null, sources: [], thinkingCapMicroUsd: null },
  };
};

const BUDGET_WINDOWS = (at: Date) => [
  { period: "provider-cost-day", start: usagePeriodStart("day", at) },
  { period: "provider-cost-month", start: usagePeriodStart("month", at) },
];

/**
 * Hold the approved maximum against the provider budget and record the run,
 * with its audit entry, in one transaction. Refused when the switch is off,
 * the maximum is below the plan's worst case, another measurement is running,
 * or the budget has no room.
 */
export const startImageBillingMeasurement = async (input: {
  plan: MeasurementPlan;
  session: Session;
  request?: Request;
  now?: Date;
  env?: Readonly<Record<string, string | undefined>>;
}) => {
  const env = input.env ?? process.env;
  if (!imageBillingMeasurementEnabled(env)) throw new MeasurementRefusal("measurement_disabled");
  const plan = measurementPlanSchema.parse(input.plan);
  const problem = planProblem(plan);
  if (problem) throw new MeasurementRefusal("max_cost_below_worst_case", [problem], 400);
  const limits = resolveImageProviderBudget(env, { provider: plan.provider }).limits;
  if (!limits) throw new MeasurementRefusal("provider_budget_missing", [plan.provider]);
  const now = input.now ?? new Date();

  return prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    const running = await tx.imageBillingMeasurement.findFirst({
      where: { status: "running", createdAt: { gt: new Date(now.getTime() - MEASUREMENT_STALE_MS) } },
      select: { id: true },
    });
    if (running) throw new MeasurementRefusal("measurement_running", [running.id]);
    for (const window of BUDGET_WINDOWS(now)) {
      const limit = window.period === "provider-cost-day" ? limits.day : limits.month;
      const held = await incrementUsageBucket(
        tx,
        imageProviderBudgetBucketKey(plan.provider),
        window.period,
        window.start,
        limit,
        plan.maxCostMicroUsd
      );
      if (!held) throw new MeasurementRefusal("provider_budget_exhausted", [window.period]);
    }
    const row = await tx.imageBillingMeasurement.create({
      data: {
        provider: plan.provider,
        apiModelId: plan.apiModelId,
        status: "running",
        plan: plan as Prisma.InputJsonValue,
        maxCostMicroUsd: plan.maxCostMicroUsd,
        samples: [],
        actorId: input.session.user?.id ?? null,
        actorEmail: input.session.user?.email ?? null,
        createdAt: now,
      },
    });
    await writeAdminAuditLog({
      session: input.session,
      request: input.request,
      action: "model_catalog.billing_measurement_started",
      targetType: "ImageBillingMeasurement",
      targetId: row.id,
      summary: `Started a paid billing measurement of ${plan.provider} ${plan.apiModelId} (max ${plan.maxCostMicroUsd} micro-USD).`,
      metadata: {
        provider: plan.provider,
        apiModelId: plan.apiModelId,
        plan,
        samples: sampleRequests(plan).length,
        sampleCeilingMicroUsd: sampleCeilingMicroUsd(plan),
        worstCaseMicroUsd: planWorstCaseMicroUsd(plan),
        maxCostMicroUsd: plan.maxCostMicroUsd,
      },
      tx,
    });
    return row;
  });
};

const sampleFromError = (error: unknown) => {
  if (error instanceof ImageProviderError) {
    return {
      failure: error.failurePhase,
      httpStatus: error.status,
      afterGeneration: error.afterGeneration,
      providerRequestId: error.providerRequestId,
      nonImageBillableTokens: error.nonImageBillableTokens,
      billedImageTokens: error.billedImageTokens,
      usage: error.providerUsage,
    };
  }
  return {
    failure: "internal",
    httpStatus: null,
    afterGeneration: false,
    providerRequestId: null,
    nonImageBillableTokens: null,
    billedImageTokens: null,
    usage: null,
  };
};

type Generate = typeof generateImageForMeasurement;

/**
 * Send the plan's samples, one at a time, then settle the provider budget and
 * close the run. Never throws: a failure past the first write still closes the
 * row, and spend that cannot be read is counted at its ceiling.
 */
export const runImageBillingMeasurement = async (input: {
  measurementId: string;
  session: Session;
  generate?: Generate;
  now?: () => number;
}) => {
  const generate = input.generate ?? generateImageForMeasurement;
  const clock = input.now ?? Date.now;
  const row = await prisma.imageBillingMeasurement.findUnique({ where: { id: input.measurementId } });
  if (!row || row.status !== "running") return;
  const parsed = measurementPlanSchema.safeParse(row.plan);
  const samples: MeasurementSample[] = [];
  let spent = 0;
  let stopReason: string | null = null;
  try {
    if (!parsed.success) throw new Error("invalid_plan");
    const plan = parsed.data;
    const ceiling = sampleCeilingMicroUsd(plan);
    const candidate = measurementCandidate(plan);
    for (const [index, request] of sampleRequests(plan).entries()) {
      if (spent + ceiling > plan.maxCostMicroUsd) {
        stopReason = "cost_cap";
        break;
      }
      const started = clock();
      let sample: Omit<MeasurementSample, "costMicroUsd">;
      try {
        const result = await generate(candidate, { prompt: MEASUREMENT_PROMPT, size: request.size, quality: request.quality });
        sample = {
          index,
          ...request,
          delivered: true,
          failure: null,
          httpStatus: 200,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          thinkingTokens: result.thinkingTokens,
          nonImageBillableTokens: result.nonImageBillableTokens ?? null,
          billedImageTokens: result.billedImageTokens ?? null,
          usage: result.providerUsage ?? null,
          width: result.outputWidth,
          height: result.outputHeight,
          providerRequestId: result.providerRequestId,
          durationMs: clock() - started,
        };
        // The bytes go out of scope here: a measurement keeps no image.
      } catch (error) {
        sample = {
          index,
          ...request,
          delivered: false,
          inputTokens: null,
          outputTokens: null,
          thinkingTokens: null,
          width: null,
          height: null,
          ...sampleFromError(error),
          durationMs: clock() - started,
        };
      }
      const costMicroUsd = sampleCostMicroUsd(plan, sample);
      samples.push({ ...sample, costMicroUsd });
      spent += costMicroUsd;
      await prisma.imageBillingMeasurement.update({
        where: { id: row.id },
        data: { samples: samples as unknown as Prisma.InputJsonValue, spentMicroUsd: spent },
      });
      if (costMicroUsd > ceiling) {
        stopReason = "sample_over_ceiling";
        break;
      }
    }
  } catch (error) {
    stopReason = "error";
    console.error(
      JSON.stringify({
        event: "image_billing_measurement_failed",
        measurementId: row.id,
        error: error instanceof Error ? error.message : "unknown",
      })
    );
  }

  const verdict = parsed.success ? measurementVerdict(parsed.data, samples) : null;
  try {
    await prisma.$transaction(async (tx) => {
      await takeAuditChainLock(tx);
      if (spent < row.maxCostMicroUsd) {
        await refundProviderBudget(tx, row.provider, row.maxCostMicroUsd - spent, row.createdAt);
      } else if (spent > row.maxCostMicroUsd) {
        await chargeProviderBudgetOverage(tx, row.provider, spent - row.maxCostMicroUsd, row.createdAt);
      }
      await tx.imageBillingMeasurement.update({
        where: { id: row.id },
        data: {
          status: stopReason === "error" ? "failed" : stopReason ? "stopped" : "completed",
          stopReason,
          verdict: verdict === null ? Prisma.DbNull : (verdict as unknown as Prisma.InputJsonValue),
          spentMicroUsd: spent,
          completedAt: new Date(clock()),
        },
      });
      await writeAdminAuditLog({
        session: input.session,
        action: "model_catalog.billing_measurement_finished",
        targetType: "ImageBillingMeasurement",
        targetId: row.id,
        summary: `Billing measurement of ${row.provider} ${row.apiModelId} ended (${samples.length} samples, ${spent} micro-USD).`,
        metadata: {
          provider: row.provider,
          apiModelId: row.apiModelId,
          samples: samples.length,
          spentMicroUsd: spent,
          maxCostMicroUsd: row.maxCostMicroUsd,
          stopReason,
          confirmable: verdict?.confirmable ?? false,
        },
        tx,
      });
    });
  } catch (error) {
    // The row stays "running" and the whole maximum stays held: the safe
    // direction for a budget whose spend could not be recorded.
    console.error(
      JSON.stringify({
        event: "image_billing_measurement_close_failed",
        measurementId: row.id,
        spentMicroUsd: spent,
        error: error instanceof Error ? error.message : "unknown",
      })
    );
  }
};

export const confirmBodySchema = z
  .object({
    measurementId: z.string().min(1).max(64),
    sources: z.array(z.string().url()).min(1).max(5),
  })
  .strict();

/**
 * Write the terms a completed measurement supports, after an operator looked
 * at its samples. The verdict is computed again from the stored samples, so a
 * client cannot confirm terms the samples do not support.
 */
export const confirmImageBillingTerms = async (input: {
  measurementId: string;
  sources: readonly string[];
  session: Session;
  request?: Request;
}) => {
  const result = await prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    const row = await tx.imageBillingMeasurement.findUnique({ where: { id: input.measurementId } });
    if (!row) throw new MeasurementRefusal("measurement_not_found", [], 404);
    if (row.status !== "completed") throw new MeasurementRefusal("measurement_not_completed", [row.status]);
    const plan = measurementPlanSchema.safeParse(row.plan);
    if (!plan.success) throw new MeasurementRefusal("invalid_plan", [], 409);
    const verdict = measurementVerdict(plan.data, (Array.isArray(row.samples) ? row.samples : []) as unknown as MeasurementSample[]);
    if (!verdict.confirmable || !verdict.terms) throw new MeasurementRefusal("not_confirmable", verdict.reasons);
    const unofficial = input.sources.filter((url) => !isOfficialSourceUrl(row.provider, url));
    if (unofficial.length > 0) throw new MeasurementRefusal("unofficial_source", unofficial, 400);
    const terms = verdict.terms;
    // A code model's request is the code's: terms it does not send would
    // refuse the model the moment they landed.
    const seed = IMAGE_MODEL_REGISTRY.find((model) => model.provider === row.provider && model.apiModelId === row.apiModelId);
    if (seed && terms.kind === "measured_output_limit" && (seed.maxOutputTokens !== terms.maxOutputTokens || seed.thinkingLevel)) {
      throw new MeasurementRefusal("seed_request_differs", [`max_output_tokens_${seed.maxOutputTokens ?? "none"}`]);
    }
    const created = await tx.imageModelBillingTerms.create({
      data: {
        provider: row.provider,
        apiModelId: row.apiModelId,
        kind: terms.kind,
        terms: terms as Prisma.InputJsonValue,
        sources: [...input.sources],
        measurementId: row.id,
        actorId: input.session.user?.id ?? null,
        actorEmail: input.session.user?.email ?? null,
      },
    });
    await writeAdminAuditLog({
      session: input.session,
      request: input.request,
      action: "model_catalog.billing_terms_confirmed",
      targetType: "ImageModelBillingTerms",
      targetId: created.id,
      summary: `Confirmed ${terms.kind} billing terms for ${row.provider} ${row.apiModelId} from measurement ${row.id}.`,
      metadata: {
        provider: row.provider,
        apiModelId: row.apiModelId,
        kind: terms.kind,
        terms,
        sources: [...input.sources],
        measurementId: row.id,
        notes: verdict.notes,
      },
      tx,
    });
    return created;
  });
  invalidateImageModelCatalog();
  return result;
};

/** A model's measurements (newest first) and the terms in force, for the panel. */
export const imageBillingMeasurementView = async (provider: string, apiModelId: string, now = new Date()) => {
  const [rows, terms, latestTerms] = await Promise.all([
    prisma.imageBillingMeasurement.findMany({
      where: { provider, apiModelId },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    confirmedBillingTermsFor(provider, apiModelId),
    prisma.imageModelBillingTerms.findFirst({
      where: { provider, apiModelId },
      orderBy: { createdAt: "desc" },
      select: { id: true, sources: true, createdAt: true, actorEmail: true, measurementId: true },
    }),
  ]);
  return {
    enabled: imageBillingMeasurementEnabled(process.env),
    confirmed: terms ? { terms, ...latestTerms } : null,
    measurements: rows.map((row) => {
      const plan = measurementPlanSchema.safeParse(row.plan);
      const samples = (Array.isArray(row.samples) ? row.samples : []) as unknown as MeasurementSample[];
      const stale = row.status === "running" && now.getTime() - row.createdAt.getTime() > MEASUREMENT_STALE_MS;
      return {
        id: row.id,
        status: stale ? "interrupted" : row.status,
        stopReason: row.stopReason,
        plan: plan.success ? plan.data : null,
        planned: plan.success ? sampleRequests(plan.data).length : null,
        sampleCeilingMicroUsd: plan.success ? sampleCeilingMicroUsd(plan.data) : null,
        maxCostMicroUsd: row.maxCostMicroUsd,
        spentMicroUsd: row.spentMicroUsd,
        samples,
        verdict: plan.success ? measurementVerdict(plan.data, samples) : null,
        createdAt: row.createdAt,
        completedAt: row.completedAt,
        actorEmail: row.actorEmail,
      };
    }),
  };
};
