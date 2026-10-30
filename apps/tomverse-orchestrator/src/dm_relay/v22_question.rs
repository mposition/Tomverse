//! A v22 worker's question to the owner through the Decision Maker (Tomverse
//! operator decision 2026-10-30).
//!
//! A v22 worker runs one CLI invocation with no session to wait in, so its
//! question lives in the app (`AmuxV22TaskQuestion`). Each tick, before the
//! question scan, the relay asks the app (`v22-questions/sync`) with its place
//! in the walk over confirmed proposals (`after`): the app takes one step of
//! that walk, answering an open question whose DM proposal a person confirmed,
//! says where the walk goes next, and names the open questions that still need
//! a local card and the cards of questions no longer open. The relay files each pending question as a
//! typed-ask card in `needsyou` owned by the worker's session name
//! (`/api/dm-relay/v22-questions`), so the ordinary scan routes it to a DM,
//! records the card in the app, and closes the listed cards
//! (`/api/dm-relay/v22-questions/close`) before recording that too.
//!
//! Every step is idempotent by its own key -- the local AMUX files one card per
//! question id and closing a closed card is a read; the app records one card
//! per question and one close -- so a lost answer is settled by the next tick
//! reading the same list again, never by a different write. Nothing here halts
//! the relay, sends a message to a session, or carries a DM output: the
//! confirmed answer is applied by the app itself.

use serde_json::{json, Value};

use super::flow::{AppRoute, DmApp, DmLocal, LocalRoute};
use super::wire::{read_app_answer, AppAnswer, HttpAnswer};

/// At most this many cards filed or closed per tick (the app lists three).
pub const V22_QUESTION_TICK_LIMIT: usize = 3;

/// Where the walk over confirmed proposals goes next, as the app said.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub enum V22Cursor {
    /// No answer, or the kill switch: ask again from the same place.
    #[default]
    Keep,
    /// The walk reached its end: start again from the beginning.
    Reset,
    /// The next step starts after this confirmation (`{judged_at_ms, request_id}`).
    Advance(Value),
}

/// What one tick did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct V22QuestionRun {
    pub cursor: V22Cursor,
    /// The app answered a question from a confirmed proposal this tick.
    pub resolved: bool,
    /// Cards filed and recorded in the app.
    pub filed: usize,
    /// Cards closed and recorded in the app.
    pub closed: usize,
}

impl V22QuestionRun {
    pub fn did_work(&self) -> bool {
        self.resolved || self.filed > 0 || self.closed > 0
    }
}

