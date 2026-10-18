//! `GET /api/board/{id}/typed-ask`: what the Decision Maker side of a typed
//! ask holds for a card (crate::db::dm_ask, docs/policy/amux-decision-maker.md).
//!
//! Read-only on purpose. A worker writes its typed ask through the ordinary
//! board create and PATCH (`typed_ask` beside `ask_type`/`ask_question`/
//! `ask_unblocks`); this answers what was recorded: the extension as stored,
//! with each effect declaration as recorded, the card's current question
//! revision, and the DM-pending marker and answer record of that revision.
//! Setting or releasing the marker and claiming the answer record get their
//! HTTP verbs with their callers, outside `/api/board`, because the bridge
//! that will call them never posts to `/api/board`.

use super::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use rusqlite::OptionalExtension;
use serde_json::json;

pub async fn get_typed_ask(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let id_r = id.clone();
    let read = state
        .store
        .read_async(move |conn| {
            let exists = conn
                .query_row(
                    "SELECT 1 FROM issues WHERE id = ?1 AND deleted IS NULL",
                    [&id_r],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if !exists {
                return Ok(None);
            }
            Ok(Some(crate::db::dm_ask::state_json(conn, &id_r)?))
        })
        .await;
    match read {
        Ok(Some(body)) => Json(body).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "item not found", "id": id })),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": error.to_string(), "id": id })),
        )
            .into_response(),
    }
}

/// The question revision a dashboard request says the operator answered:
/// `{"question_revision": <n>}` for the typed question it showed, or
/// `{"question_revision": null}` when the card showed none. Nothing else is
/// accepted, so an answer never claims a revision nobody named.
fn observed_revision(body: &[u8]) -> Option<Option<i64>> {
    let value = serde_json::from_slice::<serde_json::Value>(body).ok()?;
    let object = value.as_object()?;
    if object.len() != 1 {
        return None;
    }
    match object.get("question_revision")? {
        serde_json::Value::Null => Some(None),
        serde_json::Value::Number(number) => number.as_i64().filter(|revision| *revision >= 1).map(Some),
        _ => None,
    }
}

