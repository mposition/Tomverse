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
//! Halts: a decision whose outcome is unknown, a receipt or `unknown` the app
//! did not answer as recorded (refused or lost alike: the decision is never
//! offered again, so a missing outcome stays missing), a session whose pause
//! was not confirmed, a reading the relay cannot understand, and a delivery the
//! local AMUX refused after the decision (the record's claim lost a race, or
//! the lane stopped taking input in between). The last has no outcome the
//! app's delivery record can name -- it holds a receipt or `unknown`, and
//! this delivery is neither -- so the decision stays without an outcome and
//! the relay stops for a person (remainder of stage S2-2b3).
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
    pub session: String,
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
            let session = delivery.get("session")?.as_str()?;
            let message_id = delivery.get("message_id")?.as_str()?;
            let message = delivery.get("message")?.as_str()?;
            let ok = is_instance(instance)
                && crate::local_card::valid_local_card_id(card_id)
                && question_revision >= 1
                && is_ledger_identifier(session)
                && message_id == format!("{DM_DELIVERY_MESSAGE_ID_PREFIX}{}", cursor.request_id)
                && message_is_confirmed_answer(message, instance, label, card_id);
            ok.then(|| {
                NextDelivery::Ready(Delivery {
                    cursor,
                    card_id: card_id.to_owned(),
                    question_revision,
                    session: session.to_owned(),
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

/// One step of the walk: at most one confirmed answer carried to a recorded
/// receipt, a recorded unknown, or a halt.
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
                "session": delivery.session}),
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

    // 4. The delivery: called once, never again, whatever comes back.
    let answer = local
        .post(
            LocalRoute::Answers,
            json!({"card_id": delivery.card_id, "question_revision": delivery.question_revision,
                "request_id": delivery.request_id(), "session": delivery.session,
                "message": delivery.message}),
        )
        .await;
    match local_outcome(&answer) {
        Some((outcome, _)) if outcome == "delivered" => {}
        // Nothing was sent, and the app's delivery record has no outcome for
        // that: the decision stays without one, and the relay stops.
        Some((outcome, _))
            if matches!(
                outcome.as_str(),
                "not_deliverable" | "answered" | "claim_refused" | "not_sent"
            ) =>
        {
            return DeliveryRun::about(&delivery, "delivery_not_sent_after_decision")
                .halted("delivery_not_sent_after_decision")
        }
        // Unclear (§9): never sent again.
        _ => return record_unknown(app, local, &delivery).await,
    }

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
        run = run.missing(missing);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dm_relay::flow::tests::{answered, recorded, refused, FakeApp, FakeLocal};

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
                "session": SESSION, "message_id": format!("dm-answer:{REQUEST}"),
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
        // The message goes as the app composed it, to the asking worker's session.
        let writes = local.writes.lock().unwrap().clone();
        assert_eq!(
            writes[1].1,
            json!({"card_id": "AMUX-12", "question_revision": 3, "request_id": REQUEST,
                "session": SESSION, "message": message("AMUX-12", DM_DELIVERY_CONFIRMED_LABEL)})
        );
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

    #[tokio::test]
    async fn a_delivery_refused_after_the_decision_sends_nothing_and_stops_the_relay() {
        for answer in [
            json!({"outcome": "answered", "source": "operator", "same_request": false}),
            json!({"outcome": "not_deliverable", "reason": "busy"}),
            json!({"outcome": "claim_refused", "reason": "stale_revision"}),
            json!({"outcome": "not_sent", "reason": "send_refused"}),
        ] {
            let app = FakeApp::with(vec![
                (AppRoute::DeliveriesNext, ready()),
                (AppRoute::Deliveries, recorded()),
            ]);
            let local = local_with(vec![
                (LocalRoute::AnswerCheck, deliverable(true)),
                (LocalRoute::Answers, answered(200, answer.clone())),
            ]);
            let run = deliver_next(&app, &local, None).await;
            assert_eq!(
                run.halt,
                Some("delivery_not_sent_after_decision"),
                "{answer}"
            );
            // No outcome is recorded for it: neither a receipt nor unknown is true.
            assert_eq!(
                app.routes(),
                vec![AppRoute::DeliveriesNext, AppRoute::Deliveries]
            );
            assert_eq!(
                local_routes(&local),
                vec![LocalRoute::AnswerCheck, LocalRoute::Answers]
            );
        }
        // A receipt whose record was lost stops it as well, after a delivery.
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
