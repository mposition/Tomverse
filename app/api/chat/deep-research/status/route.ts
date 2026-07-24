export const dynamic = "force-dynamic";

import { randomUUID } from "node:crypto";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import {
  deserializeReservation,
  extendChatReservationExpiry,
  settleChatUsage,
} from "@/lib/chatSecurity";
import {
  conversationLockedResponse,
  hasConversationUnlockGrant,
} from "@/lib/conversationLock";
import { getModel } from "@/lib/models";
import {
  PerplexityDeepResearchError,
  pollDeepResearchJob,
} from "@/lib/perplexityDeepResearch";
import { prisma } from "@/lib/prisma";
import {
  recordModelFailure,
  recordModelSuccess,
  recordProviderFailure,
  recordProviderSuccess,
} from "@/lib/providerMonitoring";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";

const MAX_STORED_MESSAGE_CHARACTERS = 100_000;

// A poll can't legally extend a reservation past acquireChatAccess's own
// 30-minute clamp on CHAT_RESERVATION_TTL_SECONDS, so each heartbeat just
// re-arms a window comfortably inside that ceiling.
const RESERVATION_HEARTBEAT_SECONDS = 900;

const requestSchema = z
  .object({
    assistantMessageId: z.string().min(1).max(100),
  })
  .strict();

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

