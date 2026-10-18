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
//! STAGE S2-2b3: DELIVERING AN OPERATOR-CONFIRMED ANSWER
//! (docs/policy/amux-decision-maker.md §2-7, §7, §9). Three more routes behind
//! the same token:
//!
//! - `POST /api/dm-relay/answers/check` reads whether a confirmed answer could
//!   be delivered now -- the card still asks that question revision and nobody
//!   has answered it, the card is still §9's binding (its owner session is the
//!   asking worker's session and its newest attempt the request's), and the
//!   worker's lane takes automated input at a turn boundary. The bridge asks
//!   before it records the app's delivery decision, so a question the
//!   operator already answered is never decided at all.
//! - `POST /api/dm-relay/answers` delivers one: the same checks again, then,
//!   in one transaction, the binding once more and the answer record's claim
//!   for that revision (`dm_ask::claim_answer`, as `dm_confirmed` with the
//!   app's request id), and only on a claim this
//!   request won, the message through the lane's own automated send path
//!   under the message id `dm-answer:<request id>` (the local idempotency key,
//!   reserved before the send and acknowledged only on a verified delivery),
//!   and then the same text appended to the card as its record. An answer
//!   already recorded, by the operator or by this request before, is never
//!   sent. The bridge calls it once per request and never again, whatever
//!   came back.
//! - `POST /api/dm-relay/answers/unknown` is §9 for a delivery whose result
//!   the bridge does not know: it pauses the worker's session (AMUX pause)
//!   first, then reads the receipt of the message id. It sends nothing.
//!
//! STAGE S2-2b4: TWO READS BY POST, behind the same token.
//!
//! - `POST /api/dm-relay/answers/operator` lists the operator's answer
//!   records from a time on, so the bridge can report each question to the
//!   app, whose router closes its open request (§2-7: "운영자의 직접 답이
//!   먼저면 요청은 닫힌다").
//! - `POST /api/dm-relay/answers/receipt` reads what this AMUX holds of one
//!   decided delivery -- its message id's reservation and the question
//!   revision's answer record -- for a bridge that stopped between the app's
//!   decision and its outcome. It pauses nothing and sends nothing.
//!
//! The answer route takes the message text and nothing that is a Decision
//! Maker result: the bridge reads that text from the app only after a person
//! confirmed it and sends it only after the app recorded the delivery
//! decision, and the message's first line must name the card it answers. The
//! operator's direct answer claims the same record first
//! (`POST /api/board/{id}/typed-ask/answer`), so whichever comes first is the
//! one delivered (§12: "직접 답과 확정 답이 함께 와도 하나만 전달된다").

use super::AppState;
use async_trait::async_trait;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};

use crate::db::dm_ask::{self, AnswerClaim, AnswerSource, PendingRelease, PendingSet};

/// The relay token's SHA-256, lowercase hex.
pub const TOKEN_DIGEST_ENV: &str = "AMUX_DM_RELAY_TOKEN_SHA256";
pub const TOKEN_HEADER: &str = "x-amux-dm-relay-token";

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/pending", get(list_markers).post(set_marker))
        .route("/pending/release", post(release_marker))
        .route("/answers", post(deliver_answer))
        .route("/answers/check", post(check_answer))
        .route("/answers/unknown", post(answer_unknown))
        .route("/answers/operator", post(operator_answers))
        .route("/answers/receipt", post(answer_receipt))
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

// ---------------------------------------------------------------------------
// Stage S2-2b3: delivering an operator-confirmed answer
// ---------------------------------------------------------------------------

/// The local message id of a delivery: the app's `dmDeliveryMessageId()`
/// (lib/amux/decisionMakerDeliveryCore.ts in the Tomverse repository), one
/// per request, 46 characters inside the send path's 64.
pub const ANSWER_MESSAGE_ID_PREFIX: &str = "dm-answer:";

/// The app's `DM_DELIVERY_MESSAGE_MAX_BYTES`: an 8 KiB answer, §7's header
/// and sentence, with room to spare.
pub const ANSWER_MESSAGE_MAX_BYTES: usize = 16 * 1024;

/// Who the answer record names as the writer of a confirmed answer: the
/// bridge relay, which carries a person's confirmation from the app.
pub const ANSWER_ACTOR: &str = "amux-dm-relay";

/// §7's header opens every message the relay delivers, and names the card.
const ANSWER_HEADER_PREFIX: &str = "[Decision Maker ";

pub fn answer_message_id(request_id: &str) -> String {
    format!("{ANSWER_MESSAGE_ID_PREFIX}{request_id}")
}

/// True when the message is one the relay may deliver to this card: within
/// the cap, and its first line §7's header naming the card
/// (`[Decision Maker ... re <card>]`).
pub fn message_names_card(message: &str, card_id: &str) -> bool {
    let first = message.split('\n').next().unwrap_or_default();
    !message.trim().is_empty()
        && message.len() <= ANSWER_MESSAGE_MAX_BYTES
        && first.starts_with(ANSWER_HEADER_PREFIX)
        && first.ends_with(&format!(", re {card_id}]"))
}

/// What a send through the lane did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaneSend {
    /// Verified submitted to the worker.
    Delivered,
    /// Refused before anything was typed into the lane.
    Refused,
    /// Anything else: typed and not submitted, not verified, or queued.
    Unknown,
}

/// The send path's own verdict, read the way `send_post` reads it
/// (`submit_verdict_of`): a refusal types nothing, so only a refusal is
/// `Refused`, and only a verified or retried submit is `Delivered`.
pub fn lane_send_verdict(ok: bool, message: &str) -> LaneSend {
    match (ok, super::session_verbs::submit_verdict_of(message)) {
        (true, Some("confirmed" | "retried")) => LaneSend::Delivered,
        (false, None) => LaneSend::Refused,
        _ => LaneSend::Unknown,
    }
}

/// What a delivery needs from the worker's lane. The server's is [`FleetLane`],
/// the session layer itself; tests give their own.
#[async_trait]
pub trait AnswerLane: Send + Sync {
    /// Whether the lane takes automated input now, and if not, why.
    async fn deliverable(&self, state: &AppState, session: &str) -> Result<(), &'static str>;
    /// Reserves the message id before the send; false when it could not be.
    async fn reserve(&self, state: &AppState, session: &str, message_id: &str) -> bool;
    async fn send(&self, state: &AppState, session: &str, text: &str) -> LaneSend;
    /// Records the reservation's receipt once the message was delivered.
    async fn accept(&self, state: &AppState, session: &str, message_id: &str);
    /// Releases a reservation whose send typed nothing.
    async fn forget(&self, state: &AppState, session: &str, message_id: &str);
    /// AMUX pause (§9); true when the lane is paused.
    async fn pause(&self, state: &AppState, session: &str) -> bool;
    /// The message id's receipt: `accepted`, `not_accepted` or `unreadable`.
    async fn receipt(&self, state: &AppState, session: &str, message_id: &str) -> &'static str;
    /// Stage S2-2b4: the message id's reservation, without pausing anything:
    /// `accepted` (reserved and acknowledged on a verified delivery),
    /// `pending` (reserved, never acknowledged), `none` (never reserved, or
    /// forgotten after a send that typed nothing) or `unreadable`.
    async fn reservation(&self, state: &AppState, session: &str, message_id: &str) -> &'static str;
}

