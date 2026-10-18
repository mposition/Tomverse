//! Stage S2-2b4: the operator's direct answer closes its question's request
//! (docs/policy/amux-decision-maker.md §2-7: "운영자의 직접 답과 확정된 DM 답이
//! 모두 그 기록을 먼저 써야 보낸다 ... 운영자의 직접 답이 먼저면 요청은 닫힌다").
//!
//! The local AMUX writes the answer record of a question revision before
//! anything is sent, and the operator's direct answer from the dashboard claims
//! it as `operator` (stage S2-2b3). Each tick, before its delivery, the relay
//! reads the operator's records written since its cursor
//! (`/api/dm-relay/answers/operator`, a read in the order of their time) and
//! reports each question to the app (`requests/direct-answer`), whose router
//! closes that question's request if one is open. A question with no request,
//! one kept with the operator and one already closed are answers, not
//! failures, and the walk moves past them.
//!
//! The cursor is the record's time, not a row number: the local AMUX vacuums
//! its database, which may renumber rows. A record written later in the same
//! second as the cursor may sort before records already reported, so each read
//! starts at the cursor's second again and skips the records of that second it
//! has already reported.
//!
//! A report is a close the ledger takes once: the same report again finds the
//! request closed and writes nothing. So a report the app refused for now or
//! whose answer was lost is asked again at the next tick from the same place,
//! the way a lost routing is asked again (§9) -- the walk keeps its cursor
//! until the app has answered.
//!
//! WHAT THIS MUST NEVER DO: reach a worker. It reads the local AMUX's records
//! and writes only to the app; a request it closes takes no judgment, so a
//! proposal nobody confirmed can never be delivered after the operator
//! answered.

use std::collections::BTreeSet;

use serde_json::{json, Value};

use super::flow::{AppRoute, DmApp, DmLocal, LocalRoute};
use super::wire::{read_app_answer, AppAnswer, HttpAnswer};

/// How far back the walk starts when the relay starts: a request is closed as
/// stale 720 hours after it was created (§10), and a question is answered after
/// it was routed, so an answer older than this has no open request to close.
/// A day's margin over the 720 hours.
pub const DM_DIRECT_ANSWER_LOOKBACK_SECS: i64 = 31 * 24 * 60 * 60;

/// Where the walk over the operator's answer records stands: the second it
/// reads from, and the records of that second it has already reported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectCursor {
    pub since: i64,
    pub reported: BTreeSet<(i64, String, i64)>,
}

impl DirectCursor {
    pub fn starting_at(now_secs: i64) -> Self {
        Self {
            since: now_secs - DM_DIRECT_ANSWER_LOOKBACK_SECS,
            reported: BTreeSet::new(),
        }
    }

    /// Moves the read to `since`, forgetting what came before it.
    fn move_to(&mut self, since: i64) {
        self.since = since.max(self.since);
        let since = self.since;
        self.reported.retain(|(at, _, _)| *at >= since);
    }
}

/// One operator answer record, as the local route lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperatorAnswer {
    pub recorded_at: i64,
    pub card_id: String,
    pub question_revision: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectRun {
    pub code: &'static str,
    /// Requests the app closed in this run.
    pub closed: usize,
    /// Records the walk reported and moved past.
    pub reported: usize,
}

