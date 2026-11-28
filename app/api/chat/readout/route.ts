import { resolveChatRouteSession } from "@/lib/chatRouteSession";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";

import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { CHAT_ANSWER_RATING_REFUSAL_STATUS, chatAnswerRatingRefusal } from "@/lib/chatAnswerRatingCore";
import { READOUT_MAX_CHUNKS, readoutRefusal, resolveReadoutLimits } from "@/lib/chatReadoutAccess";
import {
  readoutAccountKey,
  readoutBudgetStore,
  readoutLeaseStore,
  readoutPieceLeaseKey,
  readoutProviderKey,
} from "@/lib/chatReadoutBudget";
import { readoutApiKey } from "@/lib/chatReadoutServer";
import {
  ReadoutBudgetError,
  readoutKeepsLease,
  reserveReadoutCharacters,
  settleReadoutReservation,
  type ReadoutDisposition,
} from "@/lib/chatReadoutBudgetCore";
import { synthesizeReadoutSpeech } from "@/lib/chatReadoutSpeechCore";
import { readoutPieces } from "@/lib/chatReadoutText";
import { conversationLockedResponse, hasConversationUnlockGrant } from "@/lib/conversationLock";
import { prisma } from "@/lib/prisma";

/**
 * POST /api/chat/readout -- one piece of a Chat answer, spoken by the server's
 * speech provider (docs/policy/voice-input.md §6.4).
 *
 * Every refusal is answered with a code the browser reads as "use the
 * browser's own voice instead"; none of them reach the provider or the budget.
 * The order is: switch and prerequisites, signed-in owner, rate limit, the
 * answer itself, the piece's lease (one request per account, answer and piece
 * at a time; kept after an unknown outcome so the piece is not bought twice),
 * then reserve -> call -> settle on every exit. The text is
 * always the stored answer, re-cleaned here; the request names an answer and a
 * piece number, never the words that are paid for.
 *
 * No credits: like voice input this is not priced to the user (§6.1-1). The
 * guardrail is the character budget in lib/chatReadoutBudgetCore.ts.
 */

const bodySchema = z.object({
  messageId: z.string().trim().min(1).max(191),
  chunk: z.number().int().min(0).max(READOUT_MAX_CHUNKS - 1),
});

const NO_STORE = { "Cache-Control": "no-store" } as const;

const refuse = (status: number, code: string, headers: Record<string, string> = {}) =>
  NextResponse.json({ code }, { status, headers: { ...NO_STORE, ...headers } });

const log = (fields: Record<string, string | number | boolean | null>) =>
  console.info(JSON.stringify({ event: "chat_readout", ...fields }));

export async function POST(req: Request) {
  const apiKey = readoutApiKey();
  const unavailable = readoutRefusal({ env: process.env, hasProviderKey: Boolean(apiKey) });
  const limits = resolveReadoutLimits(process.env);
  if (unavailable || !limits) {
    return refuse(503, "READOUT_UNAVAILABLE");
  }

  try {
    const routeAuth = await resolveChatRouteSession(req);
    if (routeAuth.response) return routeAuth.response;
    const userId = routeAuth.session?.user?.id;
    // Guests keep the browser voice: a paid call needs an account to bound it to.
    if (!userId) return refuse(401, "READOUT_AUTH_REQUIRED");
    await consumeApiRateLimit(req, userId, "chat-readout", { minute: 30, day: 1_000 });
    const body = await readLimitedJson(req, 1024, bodySchema);

    const message = await prisma.message.findUnique({
      where: { id: body.messageId },
      select: {
        id: true,
        role: true,
        status: true,
        content: true,
        conversationId: true,
        conversation: { select: { userId: true, kind: true, password: true, passwordVersion: true } },
      },
    });
    // The answer-rating rule: the owner's own unlocked Chat answer, nothing else.
    const refusal = chatAnswerRatingRefusal({
      message,
      userId,
      unlocked:
        message !== null &&
        hasConversationUnlockGrant(
          req,
          userId,
          message.conversationId,
          message.conversation.password == null ? null : message.conversation.passwordVersion
        ),
    });
    if (refusal === "locked") return conversationLockedResponse();
    if (refusal || !message) {
      return refuse(CHAT_ANSWER_RATING_REFUSAL_STATUS[refusal ?? "not_found"], "READOUT_NOT_AN_ANSWER");
    }

    const pieces = readoutPieces(message.content);
    const text = pieces.chunks[body.chunk];
    if (!text) return refuse(404, "READOUT_NOTHING_TO_READ");

    // The same piece is already being read for this account -- another tab, a
    // retried click -- or its last paid call ended with an unknown outcome.
    // Either way a second call could buy it twice, so this one does not start.
    const leaseKey = readoutPieceLeaseKey(userId, message.id, body.chunk);
    if (!(await readoutLeaseStore.acquire(leaseKey))) {
      log({ outcome: "in_progress", chunk: body.chunk });
      return refuse(409, "READOUT_IN_PROGRESS");
    }

    let reservation;
    try {
      reservation = await reserveReadoutCharacters({
        store: readoutBudgetStore,
        accountKey: readoutAccountKey(userId),
        providerKey: readoutProviderKey(),
        characters: text.length,
        limits,
      });
    } catch (error) {
      // Nothing was sent, so the piece is free again.
      await readoutLeaseStore.release(leaseKey).catch(() => undefined);
      if (error instanceof ReadoutBudgetError) {
        log({ outcome: "limit_reached", bucket: error.bucket });
        return refuse(429, "READOUT_LIMIT_REACHED", { "Retry-After": String(error.retryAfterSeconds) });
      }
      throw error;
    }

    let disposition: ReadoutDisposition = "indeterminate";
    try {
      const result = await synthesizeReadoutSpeech({ text, apiKey, fetchImpl: fetch });
      disposition = result.disposition;
      log({
        outcome: result.ok ? "spoken" : result.code,
        disposition: result.disposition,
        status: result.ok ? 200 : result.status,
        chunk: body.chunk,
        chunks: pieces.chunks.length,
      });
      // The browser must tell these apart: a refusal cost nothing, while an
      // unknown outcome may have been billed and is never asked for again.
      if (!result.ok) {
        return refuse(502, result.disposition === "indeterminate" ? "READOUT_OUTCOME_UNKNOWN" : "READOUT_PROVIDER_REFUSED");
      }
      return new Response(result.audio, {
        status: 200,
        headers: {
          ...NO_STORE,
          "Content-Type": result.contentType,
          "X-Readout-Chunks": String(pieces.chunks.length),
          "X-Readout-Truncated": pieces.truncated ? "1" : "0",
        },
      });
    } finally {
      // Every exit settles. An exception before a disposition is known keeps
      // the booking, the same as any other unknown outcome.
      await settleReadoutReservation({ store: readoutBudgetStore, reservation, disposition }).catch((error) =>
        console.error("Failed to settle a read-aloud reservation:", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        })
      );
      // Released only once the outcome is known; an unknown one keeps the
      // piece leased until the lease lapses (READOUT_PIECE_LEASE_SECONDS).
      if (!readoutKeepsLease(disposition)) await readoutLeaseStore.release(leaseKey).catch(() => undefined);
    }
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Read-aloud failed:", { errorName: error instanceof Error ? error.name : "UnknownError" });
    return refuse(500, "READOUT_FAILED");
  }
}
