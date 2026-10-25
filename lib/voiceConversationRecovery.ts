import "server-only";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { ApiSecurityError } from "@/lib/apiSecurity";
import { readVoiceCreditPayload, settleVoiceConversationCredits } from "@/lib/voiceConversationCredits";
import { attachVoiceProviderSession, closeVoiceProviderSession, hangupVoiceProviderSession } from "@/lib/voiceConversationProvider";
import { VOICE_CONVERSATION_SOURCE } from "@tomverse/chat-core";

const heartbeatKey = "voice-conversation:watchdog";
const heartbeatPeriod = "worker";
const epoch = new Date(0);
const receivers = new Map<string, () => void>();
const receiverClosers = new Map<string, () => Promise<void>>();
const receiverEmergencyClosers = new Map<string, () => void>();
// A receiver outlives individual funding windows. Never capture its first deadline.
const receiverBounds = new Map<string, { closeAt: number; expiresAt: number; webLeaseUntil: number }>();
const retryAfter = new Map<string, number>();
const hangupRetryAfter = new Map<string, number>();

/** A database lease also excludes receivers in other worker/maintenance processes. */
export async function claimVoiceRecoveryLease(id: string) {
  const token = randomUUID(); const until = new Date(Date.now() + 30_000).toISOString();
  const changed = await prisma.$executeRaw`UPDATE "ChatCreditReservation" SET "reservationPayload" = jsonb_set("reservationPayload", '{recoveryLease}', jsonb_build_object('token', ${token}::text, 'until', ${until}::text)), "lastError" = COALESCE("lastError", 'VOICE_CLOSE_REQUESTED'), "updatedAt" = NOW()
    WHERE "id" = ${id} AND "source" = ${VOICE_CONVERSATION_SOURCE} AND ("status" = 'reserved' OR "lastError" = 'VOICE_PROVIDER_STOP_PENDING')
    AND COALESCE(("reservationPayload"->>'webLeaseUntil')::timestamptz, 'epoch'::timestamptz) <= NOW()
    AND COALESCE(("reservationPayload"->'recoveryLease'->>'until')::timestamptz, 'epoch'::timestamptz) <= NOW()`;
  return changed === 1 ? token : null;
}
async function renewRecoveryLease(id: string, token: string) {
  const until = new Date(Date.now() + 30_000).toISOString();
  const changed = await prisma.$executeRaw`UPDATE "ChatCreditReservation" SET "reservationPayload" = jsonb_set("reservationPayload", '{recoveryLease,until}', to_jsonb(${until}::text))
    WHERE "id" = ${id} AND "reservationPayload"->'recoveryLease'->>'token' = ${token}
    AND ("status" = 'reserved' OR "lastError" = 'VOICE_PROVIDER_STOP_PENDING')`;
  if (changed !== 1) throw new Error("The recovery receiver lost ownership.");
}
export async function releaseVoiceRecoveryLease(id: string, token: string) {
  await prisma.$executeRaw`UPDATE "ChatCreditReservation" SET "reservationPayload" = "reservationPayload" - 'recoveryLease'
    WHERE "id" = ${id} AND "reservationPayload"->'recoveryLease'->>'token' = ${token}`;
}