/// The session layer: the same gates every automated sender meets
/// (`deliver_automated`), the boundary-only send that refuses rather than
/// type into a turn, the message id reservation and receipt of `send_post`,
/// and the worker lifecycle's pause.
#[derive(Debug, Clone, Copy, Default)]
pub struct FleetLane;

#[async_trait]
impl AnswerLane for FleetLane {
    async fn deliverable(&self, state: &AppState, session: &str) -> Result<(), &'static str> {
        use super::session_verbs as fleet;
        if !fleet::valid_session_name(session) {
            return Err("invalid_session");
        }
        if !fleet::env_path(session).exists() {
            return Err("session_missing");
        }
        if fleet::lane_is_archived(session) {
            return Err("archived");
        }
        if fleet::lane_is_paused(session) {
            return Err("paused");
        }
        if fleet::session_is_isolated(session) {
            return Err("isolated");
        }
        if !fleet::is_running(session).await {
            return Err("not_running");
        }
        // A permission dialog is never answered by a delivery (§13).
        if fleet::lane_is_blocked(state, session) {
            return Err("blocked");
        }
        if fleet::steer_delivery_for(state, session, 0.0).await != fleet::SteerDelivery::AtBoundary {
            return Err("busy");
        }
        Ok(())
    }

    async fn reserve(&self, state: &AppState, session: &str, message_id: &str) -> bool {
        super::session_verbs::send_dedup_gate(state, session, message_id)
            .await
            .is_none()
    }

    async fn send(&self, state: &AppState, session: &str, text: &str) -> LaneSend {
        use super::session_verbs as fleet;
        // The scheduler's boundary send (`deliver_automated`): automation, so
        // a paused, isolated or blocked lane refuses; from the steering side,
        // so a turn that started since the check refuses instead of being
        // typed into; never queued.
        let mode = fleet::SendMode {
            defer_if_busy: false,
            from_steering: true,
            allow_mid_turn: false,
            hook_confirmed_idle: false,
            origin: fleet::SendOrigin::Automation,
        };
        let (ok, message) = fleet::send_text_inner(state, session, text, mode).await;
        lane_send_verdict(ok, &message)
    }

    async fn accept(&self, state: &AppState, session: &str, message_id: &str) {
        super::session_verbs::send_dedup_accept(state, session, message_id, message_id).await;
    }

    async fn forget(&self, state: &AppState, session: &str, message_id: &str) {
        super::session_verbs::send_dedup_forget(state, session, message_id).await;
    }

    async fn pause(&self, state: &AppState, session: &str) -> bool {
        super::workers::pause_worker(State(state.clone()), Path(session.to_string()))
            .await
            .status()
            .is_success()
    }

    async fn receipt(&self, state: &AppState, session: &str, message_id: &str) -> &'static str {
        let response = super::session_verbs::send_receipt(state, session, message_id);
        let status = response.status();
        let Ok(bytes) = axum::body::to_bytes(response.into_body(), 64 * 1024).await else {
            return "unreadable";
        };
        let accepted = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|value| value.get("accepted").and_then(Value::as_bool));
        match (status, accepted) {
            (StatusCode::OK, Some(true)) => "accepted",
            (StatusCode::ACCEPTED, Some(false)) => "not_accepted",
            _ => "unreadable",
        }
    }

    async fn reservation(&self, state: &AppState, session: &str, message_id: &str) -> &'static str {
        let (session, message_id) = (session.to_string(), message_id.to_string());
        // The send ledger `send_receipt` reads: a row is a reservation, and its
        // receipt id is set only by `send_dedup_accept` on a verified delivery.
        let read = state
            .store
            .read_async(move |conn| {
                use rusqlite::OptionalExtension;
                Ok(conn
                    .query_row(
                        "SELECT receipt_id FROM send_dedup WHERE session=?1 AND msg_id=?2",
                        rusqlite::params![session, message_id],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .optional()?)
            })
            .await;
        match read {
            Ok(Some(Some(_))) => "accepted",
            Ok(Some(None)) => "pending",
            Ok(None) => "none",
            Err(_) => "unreadable",
        }
    }
}

/// §9's binding of a request, as the relay routed it (the Tomverse
/// repository's apps/tomverse-orchestrator/src/dm_relay/wire.rs
/// `routing_binding`): the asking worker and its AMUX session, both the card's
/// owner session, and the card's newest task attempt (0 with none).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct AnswerCheckBody {
    card_id: String,
    question_revision: i64,
    worker: String,
    session: String,
    session_attempt: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct AnswerBody {
    card_id: String,
    question_revision: i64,
    request_id: String,
    worker: String,
    session: String,
    session_attempt: i64,
    message: String,
}

/// The card's owner session and newest task attempt, the two values the
/// relay's binding was made of; `None` when the card is gone.
fn card_owner(conn: &rusqlite::Connection, card_id: &str) -> rusqlite::Result<Option<(Option<String>, i64)>> {
    use rusqlite::OptionalExtension;
    let session = conn
        .query_row(
            "SELECT session FROM issues WHERE id = ?1 AND deleted IS NULL",
            [card_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?;
    let Some(session) = session else {
        return Ok(None);
    };
    let attempt = crate::db::attempts::list_for_card(conn, card_id)?
        .iter()
        .map(|attempt| attempt.attempt)
        .max()
        .unwrap_or(0);
    Ok(Some((session, attempt)))
}

/// Why the card is no longer the binding's, or `None` when it still is: its
/// owner session is the binding's session and the binding's worker (the relay
/// routes them as one), and its newest attempt is the binding's. A card
/// given to another worker or attempt keeps its question revision, so the
/// revision alone cannot tell (review r-20261018-065705-65cb2a).
fn binding_refusal(
    owner: Option<&(Option<String>, i64)>,
    worker: &str,
    session: &str,
    session_attempt: i64,
) -> Option<&'static str> {
    let Some((owner_session, attempt)) = owner else {
        return Some("question_changed");
    };
    if owner_session.as_deref() != Some(session) || worker != session {
        return Some("owner_changed");
    }
    (*attempt != session_attempt).then_some("attempt_changed")
}

/// [`binding_refusal`] on a read of the card.
async fn binding_holds(
    state: &AppState,
    card_id: &str,
    worker: &str,
    session: &str,
    session_attempt: i64,
) -> Result<(), &'static str> {
    let card = card_id.to_string();
    let owner = state
        .store
        .read_async(move |conn| Ok(card_owner(conn, &card)?))
        .await
        .map_err(|_| "store_unreadable")?;
    match binding_refusal(owner.as_ref(), worker, session, session_attempt) {
        Some(reason) => Err(reason),
        None => Ok(()),
    }
}

