use std::time::Duration;

use anyhow::{Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::scheduler::ScoreBreakdown;
use crate::worker::{CandidateRoutingSignals, RoutingTaskProfile};

#[derive(Clone)]
pub struct TomverseApi {
    client: Client,
    base_url: String,
    secret: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct QueueTask {
    pub id: String,
    pub title: String,
    pub status: String,
    pub kind: String,
    pub priority: String,
    pub pinned: bool,
    pub drag: i64,
    pub owner: Option<String>,
    pub revision: i64,
    pub created_at: String,
    pub dependencies: Vec<String>,
    pub dependent_count: i64,
    #[serde(default)]
    pub scheduler_score: i64,
    #[serde(default)]
    pub scoring_version: String,
    #[serde(default)]
    pub scheduler_signals: ScoreBreakdown,
}

#[derive(Debug, Serialize)]
struct QueueRequest {}

#[derive(Debug, Serialize)]
struct RoutingSnapshotRequest<'a> {
    task_id: &'a str,
    expected_revision: i64,
}

#[derive(Debug, Deserialize)]
pub struct RoutingSnapshotResponse {
    pub eligible: bool,
    pub execution_ready: bool,
    pub reason: Option<String>,
    pub task: Option<RoutingTaskProfile>,
    pub candidates: Vec<CandidateRoutingSignals>,
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

#[derive(Debug, Deserialize)]
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
    pub const fn as_str(&self) -> &'static str {
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
pub struct ClaimResponse {
    pub claimed: bool,
    pub revision: Option<i64>,
    pub decision_id: Option<String>,
    pub reason: Option<ClaimRefusalReason>,
}

/// The recovery route has a twelve-second server budget. Keep the caller
/// above it so a client timeout cannot manufacture an ambiguous retry.
const TOMVERSE_INTERNAL_RECOVERY_TIMEOUT: Duration = Duration::from_secs(15);
/// Every other internal call. Before this the client had no deadline, so one
/// request the server never answered stalled the scheduler tick or the WSL
/// bridge loop indefinitely. It is longer than the server route budget
/// (15 seconds), so a normal slow answer still arrives. A timeout on a
/// mutating call is an unknown outcome: the callers already treat any error as
/// a failed tick (scheduler) or a halt (bridge) and never retry it blindly.
const TOMVERSE_INTERNAL_REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const TOMVERSE_INTERNAL_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

impl TomverseApi {
    pub fn from_env() -> Result<Self> {
        let base_url =
            std::env::var("TOMVERSE_INTERNAL_URL").context("TOMVERSE_INTERNAL_URL is required")?;

        let secret = std::env::var("TOMVERSE_AMUX_SYNC_SECRET")
            .context("TOMVERSE_AMUX_SYNC_SECRET is required")?;

        if secret.len() < 32 {
            anyhow::bail!("TOMVERSE_AMUX_SYNC_SECRET must contain at least 32 characters");
        }

        Ok(Self {
            client: Client::builder()
                .timeout(TOMVERSE_INTERNAL_REQUEST_TIMEOUT)
                .connect_timeout(TOMVERSE_INTERNAL_CONNECT_TIMEOUT)
                .build()
                .context("Tomverse internal client failed")?,
            base_url: base_url.trim_end_matches('/').to_owned(),
            secret,
        })
    }

    pub async fn queue(&self) -> Result<Vec<QueueTask>> {
        self.client
            .post(format!("{}/api/internal/amux/queue", self.base_url))
            .bearer_auth(&self.secret)
            .json(&QueueRequest {})
            .send()
            .await?
            .error_for_status()?
            .json()
            .await
            .context("invalid Tomverse AMUX queue response")
    }

    pub async fn routing_snapshot(
        &self,
        task_id: &str,
        expected_revision: i64,
    ) -> Result<RoutingSnapshotResponse> {
        self.client
            .post(format!(
                "{}/api/internal/amux/routing-snapshot",
                self.base_url
            ))
            .bearer_auth(&self.secret)
            .json(&RoutingSnapshotRequest {
                task_id,
                expected_revision,
            })
            .send()
            .await?
            .error_for_status()?
            .json()
            .await
            .context("invalid Tomverse AMUX routing snapshot response")
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

        let status = response.status();
        if !status.is_success() && status != reqwest::StatusCode::CONFLICT {
            response.error_for_status_ref()?;
        }

        response
            .json()
            .await
            .context("invalid Tomverse AMUX claim response")
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct OwnedTodoTask {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub kind: String,
    pub priority: String,
    pub owner: String,
    pub revision: i64,
    pub claimed_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
struct WorkerRegisterRequest<'a> {
    worker_name: &'a str,
    instance_id: &'a str,
}

#[derive(Debug, Clone, Deserialize)]
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
pub struct ExecutionHeartbeatResponse {
    pub accepted: bool,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    review_pr_number: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExecutionSettleResponse {
    pub settled: bool,
    #[serde(rename = "taskRevision")]
    pub task_revision: Option<i64>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AutoPromotionTickResponse {
    pub promoted: bool,
    pub reason: Option<String>,
    pub consumption_id: Option<String>,
    pub expired: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
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
            .bearer_auth(&self.secret)
            .json(&WorkerRegisterRequest {
                worker_name,
                instance_id,
            })
            .send()
            .await?;

        let status = response.status();

        if !status.is_success() && status != reqwest::StatusCode::CONFLICT {
            response.error_for_status_ref()?;
        }

        response
            .json()
            .await
            .context("invalid Tomverse AMUX worker-register response")
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

        let status = response.status();

        if !status.is_success() && status != reqwest::StatusCode::CONFLICT {
            response.error_for_status_ref()?;
        }

        response
            .json()
            .await
            .context("invalid Tomverse AMUX worker-heartbeat response")
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
            .bearer_auth(&self.secret)
            .json(&DeliveryPullRequest {
                worker,
                instance_id,
                generation,
            })
            .send()
            .await?;

        let status = response.status();

        if !status.is_success() && status != reqwest::StatusCode::CONFLICT {
            response.error_for_status_ref()?;
        }

        response
            .json()
            .await
            .context("invalid Tomverse AMUX delivery-pull response")
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

        let status = response.status();

        if !status.is_success() && status != reqwest::StatusCode::CONFLICT {
            response.error_for_status_ref()?;
        }

        response
            .json()
            .await
            .context("invalid Tomverse AMUX delivery-ack response")
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

        let status = response.status();

        if !status.is_success() && status != reqwest::StatusCode::CONFLICT {
            response.error_for_status_ref()?;
        }

        response
            .json()
            .await
            .context("invalid Tomverse AMUX execution-heartbeat response")
    }

    pub async fn owned_queue(&self) -> Result<Vec<OwnedTodoTask>> {
        self.client
            .post(format!("{}/api/internal/amux/owned-queue", self.base_url))
            .bearer_auth(&self.secret)
            .json(&QueueRequest {})
            .send()
            .await?
            .error_for_status()?
            .json()
            .await
            .context("invalid Tomverse AMUX owned-queue response")
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

        let status = response.status();

        if !status.is_success() && status != reqwest::StatusCode::CONFLICT {
            response.error_for_status_ref()?;
        }

        response
            .json()
            .await
            .context("invalid Tomverse AMUX execution-start response")
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
        review_pr_number: Option<i64>,
    ) -> Result<ExecutionSettleResponse> {
        let response = self
            .client
            .post(format!(
                "{}/api/internal/amux/execution/settle",
                self.base_url
            ))
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

        let status = response.status();

        if !status.is_success() && status != reqwest::StatusCode::CONFLICT {
            response.error_for_status_ref()?;
        }

        response
            .json()
            .await
            .context("invalid Tomverse AMUX execution-settle response")
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
            .send()
            .await?;

        let status = response.status();

        if !status.is_success() && status != reqwest::StatusCode::CONFLICT {
            response.error_for_status_ref()?;
        }

        response
            .json()
            .await
            .context("invalid Tomverse AMUX auto-promotion tick response")
    }

    pub async fn execution_recover(&self) -> Result<ExecutionRecoveryResponse> {
        let response = self
            .client
            .post(format!(
                "{}/api/internal/amux/execution/recover",
                self.base_url
            ))
            .timeout(TOMVERSE_INTERNAL_RECOVERY_TIMEOUT)
            .bearer_auth(&self.secret)
            .json(&QueueRequest {})
            .send()
            .await?;

        let status = response.status();

        if !status.is_success() && status != reqwest::StatusCode::CONFLICT {
            response.error_for_status_ref()?;
        }

        response
            .json()
            .await
            .context("invalid Tomverse AMUX execution-recover response")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn internal_deadline_outlasts_the_server_route_budget() {
        // The app's AMUX route budget is 15 seconds; a shorter client deadline
        // would turn every normal slow answer into an unknown outcome.
        assert!(TOMVERSE_INTERNAL_REQUEST_TIMEOUT > Duration::from_secs(15));
        assert!(TOMVERSE_INTERNAL_CONNECT_TIMEOUT < TOMVERSE_INTERNAL_REQUEST_TIMEOUT);
        assert!(TOMVERSE_INTERNAL_RECOVERY_TIMEOUT <= TOMVERSE_INTERNAL_REQUEST_TIMEOUT);
    }

    #[test]
    fn from_env_builds_a_client_with_a_deadline() {
        let source = include_str!("tomverse_api.rs");
        let from_env = &source[source.find("pub fn from_env").unwrap()..];
        let body = &from_env[..from_env.find("pub async fn queue").unwrap()];
        assert!(body.contains(".timeout(TOMVERSE_INTERNAL_REQUEST_TIMEOUT)"));
        assert!(!body.contains("Client::new()"));
    }
}