/** The independent worker receives final usage even when the web process dies. */
export async function observeActiveVoiceConversations() {
  if (process.env.VOICE_CONVERSATION_KILL_SWITCH) for (const close of receiverClosers.values()) void close().catch(() => {});
  const rows = await prisma.chatCreditReservation.findMany({ where: { source: VOICE_CONVERSATION_SOURCE, OR: [{ status: "reserved" }, { lastError: "VOICE_PROVIDER_STOP_PENDING" }], providerRequestId: { not: null } } });
  for (const id of retryAfter.keys()) if (!rows.some(row => row.id === id)) retryAfter.delete(id);
  for (const id of hangupRetryAfter.keys()) if (!rows.some(row => row.id === id)) hangupRetryAfter.delete(id);
  for (const id of receiverBounds.keys()) if (!rows.some(row => row.id === id)) receiverBounds.delete(id);
  for (const [id, release] of receivers) if (!rows.some(row => row.id === id)) release();
  for (const row of rows) {
    let payload;
    try { payload = readVoiceCreditPayload(row.reservationPayload); } catch { continue; }
    receiverBounds.set(row.id, { closeAt: Date.parse(payload.closeAt ?? row.expiresAt.toISOString()), expiresAt: row.expiresAt.getTime(), webLeaseUntil: Date.parse(payload.webLeaseUntil ?? "") });
    const webHealthy = Date.parse(payload.webLeaseUntil ?? "") > Date.now();
    const urgent = () => {
      const latest = receiverBounds.get(row.id);
      return Boolean(latest && latest.webLeaseUntil > Date.now() && (latest.closeAt <= Date.now() || process.env.VOICE_CONVERSATION_KILL_SWITCH));
    };
    const hangup = () => {
      if ((hangupRetryAfter.get(row.id) ?? 0) > Date.now()) return;
      hangupRetryAfter.set(row.id, Date.now() + 10_000);
      void hangupVoiceProviderSession(row.providerRequestId!).catch(() => {});
    };
    if (receivers.has(row.id)) {
      if (urgent()) receiverEmergencyClosers.get(row.id)?.();
      if (!webHealthy) await receiverClosers.get(row.id)?.();
      continue;
    }
    // Expired holds belong to the grace reconciler; never repeatedly attach an
    // observer whose retention deadline has already passed.
    if (row.expiresAt.getTime() <= Date.now()) { if (urgent()) hangup(); continue; }
    if (!urgent() && (retryAfter.get(row.id) ?? 0) > Date.now()) continue;
    // Observe from the start: late attachment can miss the final usage event
    // when the web process disappears. Only an expired web lease grants commands.
    const socket = attachVoiceProviderSession(row.providerRequestId!);
    let lease: string | null = null;
    let claiming = false;
    let finalizing = false;
    let closeRequested = false;
    let finalizationTimer: ReturnType<typeof setTimeout> | undefined;
    let leaseTimer: ReturnType<typeof setInterval> | undefined;
    const close = () => { if (lease && !closeRequested && socket.readyState === socket.OPEN) { socket.send(JSON.stringify({ type: "session.close" })); closeRequested = true; } };
    const expiryTimer = setInterval(() => {
      if (finalizing || (receiverBounds.get(row.id)?.expiresAt ?? 0) > Date.now()) return;
      if (lease) void hangupVoiceProviderSession(row.providerRequestId!).catch(() => {});
      release();
    }, 2_000);
    let released = false;
    const emergencyClose = () => { if (socket.readyState === socket.OPEN && urgent()) hangup(); };
    async function takeOver() {
      if (released || finalizing || claiming) return;
      if (lease) { close(); return; }
      claiming = true;
      try {
        const token = await claimVoiceRecoveryLease(row.id);
        if (!token) return;
        if (released || finalizing) { await releaseVoiceRecoveryLease(row.id, token); return; }
        lease = token;
        leaseTimer = setInterval(() => { void renewRecoveryLease(row.id, token).catch(() => { if (!finalizing) release(); }); }, 5_000);
        close();
      } finally { claiming = false; }
    }
    function release() {
      if (released) return; released = true;
      clearInterval(expiryTimer); clearTimeout(finalizationTimer); clearInterval(leaseTimer);
      receivers.delete(row.id); receiverClosers.delete(row.id); receiverEmergencyClosers.delete(row.id); receiverBounds.delete(row.id); retryAfter.set(row.id, Date.now() + 10_000);
      socket.close(); if (lease) void releaseVoiceRecoveryLease(row.id, lease).catch(() => {});
    }
    receivers.set(row.id, release);
    receiverClosers.set(row.id, takeOver);
    receiverEmergencyClosers.set(row.id, emergencyClose);
    // Observe before an emergency hangup can emit its terminal usage event.
    // A failed attachment still uses the existing emergency stop authority.
    socket.once("open", () => { close(); emergencyClose(); });
    socket.on("message", data => {
      let event; try { event = JSON.parse(data.toString()); } catch { return; }
      const seconds = event.usage?.seconds;
      if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return;
      // Durable usage/finalization below validate against the latest funded bound,
      // including renewals committed since this observer's last sweep.
      if (event.type === "session.usage.updated") {
        void recordVoiceUsage(row.id, seconds).catch(() => close());
      } else if (event.type === "session.closed") {
        finalizing = true;
        const deadline = new Promise<never>((_, reject) => { finalizationTimer = setTimeout(() => reject(new Error("Voice finalization deadline exceeded.")), 15_000); });
        void Promise.race([finalizeVoiceReservation(row.id, seconds), deadline]).catch(() => {
          // A stalled database operation must not renew ownership forever.
          // This marker is best effort; lease expiry still permits another sweep.
          void prisma.chatCreditReservation.updateMany({ where: { id: row.id, status: "reserved" }, data: { lastError: "VOICE_RECOVERY_PENDING" } }).catch(() => {});
        }).finally(release);
      }
    });
    socket.once("error", () => { if (!finalizing) { if (urgent()) hangup(); release(); } });
    socket.once("close", () => { if (!finalizing) release(); });
    if (!webHealthy) await takeOver();
  }
}

