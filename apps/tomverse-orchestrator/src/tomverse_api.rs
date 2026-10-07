use std::time::Duration;

use anyhow::{Context, Result, bail};
use reqwest::{Client, StatusCode, header};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;

use uuid::Uuid;

use crate::orchestrator_halt::{AckRequest, HaltRecordRequest};
use crate::scheduler::ScoreBreakdown;
use crate::worker::{CandidateRoutingSignals, RoutingTaskProfile};

/// Orchestration policy version 20, section 4: the request identity of a
/// write call, sent as headers so the claim, recover and tick bodies stay
/// exactly what they were (tests/fixtures and main_wire_compat.rs pin them).
pub const REQUEST_ID_HEADER: &str = "x-amux-request-id";
pub const INSTANCE_ID_HEADER: &str = "x-amux-instance-id";

/// A new request id for every write call, the process's instance id on each.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WriteIds {
    pub request_id: Uuid,
    pub instance_id: Uuid,
}

/// A status and the body that came with it, read whole and bounded, whatever
/// the status. The caller decides what it means (lib orchestrator_halt.rs);
/// a transport failure, a body over its limit or a compressed body is an
/// error instead, which for a write call is no answer at all.
#[derive(Debug)]
pub struct RawAnswer {
    pub status: StatusCode,
    pub body: Vec<u8>,
}

pub(crate) async fn read_raw_answer(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> Result<RawAnswer> {
    let status = response.status();
    ensure_identity_encoding(&response)?;
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .context("failed to read Tomverse internal response")?
    {
        let next_len = body
            .len()
            .checked_add(chunk.len())
            .context("Tomverse internal response byte count overflow")?;
        if next_len > max_bytes {
            bail!("Tomverse internal response exceeds byte limit");
        }
        body.extend_from_slice(&chunk);
    }
    Ok(RawAnswer { status, body })
}

#[derive(Clone)]
pub struct TomverseApi {
    client: Client,
    claim_timeout: Duration,
    selection_read_timeout: Duration,
    base_url: String,
    secret: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V22UsageRecord {
    Recorded,
    PrivateOnly,
    Rejected,
}

const PRISMA_INT_MAX: i64 = 2_147_483_647;
const MAX_QUEUE_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_OWNED_QUEUE_RESPONSE_BYTES: usize = 1024 * 1024;
// Matches the app's complete-or-refuse serialization ceiling.
const MAX_ROUTING_RESPONSE_BYTES: usize = 512 * 1024;
const MAX_LIFECYCLE_RESPONSE_BYTES: usize = 128 * 1024;
const MAX_QUEUE_ITEMS: usize = 512;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QueueTask {
    pub id: String,
    pub kind: String,
    pub priority: String,
    pub pinned: bool,
    pub drag: i64,
    pub revision: i64,
    pub created_at: String,
    pub dependent_count: i64,
    #[serde(default)]
    pub scheduler_score: i64,
    #[serde(default)]
    pub scoring_version: String,
    #[serde(default)]
    pub scheduler_signals: ScoreBreakdown,
    // Compatibility window (docs/ops/amux/wsl-execution-bridge.md, "Wire
    // compatibility"). main's server sent these four. This app keeps sending
    // title, status and dependencies, which an orchestrator built before this
    // change requires, and no longer sends owner, which that orchestrator
    // reads as an Option. Accepted from either server and never read here; a
    // server that drops them parses the same. Any other field is still
    // refused.
    #[serde(default, rename = "title")]
    pub legacy_title: Option<String>,
    #[serde(default, rename = "status")]
    pub legacy_status: Option<String>,
    #[serde(default, rename = "owner")]
    pub legacy_owner: Option<String>,
    #[serde(default, rename = "dependencies")]
    pub legacy_dependencies: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
struct QueueRequest {}

#[derive(Debug, Serialize)]
struct RoutingSnapshotRequest<'a> {
    task_id: &'a str,
    expected_revision: i64,
}

/// The routing snapshot the app sends (lib/amux/wireContract.ts,
/// `amuxRoutingResponseSchema`). The field list is pinned against that schema
/// by tests/amuxWireContract.test.ts and against the shared fixture
/// tests/fixtures/amux-routing-snapshot-v1.json on both sides, so a field the
/// server adds fails a test instead of the first non-empty queue.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoutingSnapshotResponse {
    pub eligible: bool,
    pub execution_ready: bool,
    pub reason: Option<String>,
    pub task: Option<RoutingTaskProfile>,
    pub candidates: Vec<CandidateRoutingSignals>,
    /// Per-worker routing evidence, keyed by worker name. The scorer reads
    /// the candidate signals, which the server already derived from this, so
    /// the evidence stays an opaque object here: only its outer shape (object
    /// values under canonical worker names, empty on a refusal) is checked.
    /// Its inner fields are the server schema's to police.
    pub telemetry: serde_json::Map<String, Value>,
}

const MAX_ROUTING_CANDIDATES: usize = 128;

/// The one conflict the two selection reads answer with a known meaning: the
/// board is larger than the app serializes in one complete response (more than
/// 512 rows, or a body over 512 KB; lib/amux/store.ts and
/// lib/amux/internalRoute.ts). main's server never sent it. Nothing was
/// written and nothing was claimed, so the scheduler logs it and skips the
/// tick instead of treating it as an unknown outcome.
pub const BOARD_CAPACITY_EXCEEDED: &str = "board_capacity_exceeded";

/// The 503 the three selection reads (queue, routing snapshot, owned queue)
/// answer with when the database could not take the read just then: no pool
/// connection, no transaction start within `maxWait`, a statement timeout or a
/// dropped connection, in a route that had written nothing
/// (lib/amux/readFailureCore.ts; decided in `amuxDbBoundaryFailure`,
/// lib/amux/dbBoundary.ts). A read writes nothing, so this is not an unknown
/// outcome: the scheduler and the WSL bridge log it and skip the tick. A write
/// whose outcome is unknown still answers `amux_outcome_unknown`, and every
/// other 503 stays an error.
pub const DATABASE_BUSY: &str = "amux_database_busy";

/// A selection read: the body, the app's board-capacity refusal, or the app's
/// database-busy answer. The last two wrote nothing.
#[derive(Debug)]
pub enum SelectionRead<T> {
    Ready(T),
    BoardCapacityExceeded,
    DatabaseBusy,
}

/// The selection reads at 503: `{error, reason}` from
/// `amuxInternalErrorResponse` (lib/amux/internalRoute.ts), the same body for
/// all three routes.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DatabaseBusyAnswer {
    #[allow(dead_code)]
    error: String,
    reason: String,
}

/// The statuses the three selection reads parse: 200, the capacity 409 and
/// the database-busy 503. Each parser still refuses any other body at 409 or
/// 503. Writes do not use this list.
const SELECTION_READ_STATUSES: &[StatusCode] = &[
    StatusCode::OK,
    StatusCode::CONFLICT,
    StatusCode::SERVICE_UNAVAILABLE,
];

/// Whether a 503 body is exactly the database-busy answer. Any other 503 body
/// -- `amux_outcome_unknown` with its incident id, a deadline, an extra field
/// -- is not.
fn is_database_busy_body(body: &[u8]) -> bool {
    serde_json::from_slice::<DatabaseBusyAnswer>(body)
        .is_ok_and(|answer| answer.reason == DATABASE_BUSY)
}

/// A write, or any call other than the three selection reads, answered with
/// the exact database-busy body at 503: the app decided that nothing was
/// written, because the transaction never started (or, for a read inside the
/// route, found the database busy) before the route had written anything
/// (`amuxDbBoundaryFailure`, lib/amux/dbBoundary.ts). Every such call still
/// returns it as an error, so a caller that does not look for it stops as it
/// always did; only a caller that asks `is_database_busy` treats it as a
/// request that did not happen and sends it again on a later tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DatabaseBusy;

impl std::fmt::Display for DatabaseBusy {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Tomverse AMUX answered 503 amux_database_busy; the request did not start")
    }
}

impl std::error::Error for DatabaseBusy {}

/// Whether this error is, anywhere in its chain, the exact database-busy
/// answer. A timeout, a lost response, any other status or body is not.
pub fn is_database_busy(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.downcast_ref::<DatabaseBusy>().is_some())
}

/// A selection read (`queue`, `routing_snapshot`) answered with a status that
/// carries no evidence anything was written: any 5xx other than the exact
/// database-busy body (already `DatabaseBusy`), or 429 (rejected before the
/// app started a transaction). Attached by `database_busy_or` and by
/// `parse_queue_body`/`parse_routing_snapshot_body` for the one status
/// (503 with a body other than the busy answer) that reaches them directly.
/// Never attached for a status outside that set: a 4xx other than 429 is an
/// auth/config problem a retry cannot fix, and a malformed 2xx body is a
/// contract break, so both keep the plain error they had before this type
/// existed. Nothing outside `scheduler.rs`'s selection-read handling looks
/// for this marker, so attaching it here changes no other caller's control
/// flow (claim, recovery, auto-promotion, lifecycle routes, and the WSL
/// bridge's owned-queue read all still see a plain `Err` and stop as before).
#[derive(Debug, Clone, Copy)]
pub struct SelectionReadTransientStatus {
    pub status: StatusCode,
}

impl SelectionReadTransientStatus {
    /// A short, secret-free label for the WARN log: which of the two known
    /// buckets this status fell into. Never the response body or the request
    /// URL.
    pub fn error_class(self) -> &'static str {
        if self.status == StatusCode::TOO_MANY_REQUESTS {
            "http_429"
        } else {
            "http_5xx"
        }
    }
}

impl std::fmt::Display for SelectionReadTransientStatus {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Tomverse AMUX selection read answered {}; nothing is known to have been written",
            self.status
        )
    }
}

impl std::error::Error for SelectionReadTransientStatus {}

/// Whether a status carries the "nothing was written" evidence
/// `SelectionReadTransientStatus` names: any 5xx, or 429.
fn is_selection_transient_status_code(status: StatusCode) -> bool {
    status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS
}

/// Whether this error is, anywhere in its chain, a transport failure (never
/// reached the app: connect, send, timeout, or a body read that failed after
/// the response started) or the `SelectionReadTransientStatus` marker. Used
/// only by the scheduler's two selection reads (`queue`, `routing_snapshot`);
/// every other caller of this module still treats any `Err` as unknown and
/// stops, so this classification changes nothing for them.
pub fn is_selection_read_recoverable(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause.downcast_ref::<SelectionReadTransientStatus>().is_some()
            || cause.downcast_ref::<reqwest::Error>().is_some()
    })
}

/// The short, secret-free error class for a recoverable selection-read
/// failure's WARN log. `is_selection_read_recoverable` must already be true;
/// callers that skip that check get `"transport"` as a safe default.
pub fn selection_read_error_class(error: &anyhow::Error) -> &'static str {
    error
        .chain()
        .find_map(|cause| cause.downcast_ref::<SelectionReadTransientStatus>())
        .map(|marker| marker.error_class())
        .unwrap_or("transport")
}

/// A 503 body is small; this is only enough to recognise the busy answer.
const MAX_BUSY_PROBE_BYTES: usize = 1024;

/// The error for a status the caller does not accept. A 503 whose body is
/// exactly the busy answer is `DatabaseBusy`; a 5xx or 429 with any other
/// body is `SelectionReadTransientStatus` (inert for every caller except the
/// scheduler's selection reads, see that type's doc comment); anything else
/// is `otherwise`, the error the caller returned before either answer
/// existed.
async fn database_busy_or(mut response: reqwest::Response, otherwise: &'static str) -> anyhow::Error {
    let status = response.status();
    if status != StatusCode::SERVICE_UNAVAILABLE || ensure_identity_encoding(&response).is_err() {
        return transient_status_or(status, otherwise);
    }
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if body.len() + chunk.len() > MAX_BUSY_PROBE_BYTES {
                    return transient_status_or(status, otherwise);
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(_) => return transient_status_or(status, otherwise),
        }
    }
    if is_database_busy_body(&body) {
        anyhow::Error::new(DatabaseBusy)
    } else {
        transient_status_or(status, otherwise)
    }
}

/// `otherwise`, tagged with `SelectionReadTransientStatus` when `status` is a
/// 5xx or 429, and with `UnacceptedStatus` otherwise. Both tags are inert
/// unless a caller looks for them (only the scheduler's selection reads do),
/// so `.to_string()` on the result is still exactly `otherwise`.
fn transient_status_or(status: StatusCode, otherwise: &'static str) -> anyhow::Error {
    if is_selection_transient_status_code(status) {
        anyhow::Error::new(SelectionReadTransientStatus { status }).context(otherwise)
    } else {
        anyhow::Error::new(UnacceptedStatus { status }).context(otherwise)
    }
}

/// A status a call does not accept, other than a 5xx or 429 (those carry
/// `SelectionReadTransientStatus`). Orchestration policy version 20, section
/// 1: for the two selection reads a 404 is a counted failure, and every other
/// such status is a contract violation. Nothing else looks for it.
#[derive(Debug, Clone, Copy)]
pub struct UnacceptedStatus {
    pub status: StatusCode,
}

impl std::fmt::Display for UnacceptedStatus {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "Tomverse AMUX answered {}", self.status)
    }
}

impl std::error::Error for UnacceptedStatus {}

/// A selection read answered with one of the two other "nothing committed"
/// 503 reasons (`amux_database_deadline_exceeded`,
/// `amux_database_call_ceiling_exceeded`). Orchestration policy version 20,
/// section 1: like the busy answer, it ends the tick without a claim and is
/// not counted. Still an error for every caller that does not look for it.
#[derive(Debug, Clone, Copy)]
pub struct NothingCommittedAnswer {
    pub reason: &'static str,
}

impl std::fmt::Display for NothingCommittedAnswer {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "Tomverse AMUX answered 503 {}", self.reason)
    }
}

