//! `POST /api/dm-relay/v22-questions` and `POST /api/dm-relay/v22-questions/close`:
//! a v22 worker's question to the owner as a typed-ask card (Tomverse operator
//! decision 2026-10-30), behind the relay's token like every other
//! `/api/dm-relay` route.
//!
//! A v22 worker runs one CLI invocation and has no session to wait in, so its
//! question lives in the Tomverse app. The bridge's relay files it here as a
//! card in `needsyou` with a typed ask, owned by the worker's session name, so
//! the Decision Maker path routes it like any worker's ask. The card carries
//! the tag [`V22_QUESTION_TAG`] and one [`question_tag`] naming the app's
//! question id: the same question filed again answers the card it already has.
//!
//! The confirmed answer is never typed into a session. The app answers the
//! question itself, and the answer checks and the delivery below
//! ([`refuses_delivery`]) refuse a v22 question card, so a confirmed answer
//! cannot reach the worker's tmux lane even if the app offered it. When the
//! question is no longer open in the app the relay closes the card here.

use super::AppState;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

use crate::db::board_store::{self as bs, NewIssue};
use crate::db::{dm_ask, PendingEvent, WriteOutcome};
use amux_core::revision::{EntityType, MutationKind};

/// Every v22 question card carries this tag.
pub const V22_QUESTION_TAG: &str = "v22-question";

const QUESTION_MAX: usize = 2_000;
const UNBLOCKS_MAX: usize = 1_000;
const TITLE_MAX: usize = 200;
const LABEL_MAX: usize = 300;
const OPTIONS_MAX: usize = 6;

/// The tag naming the app's question id on its card.
pub fn question_tag(question_id: &str) -> String {
    format!("v22q-{question_id}")
}

fn is_question_id(value: &str) -> bool {
    value.len() == 36
        && value
            .bytes()
            .enumerate()
            .all(|(i, b)| if [8, 13, 18, 23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() && !b.is_ascii_uppercase() })
}

fn bounded(value: &str, max: usize) -> bool {
    // The app allows the same: newlines, tabs and carriage returns.
    !value.trim().is_empty()
        && value.chars().count() <= max
        && !value.chars().any(|c| c.is_control() && !matches!(c, '\n' | '\t' | '\r'))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OptionBody {
    id: String,
    label: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FileBody {
    question_id: String,
    worker: String,
    title: String,
    question: String,
    unblocks: String,
    options: Vec<OptionBody>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CloseBody {
    card_id: String,
}

/// Whether a card is a v22 question card. Read on the caller's connection.
pub fn is_v22_question_card(conn: &Connection, card_id: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT 1 FROM issue_tags WHERE issue_id = ?1 AND tag = ?2",
        params![card_id, V22_QUESTION_TAG],
        |_| Ok(()),
    )
    .optional()
    .map(|found| found.is_some())
}

/// The refusal the answer check and the delivery give a v22 question card.
pub const REFUSAL: &str = "v22_question_card";

/// The answer check's and the delivery's guard: `Err(REFUSAL)` for a v22
/// question card, read before anything is claimed or sent.
pub(crate) async fn refuses_delivery(state: &AppState, card_id: &str) -> Result<(), &'static str> {
    let card = card_id.to_owned();
    match state.store.read_async(move |conn| Ok(is_v22_question_card(conn, &card)?)).await {
        Ok(false) => Ok(()),
        Ok(true) => Err(REFUSAL),
        // Unreadable is not deliverable.
        Err(_) => Err("store_unavailable"),
    }
}

fn card_for_question(conn: &Connection, question_id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT t.issue_id FROM issue_tags t JOIN issues i ON i.id = t.issue_id \
         WHERE t.tag = ?1 AND i.deleted IS NULL ORDER BY i.created, i.id LIMIT 1",
        params![question_tag(question_id)],
        |row| row.get::<_, String>(0),
    )
    .optional()
}

fn snapshot(row: &bs::IssueRow, mutation: MutationKind) -> PendingEvent {
    PendingEvent {
        entity_type: EntityType::Task,
        entity_id: row.id.clone(),
        mutation,
        payload: Some(row.snapshot()),
    }
}

