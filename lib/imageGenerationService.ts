import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  assertImageGenerationEnabled,
  ImageGenerationDisabledError,
} from "@/lib/appSettings";
import {
  getUserBillingPlan,
  planAllowsFeature,
} from "@/lib/billingEntitlements";
import { getChatCreditAllocation } from "@/lib/chatCreditAllocation";
import {
  leaseHeartbeatIntervalMs,
  resolveLeaseTtlSeconds,
  type ChatConcurrencyScope,
} from "@/lib/chatConcurrencyCore";
import {
  countActiveLeases,
  insertLeases,
  releaseChatRequestLease,
  sweepExpiredLeasesForScopes,
  touchChatRequestLease,
} from "@/lib/chatRequestLease";
import {
  ChatAccessError,
  getUserChatUsageKey,
  incrementUsageBucket,
  readUsageBucketCount,
  usageMonthlyResetAt,
  usagePeriodStart,
} from "@/lib/chatSecurity";
import { estimatePromptTokens } from "@/lib/chatTokenEstimate";
import { CONVERSATION_KIND_NOT_SUPPORTED } from "@/lib/conversationKindGuard";
import { lockCreditAccount } from "@/lib/creditDebt";
import {
  reserveAddOnCredits,
  settleAddOnCredits,
  AddOnCreditError,
  type AddOnCreditReservationEntry,
} from "@/lib/creditLedger";
import {
  generateImageWithProvider,
  ImageProviderError,
} from "@/lib/imageProviderAdapter";
import {
  getImageGenerationPricing,
  IMAGE_GENERATION_MODEL_ID,
  IMAGE_PRICING_VERSION,
  IMAGE_PROMPT_INPUT_USD_PER_MILLION_TOKENS,
  IMAGE_PROMPT_MAX_TOKENS,
  maxRequestCostMicroUsd,
  type ImageQuality,
  type ImageSize,
} from "@/lib/imageGenerationPricing";
import {
  imageAssetR2Key,
  STALE_IMAGE_GENERATION_AFTER_MS,
  type ImageGenerationFailurePhase,
} from "@/lib/imageGenerationStateCore";
import { resolveImageProviderBudget } from "@/lib/imageProviderBudget";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import { prisma } from "@/lib/prisma";
import { writeR2Object } from "@/lib/r2";
import { getUserDayWindow } from "@/lib/userDailyUsage";

// The image generation billing path. Same wallet, same bucket table, same
// ledger as chat -- what differs is the shape of the price (fixed success
// price, full refund on failure, no partial refunds) and the execution model
// (claim-based async processing instead of a stream).
// Policy: docs/policy/image-generation.md sections 3, 5-7.

const IMAGE_LEASE_MODEL_ID = IMAGE_GENERATION_MODEL_ID;

// Distinct from the chat subject key on purpose: countActiveLeases counts by
// subjectKey, so image leases sharing chat's key would consume chat's
// concurrency slots and vice versa. Deriving from the chat key keeps the
// value opaque without a second hashing scheme.
const imageLeaseSubjectKey = (userId: string) =>
  `image:${getUserChatUsageKey(userId)}`;

const IMAGE_PROVIDER_BUDGET_KEY = "image-provider:openai";

const imageConcurrencyLimit = () => {
  const parsed = Number(process.env.IMAGE_USER_CONCURRENT);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 10
    ? parsed
    : 1;
};

const imageConcurrencyScope = (userId: string): ChatConcurrencyScope => ({
  scope: "subject",
  key: imageLeaseSubjectKey(userId),
  limit: imageConcurrencyLimit(),
  errorCode: "IMAGE_CONCURRENCY_EXCEEDED",
  limitLayer: "concurrency",
  limitScope: "image_user",
});

const PRESET_BY_QUALITY: Record<ImageQuality, string> = {
  low: "draft",
  medium: "standard",
  high: "final",
};

const promptCostMicroUsd = (inputTokens: number) =>
  Math.ceil(
    (Math.max(0, inputTokens) * IMAGE_PROMPT_INPUT_USD_PER_MILLION_TOKENS * 1_000_000) /
      1_000_000
  );