impl std::error::Error for NothingCommittedAnswer {}

/// The busy 503 is `SelectionRead::DatabaseBusy`; these are the other two.
fn other_nothing_committed_reason(body: &[u8]) -> Option<&'static str> {
    let answer: DatabaseBusyAnswer = serde_json::from_slice(body).ok()?;
    [
        "amux_database_deadline_exceeded",
        "amux_database_call_ceiling_exceeded",
    ]
    .into_iter()
    .find(|reason| *reason == answer.reason)
}

/// The error for a selection read's 503 whose body is not the busy answer.
fn selection_503_error(body: &[u8]) -> anyhow::Error {
    match other_nothing_committed_reason(body) {
        Some(reason) => anyhow::Error::new(NothingCommittedAnswer { reason })
            .context("unsupported Tomverse internal response status"),
        None => transient_status_or(
            StatusCode::SERVICE_UNAVAILABLE,
            "unsupported Tomverse internal response status",
        ),
    }
}

/// `POST /api/internal/amux/queue` at 409: `{error, reason}`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct QueueCapacityRefusal {
    #[allow(dead_code)]
    error: String,
    reason: String,
}

/// `POST /api/internal/amux/routing-snapshot` at 409: `{eligible, reason}`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RoutingCapacityRefusal {
    eligible: bool,
    reason: String,
}

fn queue_invariants_hold(tasks: &[QueueTask]) -> bool {
    tasks.len() <= MAX_QUEUE_ITEMS
        && tasks.iter().all(|task| {
            is_canonical_machine_id(&task.id)
                && !task.kind.is_empty()
                && task.kind.len() <= 64
                && !task.priority.is_empty()
                && task.priority.len() <= 32
                && (0..=8).contains(&task.drag)
                && (0..=PRISMA_INT_MAX).contains(&task.revision)
                && task.dependent_count >= 0
                && (0..=6_010_428).contains(&task.scheduler_score)
                && matches!(
                    task.scoring_version.as_str(),
                    "" | "amux-global-priority-v1" | "amux-global-priority-v2"
                )
                && (task.scoring_version != "amux-global-priority-v2"
                    || task.scheduler_score == task.scheduler_signals.total())
                && chrono::DateTime::parse_from_rfc3339(&task.created_at).is_ok()
        })
}

/// Reads a queue answer. 200 is the queue, held to its invariants; 409 is the
/// board-capacity refusal and nothing else; 503 is the database-busy answer
/// and nothing else. Any other status still reaching here is a 503 with some
/// other body (the only status besides 200/409/503 `queue()` accepts at all;
/// see `SELECTION_READ_STATUSES`), so it is tagged `SelectionReadTransientStatus`
/// for the scheduler to skip on. Any other body at 503, or a malformed 200, is
/// still a plain error, as before.
pub(crate) fn parse_queue_body(
    status: StatusCode,
    body: &[u8],
) -> Result<SelectionRead<Vec<QueueTask>>> {
    if status == StatusCode::CONFLICT {
        let refusal: QueueCapacityRefusal =
            serde_json::from_slice(body).context("invalid Tomverse AMUX queue conflict")?;
        if refusal.reason == BOARD_CAPACITY_EXCEEDED {
            return Ok(SelectionRead::BoardCapacityExceeded);
        }
        bail!("unexpected Tomverse AMUX queue conflict");
    }
    if status == StatusCode::SERVICE_UNAVAILABLE && is_database_busy_body(body) {
        return Ok(SelectionRead::DatabaseBusy);
    }
    if status == StatusCode::SERVICE_UNAVAILABLE {
        return Err(selection_503_error(body));
    }
    if status != StatusCode::OK {
        return Err(transient_status_or(
            status,
            "unsupported Tomverse internal response status",
        ));
    }
    let tasks: Vec<QueueTask> =
        serde_json::from_slice(body).context("invalid Tomverse internal JSON response")?;
    if !queue_invariants_hold(&tasks) {
        bail!("invalid Tomverse AMUX queue response invariant");
    }
    Ok(SelectionRead::Ready(tasks))
}

/// Reads an owned-queue answer. 200 is the owned queue, held to its
/// invariants; 409 is the board-capacity refusal, with the same body as the
/// selection queue's, and nothing else; 503 is the database-busy answer and
/// nothing else. The owned queue's other 409
/// (`{available: false, reason: "execution_api_disabled"}`), any other status
/// and any other body stay errors, which halt the WSL bridge as before.
pub(crate) fn parse_owned_queue_body(
    status: StatusCode,
    body: &[u8],
) -> Result<SelectionRead<Vec<OwnedTodoTask>>> {
    if status == StatusCode::CONFLICT {
        let refusal: QueueCapacityRefusal =
            serde_json::from_slice(body).context("invalid Tomverse AMUX owned-queue conflict")?;
        if refusal.reason == BOARD_CAPACITY_EXCEEDED {
            return Ok(SelectionRead::BoardCapacityExceeded);
        }
        bail!("unexpected Tomverse AMUX owned-queue conflict");
    }
    if status == StatusCode::SERVICE_UNAVAILABLE && is_database_busy_body(body) {
        return Ok(SelectionRead::DatabaseBusy);
    }
    if status != StatusCode::OK {
        bail!("unsupported Tomverse internal response status");
    }
    let tasks: Vec<OwnedTodoTask> =
        serde_json::from_slice(body).context("invalid Tomverse internal JSON response")?;
    if tasks.len() > MAX_QUEUE_ITEMS
        || tasks.iter().any(|task| {
            !is_canonical_machine_id(&task.id)
                || !is_canonical_machine_id(&task.owner)
                || !(0..=PRISMA_INT_MAX).contains(&task.revision)
        })
    {
        bail!("invalid Tomverse AMUX owned-queue response invariant");
    }
    Ok(SelectionRead::Ready(tasks))
}

/// Reads a routing snapshot answer, the same way as the queue. Its 409 body is
/// `{eligible, reason}`; its 503 body is the queue's `{error, reason}`. A 503
/// with any other body -- the only other status `routing_snapshot()` accepts
/// at all, see `SELECTION_READ_STATUSES` -- is tagged
/// `SelectionReadTransientStatus` for the scheduler to skip on.
pub(crate) fn parse_routing_snapshot_body(
    status: StatusCode,
    body: &[u8],
) -> Result<SelectionRead<RoutingSnapshotResponse>> {
    if status == StatusCode::CONFLICT {
        let refusal: RoutingCapacityRefusal = serde_json::from_slice(body)
            .context("invalid Tomverse AMUX routing snapshot conflict")?;
        if !refusal.eligible && refusal.reason == BOARD_CAPACITY_EXCEEDED {
            return Ok(SelectionRead::BoardCapacityExceeded);
        }
        bail!("unexpected Tomverse AMUX routing snapshot conflict");
    }
    if status == StatusCode::SERVICE_UNAVAILABLE && is_database_busy_body(body) {
        return Ok(SelectionRead::DatabaseBusy);
    }
    if status == StatusCode::SERVICE_UNAVAILABLE {
        return Err(selection_503_error(body));
    }
    if status != StatusCode::OK {
        return Err(transient_status_or(
            status,
            "unsupported Tomverse internal response status",
        ));
    }
    let snapshot: RoutingSnapshotResponse =
        serde_json::from_slice(body).context("invalid Tomverse internal JSON response")?;
    if !routing_snapshot_is_valid(&snapshot) {
        bail!("invalid Tomverse AMUX routing snapshot invariant");
    }
    Ok(SelectionRead::Ready(snapshot))
}

/// The invariants the orchestrator relies on before scoring a snapshot.
pub(crate) fn routing_snapshot_is_valid(snapshot: &RoutingSnapshotResponse) -> bool {
    if snapshot.eligible {
        snapshot.reason.is_none()
            && snapshot.task.as_ref().is_some_and(|task| {
                !task.task_kind.is_empty()
                    && task.task_kind.len() <= 64
                    && (0..=10).contains(&task.complexity)
                    && (0..=10).contains(&task.risk)
                    && task.files_expected.is_none_or(|value| value <= 100_000)
            })
            && snapshot.candidates.len() <= MAX_ROUTING_CANDIDATES
            && snapshot.candidates.iter().all(|candidate| {
                is_canonical_machine_id(&candidate.worker.worker_name)
                    && !candidate.worker.provider.is_empty()
                    && candidate.worker.provider.len() <= 80
                    && candidate
                        .worker
                        .model
                        .as_ref()
                        .is_none_or(|value| value.len() <= 160)
                    && candidate.worker.routing_roles.len() <= 64
                    && candidate
                        .worker
                        .routing_roles
                        .iter()
                        .all(|value| !value.is_empty() && value.len() <= 64)
                    && candidate.worker.status.len() <= 32
                    && [
                        candidate.predicted_success,
                        candidate.quota_remaining,
                        candidate.expected_speed,
                        candidate.low_rework,
                        candidate.low_human_attention,
                        candidate.cost_efficiency,
                    ]
                    .iter()
                    .all(|value| {
                        value.is_none_or(|number| {
                            number.is_finite() && (0.0..=1.0).contains(&number)
                        })
                    })
            })
            && snapshot.telemetry.len() <= MAX_ROUTING_CANDIDATES
            && snapshot
                .telemetry
                .iter()
                .all(|(worker, evidence)| is_canonical_machine_id(worker) && evidence.is_object())
    } else {
        snapshot
            .reason
            .as_deref()
            .is_some_and(|value| !value.is_empty())
            && snapshot.task.is_none()
            && snapshot.candidates.is_empty()
            && !snapshot.execution_ready
            && snapshot.telemetry.is_empty()
    }
}

#[derive(Debug, Serialize)]
struct ClaimRequest<'a> {
    task_id: &'a str,
    worker: &'a str,
    expected_revision: i64,
    decision: ClaimDecision,
}

#[derive(Debug, Serialize)]
struct ClaimDecision {
    scheduler_score: i64,
    scoring_version: String,
    signals: Value,
}

/// Internal Tomverse routes are small and local to the service boundary.
/// A slow connect is therefore treated as unavailable rather than allowed to
/// pin the Railway process and suppress future scheduled runs.
pub const TOMVERSE_INTERNAL_CONNECT_TIMEOUT: Duration = Duration::from_secs(1);

/// Total deadline from connect start through the complete decoded body. This
/// also bounds a peer that sends a valid claim body one byte at a time.
pub const TOMVERSE_INTERNAL_REQUEST_TIMEOUT: Duration = Duration::from_secs(3);

/// Queue and routing snapshot routes each allow 2.8 seconds inside the app.
/// Five seconds leaves one second for connect and at least one second for
/// response transport; the shorter default remains for other requests.
pub const TOMVERSE_INTERNAL_SELECTION_READ_TIMEOUT: Duration = Duration::from_secs(5);

/// Claim can perform a clock-anchor, snapshot and bounded mutation. The
/// advanced admission transaction includes incident, resource, WIP and audit
/// fences, so keep the client above the app's bounded route budget. Unknown
/// outcomes still stop the scheduler; they are never retried blindly.
pub const TOMVERSE_INTERNAL_CLAIM_TIMEOUT: Duration = Duration::from_secs(18);

/// Future lifecycle routes use a twelve-second shared DB-clock route budget.
/// Fifteen seconds covers that budget plus bounded connection and response
/// transport. Unknown outcomes stop; never blindly retry.
pub const TOMVERSE_INTERNAL_LIFECYCLE_TIMEOUT: Duration = Duration::from_secs(15);

/// The auto-promotion tick runs several short transactions -- the expiry of
/// due grants, at most one consume, and the record of a lost consume -- inside
/// a 27-second route budget anchored on the database clock
/// (`AUTO_TICK_ROUTE_BUDGET_MS`, lib/amux/autoPromotionCore.ts). The server
/// starts no transaction that could not finish inside that budget, and each
/// one checks the deadline as its last statement before COMMIT and rolls back
/// if it has passed. That check is not the COMMIT: a stall between the two can
/// still let a COMMIT land after the deadline, and no test yet proves
/// otherwise (policy version 18). Thirty seconds adds the three seconds the
/// lifecycle routes keep for connect, commit and transport.
///
/// A timeout here is an unknown outcome for this client only. The server does
/// not learn of it and records nothing for it. The scheduler logs it and does
/// not retry; the next tick reads the grants again, and a consume that did
/// commit has its consumption row, so that grant is not consumed twice.
pub const TOMVERSE_INTERNAL_AUTO_PROMOTION_TIMEOUT: Duration = Duration::from_secs(30);

/// The server's route budget for the tick, pinned against
/// lib/amux/autoPromotionCore.ts by tests/amuxClaimContractParity.test.mjs.
#[cfg(test)]
const AUTO_PROMOTION_ROUTE_BUDGET: Duration = Duration::from_secs(27);

const MAX_CLAIM_RESPONSE_BYTES: usize = 8 * 1024;

fn is_canonical_machine_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=120).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes[bytes.len() - 1].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'.' | b'_' | b':' | b'-'))
}

fn is_canonical_decision_id(value: &str) -> bool {
    value.len() == 25
        && value.starts_with('c')
        && value
            .bytes()
            .skip(1)
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
}

fn ensure_identity_encoding(response: &reqwest::Response) -> Result<()> {
    if let Some(value) = response.headers().get(header::CONTENT_ENCODING) {
        let value = value
            .to_str()
            .context("invalid Tomverse internal content encoding")?;
        if !value.is_empty() && !value.eq_ignore_ascii_case("identity") {
            bail!("unsupported Tomverse internal content encoding");
        }
    }
    Ok(())
}

