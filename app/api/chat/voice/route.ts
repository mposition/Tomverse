export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiSecurityError, apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { assertUserOperationalAccess } from "@/lib/chatSecurity";
import { hasConversationUnlockGrant } from "@/lib/conversationLock";
import { VoiceBudgetError } from "@/lib/voiceInputBudget";
import { assertVoiceWatchdogReady, finalizeVoiceReservation, recordVoiceUsage, renewVoiceWebLease } from "@/lib/voiceConversationRecovery";
import { isVoiceTranscriptEvent, voiceConversationConfig, voiceDurationCharge, VOICE_CONVERSATION_SOURCE } from "@tomverse/chat-core";
import { reserveVoiceConversationCredits, settleVoiceConversationCredits, readVoiceCreditPayload } from "@/lib/voiceConversationCredits";
import { attachVoiceProviderSession, createVoiceProviderSession, hangupVoiceProviderSession, closeVoiceProviderSession } from "@/lib/voiceConversationProvider";
import { registerVoiceTask, queueVoiceTaskResult, dispatchVoiceTask } from "@/lib/voiceConversationTasks";

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
    const authentication = await resolveChatRouteSession(request);
    if (authentication.response) return authentication.response;
    const session = authentication.session;
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
        // The primary receiver observes the durable request and sends session.close.
        // Recovery handles a dead primary; hangup remains the timed fallback.
        return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
      }
      await assertUserOperationalAccess(userId);
      if (!voiceConversationConfig(process.env) || reservation.status !== "reserved" || reservation.lastError || reservation.expiresAt <= new Date()) return json("VOICE_SESSION_ENDED", 409);
      const payload = readVoiceCreditPayload(reservation.reservationPayload);
      if (payload.conversationId && payload.conversationId !== body.conversationId) return json("VOICE_CONVERSATION_FORBIDDEN", 403);
      await ownedConversation(request, userId, body.conversationId);
      const source = await prisma.message.findFirst({ where: { id: body.sourceUserMessageId, conversationId: body.conversationId, role: "user", createdAt: { gte: reservation.createdAt } }, select: { content: true } });
      if (!source) return json("VOICE_RESULT_MISMATCH", 403);
      // Read the saved answer rather than trusting text posted by the browser.
      const answer = await prisma.chatResponseAttempt.findFirst({
        where: { userId, conversationId: body.conversationId, sourceUserMessageId: body.sourceUserMessageId, status: "completed", createdAt: { gte: reservation.createdAt } },
        select: { partialContent: true }, orderBy: { createdAt: "desc" },
      });
      const research = !answer?.partialContent.trim() ? await prisma.perplexityAsyncJob.findFirst({ where: { conversationId: body.conversationId, sourceUserMessageId: body.sourceUserMessageId, status: "completed", createdAt: { gte: reservation.createdAt } }, select: { resultText: true }, orderBy: { createdAt: "desc" } }) : null;
      const answerText = answer?.partialContent || research?.resultText;
      if (!answerText?.trim()) return json("VOICE_ANSWER_NOT_READY", 409);
      await queueVoiceTaskResult(reservation.id, { delegationId: body.delegationId, conversationId: body.conversationId, sourceId: body.sourceUserMessageId, sourceText: source.content, answer: answerText });
      return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    }
    const config = voiceConversationConfig(process.env);
    if (!config) return json("VOICE_CONVERSATION_DISABLED", 503);
    await assertUserOperationalAccess(userId);
    await assertVoiceWatchdogReady(userId);
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
      ...readVoiceCreditPayload(reservation.reservationPayload), dispatchStartedAt: new Date().toISOString(), webLeaseUntil: new Date(Date.now() + 30_000).toISOString(),
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
        await prisma.chatCreditReservation.update({ where: { id: reservation.id }, data: { lastError: "VOICE_START_OUTCOME_UNKNOWN", ...("sessionId" in providerResult && providerResult.sessionId ? { providerRequestId: providerResult.sessionId } : {}) } });
        if ("sessionId" in providerResult && providerResult.sessionId) {
          // Persist identity before any cleanup. Prefer a trusted final receipt
          // so a malformed answer SDP does not retain a full cost hold unnecessarily.
          const seconds = await closeVoiceProviderSession(providerResult.sessionId).catch(() => null);
          if (seconds !== null) await finalizeVoiceReservation(reservation.id, seconds).catch(() => {});
          else await hangupVoiceProviderSession(providerResult.sessionId).catch(() => {});
        }
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
        let input: Array<{ delta: string; start_ms: number }> = [];
        const pendingDelegations: Array<{ id: string; offset: number; since: number }> = [];
        const delegationIds = new Set<string>();
        let flushing = false;
        let delegationTimer: ReturnType<typeof setTimeout> | undefined;
        let dispatching = false;
        const resultTimer = setInterval(() => {
          if (dispatching || finished || closing || socket.readyState !== socket.OPEN) return;
          dispatching = true;
          void dispatchVoiceTask(reservation.id, socket).catch(() => { send({ type: "error", code: "VOICE_RESULT_DELIVERY_FAILED" }); stop(); }).finally(() => { dispatching = false; });
        }, 500);
        const flushDelegation = () => {
          clearTimeout(delegationTimer);
          // Transcript fragments are not completed turns. Preserve sentence
          // pauses, and partition queued requests by provider audio offsets.
          delegationTimer = setTimeout(() => {
            if (!pendingDelegations.length || closing || finished || flushing) return;
            flushing = true;
            void (async () => {
              while (pendingDelegations.length && !closing && !finished) {
                const next = pendingDelegations[0];
                const boundary = next.offset;
                const parts = input.filter(part => part.start_ms <= boundary);
                const text = parts.sort((a, b) => a.start_ms - b.start_ms).map(part => part.delta).join("").slice(-16_000);
                if (!text.trim()) {
                  if (Date.now() - next.since < 10_000) { flushDelegation(); return; }
                  send({ type: "error", code: "VOICE_TRANSCRIPT_UNAVAILABLE" }); stop(); return;
                }
                input = input.filter(part => part.start_ms > boundary);
                pendingDelegations.shift();
                await registerVoiceTask(reservation.id, next.id, text);
                if (!finished && !closing) send({ type: "delegation", delegationId: next.id, text });
              }
            })().catch(() => { send({ type: "error", code: "VOICE_TASK_RECORDING_FAILED" }); stop(); }).finally(() => { flushing = false; });
          }, 2_000);
        };
        const seen = new Set<string>();
        const send = (value: unknown) => { try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)); } catch { /* Client left; the provider still needs finalization. */ } };
        const keepalive = setInterval(() => send({ type: "heartbeat" }), 15_000);
        const durationTimer = setTimeout(() => stop(), config.maxSeconds * 1_000);
        const killTimer = setInterval(() => { if (!voiceConversationConfig(process.env)) stop(); else if (!closing && !finished) void renewVoiceWebLease(reservation.id).catch(stop); }, 5_000);
        let closeTimer: ReturnType<typeof setTimeout> | undefined;
        const finish = async (seconds: number | null) => {
          if (finished) return; finished = true;
          clearInterval(keepalive); clearInterval(killTimer); clearTimeout(durationTimer); clearTimeout(closeTimer);
          clearInterval(resultTimer); clearTimeout(delegationTimer);
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
            if (event.type === "session.input_transcript.delta") { input.push({ delta: event.delta, start_ms: event.start_ms }); input = input.slice(-256); if (pendingDelegations.length) flushDelegation(); }
            send({ type: "transcript", event });
          } else if (event.type === "session.delegation.created" && !closing) {
            const delegation = event.delegation as { id?: unknown } | undefined;
            if (typeof delegation?.id === "string" && typeof event.offset_ms === "number" && Number.isFinite(event.offset_ms) && event.offset_ms >= 0 && !delegationIds.has(delegation.id)) {
              delegationIds.add(delegation.id);
              pendingDelegations.push({ id: delegation.id, offset: event.offset_ms, since: Date.now() }); flushDelegation();
            } else if (typeof delegation?.id !== "string" || typeof event.offset_ms !== "number" || !Number.isFinite(event.offset_ms) || event.offset_ms < 0) { send({ type: "error", code: "VOICE_DELEGATION_INVALID" }); stop(); }
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
