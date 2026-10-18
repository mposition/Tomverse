//! Stage S2-2b3: delivering an operator-confirmed answer to the asking worker
//! (docs/policy/amux-decision-maker.md §2-7, §6, §7, §9), one per relay tick,
//! before the tick's question scan.
//!
//! In this order, each step only on the previous step's answer:
//!
//! 1. read the next confirmed answer (`deliveries/next`, a read): a
//!    confirmation or an edited confirmation with no delivery decision yet,
//!    after the walk's cursor; nothing while the kill switch is on;
//! 2. ask the local AMUX whether it could be delivered now
//!    (`/api/dm-relay/answers/check`, a read): the card still asks that
//!    question revision, nobody answered it, and the worker's lane takes
//!    automated input at a turn boundary. If not, the walk steps past it and
//!    nothing is written anywhere -- a question the operator answered directly
//!    is never decided at all;
//! 3. record the delivery decision (`deliveries`), and only on its recorded
//!    answer
//! 4. deliver (`/api/dm-relay/answers`): the local AMUX claims the answer
//!    record and, only on a claim this request won, sends the message under
//!    the message id `dm-answer:<request id>` and records it on the card;
//! 5. record the receipt (`deliveries/outcome`).
//!
//! §9, a delivery whose result is unclear: it is never sent again. The app
//! records `unknown`, the local AMUX pauses the worker's session and then
//! reads the message id's receipt, and a person resolves it in Admin.
//!
//! Stage S2-2b4: a delivery the local AMUX proved sent nothing after the
//! decision -- the operator's direct answer won the claim, the question or
//! §9's binding changed, the lane refused before typing, the local store
//! refused before claiming (`local_delivery`) -- is recorded as the decision's
//! third outcome, `not_sent` with its reason, and the walk carries on. What
//! does not prove that nothing was sent stays §9's unknown.
//!
//! Halts: a decision whose outcome is unknown, a receipt, `unknown` or
//! `not_sent` the app did not answer as recorded (refused or lost alike: the
//! decision is never offered again, so a missing outcome stays missing), a
//! session whose pause was not confirmed, and a reading the relay cannot
//! understand.
//!
//! Stage S2-2b4 also settles, at the relay's start, every decision a stopped
//! bridge left without an outcome (`settle_unsettled`): from the local AMUX's
//! own records of the request's message id and the question revision's answer
//! record, never by sending again.
//!
//! WHAT THIS MUST NEVER DO: send a message the app did not give out as a
//! person's confirmation, or send before the decision is recorded. The read
//! returns confirmations only, the decision route refuses anything else, and
//! the message's first line must be §7's header naming this card and this
//! judgment.

use serde_json::{json, Value};

use super::flow::{AppRoute, DmApp, DmLocal, LocalRoute};
use super::wire::{
    is_instance, is_ledger_identifier, is_request_id, read_app_answer, AppAnswer, HttpAnswer,
};

/// The local message id of a delivery: the app's `dmDeliveryMessageId()`
/// (lib/amux/decisionMakerDeliveryCore.ts).
pub const DM_DELIVERY_MESSAGE_ID_PREFIX: &str = "dm-answer:";

/// `DM_DELIVERY_MESSAGE_MAX_BYTES` of lib/amux/decisionMakerDeliveryCore.ts.
pub const DM_DELIVERY_MESSAGE_MAX_BYTES: usize = 16 * 1024;

/// §7's labels, `DM_DELIVERY_JUDGMENT_LABELS` of the same module.
pub const DM_DELIVERY_CONFIRMED_LABEL: &str = "operator-confirmed";
pub const DM_DELIVERY_EDITED_LABEL: &str = "operator-edited";

/// Where the walk over the confirmations stands (`after` of `deliveries/next`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeliveryCursor {
    pub judged_at_ms: i64,
    pub request_id: String,
}

impl DeliveryCursor {
    fn wire(cursor: Option<&DeliveryCursor>) -> Value {
        match cursor {
            Some(cursor) => {
                json!({"judged_at_ms": cursor.judged_at_ms, "request_id": cursor.request_id})
            }
            None => Value::Null,
        }
    }
}

/// A confirmed answer the app gave out to deliver.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Delivery {
    pub cursor: DeliveryCursor,
    pub card_id: String,
    pub question_revision: i64,
    /// §9's binding as the request recorded it at routing (`routing_binding`
    /// in `wire`): the asking worker, its AMUX session -- both the card's
    /// owner session -- and the card's newest attempt. The local AMUX claims
    /// and sends only while the card is still these.
    pub worker: String,
    pub session: String,
    pub session_attempt: i64,
    pub message: String,
}

