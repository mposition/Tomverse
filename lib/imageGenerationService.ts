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
  DEFAULT_IMAGE_MODEL_ID,
  getImageModel,
  getImageModelPrice,
  maxImageRequestCostMicroUsd,
  type ImageModelProvider,
} from "@/lib/imageModelRegistry";
import {
  generateImageWithProvider,
  ImageProviderError,
} from "@/lib/imageProviderAdapter";
import {
  getImageGenerationPricing,
  IMAGE_GENERATION_MODEL_ID,
  IMAGE_PROMPT_INPUT_USD_PER_MILLION_TOKENS,
  IMAGE_PROMPT_MAX_TOKENS,
  type ImageQuality,
  type ImageSize,
} from "@/lib/imageGenerationPricing";
import {
  imageAssetR2Key,
  STALE_IMAGE_GENERATION_AFTER_MS,
  STALE_IMAGE_SETTLING_AFTER_MS,
  type ImageGenerationFailurePhase,
} from "@/lib/imageGenerationStateCore";
import { safeDailyResetAt } from "@/lib/chatLimitDecisionCore";
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

const imageProviderBudgetKey = (provider: string) => `image-provider:${provider}`;

/** Kept for the settlement paths that still speak only OpenAI. */
const IMAGE_PROVIDER_BUDGET_KEY = imageProviderBudgetKey("openai");

const boundedEnvInt = (raw: string | undefined, fallback: number, max: number) => {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= max
    ? parsed
    : fallback;
};

// Workflow concurrency (policy v2 §7): how many comparison GROUPS one user
// may have active. IMAGE_USER_CONCURRENT keeps its meaning as the group
// limit -- the old name predates groups and a 1-model request is a 1-target
// group, so the number a deployment already sets still means the same thing
// to a user.
const imageConcurrencyLimit = () =>
  boundedEnvInt(
    process.env.IMAGE_USER_CONCURRENT_GROUPS ?? process.env.IMAGE_USER_CONCURRENT,
    1,
    10
  );

// The second layer: how many models one group may fan out to. Without it a
// single workflow slot would authorize unbounded provider work.
export const imageGroupMaxModels = () =>
  boundedEnvInt(process.env.IMAGE_GROUP_MAX_MODELS, 2, 4);

// Execution concurrency (policy v2 §7): provider-side job cap, counted per
// provider so one slow provider cannot starve another.
export const imageProviderJobLimit = (provider: string) =>
  boundedEnvInt(
    process.env[`IMAGE_PROVIDER_${provider.toUpperCase()}_CONCURRENT_JOBS`],
    2,
    16
  );

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
  /**
   * The models to fan out to. Omitted means the default single model, so a
   * v1-shaped caller keeps working: a single-model request is a 1-target
   * group, not a separate path (policy v2 §11).
   */
  modelIds?: string[];
};

export type ImageGenerationTargetResult = {
  targetId: string;
  modelId: string;
  provider: string;
  generationId: string;
  status: string;
  reservedCredits: number;
};

export type ImageGenerationRequestResult = {
  /** The first target's generation; kept so v1 callers still read one id. */
  generationId: string;
  groupId: string;
  conversationId: string;
  status: string;
  /** Total across every target -- what the user is actually charged. */
  reservedCredits: number;
  targets: ImageGenerationTargetResult[];
  reused: boolean;
};

/**
 * Idempotent replay: a repeat of the same request key answers with the group
 * the winner created, never a second charge. Reads the whole group so a
 * multi-model replay returns every target, not just the first.
 */
