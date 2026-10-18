//! Stage S2-2b4: the operator's direct answer closes its question's request
//! (docs/policy/amux-decision-maker.md §2-7: "운영자의 직접 답과 확정된 DM 답이
//! 모두 그 기록을 먼저 써야 보낸다 ... 운영자의 직접 답이 먼저면 요청은 닫힌다").
//!
//! The local AMUX writes the answer record of a question revision before
//! anything is sent, and the operator's direct answer from the dashboard claims
//! it as `operator` (stage S2-2b3). Each tick, before its delivery, the relay
//! reads the operator's records after the last one it passed
//! (`/api/dm-relay/answers/operator`) and reports each question to the app
//! (`requests/direct-answer`), whose router closes that question's request if
//! one is open. A question with no request, one kept with the operator and one
//! already closed are answers, not failures, and the walk moves past them.
//!
//! The walk's place is a record's own key -- its time, card and revision, the
//! card and revision being the record's primary key -- never a row number,
//! which the local AMUX's vacuum may renumber. Each read starts strictly after
//! the last record the walk passed, so a page always moves on, however many
//! records share a second (review r-20261018-121437-f0d9ce: a read by time
//! alone stayed on a second that held a full page).
//!
//! A record's time is taken before the dashboard waits for the store's writer
//! (`board_typed_ask.rs`), so a record can commit after a later-timed one the
//! walk has already passed. When a read reaches the end of the list, the walk
//! goes back to the newest time it has read less
//! [`DM_DIRECT_ANSWER_REWIND_SECS`] and reads that window again, skipping the
//! records it has already reported: a record committed that late behind a
//! later one is still found. One committed later than the window is not. Its
//! request then stays open until it is judged or closed as stale, and nothing
//! is sent twice: its answer record still holds the question, so a confirmed
//! proposal finds it answered and is not delivered.
//!
//! A report is a close the ledger takes once: the same report again finds the
//! request closed and writes nothing. So a report the app refused for now or
//! whose answer was lost is asked again at the next tick from the same place,
//! the way a lost routing is asked again (§9) -- the walk keeps its place
//! until the app has answered.
//!
//! WHAT THIS MUST NEVER DO: reach a worker. It reads the local AMUX's records
//! and writes only to the app; a request it closes takes no judgment, so a
//! proposal nobody confirmed can never be delivered after the operator
//! answered.

use std::collections::BTreeSet;

use serde_json::{json, Value};

use super::flow::{AppRoute, DmApp, DmLocal, LocalRoute};
use super::wire::{is_ledger_identifier, read_app_answer, AppAnswer, HttpAnswer};

/// How far back the walk starts when the relay starts: a request is closed as
/// stale 720 hours after it was created (§10), and a question is answered after
/// it was routed, so an answer older than this has no open request to close.
/// A day's margin over the 720 hours.
pub const DM_DIRECT_ANSWER_LOOKBACK_SECS: i64 = 31 * 24 * 60 * 60;

/// How far before the newest record time it has read the walk reads again
/// once it reaches the end of the list. Nothing bounds the dashboard's wait
/// for the store's writer between taking a record's time and committing it,
/// and the store's own notes describe requests stalled for a minute and more;
/// ten minutes is a wide margin over that, not a bound (see the module's note).
pub const DM_DIRECT_ANSWER_REWIND_SECS: i64 = 10 * 60;

/// A record's place in the list: its time in seconds, card and question
/// revision, in the local route's order.
pub type RecordKey = (i64, String, i64);

/// The key every record of `at` or later sorts after: no record has an empty
/// card.
fn before(at: i64) -> RecordKey {
    (at, String::new(), i64::MIN)
}

/// Where the walk over the operator's answer records stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectCursor {
    /// The last record the walk passed; the next read starts strictly after it.
    pub after: RecordKey,
    /// The newest record time the walk has read.
    pub newest: i64,
    /// The records reported, or passed as not reportable, from the rewind
    /// window's start on: a window read again reports none of them twice.
    pub reported: BTreeSet<RecordKey>,
}

impl DirectCursor {
    pub fn starting_at(now_secs: i64) -> Self {
        let since = now_secs - DM_DIRECT_ANSWER_LOOKBACK_SECS;
        Self {
            after: before(since),
            newest: since,
            reported: BTreeSet::new(),
        }
    }