async fn read_bounded_body(
    mut response: reqwest::Response,
    allowed_statuses: &[StatusCode],
    max_bytes: usize,
) -> Result<(StatusCode, Vec<u8>)> {
    let status = response.status();
    if !allowed_statuses.contains(&status) {
        return Err(database_busy_or(response, "unsupported Tomverse internal response status").await);
    }
    ensure_identity_encoding(&response)?;

    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .context("failed to read Tomverse internal response")?
    {
        let next_len = body
            .len()
            .checked_add(chunk.len())
            .context("Tomverse internal response byte count overflow")?;
        if next_len > max_bytes {
            bail!("Tomverse internal response exceeds byte limit");
        }
        body.extend_from_slice(&chunk);
    }
    Ok((status, body))
}

async fn read_bounded_json<T: DeserializeOwned>(
    response: reqwest::Response,
    allowed_statuses: &[StatusCode],
    max_bytes: usize,
) -> Result<(StatusCode, T)> {
    let (status, body) = read_bounded_body(response, allowed_statuses, max_bytes).await?;
    let value = serde_json::from_slice(&body).context("invalid Tomverse internal JSON response")?;
    Ok((status, value))
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClaimRefusalReason {
    ExecutionApiDisabled,
    NotEligible,
    Unclassified,
    WorkerCatalogUnavailable,
    NoAuthoritativeWorker,
    AuthoritativeWorkerMismatch,
    IncidentAdmissionBlocked,
    WipLimitReached,
    ExecutionLifecycleUnavailable,
    InvalidRoutingEvidence,
}

impl ClaimRefusalReason {
    pub const CLOSED: &'static [Self] = &[
        Self::ExecutionApiDisabled,
        Self::NotEligible,
        Self::Unclassified,
        Self::WorkerCatalogUnavailable,
        Self::NoAuthoritativeWorker,
        Self::AuthoritativeWorkerMismatch,
        Self::IncidentAdmissionBlocked,
        Self::WipLimitReached,
        Self::ExecutionLifecycleUnavailable,
        Self::InvalidRoutingEvidence,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ExecutionApiDisabled => "execution_api_disabled",
            Self::NotEligible => "not_eligible",
            Self::Unclassified => "unclassified",
            Self::WorkerCatalogUnavailable => "worker_catalog_unavailable",
            Self::NoAuthoritativeWorker => "no_authoritative_worker",
            Self::AuthoritativeWorkerMismatch => "authoritative_worker_mismatch",
            Self::IncidentAdmissionBlocked => "incident_admission_blocked",
            Self::WipLimitReached => "wip_limit_reached",
            Self::ExecutionLifecycleUnavailable => "execution_lifecycle_unavailable",
            Self::InvalidRoutingEvidence => "invalid_routing_evidence",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawClaimResponse {
    claimed: bool,
    revision: Option<i64>,
    decision_id: Option<String>,
    reason: Option<ClaimRefusalReason>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ClaimResponse {
    Claimed { revision: i64, decision_id: String },
    CasLost,
    Refused { reason: ClaimRefusalReason },
}

// Kept for the claim response tests: since policy version 20 the claim
// answer is read raw and classified by orchestrator_halt::classify_claim,
// which still parses the body with parse_claim_response_body.
#[cfg_attr(not(test), allow(dead_code))]
fn claim_response_status_is_bounded(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::OK || status == reqwest::StatusCode::CONFLICT
}

// Kept for the claim response tests: since policy version 20 the claim
// answer is read raw and classified by orchestrator_halt::classify_claim,
// which still parses the body with parse_claim_response_body.
#[cfg_attr(not(test), allow(dead_code))]
fn append_claim_response_chunk(body: &mut Vec<u8>, chunk: &[u8]) -> Result<()> {
    let Some(next_len) = body.len().checked_add(chunk.len()) else {
        bail!("Tomverse AMUX claim response exceeds byte limit");
    };

    if next_len > MAX_CLAIM_RESPONSE_BYTES {
        bail!("Tomverse AMUX claim response exceeds byte limit");
    }

    body.extend_from_slice(chunk);
    Ok(())
}

pub(crate) fn parse_claim_response_body(
    status: reqwest::StatusCode,
    body: &[u8],
) -> Result<ClaimResponse> {
    if body.len() > MAX_CLAIM_RESPONSE_BYTES {
        bail!("Tomverse AMUX claim response exceeds byte limit");
    }

    let raw: RawClaimResponse =
        serde_json::from_slice(body).context("invalid Tomverse AMUX claim response")?;

    if status == reqwest::StatusCode::CONFLICT {
        return match raw {
            RawClaimResponse {
                claimed: false,
                revision: None,
                decision_id: None,
                reason: Some(reason),
            } => Ok(ClaimResponse::Refused { reason }),
            _ => bail!("invalid Tomverse AMUX conflict claim response invariant"),
        };
    }

    if status == reqwest::StatusCode::OK {
        return match raw {
            RawClaimResponse {
                claimed: true,
                revision: Some(revision),
                decision_id: Some(decision_id),
                reason: None,
            } if (0..=PRISMA_INT_MAX).contains(&revision)
                && is_canonical_decision_id(&decision_id) =>
            {
                Ok(ClaimResponse::Claimed {
                    revision,
                    decision_id,
                })
            }
            RawClaimResponse {
                claimed: false,
                revision: None,
                decision_id: None,
                reason: None,
            } => Ok(ClaimResponse::CasLost),
            _ => bail!("invalid Tomverse AMUX success claim response invariant"),
        };
    }

    bail!("unsupported Tomverse AMUX claim response status")
}

// Kept for the claim response tests: since policy version 20 the claim
// answer is read raw and classified by orchestrator_halt::classify_claim,
// which still parses the body with parse_claim_response_body.
#[cfg_attr(not(test), allow(dead_code))]
async fn read_claim_response(mut response: reqwest::Response) -> Result<ClaimResponse> {
    let status = response.status();
    ensure_identity_encoding(&response)?;
    let mut body = Vec::new();

    /*
     * Do not trust Content-Length: intermediaries may omit or transform it.
     * The decoded bytes returned by reqwest are counted as they are read.
     */
    while let Some(chunk) = response
        .chunk()
        .await
        .context("failed to read Tomverse AMUX claim response")?
    {
        append_claim_response_chunk(&mut body, &chunk)?;
    }

    parse_claim_response_body(status, &body)
}

impl TomverseApi {
    pub async fn v22_task_result_readback(
        &self, attempt_id: &str, expected_digest: &str,
        expected_patch: Option<(&str, &str)>,
        expected_files_digest: Option<&str>,
    ) -> Result<V22UsageRecord> {
        let response = self.client
            .get(format!("{}/api/internal/amux/v22/execution/result", self.base_url))
            .timeout(TOMVERSE_INTERNAL_LIFECYCLE_TIMEOUT)
            .bearer_auth(&self.secret)
            .query(&[("attemptId", attempt_id)])
            .send().await.context("v22 result read-back unavailable")?;
        let answer = read_raw_answer(response, 4096).await?;
        if answer.status != StatusCode::OK {
            bail!("v22 result read-back failed");
        }
        let body: Value = serde_json::from_slice(&answer.body)?;
        if body.get("status").and_then(Value::as_str) == Some("recorded") &&
            body.get("attemptId").and_then(Value::as_str) == Some(attempt_id) &&
            body.get("sourceSha256").and_then(Value::as_str) == Some(expected_digest) &&
            body.get("bodyAvailable").and_then(Value::as_bool) == Some(true) &&
            match expected_patch {
                Some((digest, base)) =>
                    body.pointer("/patch/sha256").and_then(Value::as_str) == Some(digest) &&
                    body.pointer("/patch/baseSha").and_then(Value::as_str) == Some(base) &&
                    body.pointer("/patch/bodyAvailable").and_then(Value::as_bool) == Some(true) &&
                    body.pointer("/patch/filesDigest").and_then(Value::as_str) ==
                        expected_files_digest,
                None => body.get("patch").is_some_and(Value::is_null),
            } {
            return Ok(V22UsageRecord::Recorded);
        }
        if expected_patch.is_some() &&
            body.get("status").and_then(Value::as_str) == Some("recorded") &&
            body.get("attemptId").and_then(Value::as_str) == Some(attempt_id) &&
            body.get("sourceSha256").and_then(Value::as_str) == Some(expected_digest) &&
            body.get("bodyAvailable").and_then(Value::as_bool) == Some(true) &&
            body.get("patch").is_some_and(Value::is_null) {
            return Ok(V22UsageRecord::PrivateOnly);
        }
        if body.get("status").and_then(Value::as_str) == Some("absent") {
            return Ok(V22UsageRecord::Rejected);
        }
        bail!("v22 result read-back conflict")
    }

    /// A result is sent at most once. A lost answer is resolved by exact
    /// attempt/digest read-back; the model is never called again for recovery.
    pub async fn v22_task_result_record_once(
        &self,
        attempt_id: &str,
        worker: &str,
        result_text: &str,
        expected_digest: &str,
        patch: Option<(&str, &str, &str)>,
        publish_files: Option<&Value>,
        publish_files_digest: Option<&str>,
    ) -> Result<V22UsageRecord> {
        if result_text.is_empty() || result_text.len() > 65_536 ||
            result_text.contains('\0') || expected_digest.len() != 64 ||
            !expected_digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            bail!("invalid v22 result envelope");
        }
        if let Some((body, digest, base)) = patch {
            if body.is_empty() || body.len() > 65_536 ||
                !body.starts_with("diff --git ") || body.contains('\0') ||
                digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) ||
                base.len() != 40 || !base.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                bail!("invalid v22 patch envelope");
            }
        }
        if publish_files.is_some() != publish_files_digest.is_some() ||
            publish_files.is_some() && patch.is_none() ||
            publish_files_digest.is_some_and(|sha| sha.len() != 64 ||
                !sha.bytes().all(|byte| byte.is_ascii_hexdigit())) {
            bail!("v22 publish files without patch");
        }
        let path = format!("{}/api/internal/amux/v22/execution/result", self.base_url);
        let mut payload = serde_json::json!({
            "attemptId": attempt_id, "worker": worker,
            "resultText": result_text, "sourceSha256": expected_digest,
        });
        if let Some((text, sha256, base_sha)) = patch {
            payload["patch"] = serde_json::json!({
                "text": text, "sha256": sha256, "baseSha": base_sha,
            });
            if let Some(files) = publish_files {
                payload["patch"]["files"] = files.clone();
                payload["patch"]["filesDigest"] =
                    serde_json::json!(publish_files_digest);
            }
        }
        let response = self.client.post(&path)
            .timeout(TOMVERSE_INTERNAL_LIFECYCLE_TIMEOUT)
            .bearer_auth(&self.secret)
            .json(&payload).send().await;
        let mut definitely_rejected = false;
        if let Ok(response) = response {
            let status = response.status();
            if status == StatusCode::OK {
                let answer = read_raw_answer(response, 4096).await?;
                let body: Value = serde_json::from_slice(&answer.body)?;
                let accepted_patch = body.get("patchSha256").and_then(Value::as_str) ==
                    patch.map(|(_, digest, _)| digest) &&
                    body.get("filesDigest").and_then(Value::as_str) ==
                        publish_files_digest;
                let private_only = patch.is_some() &&
                    body.get("patchRejected").and_then(Value::as_bool) == Some(true) &&
                    body.get("patchSha256").is_some_and(Value::is_null) &&
                    body.get("filesDigest").is_some_and(Value::is_null);
                if body.get("attemptId").and_then(Value::as_str) == Some(attempt_id) &&
                    body.get("sourceSha256").and_then(Value::as_str) == Some(expected_digest) &&
                    (accepted_patch || private_only) {
                    return Ok(if private_only { V22UsageRecord::PrivateOnly }
                        else { V22UsageRecord::Recorded });
                }
                bail!("v22 result write response mismatch");
            }
            definitely_rejected = status == StatusCode::CONFLICT ||
                status == StatusCode::BAD_REQUEST || status == StatusCode::UNAUTHORIZED;
        }
        match self.v22_task_result_readback(attempt_id, expected_digest,
            patch.map(|(_, digest, base)| (digest, base)),
            publish_files_digest).await? {
            V22UsageRecord::Recorded => Ok(V22UsageRecord::Recorded),
            V22UsageRecord::PrivateOnly => Ok(V22UsageRecord::PrivateOnly),
            V22UsageRecord::Rejected if definitely_rejected => Ok(V22UsageRecord::Rejected),
            V22UsageRecord::Rejected =>
                bail!("v22 result write outcome unknown; read-back absent"),
        }
    }

    /// Submit the exact content-free A14 receipt once. An ambiguous write is
    /// resolved only by a GET for the same invocation ID, never by re-POST.
    pub async fn v22_cli_usage_record_once(
        &self,
        attempt_id: &str,
        receipt: &Value,
        expected_digest: &str,
    ) -> Result<V22UsageRecord> {
        if receipt.get("invocationId").and_then(Value::as_str) != Some(attempt_id) ||
            receipt.pointer("/binding/kind").and_then(Value::as_str) != Some("task_attempt") ||
            receipt.pointer("/binding/attemptId").and_then(Value::as_str) != Some(attempt_id) ||
            expected_digest.len() != 64 ||
            !expected_digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            bail!("invalid v22 usage receipt binding");
        }
        let response = self.client
            .post(format!("{}/api/internal/amux/cli-usage", self.base_url))
            .timeout(TOMVERSE_INTERNAL_LIFECYCLE_TIMEOUT)
            .bearer_auth(&self.secret)
            .json(receipt)
            .send().await;
        let mut definitely_rejected = false;
        if let Ok(response) = response {
            let status = response.status();
            if status == StatusCode::OK {
                let answer = read_raw_answer(response, 4096).await?;
                let body: Value = serde_json::from_slice(&answer.body)?;
                if body.get("invocationId").and_then(Value::as_str) == Some(attempt_id) &&
                    body.get("receiptDigest").and_then(Value::as_str) == Some(expected_digest) {
                    return Ok(V22UsageRecord::Recorded);
                }
                bail!("v22 usage write response mismatch");
            }
            definitely_rejected = status == StatusCode::CONFLICT ||
                status == StatusCode::BAD_REQUEST || status == StatusCode::UNAUTHORIZED;
        }
        let response = self.client
            .get(format!("{}/api/internal/amux/cli-usage", self.base_url))
            .timeout(TOMVERSE_INTERNAL_LIFECYCLE_TIMEOUT)
            .bearer_auth(&self.secret)
            .query(&[("invocationId", attempt_id)])
            .send().await.context("v22 usage write outcome unknown; read-back unavailable")?;
        let answer = read_raw_answer(response, 4096).await?;
        if answer.status != StatusCode::OK {
            bail!("v22 usage write outcome unknown; read-back failed");
        }
        let body: Value = serde_json::from_slice(&answer.body)?;
        if body.get("status").and_then(Value::as_str) == Some("recorded") &&
            body.get("invocationId").and_then(Value::as_str) == Some(attempt_id) &&
            body.get("receiptDigest").and_then(Value::as_str) == Some(expected_digest) {
            return Ok(V22UsageRecord::Recorded);
        }
        if definitely_rejected && body.get("status").and_then(Value::as_str) == Some("absent") {
            return Ok(V22UsageRecord::Rejected);
        }
        bail!("v22 usage write outcome unknown or conflicting read-back")
    }

    fn with_timeouts(
        base_url: String,
        secret: String,
        connect_timeout: Duration,
        request_timeout: Duration,
    ) -> Result<Self> {
        let client = Client::builder()
            .connect_timeout(connect_timeout)
            .timeout(request_timeout)
            .default_headers({
                let mut headers = header::HeaderMap::new();
                headers.insert(
                    header::ACCEPT_ENCODING,
                    header::HeaderValue::from_static("identity"),
                );
                headers
            })
            .build()
            .context("failed to build bounded Tomverse internal HTTP client")?;

        Ok(Self {
            client,
            claim_timeout: request_timeout,
            selection_read_timeout: request_timeout,
            base_url: base_url.trim_end_matches('/').to_owned(),
            secret,
        })
    }

    #[cfg(test)]
    pub(crate) fn for_test_with_timeouts(
        base_url: String,
        connect_timeout: Duration,
        request_timeout: Duration,
    ) -> Self {
        Self::with_timeouts(
            base_url,
            "test-amux-sync-secret-at-least-32-bytes".to_owned(),
            connect_timeout,
            request_timeout,
        )
        .expect("test Tomverse API client must build")
    }

    pub fn from_env() -> Result<Self> {
        let base_url =
            std::env::var("TOMVERSE_INTERNAL_URL").context("TOMVERSE_INTERNAL_URL is required")?;

        let secret = std::env::var("TOMVERSE_AMUX_SYNC_SECRET")
            .context("TOMVERSE_AMUX_SYNC_SECRET is required")?;

        if secret.len() < 32 {
            anyhow::bail!("TOMVERSE_AMUX_SYNC_SECRET must contain at least 32 characters");
        }

        let mut api = Self::with_timeouts(
            base_url,
            secret,
            TOMVERSE_INTERNAL_CONNECT_TIMEOUT,
            TOMVERSE_INTERNAL_REQUEST_TIMEOUT,
        )?;
        api.claim_timeout = TOMVERSE_INTERNAL_CLAIM_TIMEOUT;
        api.selection_read_timeout = TOMVERSE_INTERNAL_SELECTION_READ_TIMEOUT;
        Ok(api)
    }

    pub async fn queue(&self) -> Result<SelectionRead<Vec<QueueTask>>> {
        let response = self
            .client
            .post(format!("{}/api/internal/amux/queue", self.base_url))
            .bearer_auth(&self.secret)
            .json(&QueueRequest {})
            .timeout(self.selection_read_timeout)
            .send()
            .await?;
        let (status, body) = read_bounded_body(
            response,
            SELECTION_READ_STATUSES,
            MAX_QUEUE_RESPONSE_BYTES,
        )
        .await?;
        parse_queue_body(status, &body)
    }

    pub async fn routing_snapshot(
        &self,
        task_id: &str,
        expected_revision: i64,
    ) -> Result<SelectionRead<RoutingSnapshotResponse>> {
        let response = self
            .client
            .post(format!(
                "{}/api/internal/amux/routing-snapshot",
                self.base_url
            ))
            .bearer_auth(&self.secret)
            .json(&RoutingSnapshotRequest {
                task_id,
                expected_revision,
            })
            .timeout(self.selection_read_timeout)
            .send()
            .await?;
        let (status, body) = read_bounded_body(
            response,
            SELECTION_READ_STATUSES,
            MAX_ROUTING_RESPONSE_BYTES,
        )
        .await?;
        parse_routing_snapshot_body(status, &body)
    }

    /// A write call (orchestration policy version 20, section 4): it carries
    /// its request identity, and its answer comes back raw -- whatever the
    /// status -- for `orchestrator_halt::classify_claim` to decide which of
    /// the known answers it is, if any. An `Err` is no answer at all.
    #[allow(clippy::too_many_arguments)]
    pub async fn claim(
        &self,
        ids: WriteIds,
        task_id: &str,
        worker: &str,
        expected_revision: i64,
        scheduler_score: i64,
        scoring_version: &str,
        signals: Value,
    ) -> Result<RawAnswer> {
        let response = self
            .client
            .post(format!("{}/api/internal/amux/claim", self.base_url))
            .timeout(self.claim_timeout)
            .bearer_auth(&self.secret)
            .header(REQUEST_ID_HEADER, ids.request_id.to_string())
            .header(INSTANCE_ID_HEADER, ids.instance_id.to_string())
            .json(&ClaimRequest {
                task_id,
                worker,
                expected_revision,
                decision: ClaimDecision {
                    scheduler_score,
                    scoring_version: scoring_version.to_owned(),
                    signals,
                },
            })
            .send()
            .await?;
        read_raw_answer(response, MAX_CLAIM_RESPONSE_BYTES).await
    }
}