export function stopVoiceRecoveryReceivers() { for (const release of receivers.values()) release(); receiverBounds.clear(); retryAfter.clear(); hangupRetryAfter.clear(); }

export async function renewVoiceWebLease(id: string) {
  const until = new Date(Date.now() + 30_000).toISOString();
  const count = await prisma.$executeRaw`UPDATE "ChatCreditReservation" SET "reservationPayload" = jsonb_set("reservationPayload", '{webLeaseUntil}', to_jsonb(${until}::text)), "updatedAt" = NOW() WHERE "id" = ${id} AND "source" = ${VOICE_CONVERSATION_SOURCE} AND "status" = 'reserved' AND "lastError" IS NULL
    AND COALESCE(("reservationPayload"->'recoveryLease'->>'until')::timestamptz, 'epoch'::timestamptz) <= NOW()`;
  if (count !== 1) throw new Error("The primary voice receiver must close.");
}

export async function touchVoiceWatchdog() {
  await prisma.chatUsageBucket.upsert({
    where: { key_period_periodStart: { key: heartbeatKey, period: heartbeatPeriod, periodStart: epoch } },
    create: { key: heartbeatKey, period: heartbeatPeriod, periodStart: epoch, count: BigInt(1) },
    update: { count: { increment: 1 }, updatedAt: new Date() },
  });
}

export async function assertVoiceWatchdogReady(userId: string) {
  const row = await prisma.chatUsageBucket.findUnique({ where: { key_period_periodStart: { key: heartbeatKey, period: heartbeatPeriod, periodStart: epoch } }, select: { updatedAt: true } });
  if (!row || Date.now() - row.updatedAt.getTime() > 15_000) {
    throw new ApiSecurityError(503, "VOICE_RECOVERY_UNAVAILABLE", "Voice recovery is unavailable. Continue in Chat.");
  }
  if (await prisma.chatCreditReservation.findFirst({ where: { userId, source: VOICE_CONVERSATION_SOURCE, lastError: "VOICE_PROVIDER_STOP_PENDING" }, select: { id: true } })) {
    throw new ApiSecurityError(503, "VOICE_RECOVERY_UNAVAILABLE", "An earlier voice session is still closing.");
  }
}

/** Monotonic, durable provider evidence. Late interim updates cannot replace a final receipt. */
export async function recordVoiceUsage(id: string, seconds: number, confirmed = false) {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Invalid provider duration.");
  await prisma.$executeRaw`
    UPDATE "ChatCreditReservation"
    SET "providerUsageSnapshot" = jsonb_build_object('seconds', ${seconds}::double precision, 'confirmed', ${confirmed}::boolean, 'source', 'provider'), "updatedAt" = NOW()
    WHERE "id" = ${id} AND "source" = ${VOICE_CONVERSATION_SOURCE} AND "status" = 'reserved'
      AND COALESCE(("providerUsageSnapshot"->>'confirmed')::boolean, false) = false
      AND COALESCE(("providerUsageSnapshot"->>'seconds')::double precision, 0) <= ${seconds}
      AND ${seconds} <= ("reservationPayload"->>'maxSeconds')::double precision
  `;
}

export async function finalizeVoiceReservation(id: string, seconds: number) {
  const reservation = await prisma.chatCreditReservation.findUniqueOrThrow({ where: { id }, select: { reservationPayload: true } });
  const payload = readVoiceCreditPayload(reservation.reservationPayload);
  // Reject before persisting a final receipt. Otherwise an invalid final can
  // permanently preempt the bounded observed-minimum recovery path.
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > payload.maxSeconds) throw new Error("Final voice duration exceeds the authorized reservation.");
  await recordVoiceUsage(id, seconds, true);
  const saved = await prisma.chatCreditReservation.findUniqueOrThrow({ where: { id }, select: { status: true, providerUsageSnapshot: true, settledCredits: true } });
  if (saved.status === "settled") {
    // A timed-out finalizer can resume after grace settlement. It has not
    // persisted new evidence and cannot clear an unresolved provider stop.
    return { credits: saved.settledCredits };
  }
  const evidence = saved.providerUsageSnapshot as { seconds?: number; confirmed?: boolean } | null;
  if (!evidence?.confirmed || evidence.seconds !== seconds) throw new Error("Final voice duration is inconsistent with observed usage.");
  const charged = await settleVoiceConversationCredits(id, seconds, true);
  if (charged) return charged;
  const row = await prisma.chatCreditReservation.findUniqueOrThrow({ where: { id }, select: { settledCredits: true } });
  return { credits: row.settledCredits ?? 0 };
}

