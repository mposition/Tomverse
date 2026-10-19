import { isDmOptionId } from "./decisionMakerCore.ts";
import { isDmConfirmingJudgmentKind } from "./decisionMakerJudgmentCore.ts";
import { isDmRequestId, type DmRequestState } from "./decisionMakerRequestCore.ts";
import { isDmInstanceScope, type DmInstanceScope } from "./decisionMakerSwitchCore.ts";

/**
 * The AMUX Decision Maker's delivery of an operator-confirmed answer to the
 * asking worker (docs/policy/amux-decision-maker.md §2-7, §7, §9), stage
 * S2-2b3: what the bridge relay is given to deliver, and the worker message
 * it delivers.
 *
 * Pure. The message is composed here, from the policy's own words, so that
 * the one place that decides what a worker reads beside an answer is a module
 * the policy test reads (tests/amuxDecisionMakerDelivery.test.mjs holds §7's
 * header and sentence and its model table to this file). The bridge passes
 * the message through and the local AMUX checks its first line names the
 * card; neither composes one.
 *
 * Only a confirmation or an edited confirmation is ever a candidate: the
 * judgment store's read names those two kinds, `dmDeliveryCandidate()`
 * refuses anything else, and the delivery decision the app records before
 * the bridge sends anything refuses it again (§12: "운영자 확정 없이는 어떤
 * DM 출력도 worker에게 전달되지 않는다").
 */

/**
 * §7's table: the model each instance runs, in the policy's own words. The
 * worker reads these in the message header; tests/amuxDecisionMakerDelivery.test.mjs
 * reads §7's table rows and fails when either drifts.
 */
export const DM_DELIVERY_MODEL_LABELS: Readonly<Record<DmInstanceScope, string>> = Object.freeze({
  "decision-maker-openai": "GPT-6 Astra",
  "decision-maker-anthropic": "Claude Fable 5.1",
});

/** §7: `<operator-confirmed|operator-edited>`, by the judgment that made the answer. */
export const DM_DELIVERY_JUDGMENT_LABELS = Object.freeze({
  confirm: "operator-confirmed",
  edit_confirm: "operator-edited",
} as const);

export type DmConfirmingJudgmentKind = keyof typeof DM_DELIVERY_JUDGMENT_LABELS;

/**
 * §7: "승인 계약의 승인이 아니다. 사람 승인이 필요한 게이트는 따로 요청한다"는
 * 문장을 붙인다 -- the sentence, with its full stop.
 */
export const DM_DELIVERY_NOT_AN_APPROVAL = "승인 계약의 승인이 아니다. 사람 승인이 필요한 게이트는 따로 요청한다.";

/**
 * The line a `select` answer is delivered as. The worker wrote the option ids
 * of its own typed ask, so the id names the choice.
 */
export const DM_DELIVERY_OPTION_PREFIX = "선택지: ";

/**
 * The local AMUX's message idempotency key for a request's delivery: one per
 * request, so the local send path's reservation (`send_dedup`) and its
 * receipt read name this delivery and nothing else (§9: "로컬 메시지 멱등 키로
 * 전달 영수증을 조회한다"). 46 characters, inside the local key's 64.
 */
export const DM_DELIVERY_MESSAGE_ID_PREFIX = "dm-answer:";
export const dmDeliveryMessageId = (requestId: string): string => {
  if (!isDmRequestId(requestId)) throw new Error("AMUX Decision Maker delivery request id refused");
  return `${DM_DELIVERY_MESSAGE_ID_PREFIX}${requestId}`;
};

/**
 * A message's cap in UTF-8 bytes. The longest answer is a body of 8 KiB (§10:
 * the DM's answer or the operator's); the header and the sentence add a few
 * hundred bytes. The local route holds the same cap.
 */
export const DM_DELIVERY_MESSAGE_MAX_BYTES = 16 * 1024;

/** A card id as the ledger holds it (`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`). */
const CARD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** §7's header: `[Decision Maker <인스턴스> (<모델>) 제안, <operator-confirmed|operator-edited>, re <카드>]`. */
export const dmDeliveryHeader = (input: {
  instance: DmInstanceScope;
  judgmentKind: DmConfirmingJudgmentKind;
  cardId: string;
}): string => {
  if (!isDmInstanceScope(input.instance) || !isDmConfirmingJudgmentKind(input.judgmentKind) || !CARD_ID.test(input.cardId)) {
    throw new Error("AMUX Decision Maker delivery header value refused");
  }
  return `[Decision Maker ${input.instance} (${DM_DELIVERY_MODEL_LABELS[input.instance]}) 제안, ${DM_DELIVERY_JUDGMENT_LABELS[input.judgmentKind]}, re ${input.cardId}]`;
};

/** The answer a delivery carries: the option a confirmed select chose, or a text. */
export type DmDeliveryAnswer = { kind: "option"; optionId: string } | { kind: "text"; text: string };