// Frozen copy of the Rust client running in production before this tree, and
// the wire fixtures it shares with the app's route tests.
#[cfg(test)]
#[path = "main_wire_compat.rs"]
mod main_wire_compat;

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    fn answer_once(status: &'static str, body: String) -> (TomverseApi, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            loop {
                let mut chunk = [0_u8; 4096];
                let count = stream.read(&mut chunk).unwrap();
                assert!(count > 0);
                request.extend_from_slice(&chunk[..count]);
                if request.windows(4).any(|bytes| bytes == b"\r\n\r\n") { break; }
            }
            write!(stream, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()).unwrap();
        });
        (TomverseApi::for_test_with_timeouts(format!("http://{address}"),
            Duration::from_secs(1), Duration::from_secs(3)), server)
    }

    #[test]
    fn internal_deadlines_outlast_their_route_budgets() {
        // Claim runs inside the app's bounded admission budget and lifecycle
        // routes (recovery included) inside a twelve-second one; a shorter
        // client deadline would turn a normal slow answer into an unknown
        // outcome. Connect stays shorter than every total deadline.
        assert!(TOMVERSE_INTERNAL_CLAIM_TIMEOUT > Duration::from_secs(15));
        assert!(TOMVERSE_INTERNAL_LIFECYCLE_TIMEOUT > Duration::from_secs(12));
        // Auto-promotion: the tick's route budget, a connect, and at least a
        // second for commit and response transport.
        assert!(
            TOMVERSE_INTERNAL_AUTO_PROMOTION_TIMEOUT
                >= AUTO_PROMOTION_ROUTE_BUDGET
                    + TOMVERSE_INTERNAL_CONNECT_TIMEOUT
                    + Duration::from_secs(1)
        );
        assert!(TOMVERSE_INTERNAL_CONNECT_TIMEOUT < TOMVERSE_INTERNAL_REQUEST_TIMEOUT);
        assert!(TOMVERSE_INTERNAL_CONNECT_TIMEOUT < TOMVERSE_INTERNAL_LIFECYCLE_TIMEOUT);
    }

    #[test]
    fn from_env_builds_a_client_with_a_deadline() {
        let source = include_str!("tomverse_api.rs");
        let from_env = &source[source.find("pub fn from_env").unwrap()..];
        let body = &from_env[..from_env.find("pub async fn queue").unwrap()];
        assert!(body.contains("Self::with_timeouts("));
        assert!(body.contains("TOMVERSE_INTERNAL_REQUEST_TIMEOUT"));
        assert!(!body.contains("Client::new()"));
    }

    #[test]
    fn settle_and_heartbeat_bodies_without_optional_fields_parse() {
        let settled: ExecutionSettleResponse =
            serde_json::from_str(r#"{"settled":true,"taskRevision":3}"#).unwrap();
        assert!(settled.settled);
        assert_eq!(settled.task_revision, Some(3));
        let fenced: ExecutionSettleResponse =
            serde_json::from_str(r#"{"settled":false,"reason":"fenced_out"}"#).unwrap();
        assert!(!fenced.settled);
        assert_eq!(fenced.reason.as_deref(), Some("fenced_out"));
        let beat: ExecutionHeartbeatResponse = serde_json::from_str(r#"{"accepted":true}"#).unwrap();
        assert!(beat.accepted);
        let refused: ExecutionHeartbeatResponse =
            serde_json::from_str(r#"{"accepted":false,"reason":"fenced_out"}"#).unwrap();
        assert!(!refused.accepted);
    }

    #[test]
    fn v22_unverified_settlement_cannot_claim_success_or_retry() {
        let body = serde_json::to_value(V22ExecutionSettleRequest {
            attempt_id: "attempt",
            worker: "worker",
            instance_id: "instance",
            generation: 1,
            task_revision: 3,
            outcome: "blocked",
            invocation_ids: &[],
        }).unwrap();
        assert_eq!(body["outcome"], "blocked");
        assert_eq!(body["invocation_ids"], serde_json::json!([]));
        assert!(body.get("to_status").is_none());
        let response: ExecutionSettleResponse = serde_json::from_value(
            serde_json::json!({"settled":true,"taskRevision":4})
        ).unwrap();
        assert!(response.settled);
    }

    #[tokio::test]
    async fn v22_usage_record_reads_back_a_lost_write_reply_without_reposting() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            for (method, status, body) in [
                ("POST", "503 Service Unavailable", r#"{"error":"outcome_unknown"}"#),
                ("GET", "200 OK", concat!(
                    "{\"status\":\"recorded\",\"invocationId\":\"attempt-1\",",
                    "\"receiptDigest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}"
                )),
            ] {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = Vec::new();
                loop {
                    let mut chunk = [0_u8; 4096];
                    let count = stream.read(&mut chunk).unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&chunk[..count]);
                    if request.windows(4).any(|bytes| bytes == b"\r\n\r\n") { break; }
                }
                let request_line = String::from_utf8_lossy(&request);
                assert!(request_line.starts_with(method));
                if method == "GET" {
                    assert!(request_line.contains("invocationId=attempt-1"));
                }
                write!(stream, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()).unwrap();
            }
        });
        let api = TomverseApi::for_test_with_timeouts(format!("http://{address}"),
            Duration::from_secs(1), Duration::from_secs(3));
        let receipt = serde_json::json!({"invocationId":"attempt-1",
            "binding":{"kind":"task_attempt","attemptId":"attempt-1"}});
        let recorded = api.v22_cli_usage_record_once("attempt-1", &receipt,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
            .await.unwrap();
        assert_eq!(recorded, V22UsageRecord::Recorded);
        server.join().unwrap();
    }

    #[tokio::test]
    async fn v22_rejected_optional_patch_does_not_confirm_the_patch() {
        let patch = "diff --git a/a b/a\n";
        let (api, server) = answer_once("200 OK", serde_json::json!({
                "attemptId": "attempt-1", "sourceSha256": "a".repeat(64),
                "patchSha256": null, "filesDigest": null, "patchRejected": true,
            }).to_string());
        let recorded = api.v22_task_result_record_once("attempt-1", "worker",
            "private result", &"a".repeat(64),
            Some((patch, &"b".repeat(64), &"c".repeat(40))), None, None)
            .await.unwrap();
        assert_eq!(recorded, V22UsageRecord::PrivateOnly);
        server.join().unwrap();
    }

    #[tokio::test]
    async fn v22_lost_response_readback_marks_a_missing_patch_private_only() {
        let (api, server) = answer_once("200 OK", serde_json::json!({
                "status": "recorded", "attemptId": "attempt-1",
                "sourceSha256": "a".repeat(64), "bodyAvailable": true,
                "patch": null,
            }).to_string());
        let recorded = api.v22_task_result_readback("attempt-1",
            &"a".repeat(64), Some((&"b".repeat(64), &"c".repeat(40))), None)
            .await.unwrap();
        assert_eq!(recorded, V22UsageRecord::PrivateOnly);
        server.join().unwrap();
    }

    #[tokio::test]
    async fn v22_patch_readback_requires_exact_digest_base_and_files() {
        let (api, server) = answer_once("200 OK", serde_json::json!({
            "status": "recorded", "attemptId": "attempt-1",
            "sourceSha256": "a".repeat(64), "bodyAvailable": true,
            "patch": { "sha256": "b".repeat(64), "baseSha": "c".repeat(40),
                "bodyAvailable": true, "filesDigest": "d".repeat(64) },
        }).to_string());
        let recorded = api.v22_task_result_readback("attempt-1", &"a".repeat(64),
            Some((&"b".repeat(64), &"c".repeat(40))), Some(&"d".repeat(64)))
            .await.unwrap();
        assert_eq!(recorded, V22UsageRecord::Recorded);
        server.join().unwrap();

        let (api, server) = answer_once("200 OK", serde_json::json!({
            "status": "recorded", "attemptId": "attempt-1",
            "sourceSha256": "a".repeat(64), "bodyAvailable": true,
            "patch": { "sha256": "b".repeat(64), "baseSha": "c".repeat(40),
                "bodyAvailable": true, "filesDigest": "d".repeat(64) },
        }).to_string());
        assert!(api.v22_task_result_readback("attempt-1", &"a".repeat(64),
            Some((&"b".repeat(64), &"e".repeat(40))), Some(&"d".repeat(64)))
            .await.is_err());
        server.join().unwrap();
    }

    #[tokio::test]
    async fn v22_verified_settlement_sends_only_the_attempt_invocation() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let body_start = loop {
                let mut chunk = [0_u8; 1024];
                let count = stream.read(&mut chunk).unwrap();
                assert!(count > 0);
                request.extend_from_slice(&chunk[..count]);
                if let Some(index) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                    break index + 4;
                }
            };
            let headers = std::str::from_utf8(&request[..body_start]).unwrap();
            let content_length: usize = headers
                .lines()
                .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length: ").map(str::to_owned))
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            while request.len() - body_start < content_length {
                let mut chunk = [0_u8; 1024];
                let count = stream.read(&mut chunk).unwrap();
                assert!(count > 0);
                request.extend_from_slice(&chunk[..count]);
            }
            let body: Value = serde_json::from_slice(&request[body_start..body_start + content_length]).unwrap();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: 33\r\nConnection: close\r\n\r\n{{\"settled\":true,\"taskRevision\":4}}").unwrap();
            body
        });
        let delivery = PulledDelivery {
            attempt_id: "attempt-1".to_owned(),
            assignment_id: Some("assignment-1".to_owned()),
            v22_execution: None,
            task_id: "task-1".to_owned(),
            worker: "worker-1".to_owned(),
            task_revision: 3,
            prompt: String::new(),
            receipt_id: "receipt-1".to_owned(),
            lease_expires_at: String::new(),
        };
        let api = TomverseApi::for_test_with_timeouts(
            format!("http://{address}"),
            Duration::from_secs(1),
            Duration::from_secs(3),
        );
        assert!(api.v22_execution_settle_verified(&delivery, "instance-1", 1, "blocked").await.is_err());
        let result = api.v22_execution_settle_verified(&delivery, "instance-1", 1, "succeeded").await.unwrap();
        assert!(result.settled);
        let body = server.join().unwrap();
        assert_eq!(body["outcome"], "succeeded");
        assert_eq!(body["attempt_id"], "attempt-1");
        assert_eq!(body["invocation_ids"], serde_json::json!(["attempt-1"]));
    }

    #[test]
    fn the_review_pr_field_is_omitted_null_or_a_number() {
        let body = |review_pr_number| {
            serde_json::to_value(ExecutionSettleRequest {
                attempt_id: "a",
                worker: "w",
                instance_id: "i",
                generation: 1,
                task_revision: 2,
                outcome: "succeeded",
                to_status: "review",
                reason: None,
                cost_microusd: None,
                review_pr_number,
            })
            .unwrap()
        };
        assert!(body(None).get("review_pr_number").is_none());
        assert_eq!(body(Some(None))["review_pr_number"], serde_json::Value::Null);
        assert_eq!(body(Some(Some(1740)))["review_pr_number"], serde_json::json!(1740));
    }

    #[test]
    fn canonical_claim_fixture_is_rust_serialized_and_stable() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/amux-claim-request-rust-v1.json"
        ))
        .unwrap();
        let signals = fixture["decision"]["signals"].clone();
        let serialized = serde_json::to_value(ClaimRequest {
            task_id: "TASK-1",
            worker: "codex-a",
            expected_revision: 1,
            decision: ClaimDecision {
                scheduler_score: 32,
                scoring_version: "amux-global-priority-v1".to_owned(),
                signals,
            },
        })
        .unwrap();
        assert_eq!(serialized, fixture);
    }

    fn routing_snapshot_fixture(name: &str) -> Value {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/amux-routing-snapshot-v1.json"
        ))
        .unwrap();
        fixtures[name].clone()
    }

    #[test]
    fn the_server_routing_snapshot_with_telemetry_parses_and_validates() {
        // tests/amuxWireContract.test.ts parses the same file with the server's
        // response schema, so the two sides agree on one real body.
        for name in ["eligible", "refusal"] {
            let snapshot: RoutingSnapshotResponse =
                serde_json::from_value(routing_snapshot_fixture(name)).unwrap();
            assert!(routing_snapshot_is_valid(&snapshot), "{name}");
        }
        let eligible: RoutingSnapshotResponse =
            serde_json::from_value(routing_snapshot_fixture("eligible")).unwrap();
        assert_eq!(eligible.telemetry.len(), 2);
        assert_eq!(eligible.candidates.len(), 2);
    }

    fn queue_wire_fixture(name: &str) -> Value {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/amux-queue-wire-compat-v1.json"
        ))
        .unwrap();
        fixtures[name].clone()
    }

    #[test]
    fn a_board_capacity_conflict_is_its_own_selection_answer() {
        let queue_refusal =
            br#"{"error":"Queue capacity exceeded.","reason":"board_capacity_exceeded"}"#;
        assert!(matches!(
            parse_queue_body(StatusCode::CONFLICT, queue_refusal).unwrap(),
            SelectionRead::BoardCapacityExceeded
        ));
        let routing_refusal = br#"{"eligible":false,"reason":"board_capacity_exceeded"}"#;
        assert!(matches!(
            parse_routing_snapshot_body(StatusCode::CONFLICT, routing_refusal).unwrap(),
            SelectionRead::BoardCapacityExceeded
        ));

        // Any other conflict, extra field, or status is still an error.
        for (status, body) in [
            (StatusCode::CONFLICT, br#"{"error":"x","reason":"other"}"#.as_slice()),
            (
                StatusCode::CONFLICT,
                br#"{"error":"x","reason":"board_capacity_exceeded","extra":1}"#.as_slice(),
            ),
            (StatusCode::CONFLICT, b"{}".as_slice()),
            (StatusCode::SERVICE_UNAVAILABLE, queue_refusal.as_slice()),
            (StatusCode::INTERNAL_SERVER_ERROR, b"[]".as_slice()),
        ] {
            assert!(parse_queue_body(status, body).is_err(), "{status}");
        }
        for body in [
            br#"{"eligible":true,"reason":"board_capacity_exceeded"}"#.as_slice(),
            br#"{"eligible":false,"reason":"not_eligible"}"#.as_slice(),
        ] {
            assert!(parse_routing_snapshot_body(StatusCode::CONFLICT, body).is_err());
        }

        // 200 still goes through the invariants.
        let row = queue_wire_fixture("queue_server");
        let body = serde_json::to_vec(&vec![row.clone()]).unwrap();
        match parse_queue_body(StatusCode::OK, &body).unwrap() {
            SelectionRead::Ready(tasks) => assert_eq!(tasks.len(), 1),
            SelectionRead::BoardCapacityExceeded | SelectionRead::DatabaseBusy => {
                panic!("a 200 is a queue")
            }
        }
        let mut bad = row;
        bad["id"] = serde_json::json!("TASK-trailing-");
        let body = serde_json::to_vec(&vec![bad]).unwrap();
        assert!(parse_queue_body(StatusCode::OK, &body).is_err());
        let snapshot = serde_json::to_vec(&routing_snapshot_fixture("eligible")).unwrap();
        assert!(matches!(
            parse_routing_snapshot_body(StatusCode::OK, &snapshot).unwrap(),
            SelectionRead::Ready(_)
        ));
    }

    #[test]
    fn an_owned_queue_capacity_conflict_is_its_own_answer_and_nothing_else_is() {
        // The exact body app/api/internal/amux/owned-queue/route.ts sends.
        let refusal = br#"{"error":"Queue capacity exceeded.","reason":"board_capacity_exceeded"}"#;
        assert!(matches!(
            parse_owned_queue_body(StatusCode::CONFLICT, refusal).unwrap(),
            SelectionRead::BoardCapacityExceeded
        ));
        for (status, body) in [
            // The owned queue's other 409, from the execution API gate.
            (
                StatusCode::CONFLICT,
                br#"{"available":false,"reason":"execution_api_disabled"}"#.as_slice(),
            ),
            (StatusCode::CONFLICT, br#"{"error":"x","reason":"other"}"#.as_slice()),
            (
                StatusCode::CONFLICT,
                br#"{"error":"x","reason":"board_capacity_exceeded","extra":1}"#.as_slice(),
            ),
            (StatusCode::SERVICE_UNAVAILABLE, refusal.as_slice()),
            (StatusCode::INTERNAL_SERVER_ERROR, b"[]".as_slice()),
        ] {
            assert!(parse_owned_queue_body(status, body).is_err(), "{status}");
        }
        let body = serde_json::to_vec(&vec![queue_wire_fixture("owned_server")]).unwrap();
        match parse_owned_queue_body(StatusCode::OK, &body).unwrap() {
            SelectionRead::Ready(tasks) => assert_eq!(tasks.len(), 1),
            SelectionRead::BoardCapacityExceeded | SelectionRead::DatabaseBusy => {
                panic!("a 200 is an owned queue")
            }
        }
        let mut bad = queue_wire_fixture("owned_server");
        bad["owner"] = serde_json::json!("worker-");
        let body = serde_json::to_vec(&vec![bad]).unwrap();
        assert!(parse_owned_queue_body(StatusCode::OK, &body).is_err());
    }

    // The exact body lib/amux/internalRoute.ts sends for a busy read, the same
    // for all three routes. tests/server-contract/amux-commit-deadline-boundary.test.ts
    // holds the server to this literal.
    const DATABASE_BUSY_BODY: &[u8] =
        br#"{"error":"AMUX database is busy.","reason":"amux_database_busy"}"#;

    #[test]
    fn a_database_busy_answer_is_its_own_selection_answer_on_all_three_reads() {
        assert!(matches!(
            parse_queue_body(StatusCode::SERVICE_UNAVAILABLE, DATABASE_BUSY_BODY).unwrap(),
            SelectionRead::DatabaseBusy
        ));
        assert!(matches!(
            parse_routing_snapshot_body(StatusCode::SERVICE_UNAVAILABLE, DATABASE_BUSY_BODY)
                .unwrap(),
            SelectionRead::DatabaseBusy
        ));
        assert!(matches!(
            parse_owned_queue_body(StatusCode::SERVICE_UNAVAILABLE, DATABASE_BUSY_BODY).unwrap(),
            SelectionRead::DatabaseBusy
        ));
    }

    #[test]
    fn any_other_503_or_the_busy_body_at_another_status_is_still_an_error() {
        let cases: [(StatusCode, &[u8]); 9] = [
            // The server's unknown outcome, as it sends it and as a bare reason.
            (
                StatusCode::SERVICE_UNAVAILABLE,
                br#"{"error":"AMUX database outcome is unknown.","reason":"amux_outcome_unknown","incident_id":"0b8e9a52-6d8c-4f0e-9b1a-2c3d4e5f6a7b"}"#,
            ),
            (StatusCode::SERVICE_UNAVAILABLE, br#"{"reason":"amux_outcome_unknown"}"#),
            (
                StatusCode::SERVICE_UNAVAILABLE,
                br#"{"error":"AMUX database deadline exceeded.","reason":"amux_database_deadline_exceeded"}"#,
            ),
            // The busy reason with anything more or less is not the busy answer.
            (
                StatusCode::SERVICE_UNAVAILABLE,
                br#"{"error":"AMUX database is busy.","reason":"amux_database_busy","incident_id":"x"}"#,
            ),
            (StatusCode::SERVICE_UNAVAILABLE, br#"{"reason":"amux_database_busy"}"#),
            (StatusCode::SERVICE_UNAVAILABLE, b"not json"),
            // The busy body at any other status.
            (StatusCode::CONFLICT, DATABASE_BUSY_BODY),
            (StatusCode::INTERNAL_SERVER_ERROR, DATABASE_BUSY_BODY),
            (StatusCode::BAD_GATEWAY, DATABASE_BUSY_BODY),
        ];
        for (status, body) in cases {
            let text = String::from_utf8_lossy(body);
            assert!(parse_queue_body(status, body).is_err(), "queue {status} {text}");
            assert!(
                parse_routing_snapshot_body(status, body).is_err(),
                "routing {status} {text}"
            );
            assert!(
                parse_owned_queue_body(status, body).is_err(),
                "owned {status} {text}"
            );
        }
        // Another 503 keeps the error it had before this answer existed.
        let error = parse_queue_body(
            StatusCode::SERVICE_UNAVAILABLE,
            br#"{"reason":"amux_outcome_unknown"}"#,
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "unsupported Tomverse internal response status");
    }

    #[test]
    fn only_the_three_selection_reads_accept_a_503() {
        let source = include_str!("tomverse_api.rs");
        // Built with concat! so this test's own text is neither counted nor
        // found in place of the function it names.
        let needle = concat!("SELECTION_READ", "_STATUSES,");
        assert_eq!(source.matches(needle).count(), 3);
        for name in [
            concat!("pub async fn ", "queue("),
            concat!("pub async fn ", "routing_snapshot("),
            concat!("pub async fn ", "owned_queue("),
        ] {
            assert_eq!(source.matches(name).count(), 1, "{name}");
            let start = source.find(name).unwrap();
            let end = source[start + 1..]
                .find("\n    pub async fn ")
                .map_or(source.len(), |offset| start + 1 + offset);
            assert!(source[start..end].contains(needle), "{name}");
        }
    }

    #[test]
    fn queue_rows_parse_in_the_server_shape_and_the_minimal_shape() {
        // tests/amuxWireContract.test.ts holds the app's response schema to
        // the same file: the app sends *_server during the compatibility
        // window, this binary must also accept *_minimal after it, and
        // *_main is what main's server sends until this app deploys.
        for name in ["queue_main", "queue_server", "queue_minimal"] {
            let task: QueueTask = serde_json::from_value(queue_wire_fixture(name)).unwrap();
            assert_eq!(task.id, "TASK-1", "{name}");
            assert_eq!(task.scheduler_score, 32, "{name}");
            let mut body = queue_wire_fixture(name);
            body["future_field"] = serde_json::json!(true);
            assert!(serde_json::from_value::<QueueTask>(body).is_err(), "{name}");
        }
        let server: QueueTask = serde_json::from_value(queue_wire_fixture("queue_server")).unwrap();
        assert_eq!(server.legacy_title.as_deref(), Some("Fix the window"));
        assert_eq!(server.legacy_owner, None);
        let minimal: QueueTask = serde_json::from_value(queue_wire_fixture("queue_minimal")).unwrap();
        assert_eq!(minimal.legacy_title, None);
        assert_eq!(minimal.legacy_dependencies, None);
    }

    #[test]
    fn owned_queue_rows_parse_in_the_server_shape_and_the_minimal_shape() {
        for name in ["owned_main", "owned_server", "owned_minimal"] {
            let task: OwnedTodoTask = serde_json::from_value(queue_wire_fixture(name)).unwrap();
            assert_eq!(task.id, "TASK-1", "{name}");
            assert_eq!(task.owner, "claude-impl", "{name}");
            assert_eq!(task.revision, 2, "{name}");
            let mut body = queue_wire_fixture(name);
            body["future_field"] = serde_json::json!(true);
            assert!(serde_json::from_value::<OwnedTodoTask>(body).is_err(), "{name}");
        }
        let main: OwnedTodoTask = serde_json::from_value(queue_wire_fixture("owned_main")).unwrap();
        assert!(main.legacy_description.is_some());
        let server: OwnedTodoTask = serde_json::from_value(queue_wire_fixture("owned_server")).unwrap();
        assert_eq!(server.legacy_description, None);
        assert_eq!(server.legacy_claimed_at, None);
        assert_eq!(server.legacy_kind.as_deref(), Some("code"));
    }

    #[test]
    fn routing_snapshot_still_refuses_an_unknown_top_level_field() {
        for name in ["eligible", "refusal"] {
            let mut body = routing_snapshot_fixture(name);
            body["future_field"] = serde_json::json!(true);
            assert!(serde_json::from_value::<RoutingSnapshotResponse>(body).is_err(), "{name}");
        }
        // Telemetry is part of the contract, not an optional extra.
        let mut missing = routing_snapshot_fixture("eligible");
        missing.as_object_mut().unwrap().remove("telemetry");
        assert!(serde_json::from_value::<RoutingSnapshotResponse>(missing).is_err());
    }

    #[test]
    fn routing_snapshot_telemetry_keeps_its_outer_shape() {
        let mut refusal = routing_snapshot_fixture("refusal");
        refusal["telemetry"] = serde_json::json!({
            "codex-a": { "history": { "sample_size": 0 } }
        });
        let refusal: RoutingSnapshotResponse = serde_json::from_value(refusal).unwrap();
        assert!(!routing_snapshot_is_valid(&refusal));

        let mut not_object = routing_snapshot_fixture("eligible");
        not_object["telemetry"]["codex-a"] = serde_json::json!("evidence");
        let not_object: RoutingSnapshotResponse = serde_json::from_value(not_object).unwrap();
        assert!(!routing_snapshot_is_valid(&not_object));

        let mut bad_key = routing_snapshot_fixture("eligible");
        bad_key["telemetry"]["-bad name"] = serde_json::json!({});
        let bad_key: RoutingSnapshotResponse = serde_json::from_value(bad_key).unwrap();
        assert!(!routing_snapshot_is_valid(&bad_key));

        let mut array = routing_snapshot_fixture("eligible");
        array["telemetry"] = serde_json::json!([]);
        assert!(serde_json::from_value::<RoutingSnapshotResponse>(array).is_err());
    }

    #[test]
    fn claim_client_accepts_only_success_and_structured_conflict_statuses() {
        assert!(claim_response_status_is_bounded(reqwest::StatusCode::OK));
        assert!(claim_response_status_is_bounded(
            reqwest::StatusCode::CONFLICT,
        ));
        assert!(!claim_response_status_is_bounded(
            reqwest::StatusCode::BAD_REQUEST,
        ));
        assert!(!claim_response_status_is_bounded(
            reqwest::StatusCode::CREATED,
        ));
        assert!(!claim_response_status_is_bounded(
            reqwest::StatusCode::NO_CONTENT,
        ));
        assert!(!claim_response_status_is_bounded(
            reqwest::StatusCode::PARTIAL_CONTENT,
        ));
        assert!(!claim_response_status_is_bounded(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
        ));
    }

    #[test]
    fn claim_response_preserves_the_bounded_refusal_reason() {
        let response = parse_claim_response_body(
            reqwest::StatusCode::CONFLICT,
            br#"{"claimed":false,"reason":"execution_api_disabled"}"#,
        )
        .unwrap();

        assert_eq!(
            response,
            ClaimResponse::Refused {
                reason: ClaimRefusalReason::ExecutionApiDisabled,
            },
        );
    }

    #[test]
    fn claim_response_rejects_unknown_or_malformed_refusal_reasons() {
        assert!(
            parse_claim_response_body(
                reqwest::StatusCode::CONFLICT,
                br#"{"claimed":false,"reason":"future_unreviewed_reason"}"#,
            )
            .is_err()
        );

        assert!(
            parse_claim_response_body(
                reqwest::StatusCode::CONFLICT,
                br#"{"claimed":false,"reason":{"value":"execution_api_disabled"}}"#,
            )
            .is_err()
        );
    }

    #[test]
    fn claim_response_separates_claimed_cas_loss_and_conflict_states() {
        assert_eq!(
            parse_claim_response_body(
                reqwest::StatusCode::OK,
                br#"{"claimed":true,"revision":4,"decision_id":"c123456789012345678901234"}"#,
            )
            .unwrap(),
            ClaimResponse::Claimed {
                revision: 4,
                decision_id: "c123456789012345678901234".into(),
            },
        );

        assert_eq!(
            parse_claim_response_body(reqwest::StatusCode::OK, br#"{"claimed":false}"#,).unwrap(),
            ClaimResponse::CasLost,
        );

        assert_eq!(
            parse_claim_response_body(
                reqwest::StatusCode::CONFLICT,
                br#"{"claimed":false,"reason":"not_eligible"}"#,
            )
            .unwrap(),
            ClaimResponse::Refused {
                reason: ClaimRefusalReason::NotEligible,
            },
        );
    }

    #[test]
    fn claim_response_rejects_status_and_body_contradictions() {
        let invalid = [
            (
                reqwest::StatusCode::OK,
                br#"{"claimed":true,"revision":4,"decision_id":"decision-1","reason":"execution_api_disabled"}"#.as_slice(),
            ),
            (
                reqwest::StatusCode::CONFLICT,
                br#"{"claimed":true,"revision":4,"decision_id":"decision-1","reason":"execution_api_disabled"}"#.as_slice(),
            ),
            (
                reqwest::StatusCode::CONFLICT,
                br#"{"claimed":false}"#.as_slice(),
            ),
            (
                reqwest::StatusCode::OK,
                br#"{"claimed":false,"reason":"execution_api_disabled"}"#.as_slice(),
            ),
            (
                reqwest::StatusCode::OK,
                br#"{"claimed":true,"revision":4}"#.as_slice(),
            ),
            (
                reqwest::StatusCode::OK,
                br#"{"claimed":true,"decision_id":"decision-1"}"#.as_slice(),
            ),
            (
                reqwest::StatusCode::OK,
                br#"{"claimed":false,"revision":4}"#.as_slice(),
            ),
            (
                reqwest::StatusCode::OK,
                br#"{"claimed":false,"decision_id":"decision-1"}"#.as_slice(),
            ),
            (
                reqwest::StatusCode::CONFLICT,
                br#"{"claimed":false,"revision":4,"reason":"not_eligible"}"#.as_slice(),
            ),
            (
                reqwest::StatusCode::CONFLICT,
                br#"{"claimed":false,"decision_id":"decision-1","reason":"not_eligible"}"#.as_slice(),
            ),
        ];

        for (status, body) in invalid {
            assert!(
                parse_claim_response_body(status, body).is_err(),
                "status={status} body={}",
                String::from_utf8_lossy(body),
            );
        }
    }

    #[test]
    fn claim_response_rejects_every_non_200_success_status() {
        for status in [
            reqwest::StatusCode::CREATED,
            reqwest::StatusCode::NO_CONTENT,
            reqwest::StatusCode::PARTIAL_CONTENT,
        ] {
            assert!(
                parse_claim_response_body(
                    status,
                    br#"{"claimed":true,"revision":4,"decision_id":"decision-1"}"#,
                )
                .is_err(),
                "status={status}",
            );
        }
    }

    #[test]
    fn claim_response_byte_limit_counts_chunks_without_content_length() {
        let mut body = Vec::new();
        append_claim_response_chunk(&mut body, &vec![b' '; MAX_CLAIM_RESPONSE_BYTES - 1]).unwrap();
        append_claim_response_chunk(&mut body, b" ").unwrap();

        assert_eq!(body.len(), MAX_CLAIM_RESPONSE_BYTES);
        assert!(append_claim_response_chunk(&mut body, b"x").is_err());
        assert_eq!(body.len(), MAX_CLAIM_RESPONSE_BYTES);
    }

    #[test]
    fn claim_response_parser_rejects_an_oversized_body_even_without_stream_metadata() {
        let body = vec![b' '; MAX_CLAIM_RESPONSE_BYTES + 1];

        assert!(parse_claim_response_body(reqwest::StatusCode::CONFLICT, &body).is_err());
    }

    #[tokio::test]
    async fn claim_response_reader_rejects_an_oversized_chunked_body_without_content_length() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let body = vec![b'x'; MAX_CLAIM_RESPONSE_BYTES + 1];

        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1_024];
            let _ = stream.read(&mut request).unwrap();

            write!(
                stream,
                "HTTP/1.1 409 Conflict\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:X}\r\n",
                body.len(),
            )
            .unwrap();
            stream.write_all(&body).unwrap();
            stream.write_all(b"\r\n0\r\n\r\n").unwrap();
            stream.flush().unwrap();
        });

        let response = Client::new()
            .get(format!("http://{address}"))
            .send()
            .await
            .unwrap();
        let error = read_claim_response(response).await.unwrap_err();

        server.join().unwrap();
        assert!(error.to_string().contains("exceeds byte limit"));
    }

    async fn local_response(status: &str, headers: &str, body: &[u8]) -> reqwest::Response {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let body = body.to_vec();
        let status = status.to_owned();
        let headers = headers.to_owned();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1_024];
            let _ = stream.read(&mut request).unwrap();
            write!(
                stream,
                "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n",
                body.len(),
            )
            .unwrap();
            stream.write_all(&body).unwrap();
        });
        let response = Client::new()
            .get(format!("http://{address}"))
            .send()
            .await
            .unwrap();
        server.join().unwrap();
        response
    }

    #[tokio::test]
    async fn bounded_reader_rejects_nonidentity_encoding_and_exact_status_mismatch() {
        let response = local_response(
            "200 OK",
            "Content-Encoding: gzip\r\n",
            br#"{"registered":true}"#,
        )
        .await;
        assert!(
            read_bounded_json::<WorkerRegisterResponse>(response, &[StatusCode::OK], 1024,)
                .await
                .is_err()
        );

        let response = local_response("201 Created", "", b"{}").await;
        assert!(
            read_bounded_json::<WorkerRegisterResponse>(response, &[StatusCode::OK], 1024,)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn bounded_reader_rejects_nested_unknown_and_actual_bytes_over_cap() {
        let response = local_response(
            "200 OK",
            "",
            br#"{"available":true,"delivery":{"attempt_id":"x","task_id":"TASK-1","worker":"worker-a","task_revision":1,"prompt":"safe","receipt_id":"x","lease_expires_at":"2026-09-21T00:00:00Z","unexpected":"private"}}"#,
        )
        .await;
        assert!(
            read_bounded_json::<DeliveryPullResponse>(response, &[StatusCode::OK], 1024,)
                .await
                .is_err()
        );

        let response = local_response("200 OK", "", &[b'x'; 1025]).await;
        let error = read_bounded_json::<Value>(response, &[StatusCode::OK], 1024)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("exceeds byte limit"));
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OwnedTodoTask {
    pub id: String,
    pub owner: String,
    pub revision: i64,
    #[serde(default)]
    pub assignment_id: Option<String>,
    // Compatibility window (docs/ops/amux/wsl-execution-bridge.md, "Wire
    // compatibility"). main's server sent these six. This app keeps sending
    // title, kind, priority and created_at, which a WSL bridge built before
    // this change requires, and no longer sends description and claimed_at,
    // which that bridge reads as Options. Accepted from either server and
    // never read: card text is not bridge input (the delivery prompt is). A
    // server that drops them parses the same. Any other field is still
    // refused.
    #[serde(default, rename = "title")]
    pub legacy_title: Option<String>,
    #[serde(default, rename = "description")]
    pub legacy_description: Option<String>,
    #[serde(default, rename = "kind")]
    pub legacy_kind: Option<String>,
    #[serde(default, rename = "priority")]
    pub legacy_priority: Option<String>,
    #[serde(default, rename = "claimed_at")]
    pub legacy_claimed_at: Option<String>,
    #[serde(default, rename = "created_at")]
    pub legacy_created_at: Option<String>,
}

#[derive(Debug, Serialize)]
struct WorkerRegisterRequest<'a> {
    worker_name: &'a str,
    instance_id: &'a str,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerRegisterResponse {
    pub registered: bool,
    pub generation: Option<i64>,
    pub lease_expires_at: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Serialize)]