/// Files one question card, or answers the card the question already has.
/// `{card_id, created}`.
pub(crate) async fn file_with(state: &AppState, configured: Option<&str>, headers: &HeaderMap, body: &[u8]) -> Response {
    if let Err(response) = super::dm_relay::admit_relay(configured, headers) {
        return response;
    }
    let Ok(body) = serde_json::from_slice::<FileBody>(body) else {
        return super::dm_relay::invalid_request();
    };
    let options_ok = body.options.len() <= OPTIONS_MAX
        && body.options.iter().all(|option| dm_ask::is_option_id(&option.id) && bounded(&option.label, LABEL_MAX))
        && body.options.iter().map(|option| option.id.as_str()).collect::<std::collections::HashSet<_>>().len()
            == body.options.len();
    if !is_question_id(&body.question_id)
        || !super::dm_relay::is_lane_name(&body.worker)
        || !bounded(&body.title, TITLE_MAX)
        || !bounded(&body.question, QUESTION_MAX)
        || !bounded(&body.unblocks, UNBLOCKS_MAX)
        || !options_ok
    {
        return super::dm_relay::invalid_request();
    }
    let typed_ask = match dm_ask::parse_typed_ask(&json!({
        "options": body.options.iter().map(|option| json!({
            "id": option.id, "label": option.label, "effect": "choice_only", "paths": [],
        })).collect::<Vec<Value>>(),
    })) {
        Ok(input) => input,
        Err(_) => return super::dm_relay::invalid_request(),
    };
    let slot: Arc<Mutex<Option<(String, bool)>>> = Arc::new(Mutex::new(None));
    let out = slot.clone();
    let now = super::dm_relay::now_seconds();
    let written = state
        .store
        .write_async(move |conn| {
            if let Some(card_id) = card_for_question(conn, &body.question_id)? {
                *out.lock().expect("v22 question slot") = Some((card_id, false));
                return Ok(WriteOutcome { applied: false, events: vec![] });
            }
            let new = NewIssue {
                title: body.title.clone(),
                desc: format!(
                    "A v22 worker's question to the owner (Tomverse question {}). \
                     Answer it in Tomverse Admin; this card closes when the question is answered.",
                    body.question_id
                ),
                status: "needsyou".into(),
                session: Some(body.worker.clone()),
                item_type: "task".into(),
                creator: super::dm_relay::ANSWER_ACTOR.into(),
                owner_type: "agent".into(),
                due: None,
                due_time: None,
                reviewer: None,
                shepherd: None,
                gate: vec![],
                depends_on: vec![],
                tags: vec![V22_QUESTION_TAG.into(), question_tag(&body.question_id)],
                ask_type: Some("decision".into()),
                next_action: None,
                acceptance_criteria: None,
                ask_question: Some(body.question.clone()),
                ask_unblocks: Some(body.unblocks.clone()),
                ask_actor: None,
                source: Some("agent".into()),
                requested_by: None,
                callback_session: None,
                callback_prompt: None,
            };
            let row = bs::create_issue(conn, &new, now)?;
            dm_ask::write_draft(conn, &row.id, &typed_ask, now)?;
            dm_ask::sync_question_revision(conn, &row.id, now)?;
            *out.lock().expect("v22 question slot") = Some((row.id.clone(), true));
            Ok(WriteOutcome { applied: true, events: vec![snapshot(&row, MutationKind::Created)] })
        })
        .await;
    let taken = slot.lock().expect("v22 question slot").take();
    match (written, taken) {
        (Ok(_), Some((card_id, created))) => Json(json!({ "card_id": card_id, "created": created })).into_response(),
        _ => super::dm_relay::store_unavailable(),
    }
}

/// Closes a v22 question card (`done`). A card already closed is a read; a
/// card that is not a v22 question card is refused. `{closed: true}`.
pub(crate) async fn close_with(state: &AppState, configured: Option<&str>, headers: &HeaderMap, body: &[u8]) -> Response {
    if let Err(response) = super::dm_relay::admit_relay(configured, headers) {
        return response;
    }
    let Ok(body) = serde_json::from_slice::<CloseBody>(body) else {
        return super::dm_relay::invalid_request();
    };
    if !super::dm_relay::is_card_name(&body.card_id) {
        return super::dm_relay::invalid_request();
    }
    let slot: Arc<Mutex<Option<Result<(), &'static str>>>> = Arc::new(Mutex::new(None));
    let out = slot.clone();
    let now = super::dm_relay::now_seconds();
    let written = state
        .store
        .write_async(move |conn| {
            if !is_v22_question_card(conn, &body.card_id)? {
                *out.lock().expect("v22 close slot") = Some(Err("not_a_v22_question_card"));
                return Ok(WriteOutcome { applied: false, events: vec![] });
            }
            let Some(mut row) = bs::get_issue(conn, &body.card_id)? else {
                *out.lock().expect("v22 close slot") = Some(Err("not_a_v22_question_card"));
                return Ok(WriteOutcome { applied: false, events: vec![] });
            };
            if row.status == "done" {
                *out.lock().expect("v22 close slot") = Some(Ok(()));
                return Ok(WriteOutcome { applied: false, events: vec![] });
            }
            row.status = "done".into();
            row.updated = now;
            bs::save_patched(conn, &mut row)?;
            bs::clear_needs_you_tags(conn, &row.id)?;
            *out.lock().expect("v22 close slot") = Some(Ok(()));
            Ok(WriteOutcome { applied: true, events: vec![snapshot(&row, MutationKind::Updated)] })
        })
        .await;
    let taken = slot.lock().expect("v22 close slot").take();
    match (written, taken) {
        (Ok(_), Some(Ok(()))) => Json(json!({ "closed": true })).into_response(),
        (Ok(_), Some(Err(reason))) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": "dm relay request refused", "reason": reason })),
        )
            .into_response(),
        _ => super::dm_relay::store_unavailable(),
    }
}