/**
 * The worker message (§7): the header, the answer, and after a blank line the
 * sentence. The card record the local AMUX appends is this same text.
 */
export const dmDeliveryMessage = (input: {
  instance: DmInstanceScope;
  judgmentKind: DmConfirmingJudgmentKind;
  cardId: string;
  answer: DmDeliveryAnswer;
}): string => {
  const header = dmDeliveryHeader(input);
  let body: string;
  if (input.answer.kind === "option") {
    if (!isDmOptionId(input.answer.optionId)) throw new Error("AMUX Decision Maker delivery option refused");
    body = `${DM_DELIVERY_OPTION_PREFIX}${input.answer.optionId}`;
  } else {
    if (typeof input.answer.text !== "string" || input.answer.text.trim().length === 0) {
      throw new Error("AMUX Decision Maker delivery text refused");
    }
    body = input.answer.text;
  }
  return `${header}\n${body}\n\n${DM_DELIVERY_NOT_AN_APPROVAL}`;
};

// ---------------------------------------------------------------------------
// The candidate
// ---------------------------------------------------------------------------

/**
 * Where the bridge's walk over the confirmations stands: the database clock of
 * the last judgment it was given, and that request. The next read returns the
 * first confirmation after it, so one the bridge cannot deliver yet (its
 * worker busy or stopped) never holds back those behind it.
 */
export type DmDeliveryCursor = { judgedAtMs: number; requestId: string };

/** The cursor from a route body's `after`, or null for the start; undefined when malformed. */
export const parseDmDeliveryCursor = (value: unknown): DmDeliveryCursor | null | undefined => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes("judged_at_ms") || !keys.includes("request_id")) return undefined;
  const judgedAtMs = record.judged_at_ms;
  if (typeof judgedAtMs !== "number" || !Number.isSafeInteger(judgedAtMs) || judgedAtMs < 0) return undefined;
  if (!isDmRequestId(record.request_id)) return undefined;
  return { judgedAtMs, requestId: record.request_id };
};

/** A confirmation the judgment store found with no delivery decision yet. */
export type DmDeliveryJudgment = {
  requestId: string;
  judgmentKind: DmConfirmingJudgmentKind;
  instance: DmInstanceScope;
  judgedAtMs: number;
};