/// `POST /api/board/{id}/typed-ask/answer`: the operator's direct answer
/// claims the card's answer record before the dashboard sends it
/// (docs/policy/amux-decision-maker.md §2-7: "운영자의 직접 답과 확정된 DM 답이
/// 모두 그 기록을 먼저 써야 보낸다"). The body names the question revision the
/// dashboard showed the operator; in the writer's transaction, only while that
/// is still the card's current revision, it is claimed as `operator`:
///
/// - `claimed`: this answer owns the revision; the dashboard sends it.
/// - `already_answered` with the record: an operator-confirmed Decision Maker
///   answer owns it, or the operator's own earlier answer (another tab, a
///   second click) does, and either way the dashboard sends nothing and says
///   so -- one answer per question revision, whoever wrote it first (review
///   r-20261018-065705-65cb2a).
/// - `question_changed` with the card's current revision (null when it asks
///   none): the worker re-asked, or stopped asking, since the dashboard read
///   the card. Nothing is claimed and the dashboard sends nothing, so an
///   answer to the old question never takes the new one -- nor refuses the
///   new question's confirmed answer (review r-20261018-062643-057a27).
/// - `no_typed_revision`: the card showed no typed question and asks none now
///   (an ordinary ask, or one a writer moved without recording a revision),
///   so no Decision Maker answer can be delivered to it either, and nothing
///   is claimed.
///
/// A worker session cannot claim the operator's answer: a request carrying a
/// worker identity header is refused before anything is read.
pub async fn claim_operator_answer(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let worker = ["x-amux-worker", "x-amux-session"].iter().any(|name| {
        headers
            .get(*name)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| !value.trim().is_empty())
    });
    if worker {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "a worker session cannot claim the operator's answer", "reason": "worker_session" })),
        )
            .into_response();
    }
    let Some(observed) = observed_revision(&body) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "name the question revision you answered: {\"question_revision\": <n> | null}",
                "reason": "question_revision_required",
            })),
        )
            .into_response();
    };
    let actor = super::org::local_member_actor(&headers)
        .map(str::to_string)
        .or_else(|| {
            headers
                .get("x-amux-user-email")
                .and_then(|value| value.to_str().ok())
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| "owner".to_string());
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0);
    let slot: std::sync::Arc<std::sync::Mutex<Option<serde_json::Value>>> = Default::default();
    let out = slot.clone();
    let id_w = id.clone();
    let written = state
        .store
        .write_async(move |conn| {
            use crate::db::dm_ask::{self, AnswerClaim, AnswerSource};
            let exists = conn
                .query_row(
                    "SELECT 1 FROM issues WHERE id = ?1 AND deleted IS NULL",
                    [&id_w],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            let answer = if !exists {
                None
            } else {
                let current = dm_ask::current_revision(conn, &id_w)?.map(|revision| revision.question_revision);
                Some(match (observed, current) {
                    (None, None) => json!({ "outcome": "no_typed_revision" }),
                    // The revision the operator answered is the one the card asks:
                    // claim it, in this same transaction.
                    (Some(revision), Some(now_asked)) if revision == now_asked => {
                        match dm_ask::claim_answer(conn, &id_w, revision, &AnswerSource::Operator, &actor, now)? {
                            AnswerClaim::Claimed(record) => {
                                json!({ "outcome": "claimed", "question_revision": revision, "answer": record })
                            }
                            AnswerClaim::AlreadyAnswered(record) => {
                                json!({ "outcome": "already_answered", "question_revision": revision, "answer": record })
                            }
                            AnswerClaim::Refused(reason) => json!({ "outcome": "refused", "reason": reason }),
                        }
                    }
                    (_, current) => json!({ "outcome": "question_changed", "question_revision": current }),
                })
            };
            let applied = answer.as_ref().is_some_and(|value| value["outcome"] == "claimed");
            *out.lock().expect("typed ask answer slot") = answer;
            Ok(crate::db::WriteOutcome {
                applied,
                events: vec![],
            })
        })
        .await;
    let answer = slot.lock().expect("typed ask answer slot").take();
    match (written, answer) {
        (Ok(_), Some(body)) => Json(body).into_response(),
        (Ok(_), None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "item not found", "id": id })),
        )
            .into_response(),
        (Err(error), _) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": error.to_string(), "id": id })),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use serde_json::Value;
    use std::sync::Arc;
    use tower::ServiceExt;

    const WORKER: &str = "dm-typed-ask-test-worker";

    /// The dashboard's own call: no worker identity header, and the body it
    /// sends -- the question revision it observed.
    async fn owner_call(app: &Router, uri: &str, body: Value) -> (StatusCode, Value) {
        let request = axum::http::Request::builder()
            .method("POST")
            .uri(uri)
            .header("content-type", "application/json")
            .body(axum::body::Body::from(body.to_string()))
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// §12's local criterion from the dashboard's side: the operator's direct
    /// answer claims the record first, so a confirmed Decision Maker answer
    /// that comes after it is refused, and one that came before it stops the
    /// direct answer. A worker cannot claim in the operator's name.
    #[tokio::test]
    async fn the_direct_answer_claims_the_record_and_one_answer_is_delivered_whichever_comes_first() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::api::settings::test_env::set_home(home.path());
        let (app, store, _db_dir) = app();
        let (_, created) = call(
            &app,
            "POST",
            "/api/board",
            Some(asking(json!({"typed_ask": options()}))),
        )
        .await;
        let id = created["id"].as_str().unwrap().to_string();
        let uri = format!("/api/board/{id}/typed-ask/answer");

        // A worker identity is refused, and nothing is claimed.
        let (status, refused) = call(&app, "POST", &uri, Some(json!({}))).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
        assert_eq!(refused["reason"], "worker_session");
        let (_, state) = call(&app, "GET", &format!("/api/board/{id}/typed-ask"), None).await;
        assert!(state["answer"].is_null(), "{state}");

        // The operator claims revision 1; a confirmed DM answer is then refused.
        let (status, claimed) = owner_call(&app, &uri, json!({"question_revision": 1})).await;
        assert_eq!(status, StatusCode::OK, "{claimed}");
        assert_eq!(claimed["outcome"], "claimed");
        assert_eq!(claimed["question_revision"], 1);
        assert_eq!(claimed["answer"]["source"], "operator");
        let card = id.clone();
        let late = store
            .write(move |conn| {
                let claim = crate::db::dm_ask::claim_answer(
                    conn,
                    &card,
                    1,
                    &crate::db::dm_ask::AnswerSource::DmConfirmed {
                        request_id: "0b0e3b50-0f7e-4b8a-8f39-2d2b9f6c1a10".into(),
                    },
                    "amux-dm-relay",
                    2,
                )?;
                assert!(
                    matches!(claim, crate::db::dm_ask::AnswerClaim::AlreadyAnswered(ref record) if record.source == "operator"),
                    "{claim:?}"
                );
                Ok(crate::db::WriteOutcome { applied: false, events: vec![] })
            });
        assert!(late.is_ok());
        // The operator answering again (another tab) is told who already answered; the
        // dashboard sends nothing (tests/amuxDecisionMakerDashboardAnswer.test.mjs).
        let (_, again) = owner_call(&app, &uri, json!({"question_revision": 1})).await;
        assert_eq!(again["outcome"], "already_answered");
        assert_eq!(again["answer"]["source"], "operator");

        // A re-asked question is revision 2: a confirmed DM answer claims it
        // first, and the operator's direct answer is then refused.
        let (status, _) = call(
            &app,
            "PATCH",
            &format!("/api/board/{id}"),
            Some(json!({"ask_question": "Should the index be dropped instead?", "typed_ask": options()})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let card = id.clone();
        store
            .write(move |conn| {
                let claim = crate::db::dm_ask::claim_answer(
                    conn,
                    &card,
                    2,
                    &crate::db::dm_ask::AnswerSource::DmConfirmed {
                        request_id: "0b0e3b50-0f7e-4b8a-8f39-2d2b9f6c1a10".into(),
                    },
                    "amux-dm-relay",
                    3,
                )?;
                assert!(matches!(claim, crate::db::dm_ask::AnswerClaim::Claimed(_)), "{claim:?}");
                Ok(crate::db::WriteOutcome { applied: true, events: vec![] })
            })
            .unwrap();
        let (_, refused) = owner_call(&app, &uri, json!({"question_revision": 2})).await;
        assert_eq!(refused["outcome"], "already_answered", "{refused}");
        assert_eq!(refused["question_revision"], 2);
        assert_eq!(refused["answer"]["source"], "dm_confirmed");

        // An unknown card is 404.
        let (status, _) = owner_call(
            &app,
            "/api/board/NOPE-404/typed-ask/answer",
            json!({"question_revision": 1}),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    /// Review r-20261018-062643-057a27, finding 1: the operator answers the
    /// question revision the dashboard showed, not whatever the card asks when
    /// the POST lands. A worker that re-asked while the answer dialog was open
    /// must not have its new question taken by an answer to the old one --
    /// which would send that answer and refuse the new question's confirmed
    /// Decision Maker answer. The claim holds only when the observed revision
    /// is the current one; otherwise nothing is claimed and the dashboard says
    /// the question changed.
    #[tokio::test]
    async fn a_direct_answer_to_a_question_the_worker_replaced_claims_nothing() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::api::settings::test_env::set_home(home.path());
        let (app, store, _db_dir) = app();
        let (_, created) = call(
            &app,
            "POST",
            "/api/board",
            Some(asking(json!({"typed_ask": options()}))),
        )
        .await;
        let id = created["id"].as_str().unwrap().to_string();
        let uri = format!("/api/board/{id}/typed-ask/answer");
        // The dashboard opens the answer dialog on revision 1.
        let (_, seen) = call(&app, "GET", &format!("/api/board/{id}/typed-ask"), None).await;
        assert_eq!(seen["current_revision"]["question_revision"], 1);
        // The worker re-asks before the operator sends.
        let (status, _) = call(
            &app,
            "PATCH",
            &format!("/api/board/{id}"),
            Some(json!({"ask_question": "Should the index be dropped instead?", "typed_ask": options()})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let (status, changed) = owner_call(&app, &uri, json!({"question_revision": 1})).await;
        assert_eq!(status, StatusCode::OK, "{changed}");
        assert_eq!(
            changed,
            json!({"outcome": "question_changed", "question_revision": 2}),
            "the old answer does not take the new question"
        );
        // A dialog opened on a card with no typed question claims nothing on one that has one now.
        let (_, changed) = owner_call(&app, &uri, json!({"question_revision": null})).await;
        assert_eq!(changed["outcome"], "question_changed", "{changed}");
        let (_, state) = call(&app, "GET", &format!("/api/board/{id}/typed-ask"), None).await;
        assert!(state["answer"].is_null(), "revision 2 is still unanswered: {state}");
        // So the new question's confirmed answer can still be the one answer.
        let card = id.clone();
        store
            .write(move |conn| {
                let claim = crate::db::dm_ask::claim_answer(
                    conn,
                    &card,
                    2,
                    &crate::db::dm_ask::AnswerSource::DmConfirmed {
                        request_id: "0b0e3b50-0f7e-4b8a-8f39-2d2b9f6c1a10".into(),
                    },
                    "amux-dm-relay",
                    3,
                )?;
                assert!(matches!(claim, crate::db::dm_ask::AnswerClaim::Claimed(_)), "{claim:?}");
                Ok(crate::db::WriteOutcome { applied: true, events: vec![] })
            })
            .unwrap();

        // The body names the observed revision and nothing else.
        for bad in [
            json!({}),
            json!({"question_revision": "2"}),
            json!({"question_revision": 0}),
            json!({"question_revision": 2, "answer": "x"}),
            json!([2]),
        ] {
            let (status, _) = owner_call(&app, &uri, bad.clone()).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
        }
    }

    /// An ordinary ask has no typed revision: nothing to claim, and the
    /// dashboard's answer goes as before.
    #[tokio::test]
    async fn a_card_with_no_typed_revision_claims_nothing() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::api::settings::test_env::set_home(home.path());
        let (app, _store, _db_dir) = app();
        let (status, created) = call(
            &app,
            "POST",
            "/api/board",
            Some(json!({"title": "an ordinary card", "status": "todo"})),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{created}");
        let id = created["id"].as_str().unwrap();
        let uri = format!("/api/board/{id}/typed-ask/answer");
        let (status, answer) = owner_call(&app, &uri, json!({"question_revision": null})).await;
        assert_eq!(status, StatusCode::OK, "{answer}");
        assert_eq!(answer, json!({"outcome": "no_typed_revision"}));
        // A revision the card does not ask is a changed question, not "no typed revision".
        let (_, answer) = owner_call(&app, &uri, json!({"question_revision": 1})).await;
        assert_eq!(answer["outcome"], "question_changed", "{answer}");
    }

    /// The temp directory is returned, not leaked: each test holds it to its
    /// end, so the database is removed when the test finishes. Leaking it
    /// (`mem::forget`) left one directory per test per run in /tmp, and on the
    /// shared Ubuntu runner /tmp is a tmpfs with a per-user quota.
    fn app() -> (Router, crate::db::SharedStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(crate::db::Store::open(&dir.path().join("typed-ask.db")).unwrap());
        let state = AppState {
            store: store.clone(),
            started: std::time::Instant::now(),
            build_hash: "test".into(),
            auth_token: None,
            reconciled: Arc::new(std::sync::atomic::AtomicBool::new(true)),
        };
        (
            Router::new()
                .nest("/api/board", crate::api::board::routes())
                .with_state(state),
            store,
            dir,
        )
    }

    async fn call(
        app: &Router,
        method: &str,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut request = axum::http::Request::builder()
            .method(method)
            .uri(uri)
            .header("x-amux-session", WORKER);
        let payload = match body {
            Some(body) => {
                request = request.header("content-type", "application/json");
                axum::body::Body::from(body.to_string())
            }
            None => axum::body::Body::empty(),
        };
        let response = app
            .clone()
            .oneshot(request.body(payload).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    fn asking(extra: Value) -> Value {
        let mut body = json!({
            "title": "Pick the index store",
            "status": "needsyou",
            "ask_actor": "Ethan",
            "ask_type": "decision",
            "ask_question": "Which store should the index use?",
            "ask_unblocks": "The owner names the store to use.",
        });
        for (key, value) in extra.as_object().unwrap() {
            body[key] = value.clone();
        }
        body
    }

    fn options() -> Value {
        json!({
            "options": [
                {"id": "sqlite", "label": "Keep SQLite", "effect": "choice_only"},
                {"id": "pg", "label": "Move to Postgres", "effect": "branch_code_change",
                 "paths": ["crates/amux-server/src/db/mod.rs"]},
                {"id": "later", "label": "Decide next week", "effect": "deploy_now"}
            ],
            "resolution": "decision_only",
            "context": "The index grows by 40 MB a week.",
            "context_paths": ["docs/policy/amux-decision-maker.md"]
        })
    }

    fn revisions(store: &crate::db::SharedStore, id: &str) -> i64 {
        store
            .read()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM _amux_dm_ask_revisions WHERE issue_id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap()
    }

    #[tokio::test]
    async fn a_card_filed_asking_with_a_typed_ask_has_revision_one_as_recorded() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::api::settings::test_env::set_home(home.path());
        let (app, _store, _db_dir) = app();
        let (status, created) = call(
            &app,
            "POST",
            "/api/board",
            Some(asking(json!({"typed_ask": options()}))),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{created}");
        // The response shows the extension as recorded: the undeclarable
        // effect became `other`, not a refusal.
        assert_eq!(
            created["typed_ask"]["options"][2]["effect"], "other",
            "{created}"
        );
        let id = created["id"].as_str().unwrap().to_string();

        let (status, state) = call(&app, "GET", &format!("/api/board/{id}/typed-ask"), None).await;
        assert_eq!(status, StatusCode::OK, "{state}");
        assert_eq!(state["current_revision"]["question_revision"], 1, "{state}");
        let detail = &state["current_revision"]["detail"];
        assert_eq!(detail["resolution"], "decision_only");
        assert_eq!(
            detail["options"][1]["paths"][0],
            "crates/amux-server/src/db/mod.rs"
        );
        assert_eq!(
            detail["context_paths"][0],
            "docs/policy/amux-decision-maker.md"
        );
        assert_eq!(
            state["current_revision"]["ask_question"],
            "Which store should the index use?"
        );
        assert!(
            state["pending"].is_null() && state["answer"].is_null(),
            "{state}"
        );
    }

    #[tokio::test]
    async fn an_existing_ask_without_a_typed_ask_still_works_and_gets_an_empty_extension() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::api::settings::test_env::set_home(home.path());
        let (app, _store, _db_dir) = app();
        let (status, created) = call(&app, "POST", "/api/board", Some(asking(json!({})))).await;
        assert_eq!(status, StatusCode::CREATED, "{created}");
        assert!(
            created.get("typed_ask").is_none(),
            "nothing was sent, nothing is echoed"
        );
        let id = created["id"].as_str().unwrap();
        let (_, state) = call(&app, "GET", &format!("/api/board/{id}/typed-ask"), None).await;
        assert!(state["typed_ask"].is_null(), "{state}");
        assert_eq!(state["current_revision"]["question_revision"], 1, "{state}");
        assert_eq!(state["current_revision"]["detail"]["options"], json!([]));
    }

    #[tokio::test]
    async fn a_patch_carrying_only_typed_ask_is_applied_and_recorded_on_the_card() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::api::settings::test_env::set_home(home.path());
        let (app, store, _db_dir) = app();
        let (_, created) = call(
            &app,
            "POST",
            "/api/board",
            Some(asking(json!({"typed_ask": options()}))),
        )
        .await;
        let id = created["id"].as_str().unwrap().to_string();
        let rev_before = created["rev"].as_i64().unwrap();

        let narrower =
            json!({"options": [{"id": "sqlite", "label": "Keep SQLite", "effect": "choice_only"}]});
        let (status, patched) = call(
            &app,
            "PATCH",
            &format!("/api/board/{id}"),
            Some(json!({"typed_ask": narrower})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{patched}");
        assert_eq!(
            patched["applied"], true,
            "a typed_ask-only PATCH is not a no-op: {patched}"
        );
        assert!(patched["rev"].as_i64().unwrap() > rev_before);
        assert!(
            patched["log"].as_str().unwrap_or("").contains("typed_ask"),
            "the card's own history names the change"
        );
        assert_eq!(revisions(&store, &id), 2);

        // The same extension again changes nothing.
        let (status, again) = call(
            &app,
            "PATCH",
            &format!("/api/board/{id}"),
            Some(json!({"typed_ask": narrower})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{again}");
        assert_eq!(again["applied"], false, "{again}");
        assert_eq!(revisions(&store, &id), 2);
    }

    #[tokio::test]
    async fn re_asking_without_typed_ask_drops_the_previous_options() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::api::settings::test_env::set_home(home.path());
        let (app, store, _db_dir) = app();
        let (_, created) = call(
            &app,
            "POST",
            "/api/board",
            Some(asking(json!({"typed_ask": options()}))),
        )
        .await;
        let id = created["id"].as_str().unwrap().to_string();
        let (status, patched) = call(
            &app,
            "PATCH",
            &format!("/api/board/{id}"),
            Some(json!({"ask_question": "Should the index be dropped instead?"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{patched}");
        assert_eq!(revisions(&store, &id), 2);
        let (_, state) = call(&app, "GET", &format!("/api/board/{id}/typed-ask"), None).await;
        assert_eq!(state["current_revision"]["question_revision"], 2, "{state}");
        assert_eq!(
            state["current_revision"]["detail"]["options"],
            json!([]),
            "{state}"
        );
        assert_eq!(
            state["current_revision"]["ask_question"],
            "Should the index be dropped instead?"
        );

        // Re-sending the very same extension is what attaches it to the new
        // question, so it is a change, not a no-op.
        let (status, reattached) = call(
            &app,
            "PATCH",
            &format!("/api/board/{id}"),
            Some(json!({"typed_ask": options()})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{reattached}");
        assert_eq!(reattached["applied"], true, "{reattached}");
        assert_eq!(revisions(&store, &id), 3);
        let (_, state) = call(&app, "GET", &format!("/api/board/{id}/typed-ask"), None).await;
        assert_eq!(state["current_revision"]["question_revision"], 3, "{state}");
        assert_eq!(
            state["current_revision"]["detail"]["options"][0]["id"], "sqlite",
            "{state}"
        );
        assert_eq!(
            state["current_revision"]["ask_question"],
            "Should the index be dropped instead?"
        );
    }

    #[tokio::test]
    async fn a_malformed_typed_ask_refuses_the_whole_patch_and_writes_nothing() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::api::settings::test_env::set_home(home.path());
        let (app, store, _db_dir) = app();
        let (_, created) = call(
            &app,
            "POST",
            "/api/board",
            Some(asking(json!({"typed_ask": options()}))),
        )
        .await;
        let id = created["id"].as_str().unwrap().to_string();
        let (_, before) = call(&app, "GET", &format!("/api/board/{id}"), None).await;

        for (bad, code) in [
            (
                json!({"options": [{"id": "has space", "label": "x"}]}),
                "typed_ask_option_id",
            ),
            (json!({"resolution": "maybe"}), "typed_ask_resolution"),
            (json!({"context_paths": ["../outside"]}), "typed_ask_path"),
            (json!({"contextPaths": []}), "typed_ask_unknown_field"),
        ] {
            let (status, refused) = call(
                &app,
                "PATCH",
                &format!("/api/board/{id}"),
                Some(json!({"typed_ask": bad, "desc_append": "this must not land"})),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
            assert_eq!(refused["code"], code, "{refused}");
        }
        let (_, after) = call(&app, "GET", &format!("/api/board/{id}"), None).await;
        assert_eq!(after["rev"], before["rev"]);
        assert_eq!(after["desc"], before["desc"]);
        assert_eq!(revisions(&store, &id), 1);

        let (status, refused) = call(
            &app,
            "POST",
            "/api/board",
            Some(asking(json!({"typed_ask": {"options": [{"id": "a", "label": "x"}, {"id": "a", "label": "y"}]}}))),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
        assert_eq!(refused["code"], "typed_ask_option_id_repeated");
    }

    #[tokio::test]
    async fn an_unknown_card_is_404() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::api::settings::test_env::set_home(home.path());
        let (app, _store, _db_dir) = app();
        let (status, body) = call(&app, "GET", "/api/board/NOPE-404/typed-ask", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    }
}