// Client-polled status endpoint for the one model in this app's catalog that
// can't stream (sonar-deep-research, see app/api/chat/route.ts's
// usageClass === "deep-research" branch). The submitting request only ever
// creates a "pending" Message + PerplexityAsyncJob row and returns
// immediately -- this route is where the job actually gets checked, and
// where its credit reservation finally gets settled or refunded once
// Perplexity reports a terminal state.
export async function POST(request: Request) {
  const traceId = randomUUID();
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return jsonError("Authentication required.", "AUTH_REQUIRED", 401, traceId);
    }
    await consumeApiRateLimit(request, session.user.id, "deep-research-status", {
      minute: 30,
      day: 2_000,
    });

    const body = requestSchema.parse(await request.json());

    const job = await prisma.perplexityAsyncJob.findUnique({
      where: { assistantMessageId: body.assistantMessageId },
    });
    if (!job) {
      return jsonError("Deep research job not found.", "NOT_FOUND", 404, traceId);
    }

    const conversation = await prisma.conversation.findUnique({
      where: { id: job.conversationId },
      select: { userId: true, password: true },
    });
    if (!conversation || conversation.userId !== session.user.id) {
      return jsonError("Conversation not found.", "NOT_FOUND", 404, traceId);
    }
    if (
      !hasConversationUnlockGrant(
        request,
        session.user.id,
        job.conversationId,
        conversation.password
      )
    ) {
      return conversationLockedResponse();
    }

    // Already finalized by a previous poll (e.g. a second open tab) --
    // return the cached outcome instead of calling Perplexity or settling
    // credits again.
    if (job.status === "completed" || job.status === "failed") {
      return Response.json(
        {
          status: job.status,
          content: job.resultText ?? undefined,
          error: job.errorMessage ?? undefined,
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    const provider = getModel(job.modelId)?.provider || "perplexity";

    let poll;
    try {
      poll = await pollDeepResearchJob(job.perplexityJobId);
    } catch (error) {
      // A transient network/HTTP hiccup talking to Perplexity's poll
      // endpoint isn't a job failure -- report "still in progress" and let
      // the client retry. If Perplexity is genuinely down, the reservation
      // simply stops getting its heartbeat extended and the existing
      // 15-minute reconcileExpiredChatCreditReservations cron will refund
      // it once expiresAt lapses, same safety net as any other stuck job.
      console.error("Deep research poll failed:", {
        traceId,
        jobId: job.id,
        error: error instanceof PerplexityDeepResearchError ? error.message : error,
      });
      return Response.json(
        {
          status: "in_progress",
          elapsedSeconds: Math.floor(
            (Date.now() - job.submittedAt.getTime()) / 1000
          ),
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    if (poll.status === "CREATED" || poll.status === "IN_PROGRESS") {
      await Promise.all([
        prisma.perplexityAsyncJob.updateMany({
          where: { id: job.id, status: { in: ["submitted", "in_progress"] } },
          data: { status: "in_progress", lastPolledAt: new Date() },
        }),
        extendChatReservationExpiry(
          job.reservationId,
          RESERVATION_HEARTBEAT_SECONDS
        ),
      ]);
      return Response.json(
        {
          status: "in_progress",
          elapsedSeconds: Math.floor(
            (Date.now() - job.submittedAt.getTime()) / 1000
          ),
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    const reservationRow = await prisma.chatCreditReservation.findUnique({
      where: { id: job.reservationId },
      select: { reservationPayload: true },
    });
    const reservation = reservationRow
      ? deserializeReservation(reservationRow.reservationPayload)
      : null;

    const content = poll.status === "COMPLETED" ? (poll.content || "").trim() : "";

    if (poll.status === "COMPLETED" && content) {
      const storedContent =
        content.length > MAX_STORED_MESSAGE_CHARACTERS
          ? `${content.slice(0, MAX_STORED_MESSAGE_CHARACTERS)}\n\n[Response truncated for storage]`
          : content;
      // Claim + finalize atomically in one transaction: the updateMany's
      // row lock means a second concurrent poll (another tab) either sees
      // count 0 here (already claimed) or blocks until this commits and
      // then sees count 0 -- either way it can't double-settle the
      // reservation or double-write the Message row.
      const finalized = await prisma.$transaction(async (tx) => {
        const claim = await tx.perplexityAsyncJob.updateMany({
          where: { id: job.id, status: { in: ["submitted", "in_progress"] } },
          data: {
            status: "completed",
            resultText: storedContent,
            completedAt: new Date(),
          },
        });
        if (claim.count !== 1) return false;
        await tx.message.update({
          where: { id: job.assistantMessageId },
          data: { content: storedContent, status: "normal", pendingJobId: null },
        });
        return true;
      });
      if (!finalized) {
        return Response.json(
          { status: "in_progress" },
          { headers: { "Cache-Control": "no-store" } }
        );
      }
      if (reservation) {
        await settleChatUsage(
          reservation,
          {
            inputTokens: poll.inputTokens,
            outputTokens: poll.outputTokens,
            outcome: "completed",
          },
          { providerUsageSnapshot: poll.usageSnapshot }
        ).catch((error) =>
          console.error("Deep research settlement failed:", { traceId, jobId: job.id, error })
        );
      }
      await Promise.all([
        recordProviderSuccess(provider),
        recordModelSuccess(job.modelId),
      ]);
      return Response.json(
        { status: "completed", content: storedContent },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    // Either an explicit FAILED from Perplexity, or a COMPLETED job with an
    // empty report -- both are treated the same way the synchronous chat
    // path treats an empty stream: refund in full and record a real model
    // failure rather than silently showing nothing.
    const errorMessage =
      poll.status === "FAILED"
        ? poll.errorMessage || "The Perplexity deep research job failed."
        : "The deep research job completed with an empty report.";
    const diagnosticCode =
      poll.status === "FAILED" ? "DEEP_RESEARCH_JOB_FAILED" : "AI_EMPTY_RESPONSE";

    const finalizedFailure = await prisma.$transaction(async (tx) => {
      const claim = await tx.perplexityAsyncJob.updateMany({
        where: { id: job.id, status: { in: ["submitted", "in_progress"] } },
        data: { status: "failed", errorMessage, completedAt: new Date() },
      });
      if (claim.count !== 1) return false;
      await tx.message.update({
        where: { id: job.assistantMessageId },
        data: { content: errorMessage, status: "error", pendingJobId: null },
      });
      return true;
    });
    if (!finalizedFailure) {
      return Response.json(
        { status: "in_progress" },
        { headers: { "Cache-Control": "no-store" } }
      );
    }
    if (reservation) {
      await settleChatUsage(reservation, {
        inputTokens: 0,
        outputTokens: 0,
        outcome: poll.status === "FAILED" ? "failed" : "empty",
      }).catch((error) =>
        console.error("Deep research refund failed:", { traceId, jobId: job.id, error })
      );
    }
    await Promise.allSettled([
      recordProviderFailure(provider, diagnosticCode, {
        modelId: job.modelId,
        phase: "stream",
        traceId,
        message: errorMessage,
      }),
      recordModelFailure(job.modelId, provider, diagnosticCode),
    ]);
    return Response.json(
      { status: "failed", error: errorMessage },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Deep research status check failed:", { traceId, error });
    return jsonError(
      "Failed to check the deep research job status.",
      "DEEP_RESEARCH_STATUS_FAILED",
      500,
      traceId
    );
  }
}
