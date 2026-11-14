/**
 * Whether the Decision Maker has a word on a card in the owner queue, and what
 * the owner can do when it has none (owner decision 2026-11-14: "DM 의견이
 * 없으면 'DM으로 의견 요청 보내기' 버튼을 제공합니다").
 *
 * Every Decision Maker card is filed by the host's DM relay, which calls
 * `POST /api/internal/amux/decision-maker/v22-questions/sync` every thirty
 * seconds. The server records when it last heard from it
 * (dmRelayLivenessStore.ts). From 2026-11-09 to 2026-11-14 the relay was down
 * and nothing on the screen said so: questions waited with no card and no
 * reason. This module names, for one queue card, which path would ask the
 * Decision Maker, how far it got, why it stopped, and the one action the owner
 * may take: send it again (a card whose evidence could not be read once), or
 * ask for the first time (a stopped Task with no settlement yet).
 *
 * Pure. The DM's answer is still only a proposal the owner confirms.
 */

/** How long since the relay's last call before the screen says to check it. */
export const AMUX_DM_RELAY_STALE_AFTER_MS = 5 * 60 * 1_000;
/** The relay calls every 30 s; the server records at most once per this. */
export const AMUX_DM_RELAY_RECORD_EVERY_MS = 60 * 1_000;
export const AMUX_DM_RELAY_SEEN_SETTING_KEY = "amux.dm_relay.last_sync";

/** The runbook section the screen links to for the host checks. */
export const AMUX_DM_RELAY_RUNBOOK_URL =
  "https://github.com/mposition/Tomverse/blob/develop/docs/ops/amux/bridge-monitoring.md#6-dm-relay-확인";

export type AmuxDmRelayView =
  /** No call recorded yet (a fresh database, or the relay never ran here). */
  | { state: "never" }
  | { state: "live" | "stale"; lastSeenAt: string };

export function amuxDmRelayView(lastSeenAt: Date | null, now: Date): AmuxDmRelayView {
  if (lastSeenAt === null || !Number.isFinite(lastSeenAt.getTime())) return { state: "never" };
  const stale = now.getTime() - lastSeenAt.getTime() > AMUX_DM_RELAY_STALE_AFTER_MS;
  return { state: stale ? "stale" : "live", lastSeenAt: lastSeenAt.toISOString() };
}

/** The Decision Maker paths a queue card can ride, in the order they are judged. */
export const AMUX_OWNER_QUEUE_DM_SOURCES = ["question", "result_review", "t2_draft", "settlement"] as const;
export type AmuxOwnerQueueDmSource = (typeof AMUX_OWNER_QUEUE_DM_SOURCES)[number];

export const AMUX_OWNER_QUEUE_DM_STATES = [
  /** The DM answered; the proposal waits for the owner's confirmation. */
  "proposed",
  /** The card reached the DM; no answer yet. */
  "asked",
  /** The relay filed the card; the DM has not taken it yet. */
  "card_filed",
  /** The evidence could not be read or did not fit a card; a person decides. */
  "unfilable",
  /** Nothing stops it: the next relay tick files the card. */
  "waiting_relay",
  /** The path's switch is off, so no card is filed on its own. */
  "switch_off",
  /** The path's conditions do not hold for this card. */
  "not_eligible",
  /** The settlement was decided, or stopped because the Task moved. */
  "settled",
  /** No path holds the card: no question, review, draft or escalation. */
  "none",
] as const;
export type AmuxOwnerQueueDmState = (typeof AMUX_OWNER_QUEUE_DM_STATES)[number];

export type AmuxOwnerQueueDmView = {
  source: AmuxOwnerQueueDmSource | null;
  state: AmuxOwnerQueueDmState;
  /** A code saying why, for the state that has one (see the copy). */
  reason: string | null;
  /** The DM request, when one exists: the proposal drawer opens it. */
  requestId: string | null;
  /** What the owner's button does, or null when there is none. */
  action: "resend" | "request" | null;
  /** The row the action names (a review, a settlement, or the escalation). */
  sourceId: string | null;
};

/** A DM request filed from a card, and whether its answer came. */
export type AmuxOwnerQueueDmRequestFact = { requestId: string; answered: boolean };

export type AmuxOwnerQueueDmFacts = {
  question: {
    id: string; localCardId: string | null; request: AmuxOwnerQueueDmRequestFact | null;
    /** The asking run ended parked on the question. */
    parked: boolean; taskBlocked: boolean; bodyAvailable: boolean; providerKnown: boolean;
  } | null;
  review: {
    id: string; localCardId: string | null; request: AmuxOwnerQueueDmRequestFact | null;
    handoffReason: string | null;
  } | null;
  t2: {
    workItemId: string; localCardId: string | null; request: AmuxOwnerQueueDmRequestFact | null;
    unfilable: boolean;
  } | null;
  settlement: {
    id: string; state: string; localCardId: string | null; request: AmuxOwnerQueueDmRequestFact | null;
    handoffReason: string | null; cancelReason: string | null;
    /** The owner asked for it from this screen (its audit entry). */
    requested: boolean;
  } | null;
  /** The card's newest open escalation, which a settlement is filed for. */
  escalationId: string | null;
  /** No settlement yet, and the settlement scan would file this escalation. */
  settlementEligible: boolean;
};

export type AmuxOwnerQueueDmSwitches = {
  /** TOMVERSE_AMUX_DM_ROUTING: the relay's routes answer 409 without it. */
  routing: boolean;
  /** The Decision Maker kill switch; null when it could not be read (fail closed). */
  killSwitch: boolean | null;
  resultReview: boolean; t2: boolean; settlement: boolean;
};

