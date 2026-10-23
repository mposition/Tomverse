export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ApiSecurityError, apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { assertUserOperationalAccess } from "@/lib/chatSecurity";
import { hasConversationUnlockGrant } from "@/lib/conversationLock";
import { VoiceBudgetError } from "@/lib/voiceInputBudget";
import { assertVoiceWatchdogReady, finalizeVoiceReservation, recordVoiceUsage } from "@/lib/voiceConversationRecovery";
import { isVoiceTranscriptEvent, voiceConversationConfig, voiceDurationCharge, VOICE_CONVERSATION_SOURCE } from "@/lib/voiceConversationCore";
import { reserveVoiceConversationCredits, settleVoiceConversationCredits, readVoiceCreditPayload } from "@/lib/voiceConversationCredits";
import { attachVoiceProviderSession, createVoiceProviderSession, hangupVoiceProviderSession, sendVoiceProviderResult } from "@/lib/voiceConversationProvider";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), requestId: z.string().uuid(), conversationId: z.string().min(1).max(120).nullable(), sdp: z.string().min(1).max(64_000) }).strict(),
  z.object({ action: z.literal("result"), reservationId: z.string().min(1).max(200), delegationId: z.string().min(1).max(200), conversationId: z.string().min(1).max(120), sourceUserMessageId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("stop"), reservationId: z.string().min(1).max(200) }).strict(),
  z.object({ action: z.literal("status"), reservationId: z.string().min(1).max(200).optional(), requestId: z.string().uuid().optional() }).strict().refine(value => value.reservationId || value.requestId),
  z.object({ action: z.literal("history"), conversationId: z.string().min(1).max(120) }).strict(),
]);

const json = (code: string, status: number, extra: Record<string, unknown> = {}) => Response.json({ code, ...extra }, { status, headers: { "Cache-Control": "private, no-store" } });