struct WorkerHeartbeatRequest<'a> {
    worker_name: &'a str,
    instance_id: &'a str,
    generation: i64,
    status: &'a str,
    dispatch_ready: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerHeartbeatResponse {
    pub accepted: bool,
    pub lease_expires_at: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Serialize)]
struct DeliveryPullRequest<'a> {
    worker: &'a str,
    instance_id: &'a str,
    generation: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V22ExecutionProfile {
    pub model_id: String,
    pub role: String,
    pub budget_microusd: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PulledDelivery {
    pub attempt_id: String,
    #[serde(default)]
    pub assignment_id: Option<String>,
    #[serde(default)]
    pub v22_execution: Option<V22ExecutionProfile>,
    pub task_id: String,
    pub worker: String,
    pub task_revision: i64,
    pub prompt: String,
    pub receipt_id: String,
    pub lease_expires_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeliveryPullResponse {
    pub available: bool,
    pub delivery: Option<PulledDelivery>,
    pub reason: Option<String>,
}

#[derive(Debug, Serialize)]
struct DeliveryAckRequest<'a> {
    attempt_id: &'a str,
    receipt_id: &'a str,
    worker: &'a str,
    instance_id: &'a str,
    generation: i64,
    task_revision: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeliveryAckResponse {
    pub acknowledged: bool,
    pub idempotent: Option<bool>,
    pub reason: Option<String>,
}

#[derive(Debug, Serialize)]
struct ExecutionHeartbeatRequest<'a> {
    attempt_id: &'a str,
    worker: &'a str,
    instance_id: &'a str,
    generation: i64,
    task_revision: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionHeartbeatResponse {
    pub accepted: bool,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Serialize)]
struct ExecutionStartRequest<'a> {
    task_id: &'a str,
    worker: &'a str,
    instance_id: &'a str,
    generation: i64,
    expected_revision: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    assignment_id: Option<&'a str>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionStartResponse {
    pub started: bool,
    pub attempt_id: Option<String>,
    pub task_revision: Option<i64>,
    pub lease_expires_at: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V22ExecutionReadback {
    pub found: bool,
    pub state: Option<String>,
    #[serde(rename = "attemptId")]
    pub attempt_id: Option<String>,
    #[serde(rename = "taskRevision")]
    pub task_revision: Option<i64>,
    #[serde(rename = "leaseExpiresAt")]
    pub lease_expires_at: Option<String>,
    pub outcome: Option<String>,
    #[serde(rename = "toStatus")]
    pub to_status: Option<String>,
}

#[derive(Debug, Serialize)]
struct ExecutionSettleRequest<'a> {
    attempt_id: &'a str,
    worker: &'a str,
    instance_id: &'a str,
    generation: i64,
    task_revision: i64,
    outcome: &'a str,
    to_status: &'a str,
    reason: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cost_microusd: Option<u64>,
    /// Policy version 15: only with succeeded -> review; the server verifies
    /// the PR by reading GitHub itself.
    /// Outer None omits the field (the stored PR is kept); Some(None) sends
    /// null (a review that names no PR clears an earlier attempt's PR).
    #[serde(skip_serializing_if = "Option::is_none")]
    review_pr_number: Option<Option<i64>>,
}