impl Delivery {
    fn request_id(&self) -> &str {
        &self.cursor.request_id
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NextDelivery {
    None,
    Undeliverable(DeliveryCursor),
    Ready(Delivery),
}

fn cursor_of(delivery: &Value) -> Option<DeliveryCursor> {
    let request_id = delivery.get("request_id")?.as_str()?;
    let judged_at_ms = delivery.get("judged_at_ms")?.as_i64()?;
    (is_request_id(request_id) && judged_at_ms >= 0).then(|| DeliveryCursor {
        judged_at_ms,
        request_id: request_id.to_owned(),
    })
}

/// True when the message is §7's for this delivery: within the cap, and its
/// first line `[Decision Maker <instance> (<model>) 제안, <label>, re <card>]`
/// with this instance, this judgment's label and this card.
pub fn message_is_confirmed_answer(
    message: &str,
    instance: &str,
    label: &str,
    card_id: &str,
) -> bool {
    let first = message.split('\n').next().unwrap_or_default();
    message.len() <= DM_DELIVERY_MESSAGE_MAX_BYTES
        && message.len() > first.len()
        && first.starts_with(&format!("[Decision Maker {instance} ("))
        && first.ends_with(&format!(") 제안, {label}, re {card_id}]"))
}

/// The read's answer, strictly: `None` when it is not one the route gives.
pub fn parse_next_delivery(value: &Value) -> Option<NextDelivery> {
    match value.get("status")?.as_str()? {
        "none" => value
            .get("delivery")?
            .is_null()
            .then_some(NextDelivery::None),
        "undeliverable" => cursor_of(value.get("delivery")?).map(NextDelivery::Undeliverable),
        "ready" => {
            let delivery = value.get("delivery")?;
            let cursor = cursor_of(delivery)?;
            let label = match delivery.get("judgment_kind")?.as_str()? {
                "confirm" => DM_DELIVERY_CONFIRMED_LABEL,
                "edit_confirm" => DM_DELIVERY_EDITED_LABEL,
                _ => return None,
            };
            let instance = delivery.get("instance")?.as_str()?;
            let card_id = delivery.get("card_id")?.as_str()?;
            let question_revision = delivery.get("question_revision")?.as_i64()?;
            let worker = delivery.get("worker")?.as_str()?;
            let session = delivery.get("session")?.as_str()?;
            let session_attempt = delivery.get("session_attempt")?.as_i64()?;
            let message_id = delivery.get("message_id")?.as_str()?;
            let message = delivery.get("message")?.as_str()?;
            let ok = is_instance(instance)
                && crate::local_card::valid_local_card_id(card_id)
                && question_revision >= 1
                && is_ledger_identifier(worker)
                && is_ledger_identifier(session)
                && session_attempt >= 0
                && message_id == format!("{DM_DELIVERY_MESSAGE_ID_PREFIX}{}", cursor.request_id)
                && message_is_confirmed_answer(message, instance, label, card_id);
            ok.then(|| {
                NextDelivery::Ready(Delivery {
                    cursor,
                    card_id: card_id.to_owned(),
                    question_revision,
                    worker: worker.to_owned(),
                    session: session.to_owned(),
                    session_attempt,
                    message: message.to_owned(),
                })
            })
        }
        _ => None,
    }
}

/// How the walk's cursor moves after a run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CursorMove {
    /// Read again from the same place: the read itself did not answer.
    Keep,
    /// Nothing after the cursor: start again from the beginning.
    Reset,
    /// Past this confirmation.
    Advance(DeliveryCursor),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeliveryRun {
    pub code: &'static str,
    pub cursor: CursorMove,
    /// The card and question revision the run was about, for the log line.
    pub question: Option<(String, i64)>,
    pub delivered: bool,
    pub halt: Option<&'static str>,
}

impl DeliveryRun {
    fn read(code: &'static str, cursor: CursorMove) -> Self {
        Self {
            code,
            cursor,
            question: None,
            delivered: false,
            halt: None,
        }
    }

    fn about(delivery: &Delivery, code: &'static str) -> Self {
        Self {
            code,
            cursor: CursorMove::Advance(delivery.cursor.clone()),
            question: Some((delivery.card_id.clone(), delivery.question_revision)),
            delivered: false,
            halt: None,
        }
    }

    fn halted(mut self, cause: &'static str) -> Self {
        self.halt.get_or_insert(cause);
        self
    }

    /// An outcome the app did not record: the run's log line names it, and
    /// the relay stops.
    fn missing(mut self, cause: &'static str) -> Self {
        self.code = cause;
        self.halted(cause)
    }
}

async fn app_write<A: DmApp + ?Sized>(app: &A, route: AppRoute, body: Value) -> AppAnswer {
    read_app_answer(&app.post(route, body).await, route.envelope())
}

/// The local answer's `outcome`, when it answered 200 with one.
fn local_outcome(answer: &HttpAnswer) -> Option<(String, Value)> {
    let HttpAnswer::Answered { status: 200, body } = answer else {
        return None;
    };
    let value = serde_json::from_slice::<Value>(body).ok()?;
    let outcome = value.get("outcome")?.as_str()?.to_owned();
    Some((outcome, value))
}

/// `DM_DELIVERY_NOT_SENT_REASONS` of lib/amux/decisionMakerJudgmentCore.ts:
/// why a decided delivery sent nothing (stage S2-2b4), in its order.
pub const DM_DELIVERY_NOT_SENT_REASONS: [&str; 6] = [
    "answered_by_operator",
    "question_changed",
    "binding_changed",
    "lane_refused",
    "send_refused",
    "local_refused",
];

/// What the local AMUX's answer to the one delivery call proves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalDelivery {
    /// Verified delivered to the worker, and whether the card record was appended.
    Delivered { card_recorded: bool },
    /// Proved that nothing was typed into the worker's lane, with the reason
    /// the app records (`DM_DELIVERY_NOT_SENT_REASONS`).
    NotSent(&'static str),
    /// Anything else: §9's unknown.
    Unclear,
}

/// The reason a lane refusal of the local AMUX's `deliverable` gate names (the
/// session layer's own checks: `FleetLane::deliverable`), each before anything
/// is typed.
fn lane_refusal(reason: &str) -> bool {
    matches!(
        reason,
        "invalid_session"
            | "session_missing"
            | "archived"
            | "paused"
            | "isolated"
            | "not_running"
            | "blocked"
            | "busy"
    )
}

/// Stage S2-2b4: reads the local AMUX's answer to the one delivery call
/// (vendor/amux/crates/amux-server/src/api/dm_relay.rs, `deliver`). Only an
/// answer that proves nothing was typed is `NotSent`: a refusal before the
/// claim (the question answered by the operator or changed, the binding
/// changed, the lane's gate, the local store unreadable), a claim refused or
/// rolled back, a claim lost to the operator's record, and a send the lane
/// refused before typing. An answer record this request may hold -- `answered`
/// by `dm_confirmed`, or `not_deliverable` because of one -- and a reason the
/// relay does not know prove nothing, and are §9's unknown.
pub fn local_delivery(answer: &HttpAnswer) -> LocalDelivery {
    let Some((outcome, value)) = local_outcome(answer) else {
        return LocalDelivery::Unclear;
    };
    let reason = value.get("reason").and_then(Value::as_str).unwrap_or("");
    let not_sent = match outcome.as_str() {
        "delivered" => {
            return LocalDelivery::Delivered {
                card_recorded: value.get("card_recorded").and_then(Value::as_bool) == Some(true),
            }
        }
        "answered" => (value.get("source").and_then(Value::as_str) == Some("operator")
            && value.get("same_request").and_then(Value::as_bool) == Some(false))
        .then_some("answered_by_operator"),
        "not_deliverable" => match reason {
            "answered_by_operator" => Some("answered_by_operator"),
            "question_changed" => Some("question_changed"),
            "owner_changed" | "attempt_changed" => Some("binding_changed"),
            "store_unreadable" => Some("local_refused"),
            lane if lane_refusal(lane) => Some("lane_refused"),
            _ => None,
        },
        // The binding read again in the claim's own transaction: nothing claimed.
        "binding_changed" => Some(if reason == "question_changed" {
            "question_changed"
        } else {
            "binding_changed"
        }),
        "claim_refused" => match reason {
            "card_missing" | "not_needs_you" | "stale_revision" => Some("question_changed"),
            "invalid_request_id" | "missing_actor" => Some("local_refused"),
            _ => None,
        },
        "not_sent" => match reason {
            // `lane_send_verdict`: a refusal types nothing, but this request's
            // claim stays, so it is not the lane refusal before the claim.
            "send_refused" => Some("send_refused"),
            // The claim's transaction rolled back: no claim, nothing sent.
            "claim_store_failed" => Some("local_refused"),
            _ => None,
        },
        _ => None,
    };
    not_sent.map_or(LocalDelivery::Unclear, LocalDelivery::NotSent)
}

/// One step of the walk: at most one confirmed answer carried to a recorded
/// receipt, a recorded unknown, a recorded not-sent outcome, or a halt.
pub async fn deliver_next<A, L>(app: &A, local: &L, cursor: Option<&DeliveryCursor>) -> DeliveryRun
where
    A: DmApp + ?Sized,
    L: DmLocal + ?Sized,
{
    // 1. The next confirmed answer. A read: anything short of an answer is
    // asked again next tick from the same place.
    let next = match app_write(
        app,
        AppRoute::DeliveriesNext,
        json!({"after": DeliveryCursor::wire(cursor)}),
    )
    .await
    {
        AppAnswer::Done(value) => match parse_next_delivery(&value) {
            Some(next) => next,
            None => {
                return DeliveryRun::read("delivery_read_unreadable", CursorMove::Keep)
                    .halted("delivery_read_unreadable")
            }
        },
        // The kill switch, the routes closed, the bridge refused.
        AppAnswer::Refused(_) => {
            return DeliveryRun::read("delivery_read_refused", CursorMove::Keep)
        }
        AppAnswer::Unknown => return DeliveryRun::read("delivery_read_unknown", CursorMove::Keep),
    };
    let delivery = match next {
        NextDelivery::None => return DeliveryRun::read("no_delivery", CursorMove::Reset),
        NextDelivery::Undeliverable(cursor) => {
            return DeliveryRun::read("delivery_answer_erased", CursorMove::Advance(cursor))
        }
        NextDelivery::Ready(delivery) => delivery,
    };

    // 2. Could it be delivered now? A read; a no, or no answer, steps past it
    // with nothing written, and the walk comes back to it.
    let check = local
        .post(
            LocalRoute::AnswerCheck,
            json!({"card_id": delivery.card_id, "question_revision": delivery.question_revision,
                "worker": delivery.worker, "session": delivery.session,
                "session_attempt": delivery.session_attempt}),
        )
        .await;
    let deliverable = match &check {
        HttpAnswer::Answered { status: 200, body } => serde_json::from_slice::<Value>(body)
            .ok()
            .and_then(|value| value.get("deliverable").and_then(Value::as_bool)),
        _ => None,
    };
    match deliverable {
        Some(true) => {}
        Some(false) => return DeliveryRun::about(&delivery, "delivery_not_deliverable_now"),
        None => return DeliveryRun::about(&delivery, "delivery_check_unknown"),
    }

    // 3. The decision, once (§9). Unknown: it may be recorded, and nothing
    // is sent; a person reads the request in Admin.
    match app_write(
        app,
        AppRoute::Deliveries,
        json!({"request_id": delivery.request_id()}),
    )
    .await
    {
        AppAnswer::Done(_) => {}
        AppAnswer::Refused(_) => return DeliveryRun::about(&delivery, "delivery_decision_refused"),
        AppAnswer::Unknown => {
            return DeliveryRun::about(&delivery, "delivery_decision_outcome_unknown")
                .halted("delivery_decision_outcome_unknown")
        }
    }

    // 4. The delivery: called once, never again, whatever comes back. The
    // local AMUX holds the card to the binding in the claim's own transaction.
    let answer = local
        .post(
            LocalRoute::Answers,
            json!({"card_id": delivery.card_id, "question_revision": delivery.question_revision,
                "request_id": delivery.request_id(), "worker": delivery.worker,
                "session": delivery.session, "session_attempt": delivery.session_attempt,
                "message": delivery.message}),
        )
        .await;
    let card_recorded = match local_delivery(&answer) {
        LocalDelivery::Delivered { card_recorded } => card_recorded,
        // Stage S2-2b4: nothing was sent, and the local AMUX says why. The
        // decision's outcome is `not_sent` with that reason (§2-7: the answer
        // that lost is refused and shown to the operator); the relay carries
        // on unless the app did not record it.
        LocalDelivery::NotSent(reason) => {
            let run = DeliveryRun::about(&delivery, "delivery_not_sent");
            return match app_write(
                app,
                AppRoute::DeliveryOutcome,
                json!({"request_id": delivery.request_id(), "outcome": "not_sent", "reason": reason}),
            )
            .await
            {
                AppAnswer::Done(_) => run,
                AppAnswer::Refused(_) => run.missing("delivery_not_sent_record_refused"),
                AppAnswer::Unknown => run.missing("delivery_not_sent_outcome_unknown"),
            };
        }
        // Unclear (§9): never sent again.
        LocalDelivery::Unclear => return record_unknown(app, local, &delivery).await,
    };

    // 5. The receipt. Only a recorded answer is a receipt.
    let mut run = DeliveryRun::about(&delivery, "delivered");
    run.delivered = true;
    if let Some(missing) = record_outcome(
        app,
        &delivery,
        "receipt",
        "delivery_receipt_record_refused",
        "delivery_receipt_outcome_unknown",
    )
    .await
    {
        return run.missing(missing);
    }
    // §7's card record: "카드 기록도 같은 표시를 쓴다". The answer reached the
    // worker, so the receipt stands; a card the local AMUX could not append
    // to would stay without its record, since a decided request is never
    // offered again -- the relay stops and names it (review
    // r-20261018-065705-65cb2a, finding 3).
    if !card_recorded {
        run = run.missing("delivery_card_record_failed");
    }
    run
}

/// Records the delivery's outcome; `None` only when the app answered that it
/// recorded it. A refusal is not a record -- a busy database (503) or the
/// routes closed (409) wrote nothing -- and the decision is never offered
/// again, so a missing outcome would stay missing: the caller stops the relay
/// and names the record (review r-20261018-062643-057a27, finding 2).
async fn record_outcome<A: DmApp + ?Sized>(
    app: &A,
    delivery: &Delivery,
    outcome: &str,
    refused: &'static str,
    unknown: &'static str,
) -> Option<&'static str> {
    match app_write(
        app,
        AppRoute::DeliveryOutcome,
        json!({"request_id": delivery.request_id(), "outcome": outcome}),
    )
    .await
    {
        AppAnswer::Done(_) => None,
        AppAnswer::Refused(_) => Some(refused),
        AppAnswer::Unknown => Some(unknown),
    }
}

/// §9: "그 요청을 delivery_unknown으로 두고, 그 worker 세션을 일시 정지(AMUX
/// pause)한 뒤 로컬 메시지 멱등 키로 전달 영수증을 조회한다". The app's record
/// first, then the pause and the receipt in one local call. An unknown the app
/// did not record, and a session whose pause was not confirmed, stop the
/// relay; the session is paused either way.
async fn record_unknown<A, L>(app: &A, local: &L, delivery: &Delivery) -> DeliveryRun
where
    A: DmApp + ?Sized,
    L: DmLocal + ?Sized,
{
    let mut run = DeliveryRun::about(delivery, "delivery_unknown");
    if let Some(missing) = record_outcome(
        app,
        delivery,
        "unknown",
        "delivery_unknown_record_refused",
        "delivery_unknown_outcome_unknown",
    )
    .await
    {
        run = run.missing(missing);
    }
    let paused = local
        .post(
            LocalRoute::AnswerUnknown,
            json!({"card_id": delivery.card_id, "question_revision": delivery.question_revision,
                "request_id": delivery.request_id(), "session": delivery.session}),
        )
        .await;
    let confirmed = matches!(&paused, HttpAnswer::Answered { status: 200, body }
        if serde_json::from_slice::<Value>(body).ok().and_then(|value| value.get("paused").and_then(Value::as_bool)) == Some(true));
    if !confirmed {
        run = run.halted("delivery_unknown_pause_unconfirmed");
    }
    run
}

// ---------------------------------------------------------------------------
// Stage S2-2b4: a decision a stopped bridge left without an outcome
// ---------------------------------------------------------------------------

/// A decision with no outcome, as `deliveries/unsettled` gives it: §9's
/// binding, never an answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unsettled {
    pub request_id: String,
    pub decided_at_ms: i64,
    pub card_id: String,
    pub question_revision: i64,
    pub worker: String,
    pub session: String,
    pub session_attempt: i64,
}