const readGroupByIdempotencyKey = async (
  userId: string,
  idempotencyKey: string
): Promise<ImageGenerationRequestResult | null> => {
  const group = await prisma.imageGenerationGroup.findUnique({
    where: {
      userId_groupIdempotencyKey: { userId, groupIdempotencyKey: idempotencyKey },
    },
    select: {
      id: true,
      conversationId: true,
      targets: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          provider: true,
          modelId: true,
          currentGeneration: { select: { id: true, status: true } },
        },
      },
    },
  });
  if (!group || group.targets.length === 0) return null;

  const generationIds = group.targets
    .map((target) => target.currentGeneration?.id)
    .filter((id): id is string => Boolean(id));
  const reservations = await prisma.imageCreditReservation.findMany({
    where: { generationId: { in: generationIds } },
    select: { generationId: true, reservedCredits: true },
  });
  const creditsByGeneration = new Map(
    reservations.map((row) => [row.generationId, row.reservedCredits])
  );

  const targets: ImageGenerationTargetResult[] = group.targets
    .filter((target) => target.currentGeneration)
    .map((target) => ({
      targetId: target.id,
      modelId: target.modelId,
      provider: target.provider,
      generationId: target.currentGeneration!.id,
      status: target.currentGeneration!.status,
      reservedCredits: creditsByGeneration.get(target.currentGeneration!.id) ?? 0,
    }));
  if (targets.length === 0) return null;

  return {
    generationId: targets[0].generationId,
    groupId: group.id,
    conversationId: group.conversationId,
    status: targets[0].status,
    reservedCredits: targets.reduce(
      (sum, target) => sum + target.reservedCredits,
      0
    ),
    targets,
    reused: true,
  };
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

  // Resolve the fan-out before anything is charged. Duplicates collapse: a
  // group holds one target per model by construction, and silently billing
  // the same model twice would be the worst possible reading of a duplicate.
  const requestedModelIds = [
    ...new Set(
      input.modelIds && input.modelIds.length > 0
        ? input.modelIds
        : [DEFAULT_IMAGE_MODEL_ID]
    ),
  ];
  const groupLimit = imageGroupMaxModels();
  if (requestedModelIds.length > groupLimit) {
    throw new ChatAccessError(
      400,
      "IMAGE_MODEL_SELECTION_INVALID",
      `Select at most ${groupLimit} models to compare.`,
      undefined,
      { maxModels: groupLimit, requestedModels: requestedModelIds.length }
    );
  }

  // Every model priced up front, all-or-nothing (policy §11): a group whose
  // second model is unavailable must not half-run, so the whole request is
  // refused before any row exists.
  const targetPlans = requestedModelIds.map((modelId) => {
    const model = getImageModel(modelId);
    const price = getImageModelPrice(modelId, input.quality, input.size);
    return { modelId, model, price };
  });
  const unavailable = targetPlans.filter(
    (plan) => !plan.model || plan.model.disabledReason !== null || !plan.price
  );
  if (unavailable.length > 0) {
    throw new ChatAccessError(
      400,
      "IMAGE_OPTION_NOT_SUPPORTED",
      "The requested image model, quality or size is not supported.",
      undefined,
      { unsupportedModels: unavailable.map((plan) => plan.modelId) }
    );
  }
  const resolvedTargets = targetPlans.map((plan) => ({
    modelId: plan.modelId,
    model: plan.model!,
    price: plan.price!,
  }));
  const totalCredits = resolvedTargets.reduce(
    (sum, target) => sum + target.price.credits,
    0
  );

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

  const replay = await readGroupByIdempotencyKey(
    input.userId,
    input.idempotencyKey
  );
  if (replay) return replay;

  // Worst-case cost per target, then summed per provider: budgets are
  // per-provider pools (policy §8), so two OpenAI targets draw from one.
  const targetCosts = new Map<string, number>();
  for (const target of resolvedTargets) {
    const cost = maxImageRequestCostMicroUsd(target.model, target.price);
    if (cost === null) {
      // Unreachable while the registry keeps unbounded models disabled; the
      // check stays because a fixed price without a finite worst case is the
      // one thing that must never reach a provider.
      throw new ChatAccessError(
        400,
        "IMAGE_OPTION_NOT_SUPPORTED",
        "The requested image model is not available for requests.",
        undefined,
        { unsupportedModels: [target.modelId] }
      );
    }
    targetCosts.set(target.modelId, cost);
  }
  const costByProvider = new Map<string, number>();
  for (const target of resolvedTargets) {
    costByProvider.set(
      target.model.provider,
      (costByProvider.get(target.model.provider) ?? 0) +
        targetCosts.get(target.modelId)!
    );
  }

  // Floor-clamped effective limits per provider; a null means that
  // provider's configuration is unusable and the whole request fails closed.
  const budgetByProvider = new Map<string, { day: number; month: number }>();
  for (const provider of costByProvider.keys()) {
    const limits = resolveImageProviderBudget(process.env, {
      provider: provider as ImageModelProvider,
    }).limits;
    if (!limits) {
      throw new ChatAccessError(
        503,
        "PROVIDER_BUDGET_EXHAUSTED",
        "Image generation is temporarily unavailable.",
        300,
        {
          provider,
          limitLayer: "operational_guardrail",
          internalReason: "image_provider_budget_env_missing",
        }
      );
    }
    budgetByProvider.set(provider, limits);
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

      for (const [provider, providerCost] of costByProvider) {
        const providerBudget = budgetByProvider.get(provider)!;
        for (const window of [
        {
          period: "provider-cost-day",
          start: usagePeriodStart("day", now),
          limit: providerBudget.day,
        },
        {
          period: "provider-cost-month",
          start: usagePeriodStart("month", now),
          limit: providerBudget.month,
        },
      ]) {
        const charged = await incrementUsageBucket(
          tx,
          imageProviderBudgetKey(provider),
          window.period,
          window.start,
          window.limit,
          providerCost
        );
        if (!charged) {
          throw new ChatAccessError(
            503,
            "PROVIDER_BUDGET_EXHAUSTED",
            "Image generation is temporarily unavailable.",
            300,
            {
              provider,
              limitLayer: "operational_guardrail",
              resetAt: futureIso(
                window.period === "provider-cost-day"
                  ? new Date(window.start.getTime() + 86_400_000)
                  : usageMonthlyResetAt(now),
                now
              ),
              internalRequiredCostMicroUsd: providerCost,
              internalLimitCostMicroUsd: window.limit,
            }
          );
        }
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
        requiredCredits: totalCredits,
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
            requiredCredits: totalCredits,
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
          // Rolled forward whole days rather than clamped to a few seconds:
          // this is a daily boundary, and a stale one (a stored time zone
          // moved, a DST shift) resets a day later, not in a moment.
          { resetAt: safeDailyResetAt(dayWindow.end, now).toISOString() }
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

      // Add-on credits are reserved once for the whole group and split
      // across targets proportionally to what each one costs, so a per-target
      // refund gives back exactly that target's share.
      const totalMaxCost = [...targetCosts.values()].reduce(
        (sum, cost) => sum + cost,
        0
      );
      const addOnFundedCostMicroUsd =
        allocation.addOnCreditsRequired > 0
          ? Math.ceil(
              (totalMaxCost * allocation.addOnCreditsRequired) / totalCredits
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

      const group = await tx.imageGenerationGroup.create({
        data: {
          userId: input.userId,
          conversationId,
          groupIdempotencyKey: input.idempotencyKey,
        },
        select: { id: true },
      });

      // Plan and add-on credits were allocated for the group as a whole;
      // each target's reservation records its own slice so settlement and
      // refunds stay per attempt (policy §11).
      let planCreditsLeft = allocation.planReservedCredits;
      let addOnCreditsLeft = allocation.addOnCreditsRequired;
      const createdTargets: ImageGenerationTargetResult[] = [];

      for (const [index, target] of resolvedTargets.entries()) {
        const isLast = index === resolvedTargets.length - 1;
        // The last target absorbs the rounding remainder so the per-target
        // slices always sum back to exactly what was reserved.
        const planShare = isLast
          ? planCreditsLeft
          : Math.min(
              planCreditsLeft,
              Math.round(
                (allocation.planReservedCredits * target.price.credits) /
                  totalCredits
              )
            );
        planCreditsLeft -= planShare;
        const addOnShare = isLast
          ? addOnCreditsLeft
          : Math.min(addOnCreditsLeft, target.price.credits - planShare);
        addOnCreditsLeft -= addOnShare;

        const targetMaxCost = targetCosts.get(target.modelId)!;
        const targetGenerationId = randomUUID();
        const targetFundedCost =
          addOnShare > 0
            ? Math.ceil((targetMaxCost * addOnShare) / target.price.credits)
            : 0;

        const targetRow = await tx.imageGenerationTarget.create({
          data: {
            groupId: group.id,
            provider: target.model.provider,
            modelId: target.modelId,
          },
          select: { id: true },
        });

        const generation = await tx.imageGeneration.create({
          data: {
            id: targetGenerationId,
            userId: input.userId,
            conversationId,
            // Only the first attempt carries the request key: the unique is
            // (userId, idempotencyKey) and a group has one request identity.
            idempotencyKey:
              index === 0 ? input.idempotencyKey : `${input.idempotencyKey}:${index}`,
            prompt: input.prompt,
            preset: PRESET_BY_QUALITY[input.quality],
            size: input.size,
            quality: input.quality,
            provider: target.model.provider,
            modelId: target.modelId,
            leaseId,
            groupId: group.id,
            targetId: targetRow.id,
          },
          select: { id: true, conversationId: true, status: true },
        });
        await tx.imageGenerationTarget.update({
          where: { id: targetRow.id },
          data: { currentGenerationId: generation.id },
        });

        await tx.imageCreditReservation.create({
          data: {
            id: reservationIdFor(targetGenerationId),
            userId: input.userId,
            generationId: targetGenerationId,
            conversationId,
            preset: PRESET_BY_QUALITY[input.quality],
            quality: input.quality,
            size: input.size,
            provider: target.model.provider,
            modelId: target.modelId,
            groupId: group.id,
            targetId: targetRow.id,
            identitySource: "recorded",
            reservedCredits: target.price.credits,
            planReservedCredits: planShare,
            addOnReservedCredits: addOnShare,
            reservedCostMicroUsd: BigInt(targetMaxCost),
            reservedFundedCostMicroUsd: BigInt(targetFundedCost),
            // The version of the model this target was priced by, not one
            // global string: a price change to any model would otherwise
            // start a new version for every model's reservations.
            pricingVersion: target.model.pricingVersion,
            costSource: "fixed_estimate",
            pricingSnapshot: {
              credits: target.price.credits,
              outputCostMicroUsd: target.price.outputCostMicroUsd,
              maxRequestCostMicroUsd: targetMaxCost,
              promptTokenLimit: IMAGE_PROMPT_MAX_TOKENS,
              provider: target.model.provider,
              modelId: target.modelId,
            },
            // The per-lot payload belongs to the group's single add-on
            // reservation; it is stored on the first target that holds
            // add-on credits so crash recovery finds it exactly once.
            reservationPayload: (addOnShare > 0 && index === 0
              ? entries
              : []) as unknown as Prisma.InputJsonValue,
          },
        });

        createdTargets.push({
          targetId: targetRow.id,
          modelId: target.modelId,
          provider: target.model.provider,
          generationId: generation.id,
          status: generation.status,
          reservedCredits: target.price.credits,
        });
      }

      const generation = {
        id: createdTargets[0].generationId,
        conversationId: conversationId!,
        status: createdTargets[0].status,
        groupId: group.id,
        targets: createdTargets,
      };

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
      groupId: created.groupId,
      conversationId: created.conversationId,
      status: created.status,
      reservedCredits: totalCredits,
      targets: created.targets,
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
      // The loser of the race reads the winner's whole group -- either
      // unique (group key or first generation key) can be the one that
      // tripped, and both identify the same request.
      const winner = await readGroupByIdempotencyKey(
        input.userId,
        input.idempotencyKey
      );
      if (winner) return winner;
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
   * What the failed attempt sent, prompt excluded. A failure is exactly when
   * someone needs to know what was asked for, so it is snapshotted on the
   * losing path too, not only the winning one.
   */
  providerRequestParams?: Record<string, unknown> | null;
  /**
   * Whether the reserved provider budget should be released. False on every
   * path where the provider was actually called (moderation blocks and
   * provider errors still cost money Tomverse absorbs -- policy section 5);
   * true when the provider was never reached or the cost is provably gone.
   */
  releaseProviderBudget: boolean;
  /**
   * Whether this caller may also claim a row already in `settling`, and on
   * what grounds. Omitted means no -- the ordinary failure paths must never
   * take a row another settler is holding.
   *
   * - `"owned"`: this process made the settling claim and its settlement
   *   transaction then rolled back. It still owns the row, so there is
   *   nothing to wait for.
   * - a `Date`: reclaim only a row untouched since then. The sweep's grounds:
   *   it cannot know who holds the row, so it waits out any transaction that
   *   could still be open (STALE_IMAGE_SETTLING_AFTER_MS).
   *
   * Either way the reservation's own `reserved -> settling` claim below is
   * what keeps the money exactly-once: a settlement that already committed
   * moved the reservation out of `reserved` in the same transaction that
   * moved the generation out of `settling`, so it cannot be settled twice.
   */
  reclaimSettling?: "owned" | Date;
}) => {
  const claimed = await prisma.imageGeneration.updateMany({
    where: {
      id: input.generationId,
      ...(input.reclaimSettling
        ? {
            OR: [
              { status: { in: ["pending", "processing"] } },
              {
                status: "settling",
                ...(input.reclaimSettling === "owned"
                  ? {}
                  : { updatedAt: { lt: input.reclaimSettling } }),
              },
            ],
          }
        : { status: { in: ["pending", "processing"] } }),
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
        providerRequestParams: toJsonSnapshot(input.providerRequestParams),
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

/**
 * Narrows an audit snapshot to Prisma's JSON input type without widening it to
 * `any`. Round-tripping through JSON is also what guarantees the stored value
 * is serialisable at all -- a body that cannot be represented is dropped here
 * rather than throwing inside the settlement transaction.
 */
const toJsonSnapshot = (
  params: Record<string, unknown> | null | undefined
): Prisma.InputJsonValue | undefined => {
  if (!params) return undefined;
  try {
    return JSON.parse(JSON.stringify(params)) as Prisma.InputJsonValue;
  } catch {
    return undefined;
  }
};

/**
 * The per-image output cost this reservation was actually priced at.
 *
 * Returns null rather than a default when the snapshot cannot supply it. The
 * caller must then use the reserved worst case and report the gap: a zero here
 * would understate the cost ledger and over-release the provider budget, and
 * both failures are invisible in the numbers they corrupt.
 */
export const reservationOutputCostMicroUsd = (
  snapshot: unknown
): number | null => {
  if (!snapshot || typeof snapshot !== "object") return null;
  const value = (snapshot as { outputCostMicroUsd?: unknown }).outputCostMicroUsd;
  // Zero is rejected on purpose rather than accepted as a number. No image
  // costs nothing, so a zero here is the same corrupt value the `?? 0` this
  // replaces used to invent -- taking it would reproduce the bug through a
  // different door.
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
};

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
        modelId: generation.modelId,
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
        providerRequestParams: providerError.requestParams,
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
        providerRequestParams: result.requestParams,
        releaseProviderBudget: false,
      });
      return;
    }

    // The bytes' own header wins over the requested size. `parseSize` only
    // reads the legacy `WxH` string, which describes what OpenAI was asked
    // for -- it is not what another provider returns for the same resolution
    // tier (policy section 12.1), and it is the fallback only so a header
    // this parser could not read still leaves the asset row complete.
    const requestedSize = parseSize(generation.size);
    const width = result.outputWidth ?? requestedSize.width;
    const height = result.outputHeight ?? requestedSize.height;
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
    const thumbKey = imageAssetR2Key({
      userId: generation.userId,
      conversationId: generation.conversationId,
      generationId,
      role: "thumbnail",
    });
    try {
      const sharp = (await import("sharp")).default;
      const thumbBytes = await sharp(result.imageBytes)
        .resize(512, 512, { fit: "inside" })
        .webp({ quality: 80 })
        .toBuffer();
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
      // The row records the key the thumbnail *will* occupy, not a
      // `.thumb-failed` sentinel for an object nobody wrote. `status` already
      // says it is not there; inventing a second key made the deletion sweep
      // tombstone an object that never existed, and left the repair with no
      // row to fill in -- it would have had to create a second thumbnail row
      // for the same generation.
      await prisma.imageAsset
        .create({
          data: {
            generationId,
            role: "thumbnail",
            status: "failed",
            r2Key: thumbKey,
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

      // The settled cost comes from the price this reservation was made at,
      // not from whatever the table says now. Re-reading the live table meant
      // a deploy landing between reservation and settlement rewrote the
      // recorded cost of a request that had already been priced -- and, once
      // a second model exists, it meant reading gpt-image-2's flat table for
      // an image another provider produced.
      const snapshotOutputCost = reservationOutputCostMicroUsd(
        reservation.pricingSnapshot
      );
      if (snapshotOutputCost === null) {
        // Never zero. A missing snapshot cost would under-report the ledger
        // and over-release the provider budget, silently. The reserved
        // worst-case is used instead -- wrong in the conservative direction --
        // and the gap is reported rather than absorbed.
        console.error(
          JSON.stringify({
            event: "image_settlement_snapshot_cost_missing",
            generationId,
            reservationId: reservation.id,
            provider: generation.provider,
            modelId: generation.modelId,
            pricingVersion: reservation.pricingVersion,
            timestamp: new Date().toISOString(),
          })
        );
      }
      const actualCostMicroUsd =
        snapshotOutputCost === null
          ? Number(reservation.reservedCostMicroUsd)
          : snapshotOutputCost + promptCostMicroUsd(result.inputTokens);

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
          // Null when the header could not be read: absent is a fact, an
          // inferred number would contradict the file it describes.
          outputWidth: result.outputWidth,
          outputHeight: result.outputHeight,
          providerRequestParams: toJsonSnapshot(result.requestParams),
        },
      });
      await tx.conversation.update({
        where: { id: generation.conversationId },
        data: { updatedAt: new Date() },
      });
    });
  } catch (error) {
    // `reclaimSettling: "owned"` because this catch also covers the settlement
    // transaction rolling back, and that claim was made outside it: without
    // this the row stays in `settling` with its credits reserved, refused by
    // the very failure path meant to refund them and skipped by the sweep.
    await finalizeFailure({
      generationId,
      failurePhase: "provider_failed",
      publicErrorCode: "IMAGE_GENERATION_FAILED",
      internalErrorDetail: String(error).slice(0, 500),
      releaseProviderBudget: false,
      reclaimSettling: "owned",
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
): Promise<{
  examined: number;
  refunded: number;
  settlementStranded: number;
}> => {
  const staleBefore = new Date(now.getTime() - STALE_IMAGE_GENERATION_AFTER_MS);
  const settlingStaleBefore = new Date(
    now.getTime() - STALE_IMAGE_SETTLING_AFTER_MS
  );
  const stale = await prisma.imageGeneration.findMany({
    where: {
      OR: [
        {
          status: { in: ["pending", "processing"] },
          updatedAt: { lt: staleBefore },
        },
        // `settling` is included on its own longer window. Leaving it out is
        // what made the state a trap: the claim into `settling` is made
        // outside the settlement transaction, so any rollback stranded the row
        // there with its credits reserved -- and this sweep, the only thing
        // that refunds an abandoned generation, could not see it.
        { status: "settling", updatedAt: { lt: settlingStaleBefore } },
      ],
    },
    orderBy: { updatedAt: "asc" },
    take: limit,
    select: { id: true, status: true },
  });
  let refunded = 0;
  let settlementStranded = 0;
  for (const generation of stale) {
    const stranded = generation.status === "settling";
    const finalized = await finalizeFailure({
      generationId: generation.id,
      // A stranded settlement is not a lost executor: the provider answered
      // and the ledger write for its answer was lost. Saying so is what sends
      // an operator to the database rather than to the provider's status page.
      failurePhase: stranded ? "settlement_failed" : "stale_job_reconciled",
      publicErrorCode: "IMAGE_GENERATION_FAILED",
      // The executor died at an unknown point; the provider may have been
      // called, so the budget charge stays (conservative).
      releaseProviderBudget: false,
      reclaimSettling: settlingStaleBefore,
    }).catch(() => false);
    if (finalized) {
      refunded += 1;
      if (stranded) settlementStranded += 1;
    }
  }
  if (settlementStranded > 0) {
    // Distinct from a dead worker, and worth waking someone for: every one of
    // these is a settlement transaction that failed after the provider was
    // paid, so the cost is real and the credits had to be given back.
    reportOperationalIncident({
      code: "IMAGE_SETTLEMENT_STRANDED",
      title: "Image generations were stranded mid-settlement and refunded",
      severity: "error",
      cooldownMs: 15 * 60 * 1_000,
      context: {
        component: "image-generation-service",
        settlementStranded,
      },
    });
  }
  return { examined: stale.length, refunded, settlementStranded };
};

/**
 * Run every pending attempt of a group, bounded by each provider's execution
 * concurrency (policy v2 section 7). The two layers are distinct: one
 * workflow slot authorized this group, and this cap is what stops that slot
 * from turning into unbounded provider work. Each attempt still claims
 * itself, so this is safe to run alongside the reconciliation sweep.
 */
export const processImageGenerationGroup = async (
  generationIds: readonly string[]
): Promise<void> => {
  if (generationIds.length === 0) return;
  const rows = await prisma.imageGeneration.findMany({
    where: { id: { in: [...generationIds] } },
    select: { id: true, provider: true },
  });

  const byProvider = new Map<string, string[]>();
  for (const row of rows) {
    const list = byProvider.get(row.provider) ?? [];
    list.push(row.id);
    byProvider.set(row.provider, list);
  }

  await Promise.all(
    [...byProvider.entries()].map(async ([provider, ids]) => {
      const limit = imageProviderJobLimit(provider);
      const queue = [...ids];
      const workers = Array.from(
        { length: Math.min(limit, queue.length) },
        async () => {
          for (let next = queue.shift(); next; next = queue.shift()) {
            // processImageGeneration never throws; a rejection here would
            // mean a bug in the claim itself, and it must not abandon the
            // other attempts of the same group.
            await processImageGeneration(next).catch((error) =>
              console.error("Image generation attempt failed:", {
                errorName: error instanceof Error ? error.name : "UnknownError",
              })
            );
          }
        }
      );
      await Promise.all(workers);
    })
  );
};

export type ImageRetryInput = {
  userId: string;
  targetId: string;
  retryIdempotencyKey: string;
};

/**
 * Retry one failed target: a NEW attempt under the SAME target, never a new
 * group (policy section 11). A succeeded target is refused -- re-running it
 * would charge twice for a result the user already has. The new reservation
 * and the target's current-attempt pointer move in one transaction.
 */
export const retryImageGenerationTarget = async (
  input: ImageRetryInput,
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

  const target = await prisma.imageGenerationTarget.findUnique({
    where: { id: input.targetId },
    select: {
      id: true,
      groupId: true,
      provider: true,
      modelId: true,
      group: { select: { userId: true, conversationId: true } },
      currentGeneration: {
        select: {
          id: true,
          status: true,
          prompt: true,
          quality: true,
          size: true,
          attemptNumber: true,
          leaseId: true,
        },
      },
    },
  });
  if (!target || target.group.userId !== input.userId) {
    throw new ChatAccessError(
      404,
      "IMAGE_GENERATION_NOT_FOUND",
      "Image generation not found."
    );
  }
  const current = target.currentGeneration;
  if (!current) {
    throw new ChatAccessError(
      404,
      "IMAGE_GENERATION_NOT_FOUND",
      "Image generation not found."
    );
  }
  if (current.status !== "failed") {
    throw new ChatAccessError(
      409,
      "IMAGE_RETRY_NOT_ALLOWED",
      current.status === "succeeded"
        ? "This model already produced an image."
        : "This model is still generating."
    );
  }

  // Retrying is a fresh request for one model: it goes through the same
  // gates and the same charge as any other, expressed as a 1-model fan-out
  // that lands in the existing group instead of a new one.
  const replay = await prisma.imageGeneration.findFirst({
    where: {
      targetId: target.id,
      retryIdempotencyKey: input.retryIdempotencyKey,
    },
    select: { id: true, status: true, conversationId: true },
  });
  if (replay) {
    const reservation = await prisma.imageCreditReservation.findUnique({
      where: { generationId: replay.id },
      select: { reservedCredits: true },
    });
    return {
      generationId: replay.id,
      groupId: target.groupId,
      conversationId: replay.conversationId,
      status: replay.status,
      reservedCredits: reservation?.reservedCredits ?? 0,
      targets: [
        {
          targetId: target.id,
          modelId: target.modelId,
          provider: target.provider,
          generationId: replay.id,
          status: replay.status,
          reservedCredits: reservation?.reservedCredits ?? 0,
        },
      ],
      reused: true,
    };
  }

  const result = await requestImageGeneration(
    {
      userId: input.userId,
      prompt: current.prompt,
      size: current.size as ImageSize,
      quality: current.quality as ImageQuality,
      conversationId: target.group.conversationId,
      idempotencyKey: `retry-${input.retryIdempotencyKey}`.slice(0, 64),
      modelIds: [target.modelId],
    },
    now
  );

  // Re-home the fresh attempt onto the existing target so the group keeps
  // one slot per model and the UI shows the latest attempt in place.
  const freshGenerationId = result.targets[0].generationId;
  const freshTargetId = result.targets[0].targetId;
  await prisma.$transaction(async (tx) => {
    await tx.imageGeneration.update({
      where: { id: freshGenerationId },
      data: {
        groupId: target.groupId,
        targetId: target.id,
        attemptNumber: current.attemptNumber + 1,
        retryOfGenerationId: current.id,
        retryIdempotencyKey: input.retryIdempotencyKey,
      },
    });
    await tx.imageCreditReservation.updateMany({
      where: { generationId: freshGenerationId },
      data: { groupId: target.groupId, targetId: target.id },
    });
    // currentGenerationId is unique: the throwaway target still points at the
    // fresh attempt, so it has to let go before the real target can claim it.
    await tx.imageGenerationTarget.update({
      where: { id: freshTargetId },
      data: { currentGenerationId: null },
    });
    await tx.imageGenerationTarget.update({
      where: { id: target.id },
      data: { currentGenerationId: freshGenerationId },
    });
    // The throwaway target and group the fan-out created for this one model
    // have no attempts left; removing them keeps the group count honest.
    await tx.imageGenerationTarget.delete({ where: { id: freshTargetId } });
    await tx.imageGenerationGroup.delete({ where: { id: result.groupId } });
  });

  return {
    ...result,
    groupId: target.groupId,
    targets: [
      { ...result.targets[0], targetId: target.id },
    ],
  };
};
