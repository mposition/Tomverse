import { createHash } from "node:crypto";

import { BOARD_IMPORT_CANONICAL_SOURCE_SYSTEM } from "./boardImportCore.ts";
import { AMUX_IDEA_INPUT_MAX_BYTES } from "./ideaInputCore.ts";

/**
 * Legacy WORKBOARD cards (owner decision 2026-11-08): the cards imported from
 * the old private workboard in 2026-10 are not v22 Tasks, so the review
 * decision, the app record inspection and the Ubuntu inspection all refuse
 * them. The owner remakes each one as a new owner idea, which the idea lane
 * builds, and closes the old card by archiving it: its status, attempts,
 * escalation history and audit stay as they are.
 *
 * Pure: no database, no clock.
 */

/** Only these cards take the recreate and close actions. */
export const isAmuxLegacyWorkboardCard = (card: { sourceSystem: string | null }) =>
  card.sourceSystem === BOARD_IMPORT_CANONICAL_SOURCE_SYSTEM;

/**
 * The app record inspection and the Ubuntu inspection read v22 execution
 * evidence that only an admin-idea-v4 Task has
 * (ownerRecoveryInspectionRead.ts, v22TaskRecoveryService.ts). Any other card
 * hides both buttons rather than offering one the server refuses.
 */
export const isAmuxRecoveryInspectableCard = (card: { sourceSystem: string | null; cardType: string | null }) =>
  card.sourceSystem === "admin-idea-v4" && card.cardType === "task";

/**
 * The request id of a card's recreate, derived on the server from the card and
 * the exact idea text, so a resend of the same text reads the same idea back,
 * and a card whose assigned work changed since saves the text shown now rather
 * than reading back an idea made from the old one.
 */
export function amuxLegacyCardRecreateRequestId(taskId: string, ideaText: string): string {
  const bytes = createHash("sha256").update(`amux-legacy-card-recreate:${taskId}\n`)
    .update(createHash("sha256").update(ideaText, "utf8").digest("hex")).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Why a card cannot be closed now. Null when it can. */
export type AmuxLegacyCardCloseRefusal =
  | "not_legacy" | "already_closed" | "changed" | "running";

export function amuxLegacyCardCloseRefusal(card: {
  sourceSystem: string | null; archivedAt: Date | null; revision: number; status: string;
  activeDelivery: boolean; liveAttempt: boolean;
}, shownRevision: number): AmuxLegacyCardCloseRefusal | null {
  if (!isAmuxLegacyWorkboardCard(card)) return "not_legacy";
  if (card.archivedAt !== null) return "already_closed";
  if (card.revision !== shownRevision) return "changed";
  // A queued or leased delivery, an open attempt or a card a worker is doing
  // is still running: archiving it would fence the worker's settlement.
  if (card.activeDelivery || card.liveAttempt || card.status === "doing") return "running";
  return null;
}

const LABELS: Record<string, string> = {
  problem: "문제",
  scope: "범위",
  scopeIn: "할 일",
  scopeOut: "하지 않을 일",
  completionCriteria: "완료 기준",
};

const oneLine = (value: string) => value.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim();

/** The first sentence of a text, on one line. */
export function amuxFirstSentence(text: string): string {
  const line = oneLine(text);
  const match = /^(.+?[.!?。！？])(\s|$)/u.exec(line);
  return (match ? match[1] : line).trim();
}

const asLines = (value: unknown): string[] => {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap((item) => asLines(item).map((line) => `- ${line}`));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
      const lines = asLines(item);
      if (lines.length === 0) return [];
      const label = LABELS[key] ?? key;
      return lines.length === 1 && !lines[0].startsWith("- ") ? [`${label}: ${lines[0]}`] : [`${label}:`, ...lines];
    });
  }
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  return [];
};

/** Cuts a text to at most `max` UTF-8 bytes at a code point boundary. */
const cutToBytes = (text: string, max: number) => {
  if (Buffer.byteLength(text, "utf8") <= max) return text;
  let out = "";
  let bytes = 0;
  for (const point of text) {
    const size = Buffer.byteLength(point, "utf8");
    if (bytes + size > max) break;
    out += point;
    bytes += size;
  }
  return out;
};

export type AmuxLegacyCardIdea =
  | { ok: true; title: string; text: string; truncated: boolean }
  | { ok: false; code: "no_assigned_work" };

/**
 * The owner idea a legacy card becomes. Its first line is a readable title
 * (the idea's listed title, ideaTitleCore.ts): the first sentence of the
 * card's problem, or the first line of a description that is not the JSON
 * shape. Then the assigned work, field by field, and a line naming the card it
 * replaces. A text over the idea limit keeps its head; the old card stays in
 * the archive with the whole of it.
 */
export function amuxLegacyCardIdeaText(card: {
  displayKey: string | null; id: string; description: string | null; executionBrief: string | null;
}): AmuxLegacyCardIdea {
  const raw = card.description?.trim() ?? "";
  if (!raw) return { ok: false, code: "no_assigned_work" };
  let parsed: unknown = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  let title: string;
  let body: string[];
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    const problem = typeof record.problem === "string" ? record.problem.trim() : "";
    body = asLines(record);
    // Without a problem, the first field line that holds text, without its label or bullet.
    const firstText = body.map((line) => line.replace(/^- /u, "").replace(/^[^:]+:\s*/u, "").trim())
      .find((line) => line !== "") ?? "";
    title = amuxFirstSentence(problem || firstText);
  } else {
    const lines = raw.split(/\r\n|\r|\n/);
    const first = lines.findIndex((line) => line.trim() !== "");
    title = amuxFirstSentence(lines[first] ?? "");
    // The whole text, first line included: the title keeps only its first sentence.
    body = lines.slice(first).map((line) => line.trimEnd());
  }
  if (!title) return { ok: false, code: "no_assigned_work" };
  const brief = card.executionBrief?.trim();
  const footer = `원래 카드: ${card.displayKey ?? card.id} (옛 작업판에서 이관한 카드를 새 아이디어로 다시 만듦)`;
  const head = [title, "", ...body, ...(brief ? ["", "승인된 실행 브리프:", brief] : [])].join("\n").trim();
  const room = AMUX_IDEA_INPUT_MAX_BYTES - Buffer.byteLength(`\n\n…\n\n${footer}`, "utf8");
  const cut = cutToBytes(head, room);
  const truncated = cut !== head;
  return { ok: true, title, truncated,
    text: `${truncated ? `${cut.trimEnd()}\n\n…` : head}\n\n${footer}` };
}