/// How far the settling of one unsettled decision got.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Settle {
    /// No decision is without an outcome: the relay's start is settled.
    Nothing,
    /// One decision's outcome was recorded (or the relay halted on it).
    Settled,
    /// Nothing could be read or decided now; nothing was written. Asked again
    /// at the next tick, before any delivery.
    Retry,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettleRun {
    pub settle: Settle,
    pub code: &'static str,
    pub question: Option<(String, i64)>,
    pub halt: Option<&'static str>,
}

impl SettleRun {
    fn of(settle: Settle, code: &'static str) -> Self {
        Self {
            settle,
            code,
            question: None,
            halt: None,
        }
    }

    fn from_delivery(run: DeliveryRun) -> Self {
        Self {
            settle: Settle::Settled,
            code: run.code,
            question: run.question,
            halt: run.halt,
        }
    }
}

/// The unsettled read's answer, strictly: `Some(None)` when there is none,
/// `None` when it is not one the route gives.
pub fn parse_unsettled(value: &Value) -> Option<Option<Unsettled>> {
    match value.get("status")?.as_str()? {
        "none" => value.get("delivery")?.is_null().then_some(None),
        "unsettled" => {
            let delivery = value.get("delivery")?;
            let request_id = delivery.get("request_id")?.as_str()?;
            let decided_at_ms = delivery.get("decided_at_ms")?.as_i64()?;
            let card_id = delivery.get("card_id")?.as_str()?;
            let question_revision = delivery.get("question_revision")?.as_i64()?;
            let worker = delivery.get("worker")?.as_str()?;
            let session = delivery.get("session")?.as_str()?;
            let session_attempt = delivery.get("session_attempt")?.as_i64()?;
            let message_id = delivery.get("message_id")?.as_str()?;
            let ok = is_request_id(request_id)
                && decided_at_ms >= 0
                && crate::local_card::valid_local_card_id(card_id)
                && question_revision >= 1
                && is_ledger_identifier(worker)
                && is_ledger_identifier(session)
                && session_attempt >= 0
                && message_id == format!("{DM_DELIVERY_MESSAGE_ID_PREFIX}{request_id}");
            ok.then(|| {
                Some(Unsettled {
                    request_id: request_id.to_owned(),
                    decided_at_ms,
                    card_id: card_id.to_owned(),
                    question_revision,
                    worker: worker.to_owned(),
                    session: session.to_owned(),
                    session_attempt,
                })
            })
        }
        _ => None,
    }
}

