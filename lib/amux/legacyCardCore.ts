import { createHash } from "node:crypto";

import { BOARD_IMPORT_CANONICAL_SOURCE_SYSTEM } from "./boardImportCore.ts";
import { AMUX_IDEA_INPUT_MAX_BYTES } from "./ideaInputCore.ts";

/**
 * Cards the owner can only remake (owner decision 2026-11-08). Two kinds have
 * no path to a review decision or a recovery inspection:
 *
 * - `workboard`: imported from the old private workboard in 2026-10. They are
 *   not v22 Tasks, so the review decision, the app record inspection and the
 *   Ubuntu inspection all refuse them.
 * - `pre_v22_task`: an admin-idea-v4 Task made before v22 that lacks the v22
 *   receipt, task role or execution grade the Ubuntu inspection requires
 *   (lockRecoveryTask in v22TaskRecoveryService.ts), stopped in blocked or
 *   review with no run or a run whose outcome is unknown. No recovery proof
 *   can ever open its decision.
 *
 * The owner remakes such a card as a new owner idea, which the idea lane
 * builds, and closes the old card by archiving it: its status, attempts,
 * escalation history and audit stay as they are.
 *
 * - `stopped_task` (owner decision 2026-11-12): any other admin-idea-v4 Task
 *   stopped in blocked or review. It may have a review decision or a recovery
 *   path, but each new way a run stops needed its own decision before the
 *   owner could move the card at all. The owner may now always remake it,
 *   close it, or complete it as done, whatever stopped it; the decisions the
 *   server offers stay beside these.
 *
 * Pure: no database, no clock.
 */

export type AmuxLegacyCardKind = "workboard" | "pre_v22_task" | "stopped_task";

/** The facts that decide whether a card is one the owner can only remake. */
export type AmuxLegacyCardFacts = {
  sourceSystem: string | null; cardType: string | null; status: string;
  v22ReceiptId: string | null; taskRole: string | null; executionGrade: string | null;
  /** The newest attempt, or null when the card never ran. */
  lastAttempt: { endedAt: Date | string | null; outcome: string | null; reason: string | null } | null;
  /** An archived card left the owner queue (owner decision 2026-11-09): it is never a stopped Task. */
  archivedAt?: Date | string | null;
};

/** What the Ubuntu inspection accepts (lockRecoveryTask), apart from the archive. */
export const isAmuxV22RecoverableTask = (card: Pick<AmuxLegacyCardFacts,
  "sourceSystem" | "cardType" | "v22ReceiptId" | "taskRole" | "executionGrade">) =>
  card.sourceSystem === "admin-idea-v4" && card.cardType === "task" &&
  Boolean(card.v22ReceiptId) && Boolean(card.taskRole) && Boolean(card.executionGrade);

const UNKNOWN_OUTCOMES = new Set(["expired", "outcome_unknown"]);
const UNKNOWN_REASONS = new Set(["usage_outcome_unknown", "outcome_unknown"]);

function preV22Task(card: AmuxLegacyCardFacts) {
  if (isAmuxV22RecoverableTask(card)) return false;
  if (card.status !== "blocked" && card.status !== "review") return false;
  const attempt = card.lastAttempt;
  // A run still open is not an unknown outcome yet; the close refuses it as running.
  if (attempt === null || attempt.endedAt === null) return true;
  return UNKNOWN_OUTCOMES.has(attempt.outcome ?? "") || UNKNOWN_REASONS.has(attempt.reason ?? "");
}

export function amuxLegacyCardKind(card: AmuxLegacyCardFacts): AmuxLegacyCardKind | null {
  if (card.sourceSystem === BOARD_IMPORT_CANONICAL_SOURCE_SYSTEM) return "workboard";
  if (card.sourceSystem !== "admin-idea-v4" || card.cardType !== "task") return null;
  if (preV22Task(card)) return "pre_v22_task";
  return !card.archivedAt && (card.status === "blocked" || card.status === "review") ? "stopped_task" : null;
}


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

