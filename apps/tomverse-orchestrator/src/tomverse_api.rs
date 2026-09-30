use std::time::Duration;

use anyhow::{Context, Result, bail};
use reqwest::{Client, StatusCode, header};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;

use crate::scheduler::ScoreBreakdown;
use crate::worker::{CandidateRoutingSignals, RoutingTaskProfile};

#[derive(Clone)]
pub struct TomverseApi {
    client: Client,
    claim_timeout: Duration,
    selection_read_timeout: Duration,
    base_url: String,
    secret: String,
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
fn is_database_busy(body: &[u8]) -> bool {
    serde_json::from_slice::<DatabaseBusyAnswer>(body)
        .is_ok_and(|answer| answer.reason == DATABASE_BUSY)
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
/// and nothing else. Any other status or body is an error, as before.
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
    if status == StatusCode::SERVICE_UNAVAILABLE && is_database_busy(body) {
        return Ok(SelectionRead::DatabaseBusy);
    }
    if status != StatusCode::OK {
        bail!("unsupported Tomverse internal response status");
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
    if status == StatusCode::SERVICE_UNAVAILABLE && is_database_busy(body) {
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
/// `{eligible, reason}`; its 503 body is the queue's `{error, reason}`.
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
    if status == StatusCode::SERVICE_UNAVAILABLE && is_database_busy(body) {
        return Ok(SelectionRead::DatabaseBusy);
    }
    if status != StatusCode::OK {
        bail!("unsupported Tomverse internal response status");
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
        bail!("unsupported Tomverse internal response status");
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

fn claim_response_status_is_bounded(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::OK || status == reqwest::StatusCode::CONFLICT
}

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

    pub async fn claim(
        &self,
        task_id: &str,
        worker: &str,
        expected_revision: i64,
        scheduler_score: i64,
        scoring_version: &str,
        signals: Value,
    ) -> Result<ClaimResponse> {
        let response = self
            .client
            .post(format!("{}/api/internal/amux/claim", self.base_url))
            .timeout(self.claim_timeout)
            .bearer_auth(&self.secret)
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

        if !claim_response_status_is_bounded(response.status()) {
            response.error_for_status_ref()?;
            bail!("unsupported Tomverse AMUX claim response status");
        }

        read_claim_response(response).await
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
pub struct PulledDelivery {
    pub attempt_id: String,
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
    pub reason: Option<String>,
    pub consumption_id: Option<String>,
    pub expired: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionRecoveryResponse {
    pub recovered: bool,
    pub reclaimed: Option<i64>,
    pub reclaimed_claims: Option<i64>,
    pub quota_observations_deleted: Option<i64>,
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
        let response = self
            .client
            .post(format!(
                "{}/api/internal/amux/execution/heartbeat",
                self.base_url
            ))
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
    ) -> Result<ExecutionStartResponse> {
        let response = self
            .client
            .post(format!(
                "{}/api/internal/amux/execution/start",
                self.base_url
            ))
            .timeout(TOMVERSE_INTERNAL_LIFECYCLE_TIMEOUT)
            .bearer_auth(&self.secret)
            .json(&ExecutionStartRequest {
                task_id,
                worker,
                instance_id,
                generation,
                expected_revision,
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

    /// Policy version 15: the system consumer of pre-approved automatic
    /// promotion grants. The server decides everything (switch, graduation,
    /// capacity, cost, halt); a 409 carries its refusal reason.
    pub async fn auto_promotion_tick(&self) -> Result<AutoPromotionTickResponse> {
        let response = self
            .client
            .post(format!(
                "{}/api/internal/amux/auto-promotion/tick",
                self.base_url
            ))
            .bearer_auth(&self.secret)
            .json(&QueueRequest {})
            .timeout(TOMVERSE_INTERNAL_AUTO_PROMOTION_TIMEOUT)
            .send()
            .await?;
        let (_, body): (_, AutoPromotionTickResponse) = read_bounded_json(
            response,
            &[StatusCode::OK, StatusCode::CONFLICT],
            MAX_LIFECYCLE_RESPONSE_BYTES,
        )
        .await
        .context("invalid Tomverse AMUX auto-promotion tick response")?;
        Ok(body)
    }

    pub async fn execution_recover(&self) -> Result<ExecutionRecoveryResponse> {
        let response = self
            .client
            .post(format!(
                "{}/api/internal/amux/execution/recover",
                self.base_url
            ))
            .timeout(TOMVERSE_INTERNAL_LIFECYCLE_TIMEOUT)
            .bearer_auth(&self.secret)
            .json(&QueueRequest {})
            .send()
            .await?;

        let (status, body): (_, ExecutionRecoveryResponse) = read_bounded_json(
            response,
            &[StatusCode::OK, StatusCode::CONFLICT],
            MAX_LIFECYCLE_RESPONSE_BYTES,
        )
        .await?;
        let nonnegative = |value: Option<i64>| value.is_none_or(|value| value >= 0);
        let valid = match status {
            StatusCode::OK => {
                body.recovered
                    && nonnegative(body.reclaimed)
                    && nonnegative(body.reclaimed_claims)
                    && nonnegative(body.quota_observations_deleted)
                    && body.reason.is_none()
            }
            StatusCode::CONFLICT => {
                !body.recovered
                    && body.reclaimed.is_none()
                    && body.reclaimed_claims.is_none()
                    && nonnegative(body.quota_observations_deleted)
                    && body
                        .reason
                        .as_deref()
                        .is_some_and(|value| !value.is_empty())
            }
            _ => false,
        };
        if !valid {
            bail!("invalid Tomverse AMUX execution-recover response invariant");
        }
        Ok(body)
    }
}