/// What the local AMUX's records prove of one decided delivery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Recovered {
    /// The message id's reservation was acknowledged: delivered.
    Receipt,
    /// Something may have been typed, or may still be: §9's unknown.
    Unknown,
    /// Nothing was sent and nothing can be, with the reason the app records.
    NotSent(&'static str),
}

/// Stage S2-2b4: reads `/api/dm-relay/answers/receipt` -- the reservation of
/// `dm-answer:<request id>` in the session's send ledger (`accepted`,
/// `pending` or `none`) and the question revision's answer record -- into
/// what it proves. The send reserves the message id only after this request
/// won the claim, and acknowledges it only on a verified delivery; the record
/// is one per question revision, never removed, and a claim needs the
/// revision to be the card's current one. So:
///
/// - acknowledged: delivered;
/// - reserved and not acknowledged: typed perhaps -- unknown;
/// - never reserved, and the operator holds the record: this answer's claim
///   could never win -- not sent, `answered_by_operator`;
/// - never reserved, no record, and the revision no longer current: nothing
///   can claim it any more -- not sent, `question_changed`;
/// - never reserved otherwise -- the claim this request holds, or none while
///   the revision is still open: the call may still be on its way, or the
///   send refused -- unknown, and the session is paused before anything else.
///
/// `None` when the answer is not one the route gives.
pub fn recovered_outcome(value: &Value) -> Option<Recovered> {
    let reservation = value.get("reservation")?.as_str()?;
    let source = match value.get("answer_source")? {
        Value::Null => None,
        Value::String(source) if source == "operator" || source == "dm_confirmed" => {
            Some(source.as_str())
        }
        _ => return None,
    };
    let claimed = value.get("claimed_by_request")?.as_bool()?;
    let current = value.get("question_current")?.as_bool()?;
    match reservation {
        "accepted" => Some(Recovered::Receipt),
        "pending" => Some(Recovered::Unknown),
        "none" => Some(match (source, claimed, current) {
            (Some("operator"), false, _) => Recovered::NotSent("answered_by_operator"),
            (None, false, false) => Recovered::NotSent("question_changed"),
            _ => Recovered::Unknown,
        }),
        _ => None,
    }
}

