import "server-only";
import type { Prisma } from "@prisma/client";
import type WebSocket from "ws";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { ApiSecurityError } from "@/lib/apiSecurity";
import { sendVoiceProviderResult } from "@/lib/voiceConversationProvider";

type Task = { id: string; textHash: string; state: "issued" | "ready" | "dispatching" | "sent" | "failed"; answer?: string; sourceId?: string };
const textHash = (text: string) => createHash("sha256").update(text.trim()).digest("hex");
type Payload = { conversationId?: string | null; tasks?: Task[] } & Record<string, unknown>;
async function change<T>(id: string, apply: (payload: Payload) => T): Promise<T> {
  return prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<Array<{ reservationPayload: Prisma.JsonValue }>>`SELECT "reservationPayload" FROM "ChatCreditReservation" WHERE "id" = ${id} AND "source" = 'voice_conversation' AND "status" = 'reserved' AND "lastError" IS NULL FOR UPDATE`;
    if (!rows.length) throw new ApiSecurityError(409, "VOICE_SESSION_ENDED", "This voice session ended.");
    const payload = rows[0].reservationPayload as Payload; const before = JSON.stringify(payload);
    const value = apply(payload);
    if (JSON.stringify(payload) !== before) await tx.chatCreditReservation.update({ where: { id }, data: { reservationPayload: payload as unknown as Prisma.InputJsonValue } });
    return value;
  });
}
export function registerVoiceTask(id: string, delegationId: string, text: string) {
  return change(id, payload => {
    const tasks = payload.tasks ??= [];
    if (tasks.some(task => task.id === delegationId)) return;
    if (tasks.length >= 64) throw new ApiSecurityError(409, "VOICE_TASK_LIMIT", "Start another voice session to continue.");
    tasks.push({ id: delegationId, textHash: textHash(text), state: "issued" });
  });
}
export function queueVoiceTaskResult(id: string, input: { delegationId: string; conversationId: string; sourceId: string; sourceText: string; answer: string }) {
  return change(id, payload => {
    const task = payload.tasks?.find(task => task.id === input.delegationId);
    if (!task || task.textHash !== textHash(input.sourceText) || payload.conversationId && payload.conversationId !== input.conversationId) throw new ApiSecurityError(403, "VOICE_RESULT_MISMATCH", "This answer does not match the issued voice question.");
    if (task.state !== "issued") {
      if (task.sourceId !== input.sourceId) throw new ApiSecurityError(409, "VOICE_RESULT_MISMATCH", "The answer was already assigned.");
      return;
    }
    payload.conversationId = input.conversationId;
    task.answer = input.answer.slice(0, 12_000); task.sourceId = input.sourceId; task.state = "ready";
  });
}
/** A lost sender may already have appended audio. Never replay that unknown write. */
export function abandonVoiceDispatch(id: string) {
  return change(id, payload => {
    let unknown = false;
    for (const task of payload.tasks ?? []) if (task.state === "dispatching") { task.state = "failed"; delete task.answer; unknown = true; }
    return unknown;
  });
}
/** The existing receiver sends results. No second sideband connection is opened. */
export async function dispatchVoiceTask(id: string, socket: WebSocket) {
  const task = await change(id, payload => {
    const next = payload.tasks?.find(task => task.state === "ready");
    if (!next) return null;
    next.state = "dispatching"; return { ...next };
  });
  if (!task) return;
  try {
    await sendVoiceProviderResult(socket, task.id, task.answer!);
    await change(id, payload => { const saved = payload.tasks?.find(t => t.id === task.id); if (saved) { saved.state = "sent"; delete saved.answer; } });
  } catch (error) {
    // A possibly accepted append is not retried after an unknown outcome.
    await change(id, payload => { const saved = payload.tasks?.find(t => t.id === task.id); if (saved) { saved.state = "failed"; delete saved.answer; } }).catch(() => {});
    throw error;
  }
}