/** Only a read that failed once is worth sending again; a card too big stays too big. */
export const AMUX_OWNER_QUEUE_DM_RESENDABLE_HANDOFF = "evidence_unavailable";

const view = (source: AmuxOwnerQueueDmSource | null, state: AmuxOwnerQueueDmState,
  extra: Partial<Omit<AmuxOwnerQueueDmView, "source" | "state">> = {}): AmuxOwnerQueueDmView => ({
  source, state, reason: null, requestId: null, action: null, sourceId: null, ...extra,
});

/** A filed card: answered, taken, or waiting for the DM. */
const filed = (source: AmuxOwnerQueueDmSource, request: AmuxOwnerQueueDmRequestFact | null,
  sourceId: string) => request === null ? view(source, "card_filed", { sourceId }) :
  view(source, request.answered ? "proposed" : "asked", { requestId: request.requestId, sourceId });

/**
 * The one judgment the screen draws. A worker question comes first (the card
 * is answered before anything else), then a result review, then a T2 draft,
 * then the settlement of a stopped Task's escalation -- the same order in
 * which the settlement scan leaves a card to the other paths.
 */
export function amuxOwnerQueueDmView(facts: AmuxOwnerQueueDmFacts,
  switches: AmuxOwnerQueueDmSwitches): AmuxOwnerQueueDmView {
  // Every path stops here when the routing is off or the kill switch holds it.
  const held = !switches.routing ? "dm_routing" : switches.killSwitch === null ? "switches_unreadable" :
    switches.killSwitch ? "kill_switch" : null;
  const routingOff = (source: AmuxOwnerQueueDmSource, sourceId: string) =>
    view(source, "switch_off", { reason: held, sourceId });
  const { question, review, t2, settlement } = facts;
  if (question) {
    if (question.localCardId) return filed("question", question.request, question.id);
    if (held) return routingOff("question", question.id);
    const reason = !question.parked ? "question_not_parked" : !question.taskBlocked ? "task_not_blocked" :
      !question.bodyAvailable ? "result_body_gone" : !question.providerKnown ? "provider_unknown" : null;
    return reason ? view("question", "not_eligible", { reason, sourceId: question.id }) :
      view("question", "waiting_relay", { sourceId: question.id });
  }
  if (review) {
    if (review.localCardId) return filed("result_review", review.request, review.id);
    if (review.handoffReason) return view("result_review", "unfilable", { reason: review.handoffReason,
      sourceId: review.id,
      action: review.handoffReason === AMUX_OWNER_QUEUE_DM_RESENDABLE_HANDOFF ? "resend" : null });
    if (held) return routingOff("result_review", review.id);
    return switches.resultReview ? view("result_review", "waiting_relay", { sourceId: review.id }) :
      view("result_review", "switch_off", { reason: "result_review", sourceId: review.id });
  }
  if (t2) {
    if (t2.localCardId) return filed("t2_draft", t2.request, t2.workItemId);
    if (t2.unfilable) return view("t2_draft", "unfilable", { reason: "patch_does_not_fit", sourceId: t2.workItemId });
    if (held) return routingOff("t2_draft", t2.workItemId);
    return switches.t2 ? view("t2_draft", "waiting_relay", { sourceId: t2.workItemId }) :
      view("t2_draft", "switch_off", { reason: "t2_draft", sourceId: t2.workItemId });
  }
  if (settlement) {
    const sourceId = settlement.id;
    if (settlement.state === "cancelled") return view("settlement", "settled",
      { reason: settlement.cancelReason ?? "task_moved", sourceId });
    if (settlement.state !== "open") return view("settlement", "settled",
      { reason: settlement.state, sourceId, requestId: settlement.request?.requestId ?? null });
    if (settlement.localCardId) return filed("settlement", settlement.request, sourceId);
    if (settlement.handoffReason) return view("settlement", "unfilable", { reason: settlement.handoffReason,
      sourceId,
      action: settlement.handoffReason === AMUX_OWNER_QUEUE_DM_RESENDABLE_HANDOFF ? "resend" : null });
    if (held) return routingOff("settlement", sourceId);
    return switches.settlement || settlement.requested ? view("settlement", "waiting_relay", { sourceId }) :
      view("settlement", "switch_off", { reason: "settlement", sourceId, action: "request" });
  }
  if (facts.escalationId === null) return view(null, "none");
  const sourceId = facts.escalationId;
  if (!facts.settlementEligible) return view("settlement", "not_eligible",
    { reason: "settlement_not_eligible", sourceId });
  if (held) return routingOff("settlement", sourceId);
  return switches.settlement ? view("settlement", "waiting_relay", { sourceId }) :
    view("settlement", "switch_off", { reason: "settlement", sourceId, action: "request" });
}

/**
 * What the screen offers beside the view: the action, or the relay check in
 * its place when the relay is not calling -- a card sent again, or asked for,
 * would wait for a relay that is not there, and so would one already waiting.
 */
export function amuxOwnerQueueDmButton(dm: AmuxOwnerQueueDmView, relay: AmuxDmRelayView):
  "resend" | "request" | "relay_check" | null {
  const relayDown = relay.state !== "live";
  if (relayDown && (dm.action !== null || dm.state === "waiting_relay" || dm.state === "card_filed"))
    return "relay_check";
  return dm.action;
}

/** The owner asked for a settlement card from the owner queue (the sync files it while the switch is off). */
export const AMUX_OWNER_QUEUE_DM_REQUESTED_ACTION = "amux.dm_owner_settlement.requested";
/** The owner sent a card whose evidence could not be read once back to the relay. */
export const AMUX_OWNER_QUEUE_DM_RESENT_ACTION = "amux.owner_queue.dm_resent";