pub(crate) async fn file(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    file_with(&state, super::dm_relay::configured_relay_digest().as_deref(), &headers, &body).await
}

pub(crate) async fn close(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    close_with(&state, super::dm_relay::configured_relay_digest().as_deref(), &headers, &body).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use sha2::{Digest, Sha256};

    const TOKEN: &str = "relay-local-token-0123456789abcdef0123";
    const QUESTION: &str = "00000000-0000-4000-8000-00000000000a";

    fn digest() -> String {
        hex::encode(Sha256::digest(TOKEN.as_bytes()))
    }

    fn headers(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(super::super::dm_relay::TOKEN_HEADER, HeaderValue::from_str(token).unwrap());
        headers
    }

    fn state() -> (AppState, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(crate::db::Store::open(&dir.path().join("dm-relay-v22.db")).unwrap());
        let state = AppState {
            store,
            started: std::time::Instant::now(),
            build_hash: "test".into(),
            auth_token: None,
            reconciled: Arc::new(std::sync::atomic::AtomicBool::new(true)),
        };
        (state, dir)
    }

    async fn json_of(response: Response) -> (StatusCode, Value) {
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    fn question() -> Vec<u8> {
        json!({"question_id": QUESTION, "worker": "codex-impl", "title": "v22 Task t question 1",
            "question": "Which copy?", "unblocks": "the copy",
            "options": [{"id": "a", "label": "Short"}, {"id": "b", "label": "Long"}]})
        .to_string()
        .into_bytes()
    }

    #[tokio::test]
    async fn a_question_is_filed_once_as_a_typed_ask_card_of_the_worker() {
        let (state, _dir) = state();
        let digest = digest();
        let (status, filed) = json_of(file_with(&state, Some(&digest), &headers(TOKEN), &question()).await).await;
        assert_eq!(status, StatusCode::OK, "{filed}");
        assert_eq!(filed["created"], json!(true));
        let card = filed["card_id"].as_str().unwrap().to_owned();
        let (_, again) = json_of(file_with(&state, Some(&digest), &headers(TOKEN), &question()).await).await;
        assert_eq!(again, json!({"card_id": card, "created": false}));

        let id = card.clone();
        let (row, typed, v22) = state
            .store
            .read_async(move |conn| {
                Ok((
                    bs::get_issue(conn, &id)?.unwrap(),
                    dm_ask::state_json(conn, &id)?,
                    is_v22_question_card(conn, &id)?,
                ))
            })
            .await
            .unwrap();
        assert_eq!(row.status, "needsyou");
        assert_eq!(row.session.as_deref(), Some("codex-impl"));
        assert!(v22);
        assert!(typed.to_string().contains("\"choice_only\""), "{typed}");
        assert_eq!(refuses_delivery(&state, &card).await, Err(REFUSAL));
    }

    #[tokio::test]
    async fn the_token_and_the_body_are_checked_before_anything_is_written() {
        let (state, _dir) = state();
        let digest = digest();
        let (status, _) = json_of(file_with(&state, Some(&digest), &headers("wrong"), &question()).await).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let bad = json!({"question_id": "nope", "worker": "codex-impl", "title": "t", "question": "q?",
            "unblocks": "u", "options": []}).to_string().into_bytes();
        let (status, _) = json_of(file_with(&state, Some(&digest), &headers(TOKEN), &bad).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let tagged = state
            .store
            .read_async(|conn| Ok(conn.query_row("SELECT count(*) FROM issue_tags WHERE tag = ?1",
                params![V22_QUESTION_TAG], |row| row.get::<_, i64>(0))?))
            .await
            .unwrap();
        assert_eq!(tagged, 0);
    }

    #[tokio::test]
    async fn only_a_v22_question_card_is_closed_and_closing_twice_is_a_read() {
        let (state, _dir) = state();
        let digest = digest();
        let (_, filed) = json_of(file_with(&state, Some(&digest), &headers(TOKEN), &question()).await).await;
        let card = filed["card_id"].as_str().unwrap().to_owned();
        let close = json!({"card_id": card}).to_string().into_bytes();
        for _ in 0..2 {
            let (status, closed) = json_of(close_with(&state, Some(&digest), &headers(TOKEN), &close).await).await;
            assert_eq!((status, closed), (StatusCode::OK, json!({"closed": true})));
        }
        let id = card.clone();
        let row = state.store.read_async(move |conn| Ok(bs::get_issue(conn, &id)?)).await.unwrap().unwrap();
        assert_eq!(row.status, "done");

        let other = state
            .store
            .write_async(|conn| {
                let new = NewIssue {
                    title: "ordinary".into(), desc: String::new(), status: "needsyou".into(),
                    session: Some("codex-impl".into()), item_type: "task".into(), creator: "test".into(),
                    owner_type: "agent".into(), due: None, due_time: None, reviewer: None, shepherd: None,
                    gate: vec![], depends_on: vec![], tags: vec![], ask_type: Some("decision".into()),
                    next_action: None, acceptance_criteria: None, ask_question: Some("q?".into()),
                    ask_unblocks: Some("u".into()), ask_actor: None, source: None, requested_by: None,
                    callback_session: None, callback_prompt: None,
                };
                bs::create_issue(conn, &new, 1)?;
                Ok(WriteOutcome { applied: true, events: vec![] })
            })
            .await;
        assert!(other.is_ok());
        let other_id = state
            .store
            .read_async(|conn| Ok(conn.query_row("SELECT id FROM issues WHERE title = ?1",
                params!["ordinary"], |row| row.get::<_, String>(0))?))
            .await
            .unwrap();
        let refused = json!({"card_id": other_id}).to_string().into_bytes();
        let (status, answer) = json_of(close_with(&state, Some(&digest), &headers(TOKEN), &refused).await).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(answer["reason"], "not_a_v22_question_card");
        assert_eq!(refuses_delivery(&state, &other_id).await, Ok(()));
    }

    #[test]
    fn a_question_id_is_a_lowercase_uuid() {
        assert!(is_question_id("00000000-0000-4000-8000-00000000000a"));
        for bad in ["", "00000000-0000-4000-8000-00000000000A", "00000000000040008000000000000000000a", "x"] {
            assert!(!is_question_id(bad), "{bad}");
        }
        assert_eq!(question_tag("abc"), "v22q-abc");
    }

    #[test]
    fn bounded_text_refuses_blank_long_and_control_text() {
        assert!(bounded("Which copy?", 20));
        assert!(bounded("two\nlines", 20));
        assert!(bounded("tab\tbed\r\n", 20));
        assert!(!bounded("  ", 20));
        assert!(!bounded("bell\u{7}", 20));
        assert!(!bounded(&"x".repeat(21), 20));
    }

    #[tokio::test]
    async fn the_routes_are_mounted_under_the_relay_and_a_local_answer_is_refused() {
        use tower::ServiceExt;
        let (state, _dir) = state();
        let digest = digest();
        let (_, filed) = json_of(file_with(&state, Some(&digest), &headers(TOKEN), &question()).await).await;
        let card = filed["card_id"].as_str().unwrap().to_owned();
        let router = axum::Router::new()
            .nest("/api/board", crate::api::board::routes())
            .nest("/api/dm-relay", super::super::dm_relay::routes())
            .with_state(state.clone());
        let post = |uri: String, body: Value| {
            axum::http::Request::builder()
                .method("POST")
                .uri(uri)
                .header("content-type", "application/json")
                .body(axum::body::Body::from(body.to_string()))
                .unwrap()
        };
        // Mounted: the relay's own refusal (no token configured in tests), not a 404.
        for uri in ["/api/dm-relay/v22-questions", "/api/dm-relay/v22-questions/close"] {
            let response = router.clone().oneshot(post(uri.to_owned(), json!({}))).await.unwrap();
            let (status, body) = json_of(response).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{uri}");
            assert_eq!(body["reason"], "dm_relay_not_configured", "{uri}");
        }
        // The operator's direct answer on the local dashboard is refused: the
        // answer belongs in Tomverse Admin.
        let answer = router
            .clone()
            .oneshot(post(format!("/api/board/{card}/typed-ask/answer"), json!({"question_revision": 1})))
            .await
            .unwrap();
        let (status, refused) = json_of(answer).await;
        assert_eq!(status, StatusCode::CONFLICT, "{refused}");
        assert_eq!(refused["reason"], REFUSAL);
    }
}