const reservationIdFor = (generationId: string) =>
  `image-credit-reservation:${generationId}:v1`;

const futureIso = (date: Date, now: Date) =>
  (date.getTime() > now.getTime()
    ? date
    : new Date(now.getTime() + 5_000)
  ).toISOString();

export type ImageGenerationRequestInput = {
  userId: string;
  prompt: string;
  size: ImageSize;
  quality: ImageQuality;
  conversationId?: string | null;
  idempotencyKey: string;
};

export type ImageGenerationRequestResult = {
  generationId: string;
  conversationId: string;
  status: string;
  reservedCredits: number;
  reused: boolean;
};

/**
 * The reservation step: every gate, then one atomic transaction that lazily
 * creates the image conversation (when no conversationId is given), the
 * pending ImageGeneration, the financial ImageCreditReservation, the plan
 * bucket increments, the add-on ledger reservation, the provider budget
 * charge and the concurrency lease. A rejection at any point rolls the
 * whole transaction back, so a rejected request leaves no rows -- the
 * empty-work invariant (policy section 6).
 */
export const requestImageGeneration = async (
  input: ImageGenerationRequestInput,
  now = new Date()
): Promise<ImageGenerationRequestResult> => {
  try {
    await assertImageGenerationEnabled();
  } catch (error) {
    if (error instanceof ImageGenerationDisabledError) {
      throw new ChatAccessError(
        403,
        "IMAGE_GENERATION_DISABLED",
        "Image generation is not enabled."
      );
    }
    throw error;
  }

  const plan = await getUserBillingPlan(input.userId);
  if (!planAllowsFeature(plan, "imageGeneration")) {
    throw new ChatAccessError(
      403,
      "PLAN_FEATURE_NOT_INCLUDED",
      "Your plan does not include imageGeneration.",
      undefined,
      { feature: "imageGeneration" }
    );
  }

  const pricing = getImageGenerationPricing(input.quality, input.size);
  if (!pricing) {
    throw new ChatAccessError(
      400,
      "IMAGE_OPTION_NOT_SUPPORTED",
      "The requested image quality or size is not supported."
    );
  }

  const promptTokens = estimatePromptTokens(input.prompt);
  if (promptTokens > IMAGE_PROMPT_MAX_TOKENS) {
    throw new ChatAccessError(
      400,
      "IMAGE_PROMPT_TOO_LONG",
      `The prompt exceeds the ${IMAGE_PROMPT_MAX_TOKENS}-token limit.`,
      undefined,
      { maxTokens: IMAGE_PROMPT_MAX_TOKENS, estimatedTokens: promptTokens }
    );
  }

  const existing = await prisma.imageGeneration.findUnique({
    where: {
      userId_idempotencyKey: {
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
      },
    },
    select: { id: true, conversationId: true, status: true },
  });
  if (existing) {
    const reservation = await prisma.imageCreditReservation.findUnique({
      where: { generationId: existing.id },
      select: { reservedCredits: true },
    });
    return {
      generationId: existing.id,
      conversationId: existing.conversationId,
      status: existing.status,
      reservedCredits: reservation?.reservedCredits ?? pricing.credits,
      reused: true,
    };
  }

  const maxCost = maxRequestCostMicroUsd(pricing);
  // Floor-clamped effective limits; null means the configuration is unusable
  // (missing or partial in production) and the request fails closed.
  const budget = resolveImageProviderBudget().limits;
  if (!budget) {
    throw new ChatAccessError(
      503,
      "PROVIDER_BUDGET_EXHAUSTED",
      "Image generation is temporarily unavailable.",
      300,
      {
        provider: "openai",
        limitLayer: "operational_guardrail",
        internalReason: "image_provider_budget_env_missing",
      }
    );
  }

  const scope = imageConcurrencyScope(input.userId);
  const generationId = randomUUID();
  const leaseId = randomUUID();
  const ttlSeconds = resolveLeaseTtlSeconds();

  try {
    const created = await prisma.$transaction(async (tx) => {
      await lockCreditAccount(tx, input.userId);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${scope.key}))`;
      await sweepExpiredLeasesForScopes(tx, { subjectKey: scope.key });

      const activeLeases = await countActiveLeases(tx, scope);
      if (activeLeases + 1 > scope.limit) {
        throw new ChatAccessError(
          429,
          scope.errorCode,
          "An image is already being generated. Wait for it to finish.",
          5,
          {
            limitLayer: scope.limitLayer,
            limitScope: scope.limitScope,
            activeRequests: activeLeases,
            resetAt: futureIso(new Date(now.getTime() + 5_000), now),
          }
        );
      }

      for (const window of [
        {
          period: "provider-cost-day",
          start: usagePeriodStart("day", now),
          limit: budget.day,
        },
        {
          period: "provider-cost-month",
          start: usagePeriodStart("month", now),
          limit: budget.month,
        },
      ]) {
        const charged = await incrementUsageBucket(
          tx,
          IMAGE_PROVIDER_BUDGET_KEY,
          window.period,
          window.start,
          window.limit,
          maxCost
        );
        if (!charged) {
          throw new ChatAccessError(
            503,
            "PROVIDER_BUDGET_EXHAUSTED",
            "Image generation is temporarily unavailable.",
            300,
            {
              provider: "openai",
              limitLayer: "operational_guardrail",
              resetAt: futureIso(
                window.period === "provider-cost-day"
                  ? new Date(window.start.getTime() + 86_400_000)
                  : usageMonthlyResetAt(now),
                now
              ),
              internalRequiredCostMicroUsd: maxCost,
              internalLimitCostMicroUsd: window.limit,
            }
          );
        }
      }

      let conversationId = input.conversationId ?? null;
      if (conversationId) {
        const conversation = await tx.conversation.findUnique({
          where: { id: conversationId },
          select: { userId: true, kind: true },
        });
        if (!conversation || conversation.userId !== input.userId) {
          throw new ChatAccessError(
            404,
            "CONVERSATION_NOT_FOUND",
            "Conversation not found."
          );
        }
        if (conversation.kind !== "image") {
          throw new ChatAccessError(
            409,
            CONVERSATION_KIND_NOT_SUPPORTED,
            "This conversation does not support image generation."
          );
        }
      } else {
        const conversation = await tx.conversation.create({
          data: {
            userId: input.userId,
            title: input.prompt.trim().slice(0, 30) || "New image",
            kind: "image",
            selectedModels: "[]",
            disabledPanels: "[]",
          },
          select: { id: true },
        });
        conversationId = conversation.id;
      }

      const dayWindow = await getUserDayWindow(tx, input.userId, now);
      const subjectKey = getUserChatUsageKey(input.userId);
      const monthStart = usagePeriodStart("month", now);
      const monthLimit = Math.max(0, Math.trunc(plan.monthlyMessageLimit));
      const dayLimit = Math.max(0, Math.trunc(plan.dailyMessageLimit));

      const monthlyUsed = await readUsageBucketCount(
        tx,
        subjectKey,
        "month",
        monthStart
      );
      const dailyRemaining =
        dayLimit > 0
          ? dayLimit -
            (await readUsageBucketCount(tx, subjectKey, "day", dayWindow.start))
          : null;

      const purchased = await tx.creditLot.aggregate({
        where: {
          userId: input.userId,
          status: "active",
          remainingCredits: { gt: 0 },
          expiresAt: { gt: now },
        },
        _sum: { remainingCredits: true },
      });

      const allocation = getChatCreditAllocation({
        requiredCredits: pricing.credits,
        monthlyPlanCreditsRemaining: Math.max(0, monthLimit - monthlyUsed),
        dailyPlanCreditsRemaining: dailyRemaining,
        purchasedCreditsRemaining: purchased._sum.remainingCredits ?? 0,
      });

      if (allocation.balanceInsufficient) {
        throw new ChatAccessError(
          402,
          "CREDIT_BALANCE_INSUFFICIENT",
          "Not enough credits for this image.",
          undefined,
          {
            requiredCredits: pricing.credits,
            availableCredits: allocation.totalCreditsAvailableNow,
            resetAt: futureIso(usageMonthlyResetAt(now), now),
          }
        );
      }
      if (allocation.dailyPlanGuardrailBlocked) {
        throw new ChatAccessError(
          429,
          "PLAN_DAILY_CREDIT_LIMIT_REACHED",
          "Daily plan credits are exhausted.",
          Math.max(
            1,
            Math.ceil((dayWindow.end.getTime() - now.getTime()) / 1000)
          ),
          { resetAt: futureIso(dayWindow.end, now) }
        );
      }

      if (allocation.planReservedCredits > 0) {
        if (dayLimit > 0) {
          const dayCharged = await incrementUsageBucket(
            tx,
            subjectKey,
            "day",
            dayWindow.start,
            dayLimit,
            allocation.planReservedCredits
          );
          if (!dayCharged) {
            throw new ChatAccessError(
              409,
              "CONCURRENT_RESERVATION_CONFLICT",
              "Another request is reserving credits. Try again.",
              2,
              { conflictScope: "daily_plan_credits" }
            );
          }
        }
        const monthCharged = await incrementUsageBucket(
          tx,
          subjectKey,
          "month",
          monthStart,
          monthLimit,
          allocation.planReservedCredits
        );
        if (!monthCharged) {
          throw new ChatAccessError(
            409,
            "CONCURRENT_RESERVATION_CONFLICT",
            "Another request is reserving credits. Try again.",
            2,
            { conflictScope: "monthly_plan_credits" }
          );
        }
      }

      const addOnFundedCostMicroUsd =
        allocation.addOnCreditsRequired > 0
          ? Math.ceil(
              (maxCost * allocation.addOnCreditsRequired) / pricing.credits
            )
          : 0;
      let entries: AddOnCreditReservationEntry[] = [];
      if (allocation.addOnCreditsRequired > 0) {
        entries = await reserveAddOnCredits(tx, {
          userId: input.userId,
          reservationId: reservationIdFor(generationId),
          credits: allocation.addOnCreditsRequired,
          fundedCostMicroUsd: addOnFundedCostMicroUsd,
          now,
        });
      }

      // v2 (§11): every request is a comparison group; the single-model path
      // is a 1-target group. The group inherits the request idempotency key,
      // so the (userId, key) race behaves exactly as before -- the loser's
      // P2002 (on either unique) replays the winner idempotently.
      const group = await tx.imageGenerationGroup.create({
        data: {
          userId: input.userId,
          conversationId,
          groupIdempotencyKey: input.idempotencyKey,
        },
        select: { id: true },
      });
      const target = await tx.imageGenerationTarget.create({
        data: {
          groupId: group.id,
          provider: "openai",
          modelId: IMAGE_GENERATION_MODEL_ID,
        },
        select: { id: true },
      });

      const generation = await tx.imageGeneration.create({
        data: {
          id: generationId,
          userId: input.userId,
          conversationId,
          idempotencyKey: input.idempotencyKey,
          prompt: input.prompt,
          preset: PRESET_BY_QUALITY[input.quality],
          size: input.size,
          quality: input.quality,
          leaseId,
          groupId: group.id,
          targetId: target.id,
        },
        select: { id: true, conversationId: true, status: true },
      });
      await tx.imageGenerationTarget.update({
        where: { id: target.id },
        data: { currentGenerationId: generationId },
      });

      await tx.imageCreditReservation.create({
        data: {
          id: reservationIdFor(generationId),
          userId: input.userId,
          generationId,
          conversationId,
          preset: PRESET_BY_QUALITY[input.quality],
          quality: input.quality,
          size: input.size,
          reservedCredits: pricing.credits,
          planReservedCredits: allocation.planReservedCredits,
          addOnReservedCredits: allocation.addOnCreditsRequired,
          reservedCostMicroUsd: BigInt(maxCost),
          reservedFundedCostMicroUsd: BigInt(addOnFundedCostMicroUsd),
          // Identity snapshot (§12): written explicitly, never defaulted.
          provider: "openai",
          modelId: IMAGE_GENERATION_MODEL_ID,
          groupId: group.id,
          targetId: target.id,
          identitySource: "recorded",
          pricingVersion: IMAGE_PRICING_VERSION,
          costSource: "fixed_estimate",
          pricingSnapshot: {
            credits: pricing.credits,
            outputCostMicroUsd: pricing.outputCostMicroUsd,
            maxRequestCostMicroUsd: maxCost,
            promptTokenLimit: IMAGE_PROMPT_MAX_TOKENS,
            provider: "openai",
            modelId: IMAGE_GENERATION_MODEL_ID,
          },
          reservationPayload: entries as unknown as Prisma.InputJsonValue,
        },
      });

      await insertLeases(tx, [
        {
          id: leaseId,
          subjectKey: scope.key,
          ipKey: null,
          modelId: IMAGE_LEASE_MODEL_ID,
          admissionId: null,
          claimedAt: now,
          expiresAt: new Date(now.getTime() + ttlSeconds * 1_000),
        },
      ]);

      return generation;
    });

    return {
      generationId: created.id,
      conversationId: created.conversationId,
      status: created.status,
      reservedCredits: pricing.credits,
      reused: false,
    };
  } catch (error) {
    if (error instanceof AddOnCreditError) {
      throw new ChatAccessError(
        402,
        error.code === "ADDON_COST_ALLOWANCE_INSUFFICIENT"
          ? "CREDIT_COST_ALLOWANCE_INSUFFICIENT"
          : "CREDIT_BALANCE_INSUFFICIENT",
        "Not enough purchased credits for this image.",
        undefined,
        {
          availableCredits: error.availableCredits,
          resetAt: futureIso(usageMonthlyResetAt(now), now),
        }
      );
    }
    // Idempotency race: the transaction that lost the (userId,
    // idempotencyKey) unique race rolled back completely (lease, buckets and
    // ledger included). The loser answers with the winner's state instead of
    // an error -- policy section 5.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const winner = await prisma.imageGeneration.findUnique({
        where: {
          userId_idempotencyKey: {
            userId: input.userId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        select: { id: true, conversationId: true, status: true },
      });
      if (winner) {
        return {
          generationId: winner.id,
          conversationId: winner.conversationId,
          status: winner.status,
          reservedCredits: pricing.credits,
          reused: true,
        };
      }
    }
    throw error;
  }
};

const refundPlanCredits = async (
  tx: Prisma.TransactionClient,
  userId: string,
  planReservedCredits: number,
  reservedAt: Date
) => {
  if (planReservedCredits <= 0) return;
  const subjectKey = getUserChatUsageKey(userId);
  const dayWindow = await getUserDayWindow(tx, userId, reservedAt);
  for (const window of [
    { period: "day", start: dayWindow.start },
    { period: "month", start: usagePeriodStart("month", reservedAt) },
  ]) {
    await tx.$executeRaw`
      UPDATE "ChatUsageBucket"
      SET "count" = GREATEST(0, "count" - ${planReservedCredits}), "updatedAt" = NOW()
      WHERE "key" = ${subjectKey} AND "period" = ${window.period} AND "periodStart" = ${window.start}
    `;
  }
};

const refundProviderBudget = async (
  tx: Prisma.TransactionClient,
  amountMicroUsd: number,
  reservedAt: Date
) => {
  if (amountMicroUsd <= 0) return;
  for (const window of [
    { period: "provider-cost-day", start: usagePeriodStart("day", reservedAt) },
    {
      period: "provider-cost-month",
      start: usagePeriodStart("month", reservedAt),
    },
  ]) {
    await tx.$executeRaw`
      UPDATE "ChatUsageBucket"
      SET "count" = GREATEST(0, "count" - ${amountMicroUsd}), "updatedAt" = NOW()
      WHERE "key" = ${IMAGE_PROVIDER_BUDGET_KEY} AND "period" = ${window.period} AND "periodStart" = ${window.start}
    `;
  }
};

const parseReservationPayload = (
  payload: Prisma.JsonValue
): AddOnCreditReservationEntry[] =>
  Array.isArray(payload)
    ? payload.filter(
        (entry): entry is AddOnCreditReservationEntry =>
          !!entry &&
          typeof entry === "object" &&
          typeof (entry as { lotId?: unknown }).lotId === "string" &&
          Number.isSafeInteger((entry as { credits?: unknown }).credits)
      )
    : [];

const finalizeFailure = async (input: {
  generationId: string;
  failurePhase: ImageGenerationFailurePhase;
  publicErrorCode: string;
  internalErrorDetail?: string;
  providerRequestId?: string | null;
  /**
   * Whether the reserved provider budget should be released. False on every
   * path where the provider was actually called (moderation blocks and
   * provider errors still cost money Tomverse absorbs -- policy section 5);
   * true when the provider was never reached or the cost is provably gone.
   */
  releaseProviderBudget: boolean;
}) => {
  const claimed = await prisma.imageGeneration.updateMany({
    where: {
      id: input.generationId,
      status: { in: ["pending", "processing"] },
    },
    data: { status: "settling" },
  });
  if (claimed.count === 0) return false;

  const generation = await prisma.imageGeneration.findUnique({
    where: { id: input.generationId },
    select: { userId: true, leaseId: true, createdAt: true },
  });
  if (!generation?.userId) return false;

  await prisma.$transaction(async (tx) => {
    await lockCreditAccount(tx, generation.userId);
    const reservationClaim = await tx.imageCreditReservation.updateMany({
      where: { generationId: input.generationId, status: "reserved" },
      data: { status: "settling" },
    });
    if (reservationClaim.count > 0) {
      const reservation = await tx.imageCreditReservation.findUnique({
        where: { generationId: input.generationId },
      });
      if (reservation) {
        await refundPlanCredits(
          tx,
          generation.userId,
          reservation.planReservedCredits,
          reservation.createdAt
        );
        const entries = parseReservationPayload(reservation.reservationPayload);
        if (entries.length > 0) {
          await settleAddOnCredits(tx, {
            userId: generation.userId,
            reservationId: reservation.id,
            entries,
            settledCredits: 0,
            settledFundedCostMicroUsd: 0,
            outcome: "failed",
          });
        }
        if (input.releaseProviderBudget) {
          await refundProviderBudget(
            tx,
            Number(reservation.reservedCostMicroUsd),
            reservation.createdAt
          );
        }
        await tx.imageCreditReservation.update({
          where: { id: reservation.id },
          data: {
            status: "settled",
            outcome: "failed",
            settledCredits: 0,
            settledCostMicroUsd: input.releaseProviderBudget
              ? BigInt(0)
              : reservation.reservedCostMicroUsd,
            settledFundedCostMicroUsd: BigInt(0),
            refundedAt: new Date(),
            settledAt: new Date(),
            providerRequestId: input.providerRequestId ?? undefined,
          },
        });
      }
    }
    await tx.imageGeneration.update({
      where: { id: input.generationId },
      data: {
        status: "failed",
        failurePhase: input.failurePhase,
        publicErrorCode: input.publicErrorCode,
        internalErrorDetail: input.internalErrorDetail?.slice(0, 1_000),
        providerRequestId: input.providerRequestId ?? undefined,
        failedAt: new Date(),
      },
    });
  });

  if (generation.leaseId) {
    await releaseChatRequestLease(generation.leaseId, {
      reason: `image_${input.failurePhase}`,
      subjectScope: "image_user",
    });
  }
  return true;
};

const sha256Hex = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

const parseSize = (size: string): { width: number; height: number } => {
  const [width, height] = size.split("x").map((value) => Number(value));
  return { width: width || 0, height: height || 0 };
};

/**
 * The processing step, claim-based so any executor (the post-response kick,
 * a future dedicated worker, or the reconciliation sweep) can run it and
 * exactly one wins each transition. Never throws: every failure path ends
 * in finalizeFailure, which refunds and releases deterministically.
 */
export const processImageGeneration = async (
  generationId: string
): Promise<void> => {
  const claimed = await prisma.imageGeneration.updateMany({
    where: { id: generationId, status: "pending" },
    data: { status: "processing", startedAt: new Date() },
  });
  if (claimed.count === 0) return;

  const generation = await prisma.imageGeneration.findUnique({
    where: { id: generationId },
  });
  if (!generation) return;

  const ttlSeconds = resolveLeaseTtlSeconds();
  const heartbeat = generation.leaseId
    ? setInterval(() => {
        void touchChatRequestLease(generation.leaseId as string, ttlSeconds);
      }, leaseHeartbeatIntervalMs(ttlSeconds))
    : null;
  heartbeat?.unref?.();

  try {
    let result;
    try {
      result = await generateImageWithProvider({
        prompt: generation.prompt,
        size: generation.size as ImageSize,
        quality: generation.quality as ImageQuality,
      });
    } catch (error) {
      const providerError =
        error instanceof ImageProviderError
          ? error
          : new ImageProviderError("provider_failed", String(error));
      await finalizeFailure({
        generationId,
        failurePhase: providerError.failurePhase,
        publicErrorCode:
          providerError.failurePhase === "provider_moderation_rejected"
            ? "IMAGE_MODERATION_BLOCKED"
            : "IMAGE_GENERATION_FAILED",
        internalErrorDetail: providerError.message,
        providerRequestId: providerError.providerRequestId,
        // The provider was reached (or unreachable in a way that may still
        // have billed); keep the budget charge -- conservative direction.
        releaseProviderBudget: false,
      });
      return;
    }

    const originalKey = imageAssetR2Key({
      userId: generation.userId,
      conversationId: generation.conversationId,
      generationId,
      role: "original",
    });
    try {
      // The provider's bytes go to R2 untouched: no normalization, no
      // re-encode -- C2PA/SynthID provenance survives (policy section 9).
      // Store what the provider actually returned, unmodified (policy §9/§12).
      await writeR2Object(originalKey, result.imageBytes, result.mimeType);
    } catch (error) {
      await prisma.imageAssetCleanup
        .createMany({
          data: [{ r2Key: originalKey, reason: "storage_rollback" }],
          skipDuplicates: true,
        })
        .catch(() => undefined);
      await finalizeFailure({
        generationId,
        failurePhase: "original_storage_failed",
        publicErrorCode: "IMAGE_GENERATION_FAILED",
        internalErrorDetail: String(error).slice(0, 500),
        providerRequestId: result.providerRequestId,
        releaseProviderBudget: false,
      });
      return;
    }

    const { width, height } = parseSize(generation.size);
    await prisma.imageAsset.create({
      data: {
        generationId,
        role: "original",
        status: "ready",
        r2Key: originalKey,
        mimeType: result.mimeType,
        width,
        height,
        byteSize: result.imageBytes.byteLength,
        sha256: sha256Hex(result.imageBytes),
      },
    });

    // Thumbnail is a derived asset: its failure never demotes the original
    // (policy section 9). Derivation re-encodes on purpose -- only the
    // original carries provenance.
    try {
      const sharp = (await import("sharp")).default;
      const thumbBytes = await sharp(result.imageBytes)
        .resize(512, 512, { fit: "inside" })
        .webp({ quality: 80 })
        .toBuffer();
      const thumbKey = imageAssetR2Key({
        userId: generation.userId,
        conversationId: generation.conversationId,
        generationId,
        role: "thumbnail",
      });
      await writeR2Object(thumbKey, thumbBytes, "image/webp");
      const thumbMeta = await sharp(thumbBytes).metadata();
      await prisma.imageAsset.create({
        data: {
          generationId,
          role: "thumbnail",
          status: "ready",
          r2Key: thumbKey,
          mimeType: "image/webp",
          width: thumbMeta.width ?? 0,
          height: thumbMeta.height ?? 0,
          byteSize: thumbBytes.byteLength,
          sha256: sha256Hex(thumbBytes),
          provenancePreserved: false,
        },
      });
    } catch (error) {
      await prisma.imageAsset
        .create({
          data: {
            generationId,
            role: "thumbnail",
            status: "failed",
            r2Key: `${originalKey}.thumb-failed`,
            mimeType: "image/webp",
            width: 0,
            height: 0,
            byteSize: 0,
            sha256: "",
            provenancePreserved: false,
            thumbnailRetryCount: 1,
          },
        })
        .catch(() => undefined);
      console.error("Image thumbnail derivation failed:", error);
    }

    const settleClaim = await prisma.imageGeneration.updateMany({
      where: { id: generationId, status: "processing" },
      data: { status: "settling" },
    });
    if (settleClaim.count === 0) return;

    const actualCostMicroUsd =
      (getImageGenerationPricing(generation.quality, generation.size)
        ?.outputCostMicroUsd ?? 0) + promptCostMicroUsd(result.inputTokens);

    await prisma.$transaction(async (tx) => {
      await lockCreditAccount(tx, generation.userId);
      const reservationClaim = await tx.imageCreditReservation.updateMany({
        where: { generationId, status: "reserved" },
        data: { status: "settling" },
      });
      if (reservationClaim.count === 0) return;
      const reservation = await tx.imageCreditReservation.findUnique({
        where: { generationId },
      });
      if (!reservation) return;

      const entries = parseReservationPayload(reservation.reservationPayload);
      if (entries.length > 0) {
        await settleAddOnCredits(tx, {
          userId: generation.userId,
          reservationId: reservation.id,
          entries,
          settledCredits: reservation.addOnReservedCredits,
          settledFundedCostMicroUsd: Number(
            reservation.reservedFundedCostMicroUsd
          ),
          outcome: "completed",
        });
      }
      // Fixed success price: plan buckets keep their full increment. The
      // provider budget trues up to actual incurred cost like chat does.
      const budgetDifference =
        Number(reservation.reservedCostMicroUsd) - actualCostMicroUsd;
      if (budgetDifference > 0) {
        await refundProviderBudget(tx, budgetDifference, reservation.createdAt);
      }
      await tx.imageCreditReservation.update({
        where: { id: reservation.id },
        data: {
          status: "settled",
          outcome: "completed",
          settledCredits: reservation.reservedCredits,
          settledCostMicroUsd: BigInt(Math.max(0, actualCostMicroUsd)),
          settledFundedCostMicroUsd: reservation.reservedFundedCostMicroUsd,
          settledAt: new Date(),
          providerRequestId: result.providerRequestId ?? undefined,
        },
      });
      await tx.imageGeneration.update({
        where: { id: generationId },
        data: {
          status: "succeeded",
          completedAt: new Date(),
          providerRequestId: result.providerRequestId ?? undefined,
        },
      });
      await tx.conversation.update({
        where: { id: generation.conversationId },
        data: { updatedAt: new Date() },
      });
    });
  } catch (error) {
    await finalizeFailure({
      generationId,
      failurePhase: "provider_failed",
      publicErrorCode: "IMAGE_GENERATION_FAILED",
      internalErrorDetail: String(error).slice(0, 500),
      releaseProviderBudget: false,
    }).catch(() => undefined);
    reportOperationalIncident({
      code: "IMAGE_GENERATION_PROCESSING_FAILED",
      title: "Image generation processing failed unexpectedly",
      error,
      severity: "error",
      cooldownMs: 15 * 60 * 1_000,
      context: { component: "image-generation-service", generationId },
    });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (generation.leaseId) {
      await releaseChatRequestLease(generation.leaseId, {
        reason: "image_generation_finished",
        subjectScope: "image_user",
      }).catch(() => undefined);
    }
  }
};

/**
 * The refund arm of the stale recovery promised in PR 2: a generation still
 * in a live status past the stale window has lost its executor. The
 * settling claim inside finalizeFailure makes this race-safe against a
 * worker that is merely slow.
 */
export const reconcileStaleImageGenerations = async (
  now = new Date(),
  limit = 25
): Promise<{ examined: number; refunded: number }> => {
  const staleBefore = new Date(now.getTime() - STALE_IMAGE_GENERATION_AFTER_MS);
  const stale = await prisma.imageGeneration.findMany({
    where: {
      status: { in: ["pending", "processing"] },
      updatedAt: { lt: staleBefore },
    },
    orderBy: { updatedAt: "asc" },
    take: limit,
    select: { id: true },
  });
  let refunded = 0;
  for (const generation of stale) {
    const finalized = await finalizeFailure({
      generationId: generation.id,
      failurePhase: "stale_job_reconciled",
      publicErrorCode: "IMAGE_GENERATION_FAILED",
      // The executor died at an unknown point; the provider may have been
      // called, so the budget charge stays (conservative).
      releaseProviderBudget: false,
    }).catch(() => false);
    if (finalized) refunded += 1;
  }
  return { examined: stale.length, refunded };
};