/// What the claim's transaction did.
enum ClaimStep {
    /// The card stopped being the binding's: nothing was claimed.
    BindingChanged(&'static str),
    Claim(AnswerClaim),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct AnswerUnknownBody {
    card_id: String,
    question_revision: i64,
    request_id: String,
    session: String,
}

fn is_session_name(session: &str) -> bool {
    !session.trim().is_empty() && session.len() <= 128
}

/// Whether the card still asks this question revision and nobody answered
/// it: the answer record's own conditions, read without claiming.
async fn question_open(state: &AppState, card_id: &str, question_revision: i64) -> Result<(), &'static str> {
    let card = card_id.to_string();
    let read = state
        .store
        .read_async(move |conn| {
            if let Some(existing) = dm_ask::answer_for(conn, &card, question_revision)? {
                return Ok(Err(if existing.source == "operator" { "answered_by_operator" } else { "answered" }));
            }
            let current = dm_ask::current_revision(conn, &card)?.map(|revision| revision.question_revision);
            Ok(if current == Some(question_revision) { Ok(()) } else { Err("question_changed") })
        })
        .await;
    read.unwrap_or(Err("store_unreadable"))
}

async fn check_answer(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    check_answer_with(&state, &FleetLane, configured_digest().as_deref(), &headers, &body).await
}

/// `{deliverable: true}`, or `{deliverable: false, reason}`. Reads only.
pub(crate) async fn check_answer_with<L: AnswerLane>(
    state: &AppState,
    lane: &L,
    configured: Option<&str>,
    headers: &HeaderMap,
    body: &[u8],
) -> Response {
    if let Err(response) = admit(configured, headers) {
        return response;
    }
    let Ok(body) = serde_json::from_slice::<AnswerCheckBody>(body) else {
        return invalid();
    };
    if !is_card_id(&body.card_id)
        || body.question_revision < 1
        || !is_session_name(&body.session)
        || !is_session_name(&body.worker)
        || body.session_attempt < 0
    {
        return invalid();
    }
    let verdict = match question_open(state, &body.card_id, body.question_revision).await {
        Ok(()) => match binding_holds(state, &body.card_id, &body.worker, &body.session, body.session_attempt).await {
            Ok(()) => lane.deliverable(state, &body.session).await,
            Err(reason) => Err(reason),
        },
        Err(reason) => Err(reason),
    };
    Json(match verdict {
        Ok(()) => json!({ "deliverable": true }),
        Err(reason) => json!({ "deliverable": false, "reason": reason }),
    })
    .into_response()
}

async fn deliver_answer(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    deliver_answer_with(&state, FleetLane, configured_digest().as_deref(), &headers, &body).await
}

/// One delivery, at most once per request: the checks, the claim, and only
/// on a claim this request won, the reservation, the send and the card
/// record. It runs in its own task, so a bridge that gives up mid-delivery
/// cannot stop it between the claim and the send; the bridge reads a lost
/// answer as unknown and never calls again. Every answer it gives is a 200
/// naming what happened; anything else is the bridge's unknown.
pub(crate) async fn deliver_answer_with<L: AnswerLane + Clone + 'static>(
    state: &AppState,
    lane: L,
    configured: Option<&str>,
    headers: &HeaderMap,
    body: &[u8],
) -> Response {
    if let Err(response) = admit(configured, headers) {
        return response;
    }
    let Ok(body) = serde_json::from_slice::<AnswerBody>(body) else {
        return invalid();
    };
    if !is_card_id(&body.card_id)
        || body.question_revision < 1
        || !dm_ask::is_request_id(&body.request_id)
        || !is_session_name(&body.session)
        || !is_session_name(&body.worker)
        || body.session_attempt < 0
        || !message_names_card(&body.message, &body.card_id)
    {
        return invalid();
    }
    let state = state.clone();
    let now = now_secs();
    match tokio::spawn(async move { deliver(&state, &lane, &body, now).await }).await {
        Ok(answer) => Json(answer).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "dm relay delivery ended without answering" })),
        )
            .into_response(),
    }
}

async fn deliver<L: AnswerLane>(state: &AppState, lane: &L, body: &AnswerBody, now: i64) -> Value {
    if let Err(reason) = question_open(state, &body.card_id, body.question_revision).await {
        return json!({ "outcome": "not_deliverable", "reason": reason });
    }
    if let Err(reason) =
        binding_holds(state, &body.card_id, &body.worker, &body.session, body.session_attempt).await
    {
        return json!({ "outcome": "not_deliverable", "reason": reason });
    }
    if let Err(reason) = lane.deliverable(state, &body.session).await {
        return json!({ "outcome": "not_deliverable", "reason": reason });
    }

    // The answer record first: whoever claims the revision is the one answer.
    // The binding is read again in the claim's own transaction, so a card
    // given to another worker or attempt since the check is never claimed.
    let slot: Arc<Mutex<Option<ClaimStep>>> = Arc::new(Mutex::new(None));
    let out = slot.clone();
    let (card, revision, request_id) = (body.card_id.clone(), body.question_revision, body.request_id.clone());
    let (worker, session, session_attempt) = (body.worker.clone(), body.session.clone(), body.session_attempt);
    let written = state
        .store
        .write_async(move |conn| {
            let owner = card_owner(conn, &card)?;
            if let Some(reason) = binding_refusal(owner.as_ref(), &worker, &session, session_attempt) {
                *out.lock().expect("dm relay answer slot") = Some(ClaimStep::BindingChanged(reason));
                return Ok(crate::db::WriteOutcome { applied: false, events: vec![] });
            }
            let source = AnswerSource::DmConfirmed { request_id };
            let claim = dm_ask::claim_answer(conn, &card, revision, &source, ANSWER_ACTOR, now)?;
            let applied = matches!(claim, AnswerClaim::Claimed(_));
            *out.lock().expect("dm relay answer slot") = Some(ClaimStep::Claim(claim));
            Ok(crate::db::WriteOutcome { applied, events: vec![] })
        })
        .await;
    let claim = slot.lock().expect("dm relay answer slot").take();
    match (written, claim) {
        (Ok(_), Some(ClaimStep::Claim(AnswerClaim::Claimed(_)))) => {}
        (Ok(_), Some(ClaimStep::BindingChanged(reason))) => {
            return json!({ "outcome": "binding_changed", "reason": reason });
        }
        (Ok(_), Some(ClaimStep::Claim(AnswerClaim::AlreadyAnswered(existing)))) => {
            return json!({
                "outcome": "answered",
                "source": existing.source,
                "same_request": existing.request_id.as_deref() == Some(body.request_id.as_str()),
            });
        }
        (Ok(_), Some(ClaimStep::Claim(AnswerClaim::Refused(reason)))) => {
            return json!({ "outcome": "claim_refused", "reason": reason });
        }
        // The writer's transaction rolled back: no claim, and nothing sent.
        _ => return json!({ "outcome": "not_sent", "reason": "claim_store_failed" }),
    }
    tracing::info!(
        target: "amux::dm_relay",
        card = %body.card_id,
        question_revision = body.question_revision,
        request = %body.request_id,
        verdict = "dm_answer_claimed",
        "a confirmed Decision Maker answer claimed its question revision; sending it"
    );

    let message_id = answer_message_id(&body.request_id);
    if !lane.reserve(state, &body.session, &message_id).await {
        // Reserved before, or not at all: either way the send is not this call's to make.
        return json!({ "outcome": "unknown", "stage": "reservation" });
    }
    match lane.send(state, &body.session, &body.message).await {
        LaneSend::Delivered => {
            lane.accept(state, &body.session, &message_id).await;
            let card_recorded = record_on_card(state, &body.card_id, &body.message).await;
            json!({ "outcome": "delivered", "message_id": message_id, "card_recorded": card_recorded })
        }
        LaneSend::Refused => {
            lane.forget(state, &body.session, &message_id).await;
            json!({ "outcome": "not_sent", "reason": "send_refused" })
        }
        LaneSend::Unknown => json!({ "outcome": "unknown", "stage": "send" }),
    }
}