#[derive(Debug, Serialize)]
struct V22ExecutionSettleRequest<'a> {
    attempt_id: &'a str,
    worker: &'a str,
    instance_id: &'a str,
    generation: i64,
    task_revision: i64,
    outcome: &'a str,
    invocation_ids: &'a [&'a str],
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionSettleResponse {
    pub settled: bool,
    #[serde(rename = "taskRevision", default)]
    pub task_revision: Option<i64>,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AutoPromotionTickResponse {
    pub promoted: bool,
    pub claimed: Option<bool>,
    pub reason: Option<String>,
    pub consumption_id: Option<String>,
    pub expired: Option<i64>,
    pub policy_version: Option<i64>,
    pub receipt_id: Option<String>,
    pub task_id: Option<String>,
    pub assignment_id: Option<String>,
    pub worker_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionRecoveryResponse {
    pub recovered: bool,
    pub reclaimed: Option<i64>,
    pub reclaimed_claims: Option<i64>,
    pub quota_observations_deleted: Option<i64>,
    pub quarantined_v22: Option<i64>,
    pub released_unstarted_v22: Option<i64>,
    pub more: Option<bool>,
    pub reason: Option<String>,
}

impl TomverseApi {
    pub async fn worker_register(
        &self,
        worker_name: &str,
        instance_id: &str,
    ) -> Result<WorkerRegisterResponse> {
        let response = self
            .client
            .post(format!(
                "{}/api/internal/amux/workers/register",
                self.base_url
            ))
            .timeout(TOMVERSE_INTERNAL_LIFECYCLE_TIMEOUT)
            .bearer_auth(&self.secret)
            .json(&WorkerRegisterRequest {
                worker_name,
                instance_id,
            })
            .send()
            .await?;

        let (status, body): (_, WorkerRegisterResponse) = read_bounded_json(
            response,
            &[StatusCode::OK, StatusCode::CONFLICT],
            MAX_LIFECYCLE_RESPONSE_BYTES,
        )
        .await?;
        let valid = match status {
            StatusCode::OK => {
                body.registered
                    && body
                        .generation
                        .is_some_and(|value| (1..=PRISMA_INT_MAX).contains(&value))
                    && body.lease_expires_at.is_some()
                    && body.reason.is_none()
            }
            StatusCode::CONFLICT => {
                !body.registered
                    && body.generation.is_none()
                    && body.lease_expires_at.is_none()
                    && body
                        .reason
                        .as_deref()
                        .is_some_and(|value| !value.is_empty())
            }
            _ => false,
        };
        if !valid {
            bail!("invalid Tomverse AMUX worker-register response invariant");
        }
        Ok(body)
    }

    pub async fn worker_heartbeat(
        &self,
        worker_name: &str,
        instance_id: &str,
        generation: i64,
        status_name: &str,
        dispatch_ready: bool,
    ) -> Result<WorkerHeartbeatResponse> {
        let response = self
            .client
            .post(format!(
                "{}/api/internal/amux/workers/heartbeat",
                self.base_url
            ))
            .timeout(TOMVERSE_INTERNAL_LIFECYCLE_TIMEOUT)
            .bearer_auth(&self.secret)
            .json(&WorkerHeartbeatRequest {
                worker_name,
                instance_id,
                generation,
                status: status_name,
                dispatch_ready,
            })
            .send()
            .await?;

        let (status, body): (_, WorkerHeartbeatResponse) = read_bounded_json(
            response,
            &[StatusCode::OK, StatusCode::CONFLICT],
            MAX_LIFECYCLE_RESPONSE_BYTES,
        )
        .await?;
        let valid = match status {
            StatusCode::OK => {
                body.accepted && body.lease_expires_at.is_some() && body.reason.is_none()
            }
            StatusCode::CONFLICT => {
                !body.accepted
                    && body.lease_expires_at.is_none()
                    && body
                        .reason
                        .as_deref()
                        .is_some_and(|value| !value.is_empty())
            }
            _ => false,
        };
        if !valid {
            bail!("invalid Tomverse AMUX worker-heartbeat response invariant");
        }
        Ok(body)
    }

    pub async fn delivery_pull(
        &self,
        worker: &str,
        instance_id: &str,
        generation: i64,
    ) -> Result<DeliveryPullResponse> {
        let response = self
            .client
            .post(format!("{}/api/internal/amux/delivery/pull", self.base_url))
            .timeout(TOMVERSE_INTERNAL_LIFECYCLE_TIMEOUT)
            .bearer_auth(&self.secret)
            .json(&DeliveryPullRequest {
                worker,
                instance_id,
                generation,
            })
            .send()
            .await?;

        let (status, body): (_, DeliveryPullResponse) = read_bounded_json(
            response,
            &[StatusCode::OK, StatusCode::CONFLICT],
            MAX_LIFECYCLE_RESPONSE_BYTES,
        )
        .await?;
        let valid = match status {
            StatusCode::OK => {
                if body.available {
                    body.delivery.is_some() && body.reason.is_none()
                } else {
                    body.delivery.is_none() && body.reason.as_deref() == Some("none")
                }
            }
            StatusCode::CONFLICT => {
                !body.available
                    && body.delivery.is_none()
                    && body
                        .reason
                        .as_deref()
                        .is_some_and(|value| !value.is_empty())
            }
            _ => false,
        };
        if !valid {
            bail!("invalid Tomverse AMUX delivery-pull response invariant");
        }
        if let Some(delivery) = body.delivery.as_ref() {
            if uuid::Uuid::parse_str(&delivery.attempt_id).is_err()
                || uuid::Uuid::parse_str(&delivery.receipt_id).is_err()
                || chrono::DateTime::parse_from_rfc3339(&delivery.lease_expires_at).is_err()
                || !is_canonical_machine_id(&delivery.task_id)
                || !is_canonical_machine_id(&delivery.worker)
                || !(0..=PRISMA_INT_MAX).contains(&delivery.task_revision)
                || delivery.prompt.len() > 96 * 1024
            {
                bail!("invalid Tomverse AMUX delivery response fields");
            }
        }
        Ok(body)
    }

    pub async fn delivery_ack(
        &self,
        delivery: &PulledDelivery,
        instance_id: &str,
        generation: i64,
    ) -> Result<DeliveryAckResponse> {
        let response = self
            .client
            .post(format!("{}/api/internal/amux/delivery/ack", self.base_url))
            .timeout(TOMVERSE_INTERNAL_LIFECYCLE_TIMEOUT)
            .bearer_auth(&self.secret)
            .json(&DeliveryAckRequest {
                attempt_id: &delivery.attempt_id,
                receipt_id: &delivery.receipt_id,
                worker: &delivery.worker,
                instance_id,
                generation,
                task_revision: delivery.task_revision,
            })
            .send()
            .await?;

        let (status, body): (_, DeliveryAckResponse) = read_bounded_json(
            response,
            &[StatusCode::OK, StatusCode::CONFLICT],
            MAX_LIFECYCLE_RESPONSE_BYTES,
        )
        .await?;
        let valid = match status {
            StatusCode::OK => {
                body.acknowledged && body.idempotent.is_some() && body.reason.is_none()
            }
            StatusCode::CONFLICT => {
                !body.acknowledged
                    && body.idempotent.is_none()
                    && body
                        .reason
                        .as_deref()
                        .is_some_and(|value| !value.is_empty())
            }
            _ => false,
        };
        if !valid {
            bail!("invalid Tomverse AMUX delivery-ack response invariant");
        }
        Ok(body)
    }

    pub async fn execution_heartbeat(
        &self,
        delivery: &PulledDelivery,
        instance_id: &str,
        generation: i64,
    ) -> Result<ExecutionHeartbeatResponse> {
        let route = if delivery.assignment_id.is_some() {
            "v22/execution/heartbeat"
        } else {
            "execution/heartbeat"
        };
        let response = self
            .client
            .post(format!("{}/api/internal/amux/{}", self.base_url, route))
            .timeout(TOMVERSE_INTERNAL_LIFECYCLE_TIMEOUT)
            .bearer_auth(&self.secret)
            .json(&ExecutionHeartbeatRequest {
                attempt_id: &delivery.attempt_id,
                worker: &delivery.worker,
                instance_id,
                generation,
                task_revision: delivery.task_revision,
            })
            .send()
            .await?;

        let (status, body): (_, ExecutionHeartbeatResponse) = read_bounded_json(
            response,
            &[StatusCode::OK, StatusCode::CONFLICT],
            MAX_LIFECYCLE_RESPONSE_BYTES,
        )
        .await?;
        let valid = match status {
            StatusCode::OK => body.accepted && body.reason.is_none(),
            StatusCode::CONFLICT => {
                !body.accepted
                    && body
                        .reason
                        .as_deref()
                        .is_some_and(|value| !value.is_empty())
            }
            _ => false,
        };
        if !valid {
            bail!("invalid Tomverse AMUX execution-heartbeat response invariant");
        }
        Ok(body)
    }

    pub async fn owned_queue(&self) -> Result<SelectionRead<Vec<OwnedTodoTask>>> {
        let response = self
            .client
            .post(format!("{}/api/internal/amux/owned-queue", self.base_url))
            .timeout(TOMVERSE_INTERNAL_LIFECYCLE_TIMEOUT)
            .bearer_auth(&self.secret)
            .json(&QueueRequest {})
            .send()
            .await?;
        let (status, body) = read_bounded_body(
            response,
            SELECTION_READ_STATUSES,
            MAX_OWNED_QUEUE_RESPONSE_BYTES,
        )
        .await?;
        parse_owned_queue_body(status, &body)
    }

    pub async fn execution_start(
        &self,
        task_id: &str,
        worker: &str,
        instance_id: &str,
        generation: i64,
        expected_revision: i64,
        assignment_id: Option<&str>,
    ) -> Result<ExecutionStartResponse> {
        let route = if assignment_id.is_some() {
            "v22/execution/start"
        } else {
            "execution/start"
        };
        let response = self
            .client
            .post(format!("{}/api/internal/amux/{}", self.base_url, route))
            .timeout(TOMVERSE_INTERNAL_LIFECYCLE_TIMEOUT)
            .bearer_auth(&self.secret)
            .json(&ExecutionStartRequest {
                task_id,
                worker,
                instance_id,
                generation,
                expected_revision,
                assignment_id,
            })
            .send()
            .await?;

        let (status, body): (_, ExecutionStartResponse) = read_bounded_json(
            response,
            &[StatusCode::OK, StatusCode::CONFLICT],
            MAX_LIFECYCLE_RESPONSE_BYTES,
        )
        .await?;
        let valid = match status {
            StatusCode::OK => {
                body.started
                    && body.attempt_id.is_some()
                    && body
                        .task_revision
                        .is_some_and(|value| (0..=PRISMA_INT_MAX).contains(&value))
                    && body.lease_expires_at.is_some()
                    && body.reason.is_none()
            }
            StatusCode::CONFLICT => {
                !body.started
                    && body.attempt_id.is_none()
                    && body.task_revision.is_none()
                    && body.lease_expires_at.is_none()
                    && body
                        .reason
                        .as_deref()
                        .is_some_and(|value| !value.is_empty())
            }
            _ => false,
        };
        if !valid {
            bail!("invalid Tomverse AMUX execution-start response invariant");
        }
        Ok(body)
    }

    pub async fn v22_execution_readback(
        &self,
        assignment_id: &str,
        worker: &str,
        instance_id: &str,
        generation: i64,
    ) -> Result<V22ExecutionReadback> {
        let response = self.client.get(format!(
            "{}/api/internal/amux/v22/execution/attempt", self.base_url
        )).timeout(TOMVERSE_INTERNAL_LIFECYCLE_TIMEOUT)
            .bearer_auth(&self.secret)
            .query(&[("assignment_id", assignment_id), ("worker", worker),
                ("instance_id", instance_id)])
            .query(&[("generation", generation)])
            .send().await?;
        let (status, body): (_, V22ExecutionReadback) = read_bounded_json(
            response, &[StatusCode::OK], MAX_LIFECYCLE_RESPONSE_BYTES,
        ).await?;
        if status != StatusCode::OK || !body.found ||
            !matches!(body.state.as_deref(), Some("not_started" | "started" | "ended")) {
            bail!("invalid v22 execution readback");
        }
        Ok(body)
    }

    pub async fn execution_settle(
        &self,
        attempt_id: &str,
        worker: &str,
        instance_id: &str,
        generation: i64,
        task_revision: i64,
        outcome: &str,
        to_status: &str,
        reason: Option<&str>,
    ) -> Result<ExecutionSettleResponse> {
        self.execution_settle_with_review_pr(
            attempt_id,
            worker,
            instance_id,
            generation,
            task_revision,
            outcome,
            to_status,
            reason,
            None,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn execution_settle_with_review_pr(
        &self,
        attempt_id: &str,
        worker: &str,
        instance_id: &str,
        generation: i64,
        task_revision: i64,
        outcome: &str,
        to_status: &str,
        reason: Option<&str>,
        review_pr_number: Option<Option<i64>>,
    ) -> Result<ExecutionSettleResponse> {
        let response = self
            .client
            .post(format!(
                "{}/api/internal/amux/execution/settle",
                self.base_url
            ))
            .timeout(TOMVERSE_INTERNAL_LIFECYCLE_TIMEOUT)
            .bearer_auth(&self.secret)
            .json(&ExecutionSettleRequest {
                attempt_id,
                worker,
                instance_id,
                generation,
                task_revision,
                outcome,
                to_status,
                reason,
                cost_microusd: None,
                review_pr_number,
            })
            .send()
            .await?;

        let (status, body): (_, ExecutionSettleResponse) = read_bounded_json(
            response,
            &[StatusCode::OK, StatusCode::CONFLICT],
            MAX_LIFECYCLE_RESPONSE_BYTES,
        )
        .await?;
        let valid = match status {
            StatusCode::OK => {
                body.settled
                    && body
                        .task_revision
                        .is_some_and(|value| (0..=PRISMA_INT_MAX).contains(&value))
                    && body.reason.is_none()
            }
            StatusCode::CONFLICT => {
                !body.settled
                    && body.task_revision.is_none()
                    && body
                        .reason
                        .as_deref()
                        .is_some_and(|value| !value.is_empty())
            }
            _ => false,
        };
        if !valid {
            bail!("invalid Tomverse AMUX execution-settle response invariant");
        }
        Ok(body)
    }

    async fn v22_execution_settle_with_receipt(
        &self,
        delivery: &PulledDelivery,
        instance_id: &str,
        generation: i64,
        outcome: &str,
        invocation_ids: &[&str],
    ) -> Result<ExecutionSettleResponse> {
        if delivery.assignment_id.is_none() {
            bail!("v22 settlement requires an assignment-bound delivery");
        }
        let response = self.client
            .post(format!("{}/api/internal/amux/v22/execution/settle", self.base_url))
            .timeout(TOMVERSE_INTERNAL_LIFECYCLE_TIMEOUT)
            .bearer_auth(&self.secret)
            .json(&V22ExecutionSettleRequest {
                attempt_id: &delivery.attempt_id,
                worker: &delivery.worker,
                instance_id,
                generation,
                task_revision: delivery.task_revision,
                outcome,
                invocation_ids,
            })
            .send().await?;
        let (status, body): (_, ExecutionSettleResponse) = read_bounded_json(
            response, &[StatusCode::OK, StatusCode::CONFLICT],
            MAX_LIFECYCLE_RESPONSE_BYTES,
        ).await?;
        if (status == StatusCode::OK && body.settled &&
            body.task_revision.is_some_and(|value| (0..=PRISMA_INT_MAX).contains(&value)) &&
            body.reason.is_none()) ||
           (status == StatusCode::CONFLICT && !body.settled &&
            body.task_revision.is_none() &&
            body.reason.as_deref().is_some_and(|value| !value.is_empty())) {
            Ok(body)
        } else {
            bail!("invalid v22 execution-settle response invariant")
        }
    }

    /// Only a supervised one-shot CLI process may use this positive path.
    /// The app independently requires its A14 usage row to be complete,
    /// priced, and bound to the durable attempt ID before changing status.
    pub async fn v22_execution_settle_verified(
        &self,
        delivery: &PulledDelivery,
        instance_id: &str,
        generation: i64,
        outcome: &str,
    ) -> Result<ExecutionSettleResponse> {
        if !matches!(outcome, "succeeded" | "failed") {
            bail!("verified v22 settlement requires a terminal CLI result");
        }
        self.v22_execution_settle_with_receipt(delivery, instance_id, generation,
            outcome, &[&delivery.attempt_id]).await
    }

    /// A local AMUX card is not an A14 usage receipt. Without a verified
    /// one-shot result, close a terminal v22 attempt as blocked for owner
    /// read-back, never as succeeded or automatically retryable failed.
    pub async fn v22_execution_settle_unverified(
        &self,
        delivery: &PulledDelivery,
        instance_id: &str,
        generation: i64,
    ) -> Result<ExecutionSettleResponse> {
        self.v22_execution_settle_with_receipt(delivery, instance_id, generation,
            "blocked", &[]).await
    }

    /// Policy version 15: the system consumer of pre-approved automatic
    /// promotion grants. The server decides everything (switch, graduation,
    /// capacity, cost, halt). A write call since policy version 20: it
    /// carries its request identity and its answer comes back raw for
    /// `orchestrator_halt::classify_tick`. An `Err` is no answer at all.
    pub async fn auto_promotion_tick(&self, ids: WriteIds) -> Result<RawAnswer> {
        let response = self
            .client
            .post(format!(
                "{}/api/internal/amux/auto-promotion/tick",
                self.base_url
            ))
            .bearer_auth(&self.secret)
            .header(REQUEST_ID_HEADER, ids.request_id.to_string())
            .header(INSTANCE_ID_HEADER, ids.instance_id.to_string())
            .json(&QueueRequest {})
            .timeout(TOMVERSE_INTERNAL_AUTO_PROMOTION_TIMEOUT)
            .send()
            .await?;
        read_raw_answer(response, MAX_LIFECYCLE_RESPONSE_BYTES).await
    }

    /// A write call since policy version 20, answered raw for
    /// `orchestrator_halt::classify_recover`. An `Err` is no answer at all.
    pub async fn execution_recover(&self, ids: WriteIds) -> Result<RawAnswer> {
        let response = self
            .client
            .post(format!(
                "{}/api/internal/amux/execution/recover",
                self.base_url
            ))
            .timeout(TOMVERSE_INTERNAL_LIFECYCLE_TIMEOUT)
            .bearer_auth(&self.secret)
            .header(REQUEST_ID_HEADER, ids.request_id.to_string())
            .header(INSTANCE_ID_HEADER, ids.instance_id.to_string())
            .json(&QueueRequest {})
            .send()
            .await?;
        read_raw_answer(response, MAX_LIFECYCLE_RESPONSE_BYTES).await
    }

    /// Policy version 20, section 4: acknowledges a known answer to one write
    /// call. Not itself a write call: it carries no request identity header.
    pub async fn orchestrator_ack(&self, request_id: Uuid, kind: &'static str) -> Result<RawAnswer> {
        let response = self
            .client
            .post(format!(
                "{}/api/internal/amux/orchestrator/ack",
                self.base_url
            ))
            .timeout(TOMVERSE_INTERNAL_LIFECYCLE_TIMEOUT)
            .bearer_auth(&self.secret)
            .json(&AckRequest {
                request_id: request_id.to_string(),
                kind,
            })
            .send()
            .await?;
        read_raw_answer(response, MAX_LIFECYCLE_RESPONSE_BYTES).await
    }

    /// Policy version 20, section 5: records one halt, or reads back the one
    /// already recorded under the same key. There is no call that clears one.
    pub async fn orchestrator_halt_record(&self, record: &HaltRecordRequest) -> Result<RawAnswer> {
        let response = self
            .client
            .post(format!(
                "{}/api/internal/amux/orchestrator/halt",
                self.base_url
            ))
            .timeout(TOMVERSE_INTERNAL_LIFECYCLE_TIMEOUT)
            .bearer_auth(&self.secret)
            .json(record)
            .send()
            .await?;
        read_raw_answer(response, MAX_LIFECYCLE_RESPONSE_BYTES).await
    }

    /// Policy version 20, section 5: the halt state, after the server has
    /// applied its resolver, with the state of each halt key asked about.
    pub async fn orchestrator_halt_state(&self, halt_keys: &[Uuid]) -> Result<RawAnswer> {
        let query: Vec<(&str, String)> = halt_keys
            .iter()
            .map(|key| ("halt_key", key.to_string()))
            .collect();
        let response = self
            .client
            .get(format!(
                "{}/api/internal/amux/orchestrator/halt",
                self.base_url
            ))
            .timeout(TOMVERSE_INTERNAL_LIFECYCLE_TIMEOUT)
            .bearer_auth(&self.secret)
            .query(&query)
            .send()
            .await?;
        read_raw_answer(response, MAX_LIFECYCLE_RESPONSE_BYTES).await
    }
}

/// The recovery answer's own invariants: a 2xx the route sends when it
/// recovered, and its one 409 (orchestration policy version 20, section 1:
/// `execution_api_disabled`, the form the parser has always accepted).
pub(crate) fn recovery_answer_is_valid(
    status: StatusCode,
    body: &ExecutionRecoveryResponse,
) -> bool {
    let nonnegative = |value: Option<i64>| value.is_none_or(|value| value >= 0);
    match status {
        StatusCode::OK => {
            body.recovered
                && nonnegative(body.reclaimed)
                && nonnegative(body.reclaimed_claims)
                && nonnegative(body.quota_observations_deleted)
                && nonnegative(body.quarantined_v22)
                && nonnegative(body.released_unstarted_v22)
                && body.reason.is_none()
        }
        StatusCode::CONFLICT => {
            !body.recovered
                && body.reclaimed.is_none()
                && body.reclaimed_claims.is_none()
                && nonnegative(body.quota_observations_deleted)
                && body.quarantined_v22.is_none()
                && body.released_unstarted_v22.is_none()
                && body.reason.as_deref() == Some("execution_api_disabled")
        }
        _ => false,
    }
}

/// The tick answer's own invariants (policy version 20, section 1): any 200
/// the route sends, whatever its reason, and the 409 `apply_disabled`.
pub(crate) fn tick_answer_is_valid(status: StatusCode, body: &AutoPromotionTickResponse) -> bool {
    let expired = body.expired.is_none_or(|value| value >= 0);
    if body.policy_version == Some(22) {
        return match status {
            StatusCode::OK if body.promoted => {
                body.claimed.is_none() && body.reason.is_none() && body.consumption_id.is_none()
                    && body.expired.is_none()
                    && body.receipt_id.as_deref().is_some_and(|value| !value.is_empty())
                    && body.task_id.as_deref().is_some_and(|value| !value.is_empty())
                    && body.assignment_id.is_none() && body.worker_name.is_none()
            }
            StatusCode::OK if body.claimed == Some(true) => {
                !body.promoted && body.reason.is_none() && body.consumption_id.is_none()
                    && body.expired.is_none() && body.receipt_id.is_none()
                    && body.task_id.as_deref().is_some_and(|value| !value.is_empty())
                    && body.assignment_id.as_deref().is_some_and(|value| !value.is_empty())
                    && body.worker_name.as_deref().is_some_and(|value| !value.is_empty())
            }
            StatusCode::OK if !body.promoted => {
                body.claimed.is_none() &&
                body.reason.as_deref().is_some_and(|value| !value.is_empty())
                    && body.reason.as_deref() != Some("outcome_unknown")
                    && body.consumption_id.is_none() && body.expired.is_none()
                    && body.receipt_id.is_none() && body.task_id.is_none()
                    && body.assignment_id.is_none() && body.worker_name.is_none()
            }
            _ => false,
        };
    }
    if body.policy_version.is_some() || body.claimed.is_some() ||
        body.receipt_id.is_some() || body.task_id.is_some() ||
        body.assignment_id.is_some() || body.worker_name.is_some() {
        return false;
    }
    match status {
        StatusCode::OK => {
            expired
                && if body.promoted {
                    body.consumption_id
                        .as_deref()
                        .is_some_and(|value| !value.is_empty())
                        && body.reason.is_none()
                } else {
                    body.consumption_id.is_none()
                        && body.reason.as_deref().is_none_or(|value| !value.is_empty())
                }
        }
        StatusCode::CONFLICT => {
            expired
                && !body.promoted
                && body.consumption_id.is_none()
                && body.reason.as_deref() == Some("apply_disabled")
        }
        _ => false,
    }
}
