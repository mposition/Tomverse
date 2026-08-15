export const dynamic = "force-dynamic";

import { createTokenEstimateAccumulator } from "@/lib/chatTokenEstimate";
import { randomUUID } from "node:crypto";
import { generateText, Output } from "ai";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { getActiveAiModel } from "@/lib/activeAiModel";
import { getModelGenerationSettings } from "@/lib/modelGenerationCompatibility";
import { getUserBillingPlan } from "@/lib/billingEntitlements";
import {
  consumePerplexityUsage,
  discardPerplexityUsage,
  perplexityUsageHeaders,
} from "@/lib/perplexityUsageCapture";
import type { PerplexityUsageCostSnapshot } from "@/lib/perplexityUsageCore";
import {
  acquireChatAccess,
  assertModelAccess,
  chatErrorResponse,
  ChatAccessError,
  createChatBudget,
  identifyChatCaller,
  linkChatReservationProviderRequest,
  releaseChatAccess,
  settleChatUsage,
} from "@/lib/chatSecurity";
import {
  conversationLockedResponse,
  hasConversationUnlockGrant,
} from "@/lib/conversationLock";
import { getEnabledModel } from "@/lib/models";
import { prisma } from "@/lib/prisma";
import { safeErrorMetadata } from "@/lib/providerErrorClassification";
import {
  recordModelFailure,
  recordModelSuccess,
  recordProviderFailure,
  recordProviderSuccess,
} from "@/lib/providerMonitoring";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";

// Opt-in, per-item web verification for a single "needs external
// verification" claim surfaced by AI Review or Quick Difference Summary.
// Deliberately its own small endpoint rather than an automatic part of the
// review itself: it uses a live-search model (an added paid dependency) and
// is charged separately, only when the user actually wants one specific
// item checked.
const VERIFY_ITEM_MODEL_ID = "perplexity/sonar";
const VERIFY_ITEM_MAX_OUTPUT_TOKENS = 500;

const requestSchema = z
  .object({
    item: z.string().trim().min(1).max(500),
  })
  .strict();

const verificationCheckSchema = z.object({
  status: z.enum(["supported", "unsupported", "inconclusive"]),
  summary: z.string().trim().min(1).max(600),
});

const jsonError = (
  error: string,
  code: string,
  status: number,
  traceId?: string
) =>
  Response.json(
    { error, code, ...(traceId ? { traceId } : {}) },
    { status, headers: { "Cache-Control": "no-store" } }
  );

const buildVerificationPrompt = (item: string, language: string) => ({
  system: [
    "You are a fact-checking assistant with live web search.",
    "Verify the following claim or open question from an AI comparison review, using current, reliable sources.",
    `Write your summary in language code ${language || "en"}.`,
    "Be concise: one to three sentences.",
    "If sources genuinely disagree or the question cannot be resolved, say so honestly instead of guessing.",
    "Do not claim certainty you don't have.",
  ].join("\n"),
  prompt: `Verify this item: ${item}`,
});