    /// At the end of the list: read the window before the newest record again,
    /// and forget what was reported before it.
    fn rewind(&mut self) {
        let start = self.newest - DM_DIRECT_ANSWER_REWIND_SECS;
        let floor = before(start);
        if floor < self.after {
            self.after = floor;
        }
        self.reported.retain(|(at, _, _)| *at >= start);
    }
}

/// One operator answer record, as the local route lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperatorAnswer {
    pub recorded_at: i64,
    pub card_id: String,
    pub question_revision: i64,
}

impl OperatorAnswer {
    fn key(&self) -> RecordKey {
        (
            self.recorded_at,
            self.card_id.clone(),
            self.question_revision,
        )
    }

    /// A question the app's report route takes: its card a ledger identifier
    /// and its revision what the ledger holds. Anything else could never close
    /// a request, so it is passed rather than reported or read again forever
    /// (review r-20261018-121437-f0d9ce: one such record stopped the walk).
    fn reportable(&self) -> bool {
        is_ledger_identifier(&self.card_id)
            && (0..=i64::from(i32::MAX)).contains(&self.question_revision)
    }
}

/// One page of the local list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperatorPage {
    pub answers: Vec<OperatorAnswer>,
    /// More records follow the page.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectRun {
    pub code: &'static str,
    /// Requests the app closed in this run.
    pub closed: usize,
    /// Records the walk reported and moved past.
    pub reported: usize,
    /// Records the walk moved past without a report: not a question the app's
    /// route takes.
    pub skipped: usize,
    /// The page was full and held a record not seen before: read on at the
    /// next tick without waiting.
    pub more: bool,
}

