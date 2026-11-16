//! The records the relay still owes the app and the local AMUX (owner
//! direction 2026-11-16: an unknown or refused write never stops the relay
//! until a person restarts it).
//!
//! A write whose answer was lost, or that was refused for a reason that says
//! nothing about the request -- a busy database, the routes closed, the
//! bridge refused -- is not dropped and does not stop the relay: it is kept
//! here and sent again on every tick, beside the other questions, until the
//! answer is the ledger's own word for it. Every record is keyed by its
//! request, and the app writes each at most once and answers what the ledger
//! already holds -- a closed request, an outcome already recorded, the
//! (request, digest) pair already settled -- so sending one again is its
//! read-back and can never write it twice. A result is read back by its
//! (request, digest) pair (`results/lookup`) before it is submitted again,
//! and the app accepts that submission after a `result_unknown` of the same
//! digest (migration 20261116140000_amux_dm_request_windows).
//!
//! Two records also hold something back while they are owed: a cleanup
//! report its instance (nothing more is sent to an instance whose §5 latch the
//! app may not know it owes), and a session's pause that session (no other
//! answer is delivered to a session whose delivery is unknown before its pause
//! is confirmed, §9).

use std::collections::BTreeSet;

use serde_json::{json, Value};

use super::flow::{AppRoute, DmApp, DmLocal, LocalRoute};
use super::wire::{lookup_settled, read_app_answer, submission_settled, AppAnswer, HttpAnswer};

#[derive(Debug, Clone, PartialEq)]
pub enum OwedRecord {
    /// §2-3: close an assigned request whose card was not sent.
    Discard { request_id: String },
    /// §10: a transmission's receipt, or its unknown outcome.
    TransmitOutcome {
        request_id: String,
        instance: String,
        outcome: &'static str,
    },
    /// §5: a cleanup the broker could not confirm. Nothing more is sent to
    /// the instance while it is owed.
    CleanupUnknown {
        request_id: String,
        instance: String,
    },
    /// §9: a result whose answer was lost and that its lookup did not find.
    Result {
        request_id: String,
        instance: String,
        submission: Value,
        result_digest: String,
        /// Whether `results/unknown` has its answer (or has nothing to record).
        unknown_settled: bool,
    },
    /// Stage S2-2b3: a delivery decision's outcome -- `receipt`, `unknown`,
    /// or `not_sent` with its reason.
    DeliveryOutcome {
        request_id: String,
        outcome: &'static str,
        reason: Option<&'static str>,
    },
    /// §9: pause the session of a delivery whose result is unknown, and read
    /// its receipt. No other answer goes to the session while it is owed.
    Pause {
        card_id: String,
        question_revision: i64,
        request_id: String,
        session: String,
    },
}

impl OwedRecord {
    /// The instance this record holds back, if any.
    pub fn held_instance(&self) -> Option<&str> {
        match self {
            OwedRecord::CleanupUnknown { instance, .. } => Some(instance),
            _ => None,
        }
    }

    /// The session this record holds back, if any.
    pub fn held_session(&self) -> Option<&str> {
        match self {
            OwedRecord::Pause { session, .. } => Some(session),
            _ => None,
        }
    }

    /// A short name for the log line: the request id and a code, never a body.
    pub fn code(&self) -> &'static str {
        match self {
            OwedRecord::Discard { .. } => "assignment_discard",
            OwedRecord::TransmitOutcome { .. } => "transmit_outcome",
            OwedRecord::CleanupUnknown { .. } => "cleanup_unknown",
            OwedRecord::Result { .. } => "result",
            OwedRecord::DeliveryOutcome { .. } => "delivery_outcome",
            OwedRecord::Pause { .. } => "session_pause",
        }
    }

    pub fn request_id(&self) -> &str {
        match self {
            OwedRecord::Discard { request_id }
            | OwedRecord::TransmitOutcome { request_id, .. }
            | OwedRecord::CleanupUnknown { request_id, .. }
            | OwedRecord::Result { request_id, .. }
            | OwedRecord::DeliveryOutcome { request_id, .. }
            | OwedRecord::Pause { request_id, .. } => request_id,
        }
    }
}

/// A refusal that says nothing about the request: the write is still owed.
/// Every other refusal is the ledger's own answer -- the record is there, or
/// can never be -- and settles it.
pub fn refused_for_now(reason: &str) -> bool {
    reason.starts_with("amux_database_")
        || matches!(
            reason,
            "unauthorized"
                | "dm_routing_disabled"
                | "dm_digest_keys_unavailable"
                | "dm_digest_key_unavailable"
                | "settings_unreadable"
                | "state_unreadable"
                | "dm_key_period_changed"
        )
}