/// §7: "카드 기록도 같은 표시를 쓴다" -- the card's record is the delivered text,
/// appended as the operator's direct answer is. The PATCH carries no session
/// header, so it notifies nobody.
async fn record_on_card(state: &AppState, card_id: &str, message: &str) -> bool {
    super::board::patch_item(
        State(state.clone()),
        Path(card_id.to_string()),
        HeaderMap::new(),
        Json(json!({ "desc_append": format!("`answered` {message}") })),
    )
    .await
    .status()
    .is_success()
}

async fn answer_unknown(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    answer_unknown_with(&state, &FleetLane, configured_digest().as_deref(), &headers, &body).await
}

/// §9: a delivery whose result is unknown is never sent again. The worker's
/// session is paused first ("그 worker 세션을 일시 정지(AMUX pause)한 뒤"), then
/// the receipt of the message id is read, and what the answer record holds for
/// the revision. Sends nothing; a person resumes the session.
pub(crate) async fn answer_unknown_with<L: AnswerLane>(
    state: &AppState,
    lane: &L,
    configured: Option<&str>,
    headers: &HeaderMap,
    body: &[u8],
) -> Response {
    if let Err(response) = admit(configured, headers) {
        return response;
    }
    let Ok(body) = serde_json::from_slice::<AnswerUnknownBody>(body) else {
        return invalid();
    };
    if !is_card_id(&body.card_id)
        || body.question_revision < 1
        || !dm_ask::is_request_id(&body.request_id)
        || !is_session_name(&body.session)
    {
        return invalid();
    }
    let paused = lane.pause(state, &body.session).await;
    let receipt = lane.receipt(state, &body.session, &answer_message_id(&body.request_id)).await;
    let card = body.card_id.clone();
    let revision = body.question_revision;
    let answer = state
        .store
        .read_async(move |conn| Ok(dm_ask::answer_for(conn, &card, revision)?))
        .await
        .ok()
        .flatten();
    let claimed = answer
        .as_ref()
        .is_some_and(|record| record.request_id.as_deref() == Some(body.request_id.as_str()));
    tracing::warn!(
        target: "amux::dm_relay",
        card = %body.card_id,
        question_revision = body.question_revision,
        request = %body.request_id,
        paused,
        receipt,
        claimed,
        verdict = "dm_answer_delivery_unknown",
        "a confirmed Decision Maker answer's delivery is unknown; the session is paused and the operator decides"
    );
    Json(json!({
        "paused": paused,
        "receipt": receipt,
        "claimed_by_request": claimed,
        "answer_source": answer.map(|record| record.source),
    }))
    .into_response()
}

// ---------------------------------------------------------------------------
// Stage S2-2b4: the operator's answers and one decided delivery's records
// ---------------------------------------------------------------------------

/// At most this many operator answer records per answer; the bridge reads on
/// from the last one's time.
pub const OPERATOR_ANSWER_LIST_LIMIT: usize = 50;

async fn operator_answers(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    operator_answers_with(&state, configured_digest().as_deref(), &headers, &body).await
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct OperatorAnswersBody {
    since: i64,
}

/// `POST /api/dm-relay/answers/operator` with `{since}` (seconds): the
/// operator's answer records from that time on (`dm_ask::operator_answers_since`),
/// in the order of their time and then their question, at most
/// [`OPERATOR_ANSWER_LIST_LIMIT`] -- `{answers: [{card_id, question_revision,
/// recorded_at}], truncated}`. The bridge reports each question to the app,
/// whose router closes its open Decision Maker request
/// (docs/policy/amux-decision-maker.md §2-7: "운영자의 직접 답이 먼저면 요청은
/// 닫힌다"). A read: it changes nothing, and carries no answer text.
pub(crate) async fn operator_answers_with(
    state: &AppState,
    configured: Option<&str>,
    headers: &HeaderMap,
    body: &[u8],
) -> Response {
    if let Err(response) = admit(configured, headers) {
        return response;
    }
    let Ok(body) = serde_json::from_slice::<OperatorAnswersBody>(body) else {
        return invalid();
    };
    let since = body.since;
    let read = state
        .store
        .read_async(move |conn| Ok(dm_ask::operator_answers_since(conn, since, OPERATOR_ANSWER_LIST_LIMIT + 1)?))
        .await;
    let Ok(mut records) = read else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "dm relay answer record read failed" })),
        )
            .into_response();
    };
    let truncated = records.len() > OPERATOR_ANSWER_LIST_LIMIT;
    records.truncate(OPERATOR_ANSWER_LIST_LIMIT);
    let answers: Vec<_> = records
        .into_iter()
        .map(|record| {
            json!({
                "card_id": record.issue_id,
                "question_revision": record.question_revision,
                "recorded_at": record.recorded_at,
            })
        })
        .collect();
    Json(json!({ "answers": answers, "truncated": truncated })).into_response()
}

async fn answer_receipt(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    answer_receipt_with(&state, &FleetLane, configured_digest().as_deref(), &headers, &body).await
}