fn local_json(answer: &HttpAnswer) -> Option<Value> {
    match answer {
        HttpAnswer::Answered { status: 200, body } => serde_json::from_slice(body).ok(),
        _ => None,
    }
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// The card the local AMUX files, from the app's pending entry: exactly the
/// fields its route takes, nothing the app might add.
fn card_body(entry: &Value) -> Option<Value> {
    let options: Vec<Value> = entry
        .get("options")?
        .as_array()?
        .iter()
        .map(|option| Some(json!({"id": text(option, "id")?, "label": text(option, "label")?})))
        .collect::<Option<_>>()?;
    Some(json!({
        "question_id": text(entry, "question_id")?,
        "worker": text(entry, "worker")?,
        "title": text(entry, "title")?,
        "question": text(entry, "question")?,
        "unblocks": text(entry, "unblocks")?,
        "options": options,
    }))
}

fn cursor_of(sync: &Value) -> V22Cursor {
    let Some(cursor) = sync.get("cursor") else { return V22Cursor::Keep };
    match text(cursor, "move") {
        Some("reset") => V22Cursor::Reset,
        Some("advance") => match (cursor.get("judged_at_ms").and_then(Value::as_i64), text(cursor, "request_id")) {
            (Some(at), Some(request_id)) if at >= 0 => {
                V22Cursor::Advance(json!({"judged_at_ms": at, "request_id": request_id}))
            }
            _ => V22Cursor::Keep,
        },
        _ => V22Cursor::Keep,
    }
}

pub async fn sync_v22_questions<A, L>(app: &A, local: &L, after: Option<&Value>) -> V22QuestionRun
where
    A: DmApp + ?Sized,
    L: DmLocal + ?Sized,
{
    let mut run = V22QuestionRun::default();
    let route = AppRoute::V22QuestionSync;
    let body = json!({"after": after.cloned().unwrap_or(Value::Null)});
    let AppAnswer::Done(sync) = read_app_answer(&app.post(route, body).await, route.envelope()) else {
        return run;
    };
    run.resolved = text(&sync, "resolved").is_some();
    run.cursor = cursor_of(&sync);
    let entries = |key: &str| -> Vec<Value> {
        sync.get(key)
            .and_then(Value::as_array)
            .map(|items| items.iter().take(V22_QUESTION_TICK_LIMIT).cloned().collect())
            .unwrap_or_default()
    };

    for entry in entries("pending") {
        let Some(body) = card_body(&entry) else { continue };
        let question_id = body["question_id"].clone();
        let filed = local.post(LocalRoute::V22QuestionFile, body).await;
        let Some(card_id) = local_json(&filed).and_then(|value| text(&value, "card_id").map(str::to_owned)) else {
            continue;
        };
        let route = AppRoute::V22QuestionCard;
        let recorded = app.post(route, json!({"question_id": question_id, "card_id": card_id})).await;
        if matches!(read_app_answer(&recorded, route.envelope()), AppAnswer::Done(_)) {
            run.filed += 1;
        }
    }

    for entry in entries("closing") {
        let (Some(question_id), Some(card_id)) = (text(&entry, "question_id"), text(&entry, "card_id")) else {
            continue;
        };
        let closed = local.post(LocalRoute::V22QuestionClose, json!({"card_id": card_id})).await;
        if local_json(&closed).and_then(|value| value.get("closed").and_then(Value::as_bool)) != Some(true) {
            continue;
        }
        let route = AppRoute::V22QuestionClosed;
        let recorded = app.post(route, json!({"question_id": question_id, "card_id": card_id})).await;
        if matches!(read_app_answer(&recorded, route.envelope()), AppAnswer::Done(_)) {
            run.closed += 1;
        }
    }
    run
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::Mutex;

    use super::super::flow::LocalRead;

    fn answered(status: u16, body: Value) -> HttpAnswer {
        HttpAnswer::Answered { status, body: serde_json::to_vec(&body).unwrap() }
    }

    const QUESTION: &str = "00000000-0000-4000-8000-00000000000a";

    struct App {
        sync: HttpAnswer,
        calls: Mutex<Vec<(AppRoute, Value)>>,
    }

    #[async_trait]
    impl DmApp for App {
        async fn post(&self, route: AppRoute, body: Value) -> HttpAnswer {
            self.calls.lock().unwrap().push((route, body));
            match route {
                AppRoute::V22QuestionSync => self.sync.clone(),
                _ => answered(200, json!({"recorded": true})),
            }
        }
    }

    struct Local {
        answer: HttpAnswer,
        calls: Mutex<Vec<(LocalRoute, Value)>>,
    }

    #[async_trait]
    impl DmLocal for Local {
        async fn get(&self, _path: &str) -> LocalRead {
            LocalRead::Failed
        }
        async fn post(&self, route: LocalRoute, body: Value) -> HttpAnswer {
            self.calls.lock().unwrap().push((route, body));
            self.answer.clone()
        }
    }

    fn pending() -> Value {
        json!({"question_id": QUESTION, "worker": "codex-impl", "title": "v22 Task t question 1",
            "question": "Which copy?", "unblocks": "the copy",
            "options": [{"id": "a", "label": "Short"}], "extra": "dropped"})
    }

    #[tokio::test]
    async fn a_pending_question_is_filed_once_and_its_card_recorded() {
        let app = App {
            sync: answered(200, json!({"synced": true, "resolved": null, "pending": [pending()], "closing": []})),
            calls: Mutex::new(vec![]),
        };
        let local = Local { answer: answered(200, json!({"card_id": "CI-9", "created": true})), calls: Mutex::new(vec![]) };
        let run = sync_v22_questions(&app, &local, None).await;
        assert_eq!(run, V22QuestionRun { cursor: V22Cursor::Keep, resolved: false, filed: 1, closed: 0 });
        assert_eq!(app.calls.lock().unwrap()[0].1, json!({"after": null}));
        let filed = local.calls.lock().unwrap();
        assert_eq!(filed.len(), 1);
        assert_eq!(filed[0].0, LocalRoute::V22QuestionFile);
        assert!(filed[0].1.get("extra").is_none(), "only the route's own fields");
        let calls = app.calls.lock().unwrap();
        assert_eq!(calls[1], (AppRoute::V22QuestionCard, json!({"question_id": QUESTION, "card_id": "CI-9"})));
    }

    #[tokio::test]
    async fn a_closing_card_is_recorded_only_after_the_local_close() {
        let closing = json!({"synced": true, "resolved": "answered",
            "cursor": {"move": "advance", "judged_at_ms": 7, "request_id": "r-1"}, "pending": [],
            "closing": [{"question_id": QUESTION, "card_id": "CI-9"}]});
        let app = App { sync: answered(200, closing.clone()), calls: Mutex::new(vec![]) };
        let local = Local { answer: answered(200, json!({"closed": true})), calls: Mutex::new(vec![]) };
        let after = json!({"judged_at_ms": 3, "request_id": "r-0"});
        let run = sync_v22_questions(&app, &local, Some(&after)).await;
        assert_eq!(run, V22QuestionRun {
            cursor: V22Cursor::Advance(json!({"judged_at_ms": 7, "request_id": "r-1"})),
            resolved: true, filed: 0, closed: 1,
        });
        assert_eq!(app.calls.lock().unwrap()[0].1, json!({"after": after}));
        assert_eq!(app.calls.lock().unwrap()[1].0, AppRoute::V22QuestionClosed);

        let app = App { sync: answered(200, closing), calls: Mutex::new(vec![]) };
        let refused = Local { answer: answered(409, json!({"reason": "not_a_v22_question_card"})), calls: Mutex::new(vec![]) };
        assert_eq!(sync_v22_questions(&app, &refused, None).await.closed, 0);
        assert_eq!(app.calls.lock().unwrap().len(), 1, "nothing recorded without the close");
    }

    #[tokio::test]
    async fn a_closed_or_lost_sync_writes_nothing() {
        for sync in [answered(409, json!({"synced": false, "reason": "dm_routing_disabled"})), HttpAnswer::Lost] {
            let app = App { sync, calls: Mutex::new(vec![]) };
            let local = Local { answer: HttpAnswer::Lost, calls: Mutex::new(vec![]) };
            assert_eq!(sync_v22_questions(&app, &local, None).await, V22QuestionRun::default());
            assert!(local.calls.lock().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn a_lost_file_records_no_card() {
        let app = App {
            sync: answered(200, json!({"synced": true, "resolved": null, "pending": [pending()], "closing": []})),
            calls: Mutex::new(vec![]),
        };
        let local = Local { answer: HttpAnswer::Lost, calls: Mutex::new(vec![]) };
        assert_eq!(sync_v22_questions(&app, &local, None).await.filed, 0);
        assert_eq!(app.calls.lock().unwrap().len(), 1);
    }
}