/// Whether one answer settles a keyed record.
fn settles(answer: &AppAnswer) -> bool {
    match answer {
        AppAnswer::Done(_) => true,
        AppAnswer::Refused(reason) => !refused_for_now(reason),
        AppAnswer::Unknown => false,
    }
}

async fn app_write<A: DmApp + ?Sized>(app: &A, route: AppRoute, body: Value) -> AppAnswer {
    read_app_answer(&app.post(route, body).await, route.envelope())
}

/// Sends one owed record once. True when it is settled; a record still owed
/// may have changed (a result whose `results/unknown` was answered).
pub async fn settle<A, L>(app: &A, local: &L, record: &mut OwedRecord) -> bool
where
    A: DmApp + ?Sized,
    L: DmLocal + ?Sized,
{
    match record {
        OwedRecord::Discard { request_id } => settles(
            &app_write(
                app,
                AppRoute::AssignmentDiscard,
                json!({"request_id": request_id}),
            )
            .await,
        ),
        OwedRecord::TransmitOutcome {
            request_id,
            instance,
            outcome,
        } => settles(
            &app_write(
                app,
                AppRoute::TransmissionOutcome,
                json!({"request_id": request_id, "instance": instance, "outcome": outcome}),
            )
            .await,
        ),
        OwedRecord::CleanupUnknown {
            request_id,
            instance,
        } => settles(
            &app_write(
                app,
                AppRoute::CleanupUnknown,
                json!({"request_id": request_id, "instance": instance}),
            )
            .await,
        ),
        OwedRecord::DeliveryOutcome {
            request_id,
            outcome,
            reason,
        } => {
            let body = match reason {
                Some(reason) => {
                    json!({"request_id": request_id, "outcome": outcome, "reason": reason})
                }
                None => json!({"request_id": request_id, "outcome": outcome}),
            };
            settles(&app_write(app, AppRoute::DeliveryOutcome, body).await)
        }
        OwedRecord::Pause {
            card_id,
            question_revision,
            request_id,
            session,
        } => {
            let paused = local
                .post(
                    LocalRoute::AnswerUnknown,
                    json!({"card_id": card_id, "question_revision": question_revision,
                        "request_id": request_id, "session": session}),
                )
                .await;
            pause_confirmed(&paused)
        }
        OwedRecord::Result {
            request_id,
            instance,
            submission,
            result_digest,
            unknown_settled,
        } => {
            // The read-back first: the pair may be on the ledger already.
            if let AppAnswer::Done(value) = app_write(
                app,
                AppRoute::ResultLookup,
                json!({"request_id": request_id, "result_digest": result_digest}),
            )
            .await
            {
                if lookup_settled(&value) == Some(true) {
                    return true;
                }
            }
            match app_write(app, AppRoute::Results, submission.clone()).await {
                AppAnswer::Done(value) if submission_settled(&value) => return true,
                AppAnswer::Refused(reason) if !refused_for_now(&reason) => return true,
                _ => {}
            }
            if !*unknown_settled {
                match app_write(
                    app,
                    AppRoute::ResultUnknown,
                    json!({"request_id": request_id, "instance": instance, "result_digest": result_digest}),
                )
                .await
                {
                    AppAnswer::Refused(reason)
                        if reason == "already_accepted" || reason == "already_rejected" =>
                    {
                        return true
                    }
                    answer if settles(&answer) => *unknown_settled = true,
                    _ => {}
                }
            }
            false
        }
    }
}

/// The local AMUX confirmed the session paused.
pub fn pause_confirmed(answer: &HttpAnswer) -> bool {
    matches!(answer, HttpAnswer::Answered { status: 200, body }
        if serde_json::from_slice::<Value>(body).ok().and_then(|value| value.get("paused").and_then(Value::as_bool)) == Some(true))
}

/// Sends every owed record once, in order, and keeps the ones still owed.
/// Returns how many were settled.
pub async fn settle_all<A, L>(app: &A, local: &L, owed: &mut Vec<OwedRecord>) -> usize
where
    A: DmApp + ?Sized,
    L: DmLocal + ?Sized,
{
    let mut still = Vec::new();
    let mut settled = 0;
    for mut record in std::mem::take(owed) {
        if settle(app, local, &mut record).await {
            settled += 1;
            println!(
                "amux dm relay: owed {} for request {} recorded",
                record.code(),
                record.request_id()
            );
        } else {
            still.push(record);
        }
    }
    *owed = still;
    settled
}

/// The instances held back by the owed records.
pub fn held_instances(owed: &[OwedRecord]) -> BTreeSet<String> {
    owed.iter()
        .filter_map(OwedRecord::held_instance)
        .map(str::to_owned)
        .collect()
}

