//! `POST /api/dm-relay/pending`, `POST /api/dm-relay/pending/release` and
//! `GET /api/dm-relay/pending`: the HTTP verbs of the Decision Maker's
//! DM-pending marker (crate::db::dm_ask, docs/policy/amux-decision-maker.md
//! §2-3 and §2-5) -- set, release, and the list of every marker -- for the
//! Tomverse bridge's relay (apps/tomverse-orchestrator/src/dm_relay in the
//! Tomverse repository) and nobody else. The list is what a restarted relay
//! releases from: a marker on any card in any state, not only on the cards
//! its board scan opens.
//!
//! WHO MAY CALL. The bridge never posts to `/api/board`, so the marker lives
//! here. Loopback alone admits every local process, including the worker
//! sessions whose questions these are, so every route here also demands the
//! relay's own token in `x-amux-dm-relay-token`. This server holds only its
//! SHA-256, in `AMUX_DM_RELAY_TOKEN_SHA256`; the token itself is in the
//! bridge's environment file, which the worker account cannot read
//! (orchestration policy v23: "AMUX가 loopback API에 별도 토큰을 요구하면 bridge
//! 전용 토큰을 격리 계정의 환경 파일에 두고 worker 홈에서 읽지 않는다"). A
//! process that reads this server's environment learns the digest, which
//! opens nothing. With the digest unset or malformed every route is closed.
//!
//! The token is not a wall against the worker account itself: that account
//! runs this server and owns its database file. What the routes guarantee is
//! that the marker moves only through the store's compare-and-swap, and that
//! nothing here takes, stores or forwards a Decision Maker result: the set
//! takes a request id and an instance, the release a request id, and neither
//! changes the card.
//!
//! WHAT THIS MUST NEVER GROW: an answer route. Claiming the answer record and
//! sending an operator-confirmed answer to a worker are stage S2-2b3's, with
//! their own decision about who may call them.

use super::AppState;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};

use crate::db::dm_ask::{self, PendingRelease, PendingSet};

/// The relay token's SHA-256, lowercase hex.
pub const TOKEN_DIGEST_ENV: &str = "AMUX_DM_RELAY_TOKEN_SHA256";
pub const TOKEN_HEADER: &str = "x-amux-dm-relay-token";

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/pending", get(list_markers).post(set_marker))
        .route("/pending/release", post(release_marker))
}

/// At most this many markers per answer. The relay releases what it reads,
/// so a longer table is read whole over successive ticks.
pub const MARKER_LIST_LIMIT: usize = 500;

fn configured_digest() -> Option<String> {
    std::env::var(TOKEN_DIGEST_ENV).ok()
}

fn refused(status: StatusCode, reason: &'static str) -> Response {
    (
        status,
        Json(json!({ "error": "dm relay request refused", "reason": reason })),
    )
        .into_response()
}

/// The relay's token, checked against the configured digest in constant time.
fn admit(configured: Option<&str>, headers: &HeaderMap) -> Result<(), Response> {
    let Some(expected) = configured.filter(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }) else {
        return Err(refused(StatusCode::FORBIDDEN, "dm_relay_not_configured"));
    };
    let Some(token) = headers.get(TOKEN_HEADER).map(|value| value.as_bytes()) else {
        return Err(refused(StatusCode::FORBIDDEN, "dm_relay_token_missing"));
    };
    let presented = hex::encode(Sha256::digest(token));
    if super::auth::constant_time_eq(presented.as_bytes(), expected.as_bytes()) {
        Ok(())
    } else {
        Err(refused(StatusCode::FORBIDDEN, "dm_relay_token_refused"))
    }
}

/// A card id the bridge may name: the local board's id grammar.
fn is_card_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SetBody {
    card_id: String,
    question_revision: i64,
    request_id: String,
    instance: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReleaseBody {
    card_id: String,
    question_revision: i64,
    request_id: String,
}

fn invalid() -> Response {
    refused(StatusCode::BAD_REQUEST, "dm_relay_request_invalid")
}

fn store_failed() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "dm relay store write failed" })),
    )
        .into_response()
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

async fn list_markers(State(state): State<AppState>, headers: HeaderMap) -> Response {
    list_markers_with(&state, configured_digest().as_deref(), &headers).await
}