async function ownedConversation(request: Request, userId: string, conversationId: string) {
  const row = await prisma.conversation.findFirst({ where: { id: conversationId, userId }, select: { id: true, productKey: true, password: true } });
  if (!row || row.productKey !== "chat") throw new ApiSecurityError(403, "VOICE_CONVERSATION_FORBIDDEN", "This conversation is not available for voice.");
  if (!hasConversationUnlockGrant(request, userId, row.id, row.password)) throw new ApiSecurityError(423, "CONVERSATION_LOCKED", "Unlock this conversation first.");
  return row;
}

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return json("VOICE_AUTHENTICATION_REQUIRED", 401);
    const userId = session.user.id;
    const body = await readLimitedJson(request, 96 * 1024, schema);
    await consumeApiRateLimit(request, userId, body.action === "start" ? "voice-conversation-start" : "voice-conversation-control", { minute: body.action === "start" ? 4 : 60, day: body.action === "start" ? 40 : 2_000 });
    if (body.action === "history") {
      await ownedConversation(request, userId, body.conversationId);
      const rows = await prisma.chatCreditReservation.findMany({
        where: { userId, source: VOICE_CONVERSATION_SOURCE, reservationPayload: { path: ["conversationId"], equals: body.conversationId } },
        select: { id: true, status: true, createdAt: true, settledCredits: true, providerUsageSnapshot: true }, orderBy: { createdAt: "desc" }, take: 10,
      });
      return Response.json({ sessions: rows.map(row => ({ id: row.id, settled: row.status === "settled", createdAt: row.createdAt,
        credits: row.settledCredits, seconds: (row.providerUsageSnapshot as { seconds?: number } | null)?.seconds ?? 0,
        confirmed: (row.providerUsageSnapshot as { confirmed?: boolean } | null)?.confirmed === true })) }, { headers: { "Cache-Control": "no-store" } });
    }
    // Stop and billing status remain available after the kill switch is pulled.
    if (body.action !== "start") {
      const reservation = await prisma.chatCreditReservation.findFirst({ where: {
        ...(body.action === "status" && !body.reservationId ? { idempotencyKey: `voice-conversation:${userId}:${body.requestId}` } : { id: body.reservationId }),
        userId, source: VOICE_CONVERSATION_SOURCE,
      } });
      if (!reservation) return json("VOICE_SESSION_NOT_FOUND", 404);
      if (body.action === "status") return Response.json({ settled: reservation.status === "settled", credits: reservation.settledCredits,
        seconds: (reservation.providerUsageSnapshot as { seconds?: number } | null)?.seconds ?? 0,
        confirmed: (reservation.providerUsageSnapshot as { confirmed?: boolean } | null)?.confirmed === true }, { headers: { "Cache-Control": "no-store" } });
      if (!reservation.providerRequestId) return json("VOICE_SESSION_NOT_FOUND", 404);
      if (body.action === "stop") {
        await prisma.chatCreditReservation.updateMany({ where: { id: reservation.id, status: "reserved" }, data: { lastError: "VOICE_CLOSE_REQUESTED" } });
        await hangupVoiceProviderSession(reservation.providerRequestId);
        return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
      }
      await assertUserOperationalAccess(userId);
      if (!voiceConversationConfig(process.env) || reservation.status !== "reserved" || reservation.expiresAt <= new Date()) return json("VOICE_SESSION_ENDED", 409);
      const payload = readVoiceCreditPayload(reservation.reservationPayload);
      if (payload.conversationId && payload.conversationId !== body.conversationId) return json("VOICE_CONVERSATION_FORBIDDEN", 403);
      await ownedConversation(request, userId, body.conversationId);
      // Read the saved answer rather than trusting text posted by the browser.
      const answer = await prisma.chatResponseAttempt.findFirst({
        where: { userId, conversationId: body.conversationId, sourceUserMessageId: body.sourceUserMessageId, status: "completed", createdAt: { gte: reservation.createdAt } },
        select: { partialContent: true }, orderBy: { createdAt: "desc" },
      });
      if (!answer?.partialContent.trim()) return json("VOICE_ANSWER_NOT_READY", 409);
      if (!payload.conversationId) await prisma.chatCreditReservation.update({ where: { id: reservation.id }, data: { reservationPayload: { ...payload, conversationId: body.conversationId } } });
      await sendVoiceProviderResult(reservation.providerRequestId, body.delegationId, answer.partialContent);
      return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    }
    const config = voiceConversationConfig(process.env);
    if (!config) return json("VOICE_CONVERSATION_DISABLED", 503);
    await assertUserOperationalAccess(userId);
    await assertVoiceWatchdogReady();
    if (body.conversationId) await ownedConversation(request, userId, body.conversationId);
    const messages = body.conversationId ? await prisma.message.findMany({
      where: { conversationId: body.conversationId, status: "normal", role: { in: ["user", "assistant"] } },
      select: { role: true, content: true }, orderBy: { createdAt: "desc" }, take: 64,
    }) : [];
    const history: Array<{ role: "user" | "assistant"; content: string }> = [];
    let bytes = 0;
    for (const message of messages) {
      const size = Buffer.byteLength(message.content, "utf8");
      if (bytes + size > 7_500) break;
      bytes += size; history.unshift({ role: message.role as "user" | "assistant", content: message.content });
    }
    // Reserve closing headroom too. The server, not a browser timer, enforces duration.
    const reservedSeconds = config.maxSeconds + 30;
    const reservation = await reserveVoiceConversationCredits({ userId, requestId: body.requestId, conversationId: body.conversationId, creditsPerMinute: config.creditsPerMinute, maxSeconds: reservedSeconds, sessionSeconds: config.maxSeconds });
    let providerResult;
    await prisma.chatCreditReservation.update({ where: { id: reservation.id }, data: { reservationPayload: {
      ...readVoiceCreditPayload(reservation.reservationPayload), dispatchStartedAt: new Date().toISOString(),
    } } });
    try { providerResult = await createVoiceProviderSession(body.sdp, history); }
    catch {
      await prisma.chatCreditReservation.update({ where: { id: reservation.id }, data: { lastError: "VOICE_START_OUTCOME_UNKNOWN" } });
      return json("VOICE_START_OUTCOME_UNKNOWN", 502, { reservationId: reservation.id });
    }
    if (!providerResult.ok) {
      if (providerResult.rejected) {
        await settleVoiceConversationCredits(reservation.id, 0);
      } else {
        await prisma.chatCreditReservation.update({ where: { id: reservation.id }, data: { lastError: "VOICE_START_OUTCOME_UNKNOWN" } });
      }
      return json(providerResult.rejected ? "VOICE_PROVIDER_UNAVAILABLE" : "VOICE_START_OUTCOME_UNKNOWN", 502, { reservationId: reservation.id });
    }
    try {
      await prisma.chatCreditReservation.update({ where: { id: reservation.id }, data: { providerRequestId: providerResult.sessionId } });
    } catch {
      await hangupVoiceProviderSession(providerResult.sessionId).catch(() => {});
      // Retrying an idempotent link is safe even if the first DB response was lost.
      await prisma.chatCreditReservation.update({ where: { id: reservation.id }, data: {
        providerRequestId: providerResult.sessionId, lastError: "VOICE_START_OUTCOME_UNKNOWN",
      } }).catch(() => {});
      return json("VOICE_START_OUTCOME_UNKNOWN", 502, { reservationId: reservation.id });
    }
    const providerSession = providerResult;
    const encoder = new TextEncoder();
    let stopStream: () => void = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const socket = attachVoiceProviderSession(providerSession.sessionId);
        let latestSeconds = 0;
        let finished = false;
        let closing = false;
        let input = "";
        const seen = new Set<string>();
        const send = (value: unknown) => { try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)); } catch { /* Client left; the provider still needs finalization. */ } };
        const keepalive = setInterval(() => send({ type: "heartbeat" }), 15_000);
        const durationTimer = setTimeout(() => stop(), config.maxSeconds * 1_000);
        const killTimer = setInterval(() => { if (!voiceConversationConfig(process.env)) stop(); }, 5_000);
        let closeTimer: ReturnType<typeof setTimeout> | undefined;
        const finish = async (seconds: number | null) => {
          if (finished) return; finished = true;
          clearInterval(keepalive); clearInterval(killTimer); clearTimeout(durationTimer); clearTimeout(closeTimer);
          request.signal.removeEventListener("abort", stop);
          try {
            if (seconds !== null && seconds >= latestSeconds && seconds <= reservedSeconds) {
              const charged = await finalizeVoiceReservation(reservation.id, seconds);
              send({ type: "closed", confirmed: true, settled: true, seconds, credits: charged.credits });
            } else {
              await prisma.chatCreditReservation.updateMany({ where: { id: reservation.id, status: "reserved" }, data: { lastError: "VOICE_FINAL_USAGE_UNCONFIRMED" } });
              send({ type: "closed", confirmed: false });
            }
          } catch {
            await prisma.chatCreditReservation.update({ where: { id: reservation.id }, data: { lastError: "VOICE_SETTLEMENT_PENDING" } }).catch(() => {});
            send({ type: "error", code: "VOICE_SETTLEMENT_PENDING" });
          }
          finally { socket.close(); try { controller.close(); } catch {} }
        };
        function stop() {
          if (finished || closing) return; closing = true;
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "session.close" }));
          else void hangupVoiceProviderSession(providerSession.sessionId).catch(() => {});
          closeTimer = setTimeout(() => { void hangupVoiceProviderSession(providerSession.sessionId).catch(() => {}); void finish(null); }, 15_000);
        }
        stopStream = stop;
        request.signal.addEventListener("abort", stop, { once: true });
        socket.on("open", () => {
          if (request.signal.aborted || closing) { closing = false; stop(); return; }
          send({ type: "ready", reservationId: reservation.id, sdp: providerSession.sdp, creditsPerMinute: config.creditsPerMinute, maxSeconds: config.maxSeconds });
        });
        socket.on("message", data => {
          let event: Record<string, unknown>; try { event = JSON.parse(data.toString()); } catch { return; }
          if (typeof event.event_id === "string") { if (seen.has(event.event_id)) return; seen.add(event.event_id); }
          if (event.type === "session.started") {
            send({ type: "started" });
          } else if (isVoiceTranscriptEvent(event)) {
            if (event.type === "session.input_transcript.delta") input = (input + event.delta).slice(-16_000);
            send({ type: "transcript", event });
          } else if (event.type === "session.delegation.created" && !closing) {
            const delegation = event.delegation as { id?: unknown } | undefined;
            if (typeof delegation?.id === "string" && input.trim()) {
              send({ type: "delegation", delegationId: delegation.id, text: input }); input = "";
            }
          } else if (event.type === "session.usage.updated") {
            const seconds = (event.usage as { seconds?: unknown } | undefined)?.seconds;
            if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= latestSeconds) {
              latestSeconds = seconds;
              void recordVoiceUsage(reservation.id, seconds).catch(() => { send({ type: "error", code: "VOICE_USAGE_RECORDING_FAILED" }); stop(); });
              send({ type: "usage", seconds, credits: voiceDurationCharge(seconds, config.creditsPerMinute).credits });
              if (seconds >= config.maxSeconds) stop();
            }
          } else if (event.type === "session.closed") {
            const seconds = (event.usage as { seconds?: unknown } | undefined)?.seconds;
            void finish(typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? seconds : null);
          } else if (event.type === "error") { send({ type: "error", code: "VOICE_PROVIDER_ERROR" }); stop(); }
        });
        socket.on("error", () => { send({ type: "error", code: "VOICE_CONNECTION_LOST" }); stop(); });
        socket.on("close", () => { if (!finished) { void hangupVoiceProviderSession(providerSession.sessionId).catch(() => {}); void finish(null); } });
      },
      cancel() { stopStream(); },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "private, no-store", "X-Accel-Buffering": "no" } });
  } catch (error) {
    if (error instanceof VoiceBudgetError) return json(error.code, error.status);
    return apiSecurityResponse(error) ?? json("VOICE_CONVERSATION_FAILED", 500);
  }
}