/// Stage S2-2b4 (§9, principle 7): settles the oldest delivery decision with
/// no outcome -- what a bridge that stopped between a decision and its outcome
/// left behind -- from the local AMUX's own records, and never by sending
/// again: the delivery route is not called. Run at the relay's start, one
/// decision per tick, before any delivery, until none is left.
///
/// The outcome is recorded as the walk records one: a receipt, `not_sent` with
/// its reason, or `unknown` with the session paused first (`record_unknown`).
/// A receipt found this way stops the relay all the same: the card record of
/// §7 cannot be confirmed from here, and a decided request is never offered
/// again, so a person checks the card (`delivery_recovered_card_record_unconfirmed`).
/// An outcome the app did not record stops it, as in the walk. Nothing
/// readable -- the app's routes closed or lost, the local records unreadable
/// -- writes nothing and is asked again.
pub async fn settle_unsettled<A, L>(app: &A, local: &L) -> SettleRun
where
    A: DmApp + ?Sized,
    L: DmLocal + ?Sized,
{
    let unsettled = match app_write(app, AppRoute::DeliveriesUnsettled, json!({})).await {
        AppAnswer::Done(value) => match parse_unsettled(&value) {
            Some(Some(unsettled)) => unsettled,
            Some(None) => return SettleRun::of(Settle::Nothing, "no_unsettled_delivery"),
            None => {
                let mut run = SettleRun::of(Settle::Retry, "unsettled_read_unreadable");
                run.halt = Some("unsettled_read_unreadable");
                return run;
            }
        },
        AppAnswer::Refused(_) => return SettleRun::of(Settle::Retry, "unsettled_read_refused"),
        AppAnswer::Unknown => return SettleRun::of(Settle::Retry, "unsettled_read_unknown"),
    };
    let records = local
        .post(
            LocalRoute::AnswerReceipt,
            json!({"card_id": unsettled.card_id, "question_revision": unsettled.question_revision,
                "request_id": unsettled.request_id, "session": unsettled.session}),
        )
        .await;
    let recovered = match &records {
        HttpAnswer::Answered { status: 200, body } => serde_json::from_slice::<Value>(body)
            .ok()
            .and_then(|value| recovered_outcome(&value)),
        _ => None,
    };
    let delivery = Delivery {
        cursor: DeliveryCursor {
            judged_at_ms: unsettled.decided_at_ms,
            request_id: unsettled.request_id.clone(),
        },
        card_id: unsettled.card_id.clone(),
        question_revision: unsettled.question_revision,
        worker: unsettled.worker.clone(),
        session: unsettled.session.clone(),
        session_attempt: unsettled.session_attempt,
        // Nothing is sent again: the delivery carries no message.
        message: String::new(),
    };
    let Some(recovered) = recovered else {
        let mut run = SettleRun::of(Settle::Retry, "unsettled_local_unreadable");
        run.question = Some((unsettled.card_id, unsettled.question_revision));
        return run;
    };
    match recovered {
        Recovered::Receipt => {
            let run = DeliveryRun::about(&delivery, "delivery_recovered_receipt");
            let run = match record_outcome(
                app,
                &delivery,
                "receipt",
                "delivery_receipt_record_refused",
                "delivery_receipt_outcome_unknown",
            )
            .await
            {
                Some(missing) => run.missing(missing),
                None => run.halted("delivery_recovered_card_record_unconfirmed"),
            };
            SettleRun::from_delivery(run)
        }
        Recovered::NotSent(reason) => {
            let run = DeliveryRun::about(&delivery, "delivery_recovered_not_sent");
            let run = match app_write(
                app,
                AppRoute::DeliveryOutcome,
                json!({"request_id": delivery.request_id(), "outcome": "not_sent", "reason": reason}),
            )
            .await
            {
                AppAnswer::Done(_) => run,
                AppAnswer::Refused(_) => run.missing("delivery_not_sent_record_refused"),
                AppAnswer::Unknown => run.missing("delivery_not_sent_outcome_unknown"),
            };
            SettleRun::from_delivery(run)
        }
        Recovered::Unknown => SettleRun::from_delivery(record_unknown(app, local, &delivery).await),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dm_relay::flow::tests::{answered, recorded, refused, FakeApp, FakeLocal};

    // -----------------------------------------------------------------------
    // Stage S2-2b4: settling a decision a stopped bridge left without an outcome
    // -----------------------------------------------------------------------

    fn unsettled() -> HttpAnswer {
        answered(
            200,
            json!({"found": true, "status": "unsettled", "delivery": {
                "request_id": REQUEST, "decided_at_ms": 9, "card_id": "AMUX-12", "question_revision": 3,
                "worker": SESSION, "session": SESSION, "session_attempt": 2,
                "message_id": format!("dm-answer:{REQUEST}")}}),
        )
    }

    fn held(reservation: &str, source: Value, claimed: bool, current: bool) -> HttpAnswer {
        answered(
            200,
            json!({"reservation": reservation, "answer_source": source,
                "claimed_by_request": claimed, "question_current": current}),
        )
    }

    /// §9 and principle 7: the local AMUX's own records settle the decision --
    /// the receipt of `dm-answer:<request id>` and the question revision's
    /// answer record -- and nothing is ever sent again.
    #[tokio::test]
    async fn an_unsettled_decision_is_settled_from_the_local_records_and_never_sent_again() {
        for (local_record, outcome, reason, paused, halt) in [
            // Delivered: the receipt stands; the card record cannot be confirmed, so a person checks it.
            (
                held("accepted", json!("dm_confirmed"), true, false),
                "receipt",
                None,
                false,
                Some("delivery_recovered_card_record_unconfirmed"),
            ),
            // Reserved and not acknowledged: something may have been typed.
            (
                held("pending", json!("dm_confirmed"), true, true),
                "unknown",
                None,
                true,
                None,
            ),
            // The operator's record holds the revision: this answer's claim could never win.
            (
                held("none", json!("operator"), false, true),
                "not_sent",
                Some("answered_by_operator"),
                false,
                None,
            ),
            // No record and the question moved on: nothing can claim it any more.
            (
                held("none", Value::Null, false, false),
                "not_sent",
                Some("question_changed"),
                false,
                None,
            ),
            // No record and the question still open: the call may never have been made, or may
            // still claim and send -- unknown, and the session is paused.
            (
                held("none", Value::Null, false, true),
                "unknown",
                None,
                true,
                None,
            ),
            // Claimed and never reserved: a send refused, or one still on its way -- unknown.
            (
                held("none", json!("dm_confirmed"), true, true),
                "unknown",
                None,
                true,
                None,
            ),
        ] {
            let app = FakeApp::with(vec![
                (AppRoute::DeliveriesUnsettled, unsettled()),
                (AppRoute::DeliveryOutcome, recorded()),
            ]);
            let local = local_with(vec![
                (LocalRoute::AnswerReceipt, local_record.clone()),
                (
                    LocalRoute::AnswerUnknown,
                    answered(200, json!({"paused": true, "receipt": "not_accepted"})),
                ),
            ]);
            let run = settle_unsettled(&app, &local).await;
            let label = format!("{local_record:?}");
            assert_eq!(run.settle, Settle::Settled, "{label}");
            assert_eq!(run.halt, halt, "{label}");
            assert_eq!(run.question, Some(("AMUX-12".into(), 3)), "{label}");
            let mut expected = json!({"request_id": REQUEST, "outcome": outcome});
            if let Some(reason) = reason {
                expected["reason"] = json!(reason);
            }
            assert_eq!(app.body(AppRoute::DeliveryOutcome), expected, "{label}");
            assert_eq!(app.body(AppRoute::DeliveriesUnsettled), json!({}));
            // The look-up names the request's message id through its request, card and session.
            assert_eq!(
                local.writes.lock().unwrap()[0].1,
                json!({"card_id": "AMUX-12", "question_revision": 3, "request_id": REQUEST, "session": SESSION}),
                "{label}"
            );
            let routes = local_routes(&local);
            assert!(
                !routes.contains(&LocalRoute::Answers)
                    && !routes.contains(&LocalRoute::AnswerCheck),
                "never sent again: {label}"
            );
            assert_eq!(
                routes.contains(&LocalRoute::AnswerUnknown),
                paused,
                "{label}"
            );
        }
    }

    #[tokio::test]
    async fn nothing_unsettled_or_nothing_readable_writes_nothing() {
        // None left: the start is settled.
        let app = FakeApp::with(vec![(
            AppRoute::DeliveriesUnsettled,
            answered(
                200,
                json!({"found": true, "status": "none", "delivery": null}),
            ),
        )]);
        let local = FakeLocal::default();
        let run = settle_unsettled(&app, &local).await;
        assert_eq!((run.settle, run.halt), (Settle::Nothing, None));
        assert!(local_routes(&local).is_empty());
        // The app closed or lost, or the local records unreadable: asked again, nothing written.
        for (read, local_record) in [
            (refused(409, "found", "dm_routing_disabled"), None),
            (HttpAnswer::Lost, None),
            (unsettled(), Some(HttpAnswer::Lost)),
            (unsettled(), Some(answered(500, json!({"error": "x"})))),
            (
                unsettled(),
                Some(held("unreadable", Value::Null, false, true)),
            ),
            (
                unsettled(),
                Some(answered(200, json!({"reservation": "none"}))),
            ),
        ] {
            let app = FakeApp::with(vec![(AppRoute::DeliveriesUnsettled, read)]);
            let local = match local_record {
                Some(answer) => local_with(vec![(LocalRoute::AnswerReceipt, answer)]),
                None => FakeLocal::default(),
            };
            let run = settle_unsettled(&app, &local).await;
            assert_eq!((run.settle, run.halt), (Settle::Retry, None));
            assert_eq!(app.routes(), vec![AppRoute::DeliveriesUnsettled]);
            assert!(!local_routes(&local).contains(&LocalRoute::AnswerUnknown));
        }
        // A read the relay cannot understand stops it.
        let app = FakeApp::with(vec![(
            AppRoute::DeliveriesUnsettled,
            answered(
                200,
                json!({"found": true, "status": "unsettled", "delivery": {"request_id": "x"}}),
            ),
        )]);
        let run = settle_unsettled(&app, &FakeLocal::default()).await;
        assert_eq!(run.halt, Some("unsettled_read_unreadable"));
    }

    #[tokio::test]
    async fn an_outcome_the_app_did_not_record_while_settling_stops_the_relay() {
        for (local_record, outcome, halt) in [
            (
                held("none", json!("operator"), false, true),
                refused(503, "recorded", "amux_database_busy"),
                "delivery_not_sent_record_refused",
            ),
            (
                held("accepted", json!("dm_confirmed"), true, false),
                HttpAnswer::Lost,
                "delivery_receipt_outcome_unknown",
            ),
            (
                held("pending", json!("dm_confirmed"), true, true),
                refused(503, "recorded", "amux_database_busy"),
                "delivery_unknown_record_refused",
            ),
        ] {
            let app = FakeApp::with(vec![
                (AppRoute::DeliveriesUnsettled, unsettled()),
                (AppRoute::DeliveryOutcome, outcome),
            ]);
            let local = local_with(vec![
                (LocalRoute::AnswerReceipt, local_record),
                (
                    LocalRoute::AnswerUnknown,
                    answered(200, json!({"paused": true, "receipt": "not_accepted"})),
                ),
            ]);
            let run = settle_unsettled(&app, &local).await;
            assert_eq!(run.halt, Some(halt));
        }
    }

    const REQUEST: &str = "0b0e3b50-0f7e-4b8a-8f39-2d2b9f6c1a10";
    const SESSION: &str = "claude-impl";

    fn message(card: &str, label: &str) -> String {
        format!(
            "[Decision Maker decision-maker-openai (GPT-6 Astra) 제안, {label}, re {card}]\n선택지: sqlite\n\n승인 계약의 승인이 아니다. 사람 승인이 필요한 게이트는 따로 요청한다."
        )
    }

    fn ready_with(kind: &str, label: &str) -> HttpAnswer {
        answered(
            200,
            json!({"found": true, "status": "ready", "delivery": {
                "request_id": REQUEST, "judged_at_ms": 7, "judgment_kind": kind,
                "instance": "decision-maker-openai", "card_id": "AMUX-12", "question_revision": 3,
                "worker": SESSION, "session": SESSION, "session_attempt": 2,
                "message_id": format!("dm-answer:{REQUEST}"),
                "message": message("AMUX-12", label)}}),
        )
    }

    fn ready() -> HttpAnswer {
        ready_with("confirm", DM_DELIVERY_CONFIRMED_LABEL)
    }

    fn local_with(script: Vec<(LocalRoute, HttpAnswer)>) -> FakeLocal {
        let local = FakeLocal::default();
        for (route, answer) in script {
            local
                .answers
                .lock()
                .unwrap()
                .entry(route.path())
                .or_default()
                .push_back(answer);
        }
        local
    }

    fn deliverable(yes: bool) -> HttpAnswer {
        if yes {
            answered(200, json!({"deliverable": true}))
        } else {
            answered(200, json!({"deliverable": false, "reason": "busy"}))
        }
    }

    fn cursor() -> DeliveryCursor {
        DeliveryCursor {
            judged_at_ms: 7,
            request_id: REQUEST.into(),
        }
    }

    fn local_routes(local: &FakeLocal) -> Vec<LocalRoute> {
        local.routes()
    }

    #[tokio::test]
    async fn a_confirmed_answer_is_checked_decided_delivered_and_its_receipt_recorded() {
        let app = FakeApp::with(vec![
            (AppRoute::DeliveriesNext, ready()),
            (AppRoute::Deliveries, recorded()),
            (AppRoute::DeliveryOutcome, recorded()),
        ]);
        let local = local_with(vec![
            (LocalRoute::AnswerCheck, deliverable(true)),
            (
                LocalRoute::Answers,
                answered(200, json!({"outcome": "delivered", "card_recorded": true})),
            ),
        ]);
        let run = deliver_next(&app, &local, None).await;
        assert_eq!(run.code, "delivered");
        assert!(run.delivered && run.halt.is_none());
        assert_eq!(run.cursor, CursorMove::Advance(cursor()));
        assert_eq!(
            app.routes(),
            vec![
                AppRoute::DeliveriesNext,
                AppRoute::Deliveries,
                AppRoute::DeliveryOutcome
            ]
        );
        assert_eq!(app.body(AppRoute::DeliveriesNext), json!({"after": null}));
        assert_eq!(
            app.body(AppRoute::Deliveries),
            json!({"request_id": REQUEST})
        );
        assert_eq!(
            app.body(AppRoute::DeliveryOutcome),
            json!({"request_id": REQUEST, "outcome": "receipt"})
        );
        assert_eq!(
            local_routes(&local),
            vec![LocalRoute::AnswerCheck, LocalRoute::Answers]
        );
        // The message goes as the app composed it, to the asking worker's
        // session, with §9's binding the local AMUX holds the card to (review
        // r-20261018-065705-65cb2a, finding 2): the check and the claim both
        // name the worker, its session and the card's attempt.
        let writes = local.writes.lock().unwrap().clone();
        assert_eq!(
            writes[0].1,
            json!({"card_id": "AMUX-12", "question_revision": 3, "worker": SESSION,
                "session": SESSION, "session_attempt": 2})
        );
        assert_eq!(
            writes[1].1,
            json!({"card_id": "AMUX-12", "question_revision": 3, "request_id": REQUEST,
                "worker": SESSION, "session": SESSION, "session_attempt": 2,
                "message": message("AMUX-12", DM_DELIVERY_CONFIRMED_LABEL)})
        );
    }

    /// Review r-20261018-065705-65cb2a, finding 3: a delivered answer whose
    /// card record the local AMUX could not append is delivered -- its receipt
    /// is recorded -- but the card lacks §7's record, and the decided request
    /// is never offered again, so the relay stops and names it.
    #[tokio::test]
    async fn a_delivery_whose_card_record_failed_records_its_receipt_and_stops_the_relay() {
        for answer in [
            json!({"outcome": "delivered", "card_recorded": false}),
            json!({"outcome": "delivered"}),
        ] {
            let app = FakeApp::with(vec![
                (AppRoute::DeliveriesNext, ready()),
                (AppRoute::Deliveries, recorded()),
                (AppRoute::DeliveryOutcome, recorded()),
            ]);
            let local = local_with(vec![
                (LocalRoute::AnswerCheck, deliverable(true)),
                (LocalRoute::Answers, answered(200, answer.clone())),
            ]);
            let run = deliver_next(&app, &local, None).await;
            assert!(run.delivered, "{answer}");
            assert_eq!(
                app.body(AppRoute::DeliveryOutcome),
                json!({"request_id": REQUEST, "outcome": "receipt"}),
                "the answer reached the worker: that is the receipt"
            );
            assert_eq!(run.halt, Some("delivery_card_record_failed"), "{answer}");
            assert_eq!(run.code, "delivery_card_record_failed");
        }
    }

    /// A read without the binding is not one the app gives.
    #[test]
    fn a_delivery_without_its_binding_is_unreadable() {
        let body = match &ready() {
            HttpAnswer::Answered { body, .. } => body.clone(),
            HttpAnswer::Lost => unreachable!(),
        };
        let value = serde_json::from_slice::<Value>(&body).unwrap();
        assert!(parse_next_delivery(&value).is_some());
        for field in ["worker", "session_attempt"] {
            let mut missing = value.clone();
            missing["delivery"].as_object_mut().unwrap().remove(field);
            assert_eq!(parse_next_delivery(&missing), None, "{field}");
        }
        let mut negative = value.clone();
        negative["delivery"]["session_attempt"] = json!(-1);
        assert_eq!(parse_next_delivery(&negative), None);
    }

    /// §12: "운영자 확정 없이는 어떤 DM 출력도 worker에게 전달되지 않는다". The
    /// send follows a recorded decision and nothing else: a refused or lost
    /// decision, the kill switch, and a read that is not a confirmation all
    /// leave the local AMUX's delivery route uncalled.
    #[tokio::test]
    async fn nothing_reaches_the_worker_without_a_confirmation_and_a_recorded_decision() {
        for (decision, code, halt) in [
            (
                refused(409, "recorded", "not_confirmed"),
                "delivery_decision_refused",
                None,
            ),
            (
                refused(409, "recorded", "kill_switch_on"),
                "delivery_decision_refused",
                None,
            ),
            (
                HttpAnswer::Lost,
                "delivery_decision_outcome_unknown",
                Some("delivery_decision_outcome_unknown"),
            ),
        ] {
            let app = FakeApp::with(vec![
                (AppRoute::DeliveriesNext, ready()),
                (AppRoute::Deliveries, decision),
            ]);
            let local = local_with(vec![(LocalRoute::AnswerCheck, deliverable(true))]);
            let run = deliver_next(&app, &local, None).await;
            assert_eq!((run.code, run.halt), (code, halt));
            assert_eq!(
                local_routes(&local),
                vec![LocalRoute::AnswerCheck],
                "{code}"
            );
        }
        // The kill switch refuses the read itself: nothing is read out.
        let app = FakeApp::with(vec![(
            AppRoute::DeliveriesNext,
            refused(409, "found", "kill_switch_on"),
        )]);
        let local = FakeLocal::default();
        let run = deliver_next(&app, &local, Some(&cursor())).await;
        assert_eq!(
            (run.code, run.cursor),
            ("delivery_read_refused", CursorMove::Keep)
        );
        assert!(local_routes(&local).is_empty());
        // A rejection or any judgment kind other than the two confirmations is no delivery.
        for answer in [
            ready_with("reject", "operator-rejected"),
            ready_with("edit_confirm", DM_DELIVERY_CONFIRMED_LABEL),
            ready_with("confirm", DM_DELIVERY_EDITED_LABEL),
        ] {
            let app = FakeApp::with(vec![(AppRoute::DeliveriesNext, answer)]);
            let local = FakeLocal::default();
            let run = deliver_next(&app, &local, None).await;
            assert_eq!(run.halt, Some("delivery_read_unreadable"));
            assert!(local_routes(&local).is_empty());
            assert_eq!(app.routes(), vec![AppRoute::DeliveriesNext]);
        }
    }

    #[tokio::test]
    async fn a_question_that_cannot_take_the_answer_now_is_stepped_past_with_nothing_written() {
        for check in [deliverable(false), HttpAnswer::Lost] {
            let app = FakeApp::with(vec![(AppRoute::DeliveriesNext, ready())]);
            let local = local_with(vec![(LocalRoute::AnswerCheck, check)]);
            let run = deliver_next(&app, &local, None).await;
            assert_eq!(run.cursor, CursorMove::Advance(cursor()));
            assert!(run.halt.is_none());
            assert_eq!(app.routes(), vec![AppRoute::DeliveriesNext], "no decision");
            assert_eq!(local_routes(&local), vec![LocalRoute::AnswerCheck]);
        }
        // An erased answer and the end of the walk move the cursor without a local call.
        let app = FakeApp::with(vec![(
            AppRoute::DeliveriesNext,
            answered(
                200,
                json!({"found": true, "status": "undeliverable",
                "delivery": {"request_id": REQUEST, "judged_at_ms": 7, "reason": "answer_body_missing"}}),
            ),
        )]);
        let local = FakeLocal::default();
        let run = deliver_next(&app, &local, None).await;
        assert_eq!(run.cursor, CursorMove::Advance(cursor()));
        let app = FakeApp::with(vec![(
            AppRoute::DeliveriesNext,
            answered(
                200,
                json!({"found": true, "status": "none", "delivery": null}),
            ),
        )]);
        let run = deliver_next(&app, &local, Some(&cursor())).await;
        assert_eq!((run.code, run.cursor), ("no_delivery", CursorMove::Reset));
        assert_eq!(
            app.body(AppRoute::DeliveriesNext),
            json!({"after": {"judged_at_ms": 7, "request_id": REQUEST}})
        );
        assert!(local_routes(&local).is_empty());
    }

    /// §9: an unclear delivery is recorded unknown, the session paused and
    /// the receipt read -- and the delivery route is never called again.
    #[tokio::test]
    async fn an_unclear_delivery_is_never_sent_again_the_session_is_paused_and_unknown_recorded() {
        for answer in [
            HttpAnswer::Lost,
            answered(200, json!({"outcome": "unknown", "stage": "send"})),
            answered(500, json!({"error": "x"})),
        ] {
            let app = FakeApp::with(vec![
                (AppRoute::DeliveriesNext, ready()),
                (AppRoute::Deliveries, recorded()),
                (AppRoute::DeliveryOutcome, recorded()),
            ]);
            let local = local_with(vec![
                (LocalRoute::AnswerCheck, deliverable(true)),
                (LocalRoute::Answers, answer),
                (
                    LocalRoute::AnswerUnknown,
                    answered(
                        200,
                        json!({"paused": true, "receipt": "not_accepted", "claimed_by_request": true}),
                    ),
                ),
            ]);
            let run = deliver_next(&app, &local, None).await;
            assert_eq!(run.code, "delivery_unknown");
            assert_eq!(run.halt, None, "a paused session takes no other answer");
            assert!(!run.delivered);
            assert_eq!(
                app.body(AppRoute::DeliveryOutcome),
                json!({"request_id": REQUEST, "outcome": "unknown"})
            );
            assert_eq!(
                local_routes(&local),
                vec![
                    LocalRoute::AnswerCheck,
                    LocalRoute::Answers,
                    LocalRoute::AnswerUnknown
                ]
            );
            assert_eq!(
                local.writes.lock().unwrap()[2].1,
                json!({"card_id": "AMUX-12", "question_revision": 3, "request_id": REQUEST, "session": SESSION})
            );
        }
        // A pause nobody confirmed, or an unknown record nobody confirmed, stops the relay.
        for (outcome, pause, halt) in [
            (
                recorded(),
                HttpAnswer::Lost,
                "delivery_unknown_pause_unconfirmed",
            ),
            (
                recorded(),
                answered(200, json!({"paused": false, "receipt": "unreadable"})),
                "delivery_unknown_pause_unconfirmed",
            ),
            (
                HttpAnswer::Lost,
                answered(200, json!({"paused": true, "receipt": "accepted"})),
                "delivery_unknown_outcome_unknown",
            ),
        ] {
            let app = FakeApp::with(vec![
                (AppRoute::DeliveriesNext, ready()),
                (AppRoute::Deliveries, recorded()),
                (AppRoute::DeliveryOutcome, outcome),
            ]);
            let local = local_with(vec![
                (LocalRoute::AnswerCheck, deliverable(true)),
                (LocalRoute::Answers, HttpAnswer::Lost),
                (LocalRoute::AnswerUnknown, pause),
            ]);
            let run = deliver_next(&app, &local, None).await;
            assert_eq!(run.halt, Some(halt));
            assert_eq!(
                local_routes(&local)
                    .iter()
                    .filter(|route| **route == LocalRoute::Answers)
                    .count(),
                1
            );
        }
    }

    /// Stage S2-2b4 (§2-7: "다른 쪽은 거절되어 운영자에게 보인다"): a decided
    /// delivery the local AMUX proved sent nothing -- the operator's direct
    /// answer won the claim, the question or the binding changed, the lane
    /// refused before typing, the local store refused before claiming -- is
    /// recorded as `not_sent` with its reason, the decision's one outcome, and
    /// the relay carries on. Nothing is sent again and no session is paused.
    #[tokio::test]
    async fn a_delivery_the_local_amux_proved_unsent_records_not_sent_with_its_reason_and_carries_on(
    ) {
        for (answer, reason) in [
            (
                json!({"outcome": "answered", "source": "operator", "same_request": false}),
                "answered_by_operator",
            ),
            (
                json!({"outcome": "not_deliverable", "reason": "answered_by_operator"}),
                "answered_by_operator",
            ),
            (
                json!({"outcome": "not_deliverable", "reason": "question_changed"}),
                "question_changed",
            ),
            (
                json!({"outcome": "claim_refused", "reason": "stale_revision"}),
                "question_changed",
            ),
            (
                json!({"outcome": "claim_refused", "reason": "not_needs_you"}),
                "question_changed",
            ),
            (
                json!({"outcome": "claim_refused", "reason": "card_missing"}),
                "question_changed",
            ),
            // The card was given to another worker or attempt between the check and the claim.
            (
                json!({"outcome": "binding_changed", "reason": "owner_changed"}),
                "binding_changed",
            ),
            (
                json!({"outcome": "binding_changed", "reason": "attempt_changed"}),
                "binding_changed",
            ),
            (
                json!({"outcome": "binding_changed", "reason": "question_changed"}),
                "question_changed",
            ),
            (
                json!({"outcome": "not_deliverable", "reason": "attempt_changed"}),
                "binding_changed",
            ),
            (
                json!({"outcome": "not_deliverable", "reason": "busy"}),
                "lane_refused",
            ),
            (
                json!({"outcome": "not_deliverable", "reason": "paused"}),
                "lane_refused",
            ),
            (
                json!({"outcome": "not_sent", "reason": "send_refused"}),
                "send_refused",
            ),
            (
                json!({"outcome": "not_deliverable", "reason": "store_unreadable"}),
                "local_refused",
            ),
            (
                json!({"outcome": "not_sent", "reason": "claim_store_failed"}),
                "local_refused",
            ),
        ] {
            let app = FakeApp::with(vec![
                (AppRoute::DeliveriesNext, ready()),
                (AppRoute::Deliveries, recorded()),
                (AppRoute::DeliveryOutcome, recorded()),
            ]);
            let local = local_with(vec![
                (LocalRoute::AnswerCheck, deliverable(true)),
                (LocalRoute::Answers, answered(200, answer.clone())),
            ]);
            let run = deliver_next(&app, &local, None).await;
            assert_eq!(run.halt, None, "{answer}");
            assert_eq!(run.code, "delivery_not_sent", "{answer}");
            assert!(!run.delivered);
            assert_eq!(run.cursor, CursorMove::Advance(cursor()));
            assert_eq!(
                app.body(AppRoute::DeliveryOutcome),
                json!({"request_id": REQUEST, "outcome": "not_sent", "reason": reason}),
                "{answer}"
            );
            // Called once, never again, and no session is paused for a proved non-delivery.
            assert_eq!(
                local_routes(&local),
                vec![LocalRoute::AnswerCheck, LocalRoute::Answers],
                "{answer}"
            );
        }
    }

    /// Stage S2-2b4: what does not prove that nothing was sent is §9's unknown,
    /// never `not_sent` -- an answer record this request may hold, a reason the
    /// relay does not know.
    #[tokio::test]
    async fn an_answer_that_does_not_prove_nothing_was_sent_is_unknown_never_not_sent() {
        for answer in [
            json!({"outcome": "answered", "source": "dm_confirmed", "same_request": true}),
            json!({"outcome": "answered", "source": "dm_confirmed", "same_request": false}),
            json!({"outcome": "not_deliverable", "reason": "answered"}),
            json!({"outcome": "not_deliverable", "reason": "something_new"}),
            json!({"outcome": "claim_refused", "reason": "something_new"}),
            json!({"outcome": "not_sent", "reason": "something_new"}),
            json!({"outcome": "not_sent"}),
        ] {
            let app = FakeApp::with(vec![
                (AppRoute::DeliveriesNext, ready()),
                (AppRoute::Deliveries, recorded()),
                (AppRoute::DeliveryOutcome, recorded()),
            ]);
            let local = local_with(vec![
                (LocalRoute::AnswerCheck, deliverable(true)),
                (LocalRoute::Answers, answered(200, answer.clone())),
                (
                    LocalRoute::AnswerUnknown,
                    answered(200, json!({"paused": true, "receipt": "not_accepted"})),
                ),
            ]);
            let run = deliver_next(&app, &local, None).await;
            assert_eq!(run.code, "delivery_unknown", "{answer}");
            assert_eq!(
                app.body(AppRoute::DeliveryOutcome),
                json!({"request_id": REQUEST, "outcome": "unknown"}),
                "{answer}"
            );
            assert_eq!(
                local_routes(&local),
                vec![
                    LocalRoute::AnswerCheck,
                    LocalRoute::Answers,
                    LocalRoute::AnswerUnknown
                ],
                "{answer}"
            );
        }
    }

    /// The rule of stage S2-2b3 for every outcome: only the app's recorded
    /// answer is a record, so a not-sent outcome refused or lost stops the
    /// relay and names it -- the decided request is never offered again.
    #[tokio::test]
    async fn a_not_sent_outcome_the_app_did_not_record_stops_the_relay() {
        for (outcome, halt) in [
            (
                refused(503, "recorded", "amux_database_busy"),
                "delivery_not_sent_record_refused",
            ),
            (
                refused(409, "recorded", "dm_routing_disabled"),
                "delivery_not_sent_record_refused",
            ),
            (HttpAnswer::Lost, "delivery_not_sent_outcome_unknown"),
        ] {
            let app = FakeApp::with(vec![
                (AppRoute::DeliveriesNext, ready()),
                (AppRoute::Deliveries, recorded()),
                (AppRoute::DeliveryOutcome, outcome),
            ]);
            let local = local_with(vec![
                (LocalRoute::AnswerCheck, deliverable(true)),
                (
                    LocalRoute::Answers,
                    answered(200, json!({"outcome": "not_deliverable", "reason": "busy"})),
                ),
            ]);
            let run = deliver_next(&app, &local, None).await;
            assert_eq!(run.halt, Some(halt));
            assert_eq!(run.code, halt);
            assert_eq!(
                local_routes(&local),
                vec![LocalRoute::AnswerCheck, LocalRoute::Answers]
            );
        }
    }

    #[tokio::test]
    async fn a_receipt_whose_record_was_lost_after_a_delivery_stops_the_relay() {
        let app = FakeApp::with(vec![
            (AppRoute::DeliveriesNext, ready()),
            (AppRoute::Deliveries, recorded()),
            (AppRoute::DeliveryOutcome, HttpAnswer::Lost),
        ]);
        let local = local_with(vec![
            (LocalRoute::AnswerCheck, deliverable(true)),
            (
                LocalRoute::Answers,
                answered(200, json!({"outcome": "delivered"})),
            ),
        ]);
        let run = deliver_next(&app, &local, None).await;
        assert!(run.delivered);
        assert_eq!(run.halt, Some("delivery_receipt_outcome_unknown"));
    }

    #[test]
    fn the_message_must_be_sevens_header_for_this_card_and_judgment() {
        let good = message("AMUX-12", DM_DELIVERY_CONFIRMED_LABEL);
        assert!(message_is_confirmed_answer(
            &good,
            "decision-maker-openai",
            DM_DELIVERY_CONFIRMED_LABEL,
            "AMUX-12"
        ));
        for (text, instance, label, card) in [
            (
                good.clone(),
                "decision-maker-anthropic",
                DM_DELIVERY_CONFIRMED_LABEL,
                "AMUX-12",
            ),
            (
                good.clone(),
                "decision-maker-openai",
                DM_DELIVERY_EDITED_LABEL,
                "AMUX-12",
            ),
            (
                good.clone(),
                "decision-maker-openai",
                DM_DELIVERY_CONFIRMED_LABEL,
                "AMUX-1",
            ),
            (
                "sqlite".to_owned(),
                "decision-maker-openai",
                DM_DELIVERY_CONFIRMED_LABEL,
                "AMUX-12",
            ),
            (
                good.lines().next().unwrap().to_owned(),
                "decision-maker-openai",
                DM_DELIVERY_CONFIRMED_LABEL,
                "AMUX-12",
            ),
            (
                format!("{good}{}", "x".repeat(DM_DELIVERY_MESSAGE_MAX_BYTES)),
                "decision-maker-openai",
                DM_DELIVERY_CONFIRMED_LABEL,
                "AMUX-12",
            ),
        ] {
            assert!(
                !message_is_confirmed_answer(&text, instance, label, card),
                "{instance} {label} {card}"
            );
        }
        // A message id other than the request's own is not the app's answer.
        let mut wrong = serde_json::from_slice::<Value>(match &ready() {
            HttpAnswer::Answered { body, .. } => body,
            HttpAnswer::Lost => unreachable!(),
        })
        .unwrap();
        wrong["delivery"]["message_id"] = json!("dm-answer:other");
        assert_eq!(parse_next_delivery(&wrong), None);
        wrong["delivery"]["message_id"] = json!(format!("dm-answer:{REQUEST}"));
        wrong["delivery"]["card_id"] = json!("../x");
        assert_eq!(parse_next_delivery(&wrong), None);
    }

    /// Review r-20261018-062643-057a27, finding 2: a refusal of the outcome
    /// write is not a record. A busy database (503) or the routes closed (409)
    /// leave the decision with no outcome, and the next read never offers it
    /// again (it is decided), so carrying on would lose §9's `delivery_unknown`
    /// and the person's resolution for good. Whatever answer short of a
    /// recorded one -- refused or unknown -- the session is still paused, and
    /// the relay stops and says which record is missing.
    #[tokio::test]
    async fn an_unknown_outcome_the_app_did_not_record_pauses_the_session_and_stops_the_relay() {
        for (answer, halt) in [
            (
                refused(503, "recorded", "amux_database_busy"),
                "delivery_unknown_record_refused",
            ),
            (
                refused(409, "recorded", "dm_routing_disabled"),
                "delivery_unknown_record_refused",
            ),
            (HttpAnswer::Lost, "delivery_unknown_outcome_unknown"),
        ] {
            let app = FakeApp::with(vec![
                (AppRoute::DeliveriesNext, ready()),
                (AppRoute::Deliveries, recorded()),
                (AppRoute::DeliveryOutcome, answer),
            ]);
            let local = local_with(vec![
                (LocalRoute::AnswerCheck, deliverable(true)),
                (LocalRoute::Answers, HttpAnswer::Lost),
                (
                    LocalRoute::AnswerUnknown,
                    answered(200, json!({"paused": true, "receipt": "not_accepted"})),
                ),
            ]);
            let run = deliver_next(&app, &local, None).await;
            assert_eq!(run.halt, Some(halt));
            assert_eq!(run.code, halt, "the log line names the missing record");
            assert_eq!(
                local_routes(&local),
                vec![
                    LocalRoute::AnswerCheck,
                    LocalRoute::Answers,
                    LocalRoute::AnswerUnknown
                ],
                "the session is paused all the same"
            );
        }
    }

    /// The same finding for the receipt: only a recorded answer is a receipt.
    #[tokio::test]
    async fn a_receipt_the_app_did_not_record_stops_the_relay() {
        for (answer, halt) in [
            (
                refused(503, "recorded", "amux_database_busy"),
                "delivery_receipt_record_refused",
            ),
            (
                refused(409, "recorded", "dm_routing_disabled"),
                "delivery_receipt_record_refused",
            ),
            (HttpAnswer::Lost, "delivery_receipt_outcome_unknown"),
        ] {
            let app = FakeApp::with(vec![
                (AppRoute::DeliveriesNext, ready()),
                (AppRoute::Deliveries, recorded()),
                (AppRoute::DeliveryOutcome, answer),
            ]);
            let local = local_with(vec![
                (LocalRoute::AnswerCheck, deliverable(true)),
                (
                    LocalRoute::Answers,
                    answered(200, json!({"outcome": "delivered"})),
                ),
            ]);
            let run = deliver_next(&app, &local, None).await;
            assert!(run.delivered, "the answer reached the worker");
            assert_eq!(run.halt, Some(halt));
            assert_eq!(run.code, halt, "the log line names the missing record");
        }
    }
}