/// Every marker (`dm_ask::pending_markers`), oldest first: card, question
/// revision, request, instance and when it was set. A read; it changes
/// nothing. `truncated` says the table held more than one answer carries.
pub(crate) async fn list_markers_with(
    state: &AppState,
    configured: Option<&str>,
    headers: &HeaderMap,
) -> Response {
    if let Err(response) = admit(configured, headers) {
        return response;
    }
    let read = state
        .store
        .read_async(|conn| Ok(dm_ask::pending_markers(conn, MARKER_LIST_LIMIT + 1)?))
        .await;
    let Ok(mut markers) = read else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "dm relay marker read failed" })),
        )
            .into_response();
    };
    let truncated = markers.len() > MARKER_LIST_LIMIT;
    markers.truncate(MARKER_LIST_LIMIT);
    let markers: Vec<_> = markers
        .into_iter()
        .map(|marker| {
            json!({
                "card_id": marker.issue_id,
                "question_revision": marker.question_revision,
                "request_id": marker.request_id,
                "instance": marker.instance,
                "set_at": marker.set_at,
            })
        })
        .collect();
    Json(json!({ "markers": markers, "truncated": truncated })).into_response()
}

async fn set_marker(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    set_marker_with(&state, configured_digest().as_deref(), &headers, &body).await
}

async fn release_marker(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    release_marker_with(&state, configured_digest().as_deref(), &headers, &body).await
}

/// One compare-and-swap (`dm_ask::set_pending`) in the writer's transaction.
/// Every answer the store gives is a 200 naming it: `set`, `already_set` (the
/// same request holds it), or `discarded` with the reason, after which the
/// bridge discards the assignment.
pub(crate) async fn set_marker_with(
    state: &AppState,
    configured: Option<&str>,
    headers: &HeaderMap,
    body: &[u8],
) -> Response {
    if let Err(response) = admit(configured, headers) {
        return response;
    }
    let Ok(body) = serde_json::from_slice::<SetBody>(body) else {
        return invalid();
    };
    if !is_card_id(&body.card_id) || body.question_revision < 1 {
        return invalid();
    }
    let slot: Arc<Mutex<Option<PendingSet>>> = Arc::new(Mutex::new(None));
    let out = slot.clone();
    let now = now_secs();
    let written = state
        .store
        .write_async(move |conn| {
            let set = dm_ask::set_pending(
                conn,
                &body.card_id,
                body.question_revision,
                &body.request_id,
                &body.instance,
                now,
            )?;
            let applied = matches!(set, PendingSet::Set(_));
            *out.lock().expect("dm relay slot") = Some(set);
            Ok(crate::db::WriteOutcome {
                applied,
                events: vec![],
            })
        })
        .await;
    let set = slot.lock().expect("dm relay slot").take();
    match (written, set) {
        (Ok(_), Some(PendingSet::Set(pending))) => {
            Json(json!({ "outcome": "set", "pending": pending })).into_response()
        }
        (Ok(_), Some(PendingSet::AlreadySet(pending))) => {
            Json(json!({ "outcome": "already_set", "pending": pending })).into_response()
        }
        (Ok(_), Some(PendingSet::Discarded(reason))) => {
            Json(json!({ "outcome": "discarded", "reason": reason })).into_response()
        }
        _ => store_failed(),
    }
}