/// The local list, strictly: `None` when it is not one the route gives.
pub fn parse_operator_answers(value: &Value) -> Option<Vec<OperatorAnswer>> {
    value
        .get("answers")?
        .as_array()?
        .iter()
        .map(|answer| {
            let recorded_at = answer.get("recorded_at")?.as_i64()?;
            let card_id = answer.get("card_id")?.as_str()?;
            let question_revision = answer.get("question_revision")?.as_i64()?;
            (!card_id.is_empty() && card_id.len() <= 128 && question_revision >= 1).then(|| {
                OperatorAnswer {
                    recorded_at,
                    card_id: card_id.to_owned(),
                    question_revision,
                }
            })
        })
        .collect()
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

/// One page of the walk: the operator's records from the cursor's second,
/// each not yet reported reported until one the app has not answered, which
/// stays for the next tick.
pub async fn report_direct_answers<A, L>(app: &A, local: &L, cursor: &mut DirectCursor) -> DirectRun
where
    A: DmApp + ?Sized,
    L: DmLocal + ?Sized,
{
    let mut run = DirectRun {
        code: "direct_answers_reported",
        closed: 0,
        reported: 0,
    };
    let list = local
        .post(LocalRoute::OperatorAnswers, json!({"since": cursor.since}))
        .await;
    let answers = match &list {
        HttpAnswer::Answered { status: 200, body } => serde_json::from_slice::<Value>(body)
            .ok()
            .and_then(|value| parse_operator_answers(&value)),
        _ => None,
    };
    let Some(answers) = answers else {
        run.code = "direct_answers_unreadable";
        return run;
    };
    for answer in &answers {
        let key = (
            answer.recorded_at,
            answer.card_id.clone(),
            answer.question_revision,
        );
        if answer.recorded_at < cursor.since || cursor.reported.contains(&key) {
            continue;
        }
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
                cursor.move_to(answer.recorded_at);
                run.code = "direct_answer_report_unanswered";
                return run;
            }
        }
        cursor.reported.insert(key);
        run.reported += 1;
    }
    if let Some(last) = answers.last() {
        cursor.move_to(last.recorded_at);
    }
    run
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dm_relay::flow::tests::{answered, recorded, refused, FakeApp, FakeLocal};

    fn listing(answers: Value) -> HttpAnswer {
        answered(200, json!({"answers": answers, "truncated": false}))
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
        assert_eq!((run.closed, run.reported), (1, 2));
        assert_eq!(cursor.since, AT + 100);
        // The first read starts at the lookback.
        assert_eq!(
            local.writes.lock().unwrap()[0].1,
            json!({"since": AT + 1_000 - DM_DIRECT_ANSWER_LOOKBACK_SECS})
        );
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
        // The next read starts at the last record's second; what it already reported is not
        // reported again, and a record of that second written since -- sorting before it -- is.
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
        assert_eq!(
            local.writes.lock().unwrap()[0].1,
            json!({"since": AT + 100})
        );
        assert_eq!(
            app.body(AppRoute::DirectAnswer),
            json!({"card_id": "AMUX-3", "question_revision": 2})
        );
        // Records before the cursor's second are forgotten once it moves past them.
        assert!(cursor.reported.iter().all(|(at, _, _)| *at >= AT + 100));
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
                (run.closed, run.reported, cursor.since),
                (1, 2, AT + 100),
                "{reason}"
            );
        }
        // Refused for now, or lost: the walk stays on that record and reports it again next time.
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
            let run = report_direct_answers(&app, &local, &mut cursor).await;
            assert_eq!(
                (run.closed, run.reported, cursor.since),
                (0, 0, AT),
                "{first:?}"
            );
            assert_eq!(
                app.routes(),
                vec![AppRoute::DirectAnswer],
                "the second waits"
            );
            // Next time the same record is reported first.
            let run = report_direct_answers(&app, &local, &mut cursor).await;
            assert_eq!(run.reported, 0, "unscripted answers are lost again");
            assert_eq!(
                app.calls.lock().unwrap()[1].1,
                json!({"card_id": "AMUX-12", "question_revision": 3})
            );
        }
        // An unreadable list reports nothing and keeps the cursor.
        for list in [
            HttpAnswer::Lost,
            answered(403, json!({"reason": "dm_relay_token_refused"})),
            answered(200, json!({"answers": [{"card_id": "AMUX-1"}]})),
        ] {
            let app = FakeApp::default();
            let local = local_with(vec![(LocalRoute::OperatorAnswers, list)]);
            let mut cursor = DirectCursor::starting_at(AT + 1_000);
            let run = report_direct_answers(&app, &local, &mut cursor).await;
            assert_eq!(
                (run.reported, cursor.since),
                (0, AT + 1_000 - DM_DIRECT_ANSWER_LOOKBACK_SECS)
            );
            assert!(app.routes().is_empty());
        }
    }
}