/** Uses persisted evidence after a process restart; never retries session creation. */
export async function reconcileVoiceConversations(now = new Date(), limit = 10) {
  const rows = await prisma.chatCreditReservation.findMany({
    where: { source: VOICE_CONVERSATION_SOURCE, OR: [{ status: "reserved" }, { lastError: "VOICE_PROVIDER_STOP_PENDING" }] }, orderBy: { updatedAt: "asc" }, take: Math.min(10, limit),
  });
  const result = { examined: rows.length, settled: 0, deferred: 0 };
  await Promise.all(rows.map(async row => {
    let lease: string | null = null;
    let leaseTimer: ReturnType<typeof setInterval> | undefined;
    try {
      const payload = readVoiceCreditPayload(row.reservationPayload);
      if (receivers.has(row.id)) return;
      if (Date.parse(payload.webLeaseUntil ?? "") > now.getTime()) return;
      if (Date.parse(payload.recoveryLease?.until ?? "") > now.getTime()) return;
      const saved = row.providerUsageSnapshot as { seconds?: number; confirmed?: boolean } | null;
      if (row.status === "reserved" && saved?.confirmed && typeof saved.seconds === "number" && saved.seconds >= 0 && saved.seconds <= payload.maxSeconds) {
        await finalizeVoiceReservation(row.id, saved.seconds); result.settled++; return;
      }
      const closeAt = payload.closeAt ? Date.parse(payload.closeAt) : row.expiresAt.getTime();
      if (!row.lastError && now.getTime() < closeAt) return;
      lease = await claimVoiceRecoveryLease(row.id);
      if (!lease) return;
      const token = lease;
      leaseTimer = setInterval(() => { void renewRecoveryLease(row.id, token).catch(() => {}); }, 5_000);
      let providerStopped = !row.providerRequestId && !payload.dispatchStartedAt;
      if (row.providerRequestId) {
        if (row.status === "reserved") {
          const seconds = await closeVoiceProviderSession(row.providerRequestId);
          if (seconds !== null && seconds <= payload.maxSeconds) {
            const settled = await finalizeVoiceReservation(row.id, seconds).catch(() => null);
            if (settled) { result.settled++; return; }
          }
        }
        // The same session ID is safe to hang up repeatedly. No new session or work is dispatched.
        try { await hangupVoiceProviderSession(row.providerRequestId); providerStopped = true; } catch { providerStopped = false; }
      }
      if (row.status === "settled") {
        if (providerStopped) await prisma.chatCreditReservation.updateMany({ where: { id: row.id, lastError: "VOICE_PROVIDER_STOP_PENDING" }, data: { lastError: "VOICE_USAGE_ADJUSTED_AFTER_DISCONNECT" } });
        else result.deferred++;
        return;
      }
      if (now < row.expiresAt) { result.deferred++; return; }
      const seconds = saved?.confirmed ? 0 : Math.min(payload.maxSeconds, Math.max(0, Number(saved?.seconds) || 0));
      // Charge only the trusted observed minimum. The operational budget and
      // provider-cost estimate retain full exposure; unobserved seconds are waived.
      await settleVoiceConversationCredits(row.id, seconds, Boolean(payload.dispatchStartedAt), payload.dispatchStartedAt ? "observed_minimum" : "final", providerStopped);
      result.settled++;
    } catch {
      result.deferred++;
      await prisma.chatCreditReservation.updateMany({ where: { id: row.id, status: "reserved" }, data: { lastError: "VOICE_RECOVERY_PENDING" } }).catch(() => {});
    } finally {
      clearInterval(leaseTimer);
      if (lease) await releaseVoiceRecoveryLease(row.id, lease).catch(() => {});
      await prisma.chatCreditReservation.updateMany({ where: { id: row.id }, data: { updatedAt: now } }).catch(() => {});
    }
  }));
  return result;
}

export async function reconcileVoiceConversationsQuietly() {
  try { return await reconcileVoiceConversations(); } catch { return { examined: 0, settled: 0, deferred: 1 }; }
}