/// Removes the marker this request set (`dm_ask::release_pending`). It takes
/// no result: whatever the Decision Maker produced, the card is left as the
/// marker found it. `not_held` and `held_by_other` are answers, not errors.
pub(crate) async fn release_marker_with(
    state: &AppState,
    configured: Option<&str>,
    headers: &HeaderMap,
    body: &[u8],
) -> Response {
    if let Err(response) = admit(configured, headers) {
        return response;
    }
    let Ok(body) = serde_json::from_slice::<ReleaseBody>(body) else {
        return invalid();
    };
    if !is_card_id(&body.card_id)
        || body.question_revision < 1
        || !dm_ask::is_request_id(&body.request_id)
    {
        return invalid();
    }
    let slot: Arc<Mutex<Option<PendingRelease>>> = Arc::new(Mutex::new(None));
    let out = slot.clone();
    let written = state
        .store
        .write_async(move |conn| {
            let release = dm_ask::release_pending(
                conn,
                &body.card_id,
                body.question_revision,
                &body.request_id,
            )?;
            let applied = matches!(release, PendingRelease::Released(_));
            *out.lock().expect("dm relay slot") = Some(release);
            Ok(crate::db::WriteOutcome {
                applied,
                events: vec![],
            })
        })
        .await;
    let release = slot.lock().expect("dm relay slot").take();
    match (written, release) {
        (Ok(_), Some(PendingRelease::Released(_))) => {
            Json(json!({ "outcome": "released" })).into_response()
        }
        (Ok(_), Some(PendingRelease::NotHeld)) => {
            Json(json!({ "outcome": "not_held" })).into_response()
        }
        (Ok(_), Some(PendingRelease::HeldByOther(_))) => {
            Json(json!({ "outcome": "held_by_other" })).into_response()
        }
        _ => store_failed(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use serde_json::Value;
    use tower::ServiceExt;

    const TOKEN: &str = "relay-local-token-0123456789abcdef0123";
    const REQUEST: &str = "0b0e3b50-0f7e-4b8a-8f39-2d2b9f6c1a10";
    const OTHER_REQUEST: &str = "7c1d2e3f-4a5b-4c6d-8e7f-901a2b3c4d5e";
    const WORKER: &str = "dm-relay-test-worker";

    fn digest() -> String {
        hex::encode(Sha256::digest(TOKEN.as_bytes()))
    }

    fn token_headers(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(TOKEN_HEADER, HeaderValue::from_str(token).unwrap());
        headers
    }

    /// The temp directory is returned and held by each test, so its database
    /// goes when the test ends (the runner's /tmp is a small tmpfs).
    fn app() -> (Router, AppState, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(crate::db::Store::open(&dir.path().join("dm-relay.db")).unwrap());
        let state = AppState {
            store,
            started: std::time::Instant::now(),
            build_hash: "test".into(),
            auth_token: None,
            reconciled: Arc::new(std::sync::atomic::AtomicBool::new(true)),
        };
        let router = Router::new()
            .nest("/api/board", crate::api::board::routes())
            .nest("/api/dm-relay", routes())
            .with_state(state.clone());
        (router, state, dir)
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

    async fn asking_card(app: &Router) -> String {
        let (status, created) = call(
            app,
            "POST",
            "/api/board",
            Some(json!({
                "title": "Pick the index store",
                "status": "needsyou",
                "ask_actor": "Ethan",
                "ask_type": "decision",
                "ask_question": "Which store should the index use?",
                "ask_unblocks": "The owner names the store to use.",
                "typed_ask": {"options": [{"id": "sqlite", "label": "Keep SQLite", "effect": "choice_only"}]},
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{created}");
        created["id"].as_str().unwrap().to_string()
    }

    fn body(card: &str, revision: i64, request: &str) -> Vec<u8> {
        json!({"card_id": card, "question_revision": revision, "request_id": request,
            "instance": "decision-maker-openai"})
        .to_string()
        .into_bytes()
    }

    fn release_body(card: &str, revision: i64, request: &str) -> Vec<u8> {
        json!({"card_id": card, "question_revision": revision, "request_id": request})
            .to_string()
            .into_bytes()
    }

    async fn json_of(response: Response) -> (StatusCode, Value) {
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    #[tokio::test]
    async fn without_a_configured_digest_both_routes_are_closed() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::api::settings::test_env::set_home(home.path());
        let (app, _state, _dir) = app();
        // The test process never sets AMUX_DM_RELAY_TOKEN_SHA256.
        assert!(std::env::var(TOKEN_DIGEST_ENV).is_err());
        for uri in ["/api/dm-relay/pending", "/api/dm-relay/pending/release"] {
            let (status, body) = call(&app, "POST", uri, Some(json!({}))).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{uri}");
            assert_eq!(body["reason"], "dm_relay_not_configured", "{uri}");
        }
        let (status, body) = call(&app, "GET", "/api/dm-relay/pending", None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["reason"], "dm_relay_not_configured");
    }

    /// Review r-20261018-022220-384dfe: a restarted relay must find every
    /// marker, not only those on the cards its board scan opens. The list is
    /// the table's, so a marker on a question the card no longer asks is in it
    /// too, and a table longer than one answer is read over successive ticks.
    #[tokio::test]
    async fn the_marker_list_holds_every_marker_behind_the_token() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::api::settings::test_env::set_home(home.path());
        let (app, state, _dir) = app();
        let card = asking_card(&app).await;
        let digest = digest();
        let headers = token_headers(TOKEN);
        let (_, set) = json_of(
            set_marker_with(&state, Some(&digest), &headers, &body(&card, 1, REQUEST)).await,
        )
        .await;
        assert_eq!(set["outcome"], "set");
        // The worker re-asks: revision 2 is current and shows no marker, but
        // revision 1's marker is still in the table.
        let (status, patched) = call(
            &app,
            "PATCH",
            &format!("/api/board/{card}"),
            Some(json!({"ask_question": "Should the index be dropped instead?"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{patched}");
        let (_, typed) = call(&app, "GET", &format!("/api/board/{card}/typed-ask"), None).await;
        assert_eq!(typed["current_revision"]["question_revision"], 2, "{typed}");
        assert!(typed["pending"].is_null(), "{typed}");

        let (status, refused) =
            json_of(list_markers_with(&state, Some(&digest), &HeaderMap::new()).await).await;
        assert_eq!(
            (status, refused["reason"].as_str()),
            (StatusCode::FORBIDDEN, Some("dm_relay_token_missing"))
        );
        let (status, listed) =
            json_of(list_markers_with(&state, Some(&digest), &headers).await).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            listed,
            json!({"markers": [{"card_id": card, "question_revision": 1, "request_id": REQUEST,
                "instance": "decision-maker-openai", "set_at": listed["markers"][0]["set_at"]}],
                "truncated": false})
        );
        // Released by its request, it leaves the list.
        let (_, released) = json_of(
            release_marker_with(
                &state,
                Some(&digest),
                &headers,
                &release_body(&card, 1, REQUEST),
            )
            .await,
        )
        .await;
        assert_eq!(released["outcome"], "released");
        let (_, listed) = json_of(list_markers_with(&state, Some(&digest), &headers).await).await;
        assert_eq!(listed["markers"], json!([]));

        // More rows than one answer carries: the first page, and `truncated`.
        state
            .store
            .write(|conn| {
                for index in 0..=MARKER_LIST_LIMIT {
                    conn.execute(
                        "INSERT INTO _amux_dm_pending (issue_id, question_revision, request_id, instance, set_at) \
                         VALUES (?1, 1, ?2, 'decision-maker-openai', ?3)",
                        rusqlite::params![format!("AMUX-T{index:04}"), REQUEST, index as i64],
                    )?;
                }
                Ok(crate::db::WriteOutcome { applied: true, events: vec![] })
            })
            .unwrap();
        let (_, listed) = json_of(list_markers_with(&state, Some(&digest), &headers).await).await;
        assert_eq!(
            listed["markers"].as_array().unwrap().len(),
            MARKER_LIST_LIMIT
        );
        assert_eq!(listed["truncated"], true);
        assert_eq!(
            listed["markers"][0]["card_id"], "AMUX-T0000",
            "oldest first"
        );
    }

    #[tokio::test]
    async fn only_the_relay_token_opens_the_routes() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::api::settings::test_env::set_home(home.path());
        let (app, state, _dir) = app();
        let card = asking_card(&app).await;
        let digest = digest();
        let (status, answer) = json_of(
            set_marker_with(
                &state,
                Some(&digest),
                &HeaderMap::new(),
                &body(&card, 1, REQUEST),
            )
            .await,
        )
        .await;
        assert_eq!(
            (status, answer["reason"].as_str()),
            (StatusCode::FORBIDDEN, Some("dm_relay_token_missing"))
        );
        let (status, answer) = json_of(
            set_marker_with(
                &state,
                Some(&digest),
                &token_headers("not-the-relay-token"),
                &body(&card, 1, REQUEST),
            )
            .await,
        )
        .await;
        assert_eq!(
            (status, answer["reason"].as_str()),
            (StatusCode::FORBIDDEN, Some("dm_relay_token_refused"))
        );
        // The digest itself is not a token.
        let (status, _) = json_of(
            set_marker_with(
                &state,
                Some(&digest),
                &token_headers(&digest),
                &body(&card, 1, REQUEST),
            )
            .await,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        // A malformed configured digest closes the route.
        let (status, answer) = json_of(
            set_marker_with(
                &state,
                Some("ABC"),
                &token_headers(TOKEN),
                &body(&card, 1, REQUEST),
            )
            .await,
        )
        .await;
        assert_eq!(
            (status, answer["reason"].as_str()),
            (StatusCode::FORBIDDEN, Some("dm_relay_not_configured"))
        );
        // Nothing was set by any refusal.
        let (_, typed) = call(&app, "GET", &format!("/api/board/{card}/typed-ask"), None).await;
        assert!(typed["pending"].is_null(), "{typed}");
    }

    #[tokio::test]
    async fn the_marker_is_set_once_released_by_its_request_and_never_changes_the_card() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::api::settings::test_env::set_home(home.path());
        let (app, state, _dir) = app();
        let card = asking_card(&app).await;
        let (_, before) = call(&app, "GET", &format!("/api/board/{card}"), None).await;
        let digest = digest();
        let headers = token_headers(TOKEN);

        let (status, set) = json_of(
            set_marker_with(&state, Some(&digest), &headers, &body(&card, 1, REQUEST)).await,
        )
        .await;
        assert_eq!(
            (status, set["outcome"].as_str()),
            (StatusCode::OK, Some("set")),
            "{set}"
        );
        let (_, again) = json_of(
            set_marker_with(&state, Some(&digest), &headers, &body(&card, 1, REQUEST)).await,
        )
        .await;
        assert_eq!(again["outcome"], "already_set");
        let (_, other) = json_of(
            set_marker_with(
                &state,
                Some(&digest),
                &headers,
                &body(&card, 1, OTHER_REQUEST),
            )
            .await,
        )
        .await;
        assert_eq!(
            (other["outcome"].as_str(), other["reason"].as_str()),
            (Some("discarded"), Some("held_by_other_request"))
        );
        let (_, stale) = json_of(
            set_marker_with(&state, Some(&digest), &headers, &body(&card, 2, REQUEST)).await,
        )
        .await;
        assert_eq!(stale["reason"], "stale_revision");
        let (_, typed) = call(&app, "GET", &format!("/api/board/{card}/typed-ask"), None).await;
        assert_eq!(typed["pending"]["request_id"], REQUEST, "{typed}");

        // Another request cannot release it; its own can, and a second release is an answer too.
        let (_, held) = json_of(
            release_marker_with(
                &state,
                Some(&digest),
                &headers,
                &release_body(&card, 1, OTHER_REQUEST),
            )
            .await,
        )
        .await;
        assert_eq!(held["outcome"], "held_by_other");
        let (_, released) = json_of(
            release_marker_with(
                &state,
                Some(&digest),
                &headers,
                &release_body(&card, 1, REQUEST),
            )
            .await,
        )
        .await;
        assert_eq!(released["outcome"], "released");
        let (_, twice) = json_of(
            release_marker_with(
                &state,
                Some(&digest),
                &headers,
                &release_body(&card, 1, REQUEST),
            )
            .await,
        )
        .await;
        assert_eq!(twice["outcome"], "not_held");

        // The card is as the marker found it: same status, same ask, same revision.
        let (_, after) = call(&app, "GET", &format!("/api/board/{card}"), None).await;
        for key in [
            "status",
            "ask_type",
            "ask_question",
            "ask_unblocks",
            "rev",
            "title",
        ] {
            assert_eq!(before[key], after[key], "{key}");
        }
        let (_, typed) = call(&app, "GET", &format!("/api/board/{card}/typed-ask"), None).await;
        assert!(
            typed["pending"].is_null() && typed["answer"].is_null(),
            "{typed}"
        );
        assert_eq!(typed["current_revision"]["question_revision"], 1);
    }

    #[tokio::test]
    async fn a_body_that_carries_anything_else_is_refused() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::api::settings::test_env::set_home(home.path());
        let (app, state, _dir) = app();
        let card = asking_card(&app).await;
        let digest = digest();
        let headers = token_headers(TOKEN);
        // No result, answer or text field exists to carry a DM output.
        let with_output = json!({"card_id": card, "question_revision": 1, "request_id": REQUEST,
            "instance": "decision-maker-openai", "output": "select sqlite"})
        .to_string();
        let (status, _) =
            json_of(set_marker_with(&state, Some(&digest), &headers, with_output.as_bytes()).await)
                .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let with_result =
            json!({"card_id": card, "question_revision": 1, "request_id": REQUEST, "result": "x"})
                .to_string();
        let (status, _) = json_of(
            release_marker_with(&state, Some(&digest), &headers, with_result.as_bytes()).await,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = json_of(
            set_marker_with(&state, Some(&digest), &headers, &body("../x", 1, REQUEST)).await,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        // An invalid request id or instance is the store's discard, not a write.
        let (_, answer) = json_of(
            set_marker_with(
                &state,
                Some(&digest),
                &headers,
                &body(&card, 1, "not-a-uuid"),
            )
            .await,
        )
        .await;
        assert_eq!(answer["reason"], "invalid_request_id");
        let unknown_instance =
            json!({"card_id": card, "question_revision": 1, "request_id": REQUEST,
            "instance": "decision-maker-other"})
            .to_string();
        let (_, answer) = json_of(
            set_marker_with(&state, Some(&digest), &headers, unknown_instance.as_bytes()).await,
        )
        .await;
        assert_eq!(answer["reason"], "unknown_instance");
    }
}