/// The sessions held back by the owed records.
pub fn held_sessions(owed: &[OwedRecord]) -> BTreeSet<String> {
    owed.iter()
        .filter_map(OwedRecord::held_session)
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dm_relay::flow::tests::{
        answered, recorded, refused, FakeApp, FakeLocal, REQUEST_ID,
    };

    #[test]
    fn only_a_refusal_about_nothing_in_the_request_keeps_a_record_owed() {
        for reason in [
            "amux_database_busy",
            "amux_database_deadline_exceeded",
            "unauthorized",
            "dm_routing_disabled",
            "settings_unreadable",
        ] {
            assert!(refused_for_now(reason), "{reason}");
        }
        for reason in [
            "closed",
            "transmit_outcome_recorded",
            "outcome_recorded",
            "not_assigned",
            "invalid_input",
        ] {
            assert!(!refused_for_now(reason), "{reason}");
        }
    }

    #[tokio::test]
    async fn a_keyed_record_is_sent_again_until_the_ledger_answers_for_it() {
        let local = FakeLocal::default();
        for (answer, settled) in [
            (HttpAnswer::Lost, false),
            (refused(503, "recorded", "amux_database_busy"), false),
            (refused(409, "recorded", "dm_routing_disabled"), false),
            (refused(409, "recorded", "closed"), true),
            (recorded(), true),
        ] {
            let app = FakeApp::with(vec![(AppRoute::AssignmentDiscard, answer.clone())]);
            let mut record = OwedRecord::Discard {
                request_id: REQUEST_ID.into(),
            };
            assert_eq!(
                settle(&app, &local, &mut record).await,
                settled,
                "{answer:?}"
            );
        }
    }

    #[tokio::test]
    async fn an_owed_result_is_read_back_before_it_is_submitted_again() {
        let local = FakeLocal::default();
        let record = || OwedRecord::Result {
            request_id: REQUEST_ID.into(),
            instance: "decision-maker-openai".into(),
            submission: json!({"request_id": REQUEST_ID}),
            result_digest: "d".repeat(64),
            unknown_settled: true,
        };
        // Found by its pair: never submitted again.
        let app = FakeApp::with(vec![(
            AppRoute::ResultLookup,
            answered(200, json!({"found": true, "status": "accepted"})),
        )]);
        assert!(settle(&app, &local, &mut record()).await);
        assert_eq!(app.routes(), vec![AppRoute::ResultLookup]);
        // Not found: submitted again, and the ledger's answer settles it.
        let app = FakeApp::with(vec![
            (
                AppRoute::ResultLookup,
                answered(200, json!({"found": true, "status": "not_recorded"})),
            ),
            (
                AppRoute::Results,
                answered(200, json!({"submitted": true, "status": "accepted"})),
            ),
        ]);
        assert!(settle(&app, &local, &mut record()).await);
        assert_eq!(
            app.routes(),
            vec![AppRoute::ResultLookup, AppRoute::Results]
        );
        // Nothing answers: still owed.
        let app = FakeApp::default();
        assert!(!settle(&app, &local, &mut record()).await);
        // A result whose unknown is not recorded yet records it, and stays owed.
        let app = FakeApp::with(vec![(AppRoute::ResultUnknown, recorded())]);
        let mut owed = OwedRecord::Result {
            request_id: REQUEST_ID.into(),
            instance: "decision-maker-openai".into(),
            submission: json!({}),
            result_digest: "d".repeat(64),
            unknown_settled: false,
        };
        assert!(!settle(&app, &local, &mut owed).await);
        assert!(matches!(
            owed,
            OwedRecord::Result {
                unknown_settled: true,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn an_owed_pause_holds_its_session_until_the_local_amux_confirms_it() {
        let local = FakeLocal::default();
        let mut owed = vec![OwedRecord::Pause {
            card_id: "AMUX-1".into(),
            question_revision: 1,
            request_id: REQUEST_ID.into(),
            session: "claude-impl".into(),
        }];
        let app = FakeApp::default();
        assert_eq!(settle_all(&app, &local, &mut owed).await, 0);
        assert_eq!(
            held_sessions(&owed).into_iter().collect::<Vec<_>>(),
            vec!["claude-impl"]
        );
        local
            .answers
            .lock()
            .unwrap()
            .entry(LocalRoute::AnswerUnknown.path())
            .or_default()
            .push_back(answered(200, json!({"paused": true})));
        assert_eq!(settle_all(&app, &local, &mut owed).await, 1);
        assert!(owed.is_empty());
    }
}