/** The judgment store's candidate row, or null when it is not one the table could hold. */
export const dmDeliveryJudgmentFromRow = (row: unknown): DmDeliveryJudgment | null => {
  if (row === null || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const at = typeof r.judgedAtEpochMs === "bigint" || typeof r.judgedAtEpochMs === "number" ? Number(r.judgedAtEpochMs) : Number.NaN;
  if (!isDmRequestId(r.requestId) || !isDmConfirmingJudgmentKind(r.kind) || !isDmInstanceScope(r.instance)) return null;
  if (!Number.isSafeInteger(at) || at < 0) return null;
  return { requestId: r.requestId, judgmentKind: r.kind, instance: r.instance, judgedAtMs: at };
};

/** The bodies a delivery may carry, by field, as the body store returned them. */
export type DmDeliveryBodies = Partial<Record<"dm_answer" | "operator_answer", string>>;

export type DmDeliveryCandidate =
  | {
      status: "ready";
      requestId: string;
      judgedAtMs: number;
      judgmentKind: DmConfirmingJudgmentKind;
      instance: DmInstanceScope;
      cardId: string;
      questionRevision: number;
      /**
       * §9's binding as the request recorded it at routing -- the asking
       * worker, its AMUX session (the one the answer is for) and its session
       * attempt. The local AMUX claims and sends only while the card's owner
       * session and newest attempt are still these (a card given to another
       * worker keeps its question revision).
       */
      askingWorkerId: string;
      session: string;
      sessionAttempt: number;
      messageId: string;
      message: string;
    }
  | {
      /** Confirmed, but there is nothing to deliver: its answer body was erased. */
      status: "undeliverable";
      requestId: string;
      judgedAtMs: number;
      reason: "answer_body_missing" | "message_too_long";
    };

/**
 * Stage S2-2b4 (§9): a delivery decision with no outcome, as the bridge reads
 * it at its start -- the request, the database clock of the decision, and §9's
 * binding the local AMUX looks up: the card and question revision whose answer
 * record it reads, the session whose receipt of `messageId` it reads and which
 * it pauses for an unknown outcome. No answer: nothing here is sent again.
 */
export type DmUnsettledDelivery = {
  status: "unsettled";
  requestId: string;
  decidedAtMs: number;
  cardId: string;
  questionRevision: number;
  askingWorkerId: string;
  session: string;
  sessionAttempt: number;
  messageId: string;
};

/**
 * The unsettled delivery from the decision and the request's state, or null
 * when they do not agree with what the stores could have written: a decision
 * follows only a confirmation that closed its own request (§2-6), of a request
 * routed to a DM, with the binding's identifiers in the ledger's grammar.
 */
export const dmUnsettledDelivery = (input: {
  decision: { requestId: string; decidedAtMs: number };
  state: DmRequestState | null;
}): DmUnsettledDelivery | null => {
  const { decision, state } = input;
  if (!state || state.requestId !== decision.requestId) return null;
  if (state.route !== "dm_proposal" || !isDmConfirmingJudgmentKind(state.closing)) return null;
  if (!Number.isSafeInteger(decision.decidedAtMs) || decision.decidedAtMs < 0) return null;
  const { cardId, askingWorkerId, amuxSessionId: session, amuxSessionAttempt: sessionAttempt } = state.binding;
  if (!CARD_ID.test(cardId) || !CARD_ID.test(askingWorkerId) || !CARD_ID.test(session)) return null;
  if (!Number.isSafeInteger(sessionAttempt) || sessionAttempt < 0) return null;
  return {
    status: "unsettled",
    requestId: decision.requestId,
    decidedAtMs: decision.decidedAtMs,
    cardId,
    questionRevision: state.binding.questionRevision,
    askingWorkerId,
    session,
    sessionAttempt,
    messageId: dmDeliveryMessageId(decision.requestId),
  };
};

/**
 * What a confirmation gives the bridge, from the four reads the delivery read
 * composes: the confirmation itself, the request's state, its terminal
 * result's detail, and its bodies. Null when the reads do not agree with what
 * the stores could have written -- the caller reads that as unreadable state,
 * never as a candidate:
 *
 * - the request is routed to a DM, of the confirmation's instance, and closed
 *   by that very judgment (§2-6: a judgment closes its request with its own
 *   kind), so a rejected or unjudged request can never be read as confirmed;
 * - its terminal result is a proposal, a select or a free text answer.
 *
 * The answer is the person's edited answer for an edited confirmation, the
 * DM's free-text answer or the option a select chose for a confirmation. A
 * body the person erased since (§10's privacy erase) leaves nothing to
 * deliver: `undeliverable`, which the bridge steps past.
 */
export const dmDeliveryCandidate = (input: {
  judgment: DmDeliveryJudgment;
  state: DmRequestState | null;
  detail: { resultKind: string; outputKind: string | null; optionId: string | null } | null;
  bodies: DmDeliveryBodies;
}): DmDeliveryCandidate | null => {
  const { judgment, state, detail, bodies } = input;
  if (!state || state.requestId !== judgment.requestId) return null;
  if (state.route !== "dm_proposal" || state.instance !== judgment.instance) return null;
  if (state.closing !== judgment.judgmentKind) return null;
  if (state.terminal === null || state.terminal.resultKind !== "proposal") return null;
  if (!detail || detail.resultKind !== "proposal") return null;
  if (detail.outputKind !== "select" && detail.outputKind !== "free_text") return null;

  let answer: DmDeliveryAnswer | null;
  if (judgment.judgmentKind === "edit_confirm") {
    answer = typeof bodies.operator_answer === "string" ? { kind: "text", text: bodies.operator_answer } : null;
  } else if (detail.outputKind === "select") {
    if (!isDmOptionId(detail.optionId)) return null;
    answer = { kind: "option", optionId: detail.optionId };
  } else {
    answer = typeof bodies.dm_answer === "string" ? { kind: "text", text: bodies.dm_answer } : null;
  }
  const base = { requestId: judgment.requestId, judgedAtMs: judgment.judgedAtMs };
  if (answer === null || (answer.kind === "text" && answer.text.trim().length === 0)) {
    return { status: "undeliverable", ...base, reason: "answer_body_missing" };
  }
  const cardId = state.binding.cardId;
  const askingWorkerId = state.binding.askingWorkerId;
  const session = state.binding.amuxSessionId;
  const sessionAttempt = state.binding.amuxSessionAttempt;
  if (!CARD_ID.test(cardId) || !CARD_ID.test(askingWorkerId) || !CARD_ID.test(session)) return null;
  if (!Number.isSafeInteger(sessionAttempt) || sessionAttempt < 0) return null;
  const message = dmDeliveryMessage({ instance: judgment.instance, judgmentKind: judgment.judgmentKind, cardId, answer });
  if (Buffer.byteLength(message, "utf8") > DM_DELIVERY_MESSAGE_MAX_BYTES) {
    return { status: "undeliverable", ...base, reason: "message_too_long" };
  }
  return {
    status: "ready",
    ...base,
    judgmentKind: judgment.judgmentKind,
    instance: judgment.instance,
    cardId,
    questionRevision: state.binding.questionRevision,
    askingWorkerId,
    session,
    sessionAttempt,
    messageId: dmDeliveryMessageId(judgment.requestId),
    message,
  };
};