/// The local list: `None` when it is not one the route gives. Each record needs
/// its key; whether it can be reported is the walk's question, not the list's.
pub fn parse_operator_page(value: &Value) -> Option<OperatorPage> {
    let answers = value
        .get("answers")?
        .as_array()?
        .iter()
        .map(|answer| {
            Some(OperatorAnswer {
                recorded_at: answer.get("recorded_at")?.as_i64()?,
                card_id: answer.get("card_id")?.as_str()?.to_owned(),
                question_revision: answer.get("question_revision")?.as_i64()?,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    let truncated = value.get("truncated")?.as_bool()?;
    Some(OperatorPage { answers, truncated })
}

/// The app's refusals that say there is nothing to close: no request for the
/// question (or one the ledger could not hold), a request kept with the
/// operator, a request already closed.
const NOTHING_TO_CLOSE: [&str; 5] = [
    "unknown_request",
    "not_routed_to_dm",
    "closed",
    "invalid_input",
    "invalid_request",
];

/// One page of the walk: the operator's records after its place, each not yet
/// reported reported until one the app has not answered, which stays for the
/// next tick. At the end of the list the walk goes back over the rewind window.
pub async fn report_direct_answers<A, L>(app: &A, local: &L, cursor: &mut DirectCursor) -> DirectRun
where
    A: DmApp + ?Sized,
    L: DmLocal + ?Sized,
{
    let mut run = DirectRun {
        code: "direct_answers_reported",
        closed: 0,
        reported: 0,
        skipped: 0,
        more: false,
    };
    let (at, card, revision) = &cursor.after;
    let list = local
        .post(
            LocalRoute::OperatorAnswers,
            json!({"after": {"recorded_at": at, "card_id": card, "question_revision": revision}}),
        )
        .await;
    let page = match &list {
        HttpAnswer::Answered { status: 200, body } => serde_json::from_slice::<Value>(body)
            .ok()
            .and_then(|value| parse_operator_page(&value)),
        _ => None,
    };
    let Some(page) = page else {
        run.code = "direct_answers_unreadable";
        return run;
    };
    for answer in &page.answers {
        let key = answer.key();
        // The route lists strictly after the walk's place, in order; a record
        // that is not is no answer of the route's, and the walk stays put.
        if key <= cursor.after {
            run.code = "direct_answers_unreadable";
            return run;
        }
        cursor.newest = cursor.newest.max(answer.recorded_at);
        if !cursor.reported.contains(&key) {
            if answer.reportable() {
                let reported = app
                    .post(
                        AppRoute::DirectAnswer,
                        json!({"card_id": answer.card_id, "question_revision": answer.question_revision}),
                    )
                    .await;
                match read_app_answer(&reported, AppRoute::DirectAnswer.envelope()) {
                    AppAnswer::Done(_) => run.closed += 1,
                    AppAnswer::Refused(reason) if NOTHING_TO_CLOSE.contains(&reason.as_str()) => {}
                    // Refused for now or lost: this record is reported again next time.
                    AppAnswer::Refused(_) | AppAnswer::Unknown => {
                        run.code = "direct_answer_report_unanswered";
                        return run;
                    }
                }
                run.reported += 1;
            } else {
                run.skipped += 1;
            }
            cursor.reported.insert(key.clone());
        }
        cursor.after = key;
    }
    if page.truncated {
        run.more = run.reported + run.skipped > 0;
    } else {
        cursor.rewind();
    }
    run
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dm_relay::flow::tests::{answered, recorded, refused, FakeApp, FakeLocal};

    fn page(answers: Value, truncated: bool) -> HttpAnswer {
        answered(200, json!({"answers": answers, "truncated": truncated}))
    }

    fn listing(answers: Value) -> HttpAnswer {
        page(answers, false)
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

    fn read_after(local: &FakeLocal, n: usize) -> Value {
        local.writes.lock().unwrap()[n].1.clone()
    }

    fn after(at: i64, card: &str, revision: i64) -> Value {
        json!({"after": {"recorded_at": at, "card_id": card, "question_revision": revision}})
    }

    const AT: i64 = 1_790_000_000;

    fn two() -> HttpAnswer {
        listing(json!([
            {"card_id": "AMUX-12", "question_revision": 3, "recorded_at": AT},
            {"card_id": "AMUX-7", "question_revision": 1, "recorded_at": AT + 100},
        ]))
    }

    #[tokio::test]
    async fn the_operators_answer_records_close_their_requests_and_the_walk_moves_past_each() {
        let app = FakeApp::with(vec![
            (AppRoute::DirectAnswer, recorded()),
            // A question already closed (a judgment, an earlier report) is an answer, not a failure.
            (AppRoute::DirectAnswer, refused(409, "recorded", "closed")),
        ]);
        let local = local_with(vec![(LocalRoute::OperatorAnswers, two())]);
        let mut cursor = DirectCursor::starting_at(AT + 1_000);
        let run = report_direct_answers(&app, &local, &mut cursor).await;
        assert_eq!((run.closed, run.reported, run.more), (1, 2, false));
        // The first read starts at the lookback.
        let since = AT + 1_000 - DM_DIRECT_ANSWER_LOOKBACK_SECS;
        assert_eq!(read_after(&local, 0), after(since, "", i64::MIN));
        let calls = app.calls.lock().unwrap().clone();
        assert_eq!(
            calls
                .iter()
                .map(|(_, body)| body.clone())
                .collect::<Vec<_>>(),
            vec![
                json!({"card_id": "AMUX-12", "question_revision": 3}),
                json!({"card_id": "AMUX-7", "question_revision": 1}),
            ]
        );
        // Nothing reaches a worker: one local read, writes to the app's report route only.
        assert_eq!(local.routes(), vec![LocalRoute::OperatorAnswers]);
        assert!(app
            .routes()
            .iter()
            .all(|route| *route == AppRoute::DirectAnswer));
        // The end of the list: the walk goes back over the window before the newest record,
        // forgetting what it reported before the window.
        let start = AT + 100 - DM_DIRECT_ANSWER_REWIND_SECS;
        assert_eq!(cursor.after, before(start));
        assert_eq!(cursor.newest, AT + 100);
        assert!(cursor.reported.iter().all(|(at, _, _)| *at >= start));
        // A record committed late behind one already passed -- an earlier time, or the same
        // second and an earlier card -- is found; what was reported is not reported again.
        let local = local_with(vec![(
            LocalRoute::OperatorAnswers,
            listing(json!([
                {"card_id": "AMUX-3", "question_revision": 2, "recorded_at": AT + 100},
                {"card_id": "AMUX-7", "question_revision": 1, "recorded_at": AT + 100},
            ])),
        )]);
        let app = FakeApp::with(vec![(AppRoute::DirectAnswer, recorded())]);
        let run = report_direct_answers(&app, &local, &mut cursor).await;
        assert_eq!((run.closed, run.reported), (1, 1));
        assert_eq!(read_after(&local, 0), after(start, "", i64::MIN));
        assert_eq!(
            app.calls.lock().unwrap().clone(),
            vec![(
                AppRoute::DirectAnswer,
                json!({"card_id": "AMUX-3", "question_revision": 2})
            )]
        );
        // A window read again with nothing new reports nothing.
        let local = local_with(vec![(
            LocalRoute::OperatorAnswers,
            listing(json!([
                {"card_id": "AMUX-3", "question_revision": 2, "recorded_at": AT + 100},
                {"card_id": "AMUX-7", "question_revision": 1, "recorded_at": AT + 100},
            ])),
        )]);
        let app = FakeApp::default();
        let run = report_direct_answers(&app, &local, &mut cursor).await;
        assert_eq!((run.reported, run.more), (0, false));
        assert!(app.routes().is_empty());
    }

    /// Review r-20261018-121437-f0d9ce: more records in one second than a page
    /// holds. The walk moves on from the last record of each page.
    #[tokio::test]
    async fn a_full_page_inside_one_second_moves_on_to_the_records_after_it() {
        let app = FakeApp::with(vec![
            (AppRoute::DirectAnswer, recorded()),
            (AppRoute::DirectAnswer, recorded()),
            (AppRoute::DirectAnswer, recorded()),
        ]);
        let local = local_with(vec![
            (
                LocalRoute::OperatorAnswers,
                page(
                    json!([
                        {"card_id": "AMUX-1", "question_revision": 1, "recorded_at": AT},
                        {"card_id": "AMUX-2", "question_revision": 1, "recorded_at": AT},
                    ]),
                    true,
                ),
            ),
            (
                LocalRoute::OperatorAnswers,
                listing(json!([
                    {"card_id": "AMUX-3", "question_revision": 1, "recorded_at": AT},
                ])),
            ),
        ]);
        let mut cursor = DirectCursor::starting_at(AT + 1_000);
        let run = report_direct_answers(&app, &local, &mut cursor).await;
        assert_eq!((run.reported, run.more), (2, true));
        // A full page goes on from its last record, not back over the window.
        assert_eq!(cursor.after, (AT, "AMUX-2".to_string(), 1));
        let run = report_direct_answers(&app, &local, &mut cursor).await;
        assert_eq!((run.reported, run.more), (1, false));
        assert_eq!(read_after(&local, 1), after(AT, "AMUX-2", 1));
        assert_eq!(app.calls.lock().unwrap().len(), 3);
        // A full page of records already reported (the window read again) moves on without
        // asking for the next tick at once.
        let mut cursor = DirectCursor::starting_at(AT + 1_000);
        cursor.reported.insert((AT, "AMUX-1".to_string(), 1));
        cursor.reported.insert((AT, "AMUX-2".to_string(), 1));
        let local = local_with(vec![(
            LocalRoute::OperatorAnswers,
            page(
                json!([
                    {"card_id": "AMUX-1", "question_revision": 1, "recorded_at": AT},
                    {"card_id": "AMUX-2", "question_revision": 1, "recorded_at": AT},
                ]),
                true,
            ),
        )]);
        let app = FakeApp::default();
        let run = report_direct_answers(&app, &local, &mut cursor).await;
        assert_eq!((run.reported, run.more), (0, false));
        assert_eq!(cursor.after, (AT, "AMUX-2".to_string(), 1));
    }

    /// Review r-20261018-121437-f0d9ce: one record the app's route could not
    /// take stopped every later one.
    #[tokio::test]
    async fn a_record_the_app_cannot_take_is_passed_without_a_report() {
        let app = FakeApp::with(vec![(AppRoute::DirectAnswer, recorded())]);
        let local = local_with(vec![(
            LocalRoute::OperatorAnswers,
            listing(json!([
                {"card_id": "", "question_revision": 1, "recorded_at": AT},
                {"card_id": "AMUX 9", "question_revision": 1, "recorded_at": AT},
                {"card_id": "AMUX-8", "question_revision": -1, "recorded_at": AT},
                {"card_id": "AMUX-8", "question_revision": 2_147_483_648_i64, "recorded_at": AT},
                {"card_id": "AMUX-9", "question_revision": 0, "recorded_at": AT + 1},
            ])),
        )]);
        let mut cursor = DirectCursor::starting_at(AT + 1_000);
        let run = report_direct_answers(&app, &local, &mut cursor).await;
        assert_eq!((run.reported, run.skipped, run.closed), (1, 4, 1));
        assert_eq!(
            app.body(AppRoute::DirectAnswer),
            json!({"card_id": "AMUX-9", "question_revision": 0})
        );
        // Passed records are not read again as new.
        assert_eq!(cursor.reported.len(), 5);
    }

    #[tokio::test]
    async fn a_question_with_nothing_to_close_is_passed_and_an_unanswered_report_is_asked_again() {
        for reason in [
            "unknown_request",
            "not_routed_to_dm",
            "closed",
            "invalid_input",
        ] {
            let app = FakeApp::with(vec![
                (AppRoute::DirectAnswer, refused(409, "recorded", reason)),
                (AppRoute::DirectAnswer, recorded()),
            ]);
            let local = local_with(vec![(LocalRoute::OperatorAnswers, two())]);
            let mut cursor = DirectCursor::starting_at(AT + 1_000);
            let run = report_direct_answers(&app, &local, &mut cursor).await;
            assert_eq!(
                (run.closed, run.reported, cursor.newest),
                (1, 2, AT + 100),
                "{reason}"
            );
        }
        // Refused for now, or lost: the walk stays before that record and reports it again
        // next time.
        for first in [
            refused(503, "recorded", "amux_database_busy"),
            refused(409, "recorded", "dm_routing_disabled"),
            HttpAnswer::Lost,
        ] {
            let app = FakeApp::with(vec![(AppRoute::DirectAnswer, first.clone())]);
            let local = local_with(vec![
                (LocalRoute::OperatorAnswers, two()),
                (LocalRoute::OperatorAnswers, two()),
            ]);
            let mut cursor = DirectCursor::starting_at(AT + 1_000);
            let start = cursor.after.clone();
            let run = report_direct_answers(&app, &local, &mut cursor).await;
            assert_eq!(
                (run.closed, run.reported, run.code),
                (0, 0, "direct_answer_report_unanswered"),
                "{first:?}"
            );
            assert_eq!(cursor.after, start, "{first:?}");
            assert!(cursor.reported.is_empty());
            assert_eq!(
                app.routes(),
                vec![AppRoute::DirectAnswer],
                "the second waits"
            );
            // Next time the same record is reported first, from the same place.
            let run = report_direct_answers(&app, &local, &mut cursor).await;
            assert_eq!(run.reported, 0, "unscripted answers are lost again");
            assert_eq!(read_after(&local, 1), read_after(&local, 0));
            assert_eq!(
                app.calls.lock().unwrap()[1].1,
                json!({"card_id": "AMUX-12", "question_revision": 3})
            );
        }
        // An unreadable list -- or one not strictly after the walk's place, in order --
        // reports nothing and keeps the walk where it was.
        for list in [
            HttpAnswer::Lost,
            answered(403, json!({"reason": "dm_relay_token_refused"})),
            answered(
                200,
                json!({"answers": [{"card_id": "AMUX-1"}], "truncated": false}),
            ),
            answered(200, json!({"answers": []})),
            listing(json!([
                {"card_id": "AMUX-1", "question_revision": 1, "recorded_at": AT + 1_000 - DM_DIRECT_ANSWER_LOOKBACK_SECS - 1},
            ])),
            listing(json!([
                {"card_id": "AMUX-2", "question_revision": 1, "recorded_at": AT},
                {"card_id": "AMUX-1", "question_revision": 1, "recorded_at": AT},
            ])),
        ] {
            let app = FakeApp::with(vec![(AppRoute::DirectAnswer, recorded())]);
            let local = local_with(vec![(LocalRoute::OperatorAnswers, list.clone())]);
            let mut cursor = DirectCursor::starting_at(AT + 1_000);
            let run = report_direct_answers(&app, &local, &mut cursor).await;
            assert_eq!(run.code, "direct_answers_unreadable", "{list:?}");
            // The out-of-order page reported its first record and stayed there.
            assert!(run.reported <= 1, "{list:?}");
            assert!(cursor.after.0 <= AT, "{list:?}");
        }
    }
}