/// `POST /api/dm-relay/answers/receipt` with the same body as
/// `answers/unknown`: what this AMUX holds of one decided delivery, for a
/// bridge that stopped between the app's delivery decision and its outcome
/// (stage S2-2b4, docs/policy/amux-decision-maker.md §9) -- the reservation of
/// the request's message id in the session's send ledger (`accepted`,
/// `pending`, `none` or `unreadable`), the question revision's answer record
/// (`answer_source`, and whether this request holds it), and whether the card
/// still asks that revision. A read: unlike `answers/unknown` it pauses
/// nothing, and like every route here it sends nothing. The bridge records
/// the outcome these prove, and pauses the session through `answers/unknown`
/// when they prove none.
pub(crate) async fn answer_receipt_with<L: AnswerLane>(
    state: &AppState,
    lane: &L,
    configured: Option<&str>,
    headers: &HeaderMap,
    body: &[u8],
) -> Response {
    if let Err(response) = admit(configured, headers) {
        return response;
    }
    let Ok(body) = serde_json::from_slice::<AnswerUnknownBody>(body) else {
        return invalid();
    };
    if !is_card_id(&body.card_id)
        || body.question_revision < 1
        || !dm_ask::is_request_id(&body.request_id)
        || !is_session_name(&body.session)
    {
        return invalid();
    }
    let reservation = lane
        .reservation(state, &body.session, &answer_message_id(&body.request_id))
        .await;
    let (card, revision) = (body.card_id.clone(), body.question_revision);
    let read = state
        .store
        .read_async(move |conn| {
            let answer = dm_ask::answer_for(conn, &card, revision)?;
            let current = dm_ask::current_revision(conn, &card)?.map(|current| current.question_revision);
            Ok((answer, current == Some(revision)))
        })
        .await;
    let Ok((answer, question_current)) = read else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "dm relay answer record read failed" })),
        )
            .into_response();
    };
    let claimed = answer
        .as_ref()
        .is_some_and(|record| record.request_id.as_deref() == Some(body.request_id.as_str()));
    Json(json!({
        "reservation": reservation,
        "answer_source": answer.map(|record| record.source),
        "claimed_by_request": claimed,
        "question_current": question_current,
    }))
    .into_response()
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

    // -----------------------------------------------------------------------
    // Stage S2-2b3: delivering an operator-confirmed answer
    // -----------------------------------------------------------------------

    /// A lane whose answers are set by the test, recording every call.
    #[derive(Clone)]
    struct FakeLane {
        deliverable: Result<(), &'static str>,
        reserve: bool,
        send: LaneSend,
        paused: bool,
        receipt: &'static str,
        /// The operator's direct answer, claimed while the lane is checked:
        /// the race between the delivery's read and its claim.
        operator_answers_during_check: Option<(String, i64)>,
        /// Stage S2-2b4: the message id's reservation the send ledger holds.
        reservation: &'static str,
        /// The card given to another worker while the lane is checked: the
        /// race between the delivery's binding check and its claim.
        reassigned_during_check: Option<(String, String)>,
        calls: Arc<Mutex<Vec<String>>>,
    }

    impl FakeLane {
        fn ready() -> Self {
            Self {
                deliverable: Ok(()),
                reserve: true,
                send: LaneSend::Delivered,
                paused: true,
                receipt: "not_accepted",
                operator_answers_during_check: None,
                reservation: "none",
                reassigned_during_check: None,
                calls: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }

        fn sends(&self) -> usize {
            self.calls().iter().filter(|call| call.starts_with("send")).count()
        }
    }

    #[async_trait]
    impl AnswerLane for FakeLane {
        async fn deliverable(&self, state: &AppState, _session: &str) -> Result<(), &'static str> {
            self.calls.lock().unwrap().push("deliverable".into());
            if let Some((card, revision)) = self.operator_answers_during_check.clone() {
                state
                    .store
                    .write_async(move |conn| {
                        dm_ask::claim_answer(conn, &card, revision, &AnswerSource::Operator, "Ethan", 1)?;
                        Ok(crate::db::WriteOutcome { applied: true, events: vec![] })
                    })
                    .await
                    .unwrap();
            }
            if let Some((card, session)) = self.reassigned_during_check.clone() {
                state
                    .store
                    .write_async(move |conn| {
                        conn.execute("UPDATE issues SET session = ?2 WHERE id = ?1", rusqlite::params![card, session])?;
                        Ok(crate::db::WriteOutcome { applied: true, events: vec![] })
                    })
                    .await
                    .unwrap();
            }
            self.deliverable
        }
        async fn reserve(&self, _state: &AppState, _session: &str, message_id: &str) -> bool {
            self.calls.lock().unwrap().push(format!("reserve {message_id}"));
            self.reserve
        }
        async fn send(&self, _state: &AppState, session: &str, text: &str) -> LaneSend {
            self.calls.lock().unwrap().push(format!("send {session} {text}"));
            self.send
        }
        async fn accept(&self, _state: &AppState, _session: &str, message_id: &str) {
            self.calls.lock().unwrap().push(format!("accept {message_id}"));
        }
        async fn forget(&self, _state: &AppState, _session: &str, message_id: &str) {
            self.calls.lock().unwrap().push(format!("forget {message_id}"));
        }
        async fn pause(&self, _state: &AppState, session: &str) -> bool {
            self.calls.lock().unwrap().push(format!("pause {session}"));
            self.paused
        }
        async fn receipt(&self, _state: &AppState, _session: &str, message_id: &str) -> &'static str {
            self.calls.lock().unwrap().push(format!("receipt {message_id}"));
            self.receipt
        }
        async fn reservation(&self, _state: &AppState, session: &str, message_id: &str) -> &'static str {
            self.calls.lock().unwrap().push(format!("reservation {session} {message_id}"));
            self.reservation
        }
    }

    const SESSION: &str = "claude-impl";

    fn message_for(card: &str) -> String {
        format!(
            "[Decision Maker decision-maker-openai (GPT-6 Astra) 제안, operator-confirmed, re {card}]\n선택지: sqlite\n\n승인 계약의 승인이 아니다. 사람 승인이 필요한 게이트는 따로 요청한다."
        )
    }

    /// §9's binding as the relay routed it: the card's owner session is the
    /// asking worker and its session, with the card's newest attempt (none: 0).
    fn check_body(card: &str, revision: i64) -> Vec<u8> {
        check_body_bound(card, revision, SESSION, SESSION, 0)
    }

    fn check_body_bound(card: &str, revision: i64, worker: &str, session: &str, attempt: i64) -> Vec<u8> {
        json!({"card_id": card, "question_revision": revision, "worker": worker,
            "session": session, "session_attempt": attempt})
        .to_string()
        .into_bytes()
    }

    fn answer_body(card: &str, revision: i64, request: &str, message: &str) -> Vec<u8> {
        json!({"card_id": card, "question_revision": revision, "request_id": request,
            "worker": SESSION, "session": SESSION, "session_attempt": 0, "message": message})
        .to_string()
        .into_bytes()
    }

    /// An asking card owned by `SESSION`, as a worker's own typed ask is.
    async fn owned_card(app: &Router, state: &AppState) -> String {
        let card = asking_card(app).await;
        own(state, &card, SESSION);
        card
    }

    fn own(state: &AppState, card: &str, session: &str) {
        let (card, session) = (card.to_string(), session.to_string());
        state
            .store
            .write(move |conn| {
                conn.execute("UPDATE issues SET session = ?2 WHERE id = ?1", rusqlite::params![card, session])?;
                Ok(crate::db::WriteOutcome { applied: true, events: vec![] })
            })
            .unwrap();
    }

    fn unknown_body(card: &str, revision: i64, request: &str) -> Vec<u8> {
        json!({"card_id": card, "question_revision": revision, "request_id": request, "session": SESSION})
            .to_string()
            .into_bytes()
    }

    #[tokio::test]
    async fn the_answer_routes_are_closed_without_the_relay_token() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::api::settings::test_env::set_home(home.path());
        let (app, state, _dir) = app();
        let card = owned_card(&app, &state).await;
        let lane = FakeLane::ready();
        let digest = digest();
        for (configured, headers, reason) in [
            (None, token_headers(TOKEN), "dm_relay_not_configured"),
            (Some(digest.as_str()), HeaderMap::new(), "dm_relay_token_missing"),
            (Some(digest.as_str()), token_headers("not-the-relay-token"), "dm_relay_token_refused"),
        ] {
            for response in [
                check_answer_with(&state, &lane, configured, &headers, &check_body(&card, 1)).await,
                deliver_answer_with(&state, lane.clone(), configured, &headers, &answer_body(&card, 1, REQUEST, &message_for(&card))).await,
                answer_unknown_with(&state, &lane, configured, &headers, &unknown_body(&card, 1, REQUEST)).await,
            ] {
                let (status, body) = json_of(response).await;
                assert_eq!((status, body["reason"].as_str()), (StatusCode::FORBIDDEN, Some(reason)));
            }
        }
        assert!(lane.calls().is_empty(), "a refused call reaches no lane");
        let (_, typed) = call(&app, "GET", &format!("/api/board/{card}/typed-ask"), None).await;
        assert!(typed["answer"].is_null(), "{typed}");
    }

    #[tokio::test]
    async fn a_confirmed_answer_is_claimed_then_sent_once_and_recorded_on_the_card() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::api::settings::test_env::set_home(home.path());
        let (app, state, _dir) = app();
        let card = owned_card(&app, &state).await;
        let digest = digest();
        let headers = token_headers(TOKEN);
        let lane = FakeLane::ready();

        let (_, check) = json_of(check_answer_with(&state, &lane, Some(&digest), &headers, &check_body(&card, 1)).await).await;
        assert_eq!(check, json!({"deliverable": true}));

        let message = message_for(&card);
        let (status, delivered) = json_of(
            deliver_answer_with(&state, lane.clone(), Some(&digest), &headers, &answer_body(&card, 1, REQUEST, &message)).await,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{delivered}");
        assert_eq!(delivered["outcome"], "delivered", "{delivered}");
        assert_eq!(delivered["message_id"], format!("dm-answer:{REQUEST}"));
        assert_eq!(delivered["card_recorded"], true);
        let message_id = answer_message_id(REQUEST);
        assert_eq!(
            lane.calls(),
            vec![
                "deliverable".to_string(),
                "deliverable".to_string(),
                format!("reserve {message_id}"),
                format!("send {SESSION} {message}"),
                format!("accept {message_id}"),
            ]
        );
        // The record names this request; the card carries the same text.
        let (_, typed) = call(&app, "GET", &format!("/api/board/{card}/typed-ask"), None).await;
        assert_eq!(typed["answer"]["source"], "dm_confirmed", "{typed}");
        assert_eq!(typed["answer"]["request_id"], REQUEST);
        assert_eq!(typed["answer"]["actor"], ANSWER_ACTOR);
        let (_, detail) = call(&app, "GET", &format!("/api/board/{card}"), None).await;
        assert!(
            detail["desc"].as_str().unwrap_or("").contains(&format!("`answered` {message}")),
            "{detail}"
        );

        // Never twice: the same request again, and another request, send nothing.
        for request in [REQUEST, OTHER_REQUEST] {
            let (_, again) = json_of(
                deliver_answer_with(&state, lane.clone(), Some(&digest), &headers, &answer_body(&card, 1, request, &message)).await,
            )
            .await;
            assert_eq!(again, json!({"outcome": "not_deliverable", "reason": "answered"}));
        }
        assert_eq!(lane.sends(), 1);
        let (_, check) = json_of(check_answer_with(&state, &lane, Some(&digest), &headers, &check_body(&card, 1)).await).await;
        assert_eq!(check, json!({"deliverable": false, "reason": "answered"}));
    }

    /// §12: "직접 답과 확정 답이 함께 와도 하나만 전달된다", both orders, on the
    /// route the bridge calls: the operator's answer first -- before the
    /// delivery reads the card, or between its read and its claim -- and the
    /// confirmed answer is never sent.
    #[tokio::test]
    async fn a_direct_answer_first_stops_the_confirmed_one_whenever_it_lands() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::api::settings::test_env::set_home(home.path());
        let (app, state, _dir) = app();
        let digest = digest();
        let headers = token_headers(TOKEN);

        // Before the delivery reads the card.
        let card = owned_card(&app, &state).await;
        let claimed = card.clone();
        state
            .store
            .write(move |conn| {
                dm_ask::claim_answer(conn, &claimed, 1, &AnswerSource::Operator, "Ethan", 1)?;
                Ok(crate::db::WriteOutcome { applied: true, events: vec![] })
            })
            .unwrap();
        let lane = FakeLane::ready();
        let (_, refused) = json_of(
            deliver_answer_with(&state, lane.clone(), Some(&digest), &headers, &answer_body(&card, 1, REQUEST, &message_for(&card))).await,
        )
        .await;
        assert_eq!(refused, json!({"outcome": "not_deliverable", "reason": "answered_by_operator"}));
        assert_eq!(lane.sends(), 0);

        // Between the delivery's read and its claim: the claim loses.
        let card = owned_card(&app, &state).await;
        let mut lane = FakeLane::ready();
        lane.operator_answers_during_check = Some((card.clone(), 1));
        let (_, lost) = json_of(
            deliver_answer_with(&state, lane.clone(), Some(&digest), &headers, &answer_body(&card, 1, REQUEST, &message_for(&card))).await,
        )
        .await;
        assert_eq!(lost, json!({"outcome": "answered", "source": "operator", "same_request": false}));
        assert_eq!(lane.sends(), 0);
        assert_eq!(lane.calls(), vec!["deliverable".to_string()]);
        let (_, typed) = call(&app, "GET", &format!("/api/board/{card}/typed-ask"), None).await;
        assert_eq!(typed["answer"]["source"], "operator", "{typed}");
    }

    #[tokio::test]
    async fn a_send_that_typed_nothing_releases_its_reservation_and_an_unknown_one_keeps_it() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::api::settings::test_env::set_home(home.path());
        let (app, state, _dir) = app();
        let digest = digest();
        let headers = token_headers(TOKEN);
        let message_id = answer_message_id(REQUEST);
        for (send, outcome, last) in [
            (LaneSend::Refused, json!({"outcome": "not_sent", "reason": "send_refused"}), Some(format!("forget {message_id}"))),
            (LaneSend::Unknown, json!({"outcome": "unknown", "stage": "send"}), None),
        ] {
            let card = owned_card(&app, &state).await;
            let mut lane = FakeLane::ready();
            lane.send = send;
            let (_, answer) = json_of(
                deliver_answer_with(&state, lane.clone(), Some(&digest), &headers, &answer_body(&card, 1, REQUEST, &message_for(&card))).await,
            )
            .await;
            assert_eq!(answer, outcome);
            let calls = lane.calls();
            assert!(calls.last().unwrap().starts_with(match &last {
                Some(last) => last.as_str(),
                None => "send",
            }), "{calls:?}");
            assert!(!calls.iter().any(|call| call.starts_with("accept")), "{calls:?}");
            // Either way the revision is answered: the claim came first and is never undone.
            let (_, typed) = call(&app, "GET", &format!("/api/board/{card}/typed-ask"), None).await;
            assert_eq!(typed["answer"]["source"], "dm_confirmed", "{typed}");
            let (_, detail) = call(&app, "GET", &format!("/api/board/{card}"), None).await;
            assert!(!detail["desc"].as_str().unwrap_or("").contains("[Decision Maker"), "no card record without a delivery");
        }
        // A reservation that already existed is not this call's to send.
        let card = owned_card(&app, &state).await;
        let mut lane = FakeLane::ready();
        lane.reserve = false;
        let (_, answer) = json_of(
            deliver_answer_with(&state, lane.clone(), Some(&digest), &headers, &answer_body(&card, 1, REQUEST, &message_for(&card))).await,
        )
        .await;
        assert_eq!(answer, json!({"outcome": "unknown", "stage": "reservation"}));
        assert_eq!(lane.sends(), 0);
    }

    #[tokio::test]
    async fn a_lane_that_cannot_take_input_or_a_changed_question_claims_nothing() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::api::settings::test_env::set_home(home.path());
        let (app, state, _dir) = app();
        let digest = digest();
        let headers = token_headers(TOKEN);
        let card = owned_card(&app, &state).await;
        let mut lane = FakeLane::ready();
        lane.deliverable = Err("busy");
        let (_, check) = json_of(check_answer_with(&state, &lane, Some(&digest), &headers, &check_body(&card, 1)).await).await;
        assert_eq!(check, json!({"deliverable": false, "reason": "busy"}));
        let (_, answer) = json_of(
            deliver_answer_with(&state, lane.clone(), Some(&digest), &headers, &answer_body(&card, 1, REQUEST, &message_for(&card))).await,
        )
        .await;
        assert_eq!(answer, json!({"outcome": "not_deliverable", "reason": "busy"}));
        // A revision the card no longer asks is changed, whatever the lane says.
        let (_, stale) = json_of(check_answer_with(&state, &FakeLane::ready(), Some(&digest), &headers, &check_body(&card, 2)).await).await;
        assert_eq!(stale, json!({"deliverable": false, "reason": "question_changed"}));
        let (_, typed) = call(&app, "GET", &format!("/api/board/{card}/typed-ask"), None).await;
        assert!(typed["answer"].is_null(), "{typed}");
        assert_eq!(lane.sends(), 0);
    }

    #[tokio::test]
    async fn a_message_that_does_not_name_its_card_never_reaches_the_lane() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::api::settings::test_env::set_home(home.path());
        let (app, state, _dir) = app();
        let digest = digest();
        let headers = token_headers(TOKEN);
        let card = owned_card(&app, &state).await;
        let lane = FakeLane::ready();
        for message in [
            message_for("AMUX-OTHER"),
            "sqlite".to_string(),
            String::new(),
            format!("{}\n{}", message_for(&card), "x".repeat(ANSWER_MESSAGE_MAX_BYTES)),
        ] {
            let (status, _) = json_of(
                deliver_answer_with(&state, lane.clone(), Some(&digest), &headers, &answer_body(&card, 1, REQUEST, &message)).await,
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
        }
        // Nothing else rides along: no result, no output field.
        let with_output = json!({"card_id": card, "question_revision": 1, "request_id": REQUEST,
            "session": SESSION, "message": message_for(&card), "output": "select sqlite"})
        .to_string();
        let (status, _) = json_of(deliver_answer_with(&state, lane.clone(), Some(&digest), &headers, with_output.as_bytes()).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(lane.calls().is_empty());
        assert!(message_names_card(&message_for(&card), &card));
    }

    #[tokio::test]
    async fn an_unknown_delivery_pauses_the_session_before_reading_the_receipt_and_sends_nothing() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::api::settings::test_env::set_home(home.path());
        let (app, state, _dir) = app();
        let digest = digest();
        let headers = token_headers(TOKEN);
        let card = owned_card(&app, &state).await;
        let mut lane = FakeLane::ready();
        lane.send = LaneSend::Unknown;
        deliver_answer_with(&state, lane.clone(), Some(&digest), &headers, &answer_body(&card, 1, REQUEST, &message_for(&card))).await;
        let after_delivery = lane.calls().len();
        let (_, unknown) = json_of(
            answer_unknown_with(&state, &lane, Some(&digest), &headers, &unknown_body(&card, 1, REQUEST)).await,
        )
        .await;
        assert_eq!(
            unknown,
            json!({"paused": true, "receipt": "not_accepted", "claimed_by_request": true, "answer_source": "dm_confirmed"})
        );
        assert_eq!(
            lane.calls()[after_delivery..].to_vec(),
            vec![format!("pause {SESSION}"), format!("receipt {}", answer_message_id(REQUEST))]
        );
        assert_eq!(lane.sends(), 1, "the unknown route sends nothing");
    }

    #[test]
    fn the_send_paths_own_verdict_decides_delivered_refused_or_unknown() {
        assert_eq!(lane_send_verdict(true, "sent"), LaneSend::Delivered);
        assert_eq!(lane_send_verdict(true, "sent (Enter landed on retry)"), LaneSend::Delivered);
        assert_eq!(lane_send_verdict(false, "session at a selector — retry at next idle boundary"), LaneSend::Refused);
        assert_eq!(lane_send_verdict(false, "target is paused: amux automation is not delivered into a paused worker."), LaneSend::Refused);
        assert_eq!(lane_send_verdict(false, "not submitted — the text is in the composer"), LaneSend::Unknown);
        assert_eq!(lane_send_verdict(true, "sent but could not be verified"), LaneSend::Unknown);
        assert_eq!(lane_send_verdict(true, "queued (steering) — delivers later"), LaneSend::Unknown);
        assert_eq!(answer_message_id(REQUEST).len(), 46);
    }

    /// Review r-20261018-065705-65cb2a, finding 2: the question revision does
    /// not change when a card is given to another worker or attempt, so the
    /// revision alone would send the confirmed answer to a session that no
    /// longer owns the question. §9's binding -- the asking worker, its AMUX
    /// session and the card's attempt, as the relay routed them -- must still
    /// be the card's, at the check and again in the claim's own transaction.
    #[tokio::test]
    async fn a_card_given_to_another_worker_or_attempt_is_never_answered_into_the_old_session() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::api::settings::test_env::set_home(home.path());
        let (app, state, _dir) = app();
        let digest = digest();
        let headers = token_headers(TOKEN);

        // The card was given to another worker; the question is the same.
        let card = owned_card(&app, &state).await;
        own(&state, &card, "codex-impl");
        let (_, typed) = call(&app, "GET", &format!("/api/board/{card}/typed-ask"), None).await;
        assert_eq!(typed["current_revision"]["question_revision"], 1, "{typed}");
        let lane = FakeLane::ready();
        let (_, check) = json_of(check_answer_with(&state, &lane, Some(&digest), &headers, &check_body(&card, 1)).await).await;
        assert_eq!(check, json!({"deliverable": false, "reason": "owner_changed"}));
        let (_, answer) = json_of(
            deliver_answer_with(&state, lane.clone(), Some(&digest), &headers, &answer_body(&card, 1, REQUEST, &message_for(&card))).await,
        )
        .await;
        assert_eq!(answer, json!({"outcome": "not_deliverable", "reason": "owner_changed"}));

        // Another attempt of the same owner, and a binding whose worker is not the owner.
        own(&state, &card, SESSION);
        for (body, reason) in [
            (check_body_bound(&card, 1, SESSION, SESSION, 1), "attempt_changed"),
            (check_body_bound(&card, 1, "someone-else", SESSION, 0), "owner_changed"),
        ] {
            let (_, check) = json_of(check_answer_with(&state, &lane, Some(&digest), &headers, &body).await).await;
            assert_eq!(check, json!({"deliverable": false, "reason": reason}));
        }
        let (_, check) = json_of(check_answer_with(&state, &lane, Some(&digest), &headers, &check_body(&card, 1)).await).await;
        assert_eq!(check, json!({"deliverable": true}), "the binding is the card's again");

        // Given away between the check and the claim: the claim's own transaction refuses it.
        let mut lane = FakeLane::ready();
        lane.reassigned_during_check = Some((card.clone(), "codex-impl".to_string()));
        let (_, answer) = json_of(
            deliver_answer_with(&state, lane.clone(), Some(&digest), &headers, &answer_body(&card, 1, REQUEST, &message_for(&card))).await,
        )
        .await;
        assert_eq!(answer, json!({"outcome": "binding_changed", "reason": "owner_changed"}));
        assert_eq!(lane.sends(), 0);
        let (_, typed) = call(&app, "GET", &format!("/api/board/{card}/typed-ask"), None).await;
        assert!(typed["answer"].is_null(), "nothing was claimed: {typed}");
    }

    // -----------------------------------------------------------------------
    // Stage S2-2b4: the operator's answers and one decided delivery's records
    // -----------------------------------------------------------------------

    fn claim_as(state: &AppState, card: &str, revision: i64, source: AnswerSource, at: i64) {
        let card = card.to_string();
        state
            .store
            .write(move |conn| {
                let claim = dm_ask::claim_answer(conn, &card, revision, &source, "Ethan", at)?;
                assert!(matches!(claim, AnswerClaim::Claimed(_)), "{claim:?}");
                Ok(crate::db::WriteOutcome { applied: true, events: vec![] })
            })
            .unwrap();
    }

    #[tokio::test]
    async fn the_operator_answer_list_is_the_operators_records_by_time_behind_the_relay_token() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::api::settings::test_env::set_home(home.path());
        let (app, state, _dir) = app();
        let digest = digest();
        let headers = token_headers(TOKEN);
        let first = owned_card(&app, &state).await;
        let confirmed = owned_card(&app, &state).await;
        let second = owned_card(&app, &state).await;
        claim_as(&state, &first, 1, AnswerSource::Operator, 500);
        claim_as(&state, &confirmed, 1, AnswerSource::DmConfirmed { request_id: REQUEST.into() }, 450);
        claim_as(&state, &second, 1, AnswerSource::Operator, 400);
        // Behind the relay's token, like every route here.
        for (configured, headers, reason) in [
            (None, token_headers(TOKEN), "dm_relay_not_configured"),
            (Some(digest.as_str()), HeaderMap::new(), "dm_relay_token_missing"),
            (Some(digest.as_str()), token_headers("not-the-relay-token"), "dm_relay_token_refused"),
        ] {
            let (status, body) = json_of(operator_answers_with(&state, configured, &headers, br#"{"since": 0}"#).await).await;
            assert_eq!((status, body["reason"].as_str()), (StatusCode::FORBIDDEN, Some(reason)));
        }
        // The operator's records only, by time; a confirmed answer's record is not one.
        let (status, listed) = json_of(operator_answers_with(&state, Some(&digest), &headers, br#"{"since": 0}"#).await).await;
        assert_eq!(status, StatusCode::OK, "{listed}");
        assert_eq!(
            listed,
            json!({"answers": [
                {"card_id": second, "question_revision": 1, "recorded_at": 400},
                {"card_id": first, "question_revision": 1, "recorded_at": 500},
            ], "truncated": false})
        );
        let (_, later) = json_of(operator_answers_with(&state, Some(&digest), &headers, br#"{"since": 401}"#).await).await;
        assert_eq!(later["answers"].as_array().unwrap().len(), 1);
        assert_eq!(later["answers"][0]["card_id"], json!(first));
        // Nothing but a time: no other field, and a time it is.
        for bad in [&br#"{}"#[..], br#"{"since": 0, "card_id": "x"}"#, br#"{"since": "0"}"#, b"x"] {
            let (status, _) = json_of(operator_answers_with(&state, Some(&digest), &headers, bad).await).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{}", String::from_utf8_lossy(bad));
        }
    }

    #[tokio::test]
    async fn the_receipt_read_reports_the_reservation_and_the_record_and_never_pauses_or_sends() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::api::settings::test_env::set_home(home.path());
        let (app, state, _dir) = app();
        let digest = digest();
        let headers = token_headers(TOKEN);
        let card = owned_card(&app, &state).await;
        let message_id = answer_message_id(REQUEST);
        let read = |lane: FakeLane, revision: i64, card: String| {
            let state = state.clone();
            let (digest, headers) = (digest.clone(), headers.clone());
            async move {
                let response = answer_receipt_with(&state, &lane, Some(&digest), &headers, &unknown_body(&card, revision, REQUEST)).await;
                (json_of(response).await, lane)
            }
        };
        // Nothing recorded, the question still open, never reserved.
        let ((status, open), lane) = read(FakeLane::ready(), 1, card.clone()).await;
        assert_eq!(status, StatusCode::OK, "{open}");
        assert_eq!(
            open,
            json!({"reservation": "none", "answer_source": null, "claimed_by_request": false, "question_current": true})
        );
        // It reads: the reservation of this request's message id in its session, and nothing else.
        assert_eq!(lane.calls(), vec![format!("reservation {SESSION} {message_id}")]);
        // A revision the card no longer asks.
        let ((_, moved), _) = read(FakeLane::ready(), 2, card.clone()).await;
        assert_eq!(moved["question_current"], json!(false));
        // This request's claim, reserved and never acknowledged.
        claim_as(&state, &card, 1, AnswerSource::DmConfirmed { request_id: REQUEST.into() }, 600);
        let mut pending = FakeLane::ready();
        pending.reservation = "pending";
        let ((_, claimed), lane) = read(pending, 1, card.clone()).await;
        assert_eq!(
            claimed,
            json!({"reservation": "pending", "answer_source": "dm_confirmed", "claimed_by_request": true, "question_current": true})
        );
        assert!(lane.calls().iter().all(|call| call.starts_with("reservation ")), "never paused, reserved or sent");
        // The operator's record on another card.
        let other = owned_card(&app, &state).await;
        claim_as(&state, &other, 1, AnswerSource::Operator, 610);
        let ((_, operator), _) = read(FakeLane::ready(), 1, other).await;
        assert_eq!(operator["answer_source"], json!("operator"));
        assert_eq!(operator["claimed_by_request"], json!(false));
        // Behind the token, and a strict body.
        let lane = FakeLane::ready();
        let (status, _) = json_of(answer_receipt_with(&state, &lane, None, &headers, &unknown_body(&card, 1, REQUEST)).await).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let extra = json!({"card_id": card, "question_revision": 1, "request_id": REQUEST, "session": SESSION, "message": "x"}).to_string();
        let (status, _) = json_of(answer_receipt_with(&state, &lane, Some(&digest), &headers, extra.as_bytes()).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(lane.calls().is_empty());
    }
}