export function amuxLegacyCardCloseRefusal(card: AmuxLegacyCardFacts & {
  archivedAt: Date | null; revision: number; activeDelivery: boolean; liveAttempt: boolean;
  /** An open or acknowledged escalation is still on the card. */
  openEscalation: boolean;
}, shownRevision: number): AmuxLegacyCardCloseRefusal | null {
  if (amuxLegacyCardKind(card) === null) return "not_legacy";
  // A card archived elsewhere (a closed local card) can still hold an open
  // escalation; its close then only resolves that, so the queue lets it go.
  if (card.archivedAt !== null && !card.openEscalation) return "already_closed";
  if (card.revision !== shownRevision) return "changed";
  // A queued or leased delivery, an open attempt or a card a worker is doing
  // is still running: archiving it would fence the worker's settlement.
  if (card.activeDelivery || card.liveAttempt || card.status === "doing") return "running";
  return null;
}

/** Why the owner cannot complete a card as done now. Null when the owner can. */
export type AmuxOwnerCompleteRefusal = AmuxLegacyCardCloseRefusal | "not_completable";

/**
 * The owner completes a stopped v22 Task as done (owner decision 2026-11-12):
 * the work is in, whatever the pipeline recorded. Only a Task that holds its
 * v22 receipt can be done (amux_v22_card_receipt_guard), and an archived card
 * keeps its archive. Everything a close refuses, this refuses too.
 */
export function amuxOwnerCompleteRefusal(card: Parameters<typeof amuxLegacyCardCloseRefusal>[0],
  shownRevision: number): AmuxOwnerCompleteRefusal | null {
  const refusal = amuxLegacyCardCloseRefusal(card, shownRevision);
  if (refusal) return refusal;
  if (amuxLegacyCardKind(card) !== "stopped_task" || !isAmuxV22RecoverableTask(card) ||
      card.archivedAt !== null) return "not_completable";
  return null;
}

const LEGACY_KIND_LABELS: Record<AmuxLegacyCardKind, string> = {
  workboard: "옛 작업판에서 이관한 카드",
  pre_v22_task: "v22 이전에 만든 Task",
  stopped_task: "멈춘 Task",
};

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
const ROLE_LABELS: Record<string, string> = {
  investigate: "조사", design: "설계", review: "검토", verify: "검증", operate: "운영", implement: "구현",
};

/** Roles whose work is not a code change; the remade idea says so, so the lane keeps it that way. */
const NON_CODE_ROLES = new Set(["investigate", "design", "review", "verify", "operate"]);

export function amuxLegacyCardIdeaText(card: {
  displayKey: string | null; id: string; description: string | null; executionBrief: string | null;
  kind?: AmuxLegacyCardKind; taskRole?: string | null;
  /** The card's own title, the idea's title when only the approved brief is readable. */
  title?: string | null;
}): AmuxLegacyCardIdea {
  const raw = card.description?.trim() ?? "";
  const brief = card.executionBrief?.trim() ?? "";
  if (!raw && !brief) return { ok: false, code: "no_assigned_work" };
  let parsed: unknown = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  let title: string;
  let body: string[];
  if (!raw) {
    // No assigned work of its own: the approved brief below is the work, under
    // the card's title, or the brief's first sentence when it has none.
    title = amuxFirstSentence(card.title ?? "") || amuxFirstSentence(brief);
    body = [];
  } else if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
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
  const footer = `원래 카드: ${card.displayKey ?? card.id} (${LEGACY_KIND_LABELS[card.kind ?? "workboard"]}를 새 아이디어로 다시 만듦)`;
  const role = card.taskRole ? ROLE_LABELS[card.taskRole] ?? card.taskRole : null;
  const nature = role ? [`작업 성격: ${role}${NON_CODE_ROLES.has(card.taskRole!) ?
    " (코드 수정이 아닌 작업입니다. 결과는 보고서로 남기고 코드를 바꾸지 않습니다)" : ""}`] : [];
  const head = [title, "", ...nature, ...(nature.length ? [""] : []), ...body,
    ...(brief ? [...(body.length ? [""] : []), "승인된 실행 브리프:", brief] : [])].join("\n").trim();
  const room = AMUX_IDEA_INPUT_MAX_BYTES - Buffer.byteLength(`\n\n…\n\n${footer}`, "utf8");
  const cut = cutToBytes(head, room);
  const truncated = cut !== head;
  return { ok: true, title, truncated,
    text: `${truncated ? `${cut.trimEnd()}\n\n…` : head}\n\n${footer}` };
}