export async function POST(
  request: Request,
  context: { params: Promise<{ conversationId: string }> }
) {
  const traceId = randomUUID();
  let leaseId: string | null = null;
  let providerUsageTraceId: string | null = null;
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return jsonError("Authentication required.", "AUTH_REQUIRED", 401, traceId);
    }
    await consumeApiRateLimit(
      request,
      session.user.id,
      "comparison-review-verify-item",
      { minute: 5, day: 20 }
    );

    const { conversationId } = await context.params;
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { userId: true, password: true },
    });
    if (!conversation || conversation.userId !== session.user.id) {
      return jsonError("Conversation not found.", "NOT_FOUND", 404, traceId);
    }
    if (
      !hasConversationUnlockGrant(
        request,
        session.user.id,
        conversationId,
        conversation.password
      )
    ) {
      return conversationLockedResponse();
    }

    const body = await readLimitedJson(request, 4 * 1024, requestSchema);

    const model = getEnabledModel(VERIFY_ITEM_MODEL_ID);
    if (!model) {
      throw new ChatAccessError(
        503,
        "VERIFICATION_REVIEWER_UNAVAILABLE",
        "Web verification is not currently configured."
      );
    }

    const billingPlan = await getUserBillingPlan(session.user.id);
    const access = identifyChatCaller(request, session.user.id, billingPlan.tier, {
      dailyMessageLimit: billingPlan.dailyMessageLimit,
      monthlyMessageLimit: billingPlan.monthlyMessageLimit,
    });
    assertModelAccess(access, model);

    const userSettings = await prisma.userSettings.findUnique({
      where: { userId: session.user.id },
      select: { language: true },
    });
    const verificationPrompt = buildVerificationPrompt(
      body.item,
      userSettings?.language || "en"
    );

    // Was `Buffer.byteLength(item) / 4`, the per-surface copy that
    // lib/chatTokenEstimate.ts exists to replace: it prices a Korean item at
    // roughly a third of what it costs, which is the direction that
    // under-reserves. The 300 is the verification template's own framing and
    // 64 a floor, so both stay opaque -- neither is a tokenizer prediction.
    const estimate = createTokenEstimateAccumulator()
      .addText(body.item)
      .addTokens(300)
      .breakdown();
    const inputTokens =
      estimate.rawTotal >= 64
        ? estimate
        : {
            ...estimate,
            opaqueTokens: estimate.opaqueTokens + (64 - estimate.rawTotal),
            rawTotal: 64,
          };
    const budget = createChatBudget("user", model, inputTokens);
    budget.maxOutputTokens = Math.min(
      budget.maxOutputTokens,
      VERIFY_ITEM_MAX_OUTPUT_TOKENS
    );

    const grant = await acquireChatAccess(access, budget, {
      traceId,
      source: "comparison_review",
    });
    leaseId = grant.leaseId;
    const reservation = grant.usageReservation;
    providerUsageTraceId = reservation.reservationId;
    let providerUsageSnapshot: PerplexityUsageCostSnapshot | null = null;

    try {
      const generated = await generateText({
        model: getActiveAiModel(model),
        system: verificationPrompt.system,
        prompt: verificationPrompt.prompt,
        output: Output.object({ schema: verificationCheckSchema }),
        ...getModelGenerationSettings(model, { temperature: 0.1 }),
        maxOutputTokens: budget.maxOutputTokens,
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(30_000),
        headers: perplexityUsageHeaders(providerUsageTraceId),
      });

      providerUsageSnapshot = await consumePerplexityUsage(providerUsageTraceId);
      await linkChatReservationProviderRequest(reservation.reservationId, {
        providerRequestId:
          generated.response.headers?.["x-request-id"] ||
          generated.response.headers?.["request-id"] ||
          null,
        providerResponseId: generated.response.id,
      }).catch((linkError) =>
        console.error("Verification item provider request link failed:", {
          traceId,
          linkError,
        })
      );

      const result = verificationCheckSchema.parse(generated.output);

      await settleChatUsage(
        reservation,
        {
          inputTokens: generated.usage.inputTokens,
          cachedInputTokens: generated.usage.inputTokenDetails.cacheReadTokens,
          outputTokens: generated.usage.outputTokens,
          outcome: "completed",
        },
        { providerUsageSnapshot }
      ).catch((settlementError) =>
        console.error("Verification item settlement failed:", {
          traceId,
          settlementError,
        })
      );
      await Promise.all([
        recordProviderSuccess(model.provider),
        recordModelSuccess(model.id),
      ]);

      return Response.json(
        {
          status: result.status,
          summary: result.summary,
          reviewerModelId: model.id,
          usageCredits: budget.usageCredits,
          disclaimer:
            "This is a best-effort web check, not a guarantee -- verify anything important yourself.",
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    } catch (error) {
      if (providerUsageTraceId) {
        providerUsageSnapshot = await consumePerplexityUsage(providerUsageTraceId);
      }
      await settleChatUsage(
        reservation,
        { inputTokens: 0, outputTokens: 0, outcome: "failed" },
        { providerUsageSnapshot }
      ).catch((settlementError) =>
        console.error("Verification item refund failed:", {
          traceId,
          settlementError,
        })
      );
      await Promise.allSettled([
        recordProviderFailure(model.provider, "VERIFICATION_ITEM_FAILED", {
          modelId: model.id,
          phase: "request",
          traceId,
          errorName: safeErrorMetadata(error).name,
          errorCode: safeErrorMetadata(error).code,
          httpStatus: safeErrorMetadata(error).statusCode,
          retryable: safeErrorMetadata(error).isRetryable,
        }),
        recordModelFailure(model.id, model.provider, "VERIFICATION_ITEM_FAILED"),
      ]);
      throw error;
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonError(
        "Invalid verification request.",
        "INVALID_VERIFICATION_REQUEST",
        400,
        traceId
      );
    }
    const chatResponse = chatErrorResponse(error);
    if (chatResponse) return chatResponse;
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Comparison review item verification failed:", {
      traceId,
      ...safeErrorMetadata(error),
    });
    return jsonError(
      "Failed to verify this item. Reserved credits were refunded.",
      "VERIFICATION_ITEM_FAILED",
      500,
      traceId
    );
  } finally {
    if (providerUsageTraceId) {
      discardPerplexityUsage(providerUsageTraceId);
    }
    if (leaseId) await releaseChatAccess(leaseId);
  }
}
