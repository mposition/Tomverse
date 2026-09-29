//! Wire parity with the Rust client that runs in production today.
//!
//! The WSL bridge and the claim-only orchestrator running when develop's AMUX
//! came to main were built from main 7724fd683 or later. The server deploys
//! before they are rebuilt, so every response it sends must still parse with
//! their structs, and every request they send must still pass its schemas.
//! `frozen` below is a verbatim copy of those structs (no field added, none
//! removed, no serde attribute changed). The fixtures are shared with
//! tests/server-contract/amux-main-rust-wire-parity.test.ts, which drives the
//! real routes with the same requests and requires the same responses.
//!
//! Delete this module only when no binary older than this tree can run.

use super::*;

mod frozen {
    //! apps/tomverse-orchestrator/src/tomverse_api.rs and worker.rs at main
    //! 7724fd683, response and request structs only.
    #![allow(dead_code)]

    use serde::{Deserialize, Serialize};
    use serde_json::Value;

    #[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
    pub struct ScoreBreakdown {
        pub pin: i64,
        pub age_hours: i64,
        pub type_weight: i64,
        pub priority_weight: i64,
        pub dependents: i64,
        pub dependent_weight: i64,
        pub drag: i64,
        pub urgency: i64,
        pub capacity_weight: i64,
        pub incident_bonus: i64,
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

    #[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
    pub struct RoutingTaskProfile {
        pub task_kind: String,
        pub complexity: i64,
        pub risk: i64,
        pub files_expected: Option<usize>,
    }

    #[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
    pub struct RoutingWorkerCandidate {
        pub worker_name: String,
        pub provider: String,
        pub model: Option<String>,
        pub routing_roles: Vec<String>,
        pub running: bool,
        pub status: String,
        pub dispatch_ready: bool,
        pub archived: bool,
        pub paused: bool,
        pub isolated: bool,
        pub blocked: bool,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct CandidateRoutingSignals {
        pub worker: RoutingWorkerCandidate,
        pub predicted_success: Option<f64>,
        pub quota_remaining: Option<f64>,
        pub expected_speed: Option<f64>,
        pub low_rework: Option<f64>,
        pub low_human_attention: Option<f64>,
        pub cost_efficiency: Option<f64>,
        pub provider_exhausted: bool,
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
    pub struct RoutingSnapshotRequest<'a> {
        pub task_id: &'a str,
        pub expected_revision: i64,
    }

    #[derive(Debug, Serialize)]
    pub struct ClaimRequest<'a> {
        pub task_id: &'a str,
        pub worker: &'a str,
        pub expected_revision: i64,
        pub decision: ClaimDecision,
    }

    #[derive(Debug, Serialize)]
    pub struct ClaimDecision {
        pub scheduler_score: i64,
        pub scoring_version: String,
        pub signals: Value,
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

    #[derive(Debug, Deserialize)]
    pub struct ClaimResponse {
        pub claimed: bool,
        pub revision: Option<i64>,
        pub decision_id: Option<String>,
        pub reason: Option<ClaimRefusalReason>,
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
    pub struct WorkerRegisterRequest<'a> {
        pub worker_name: &'a str,
        pub instance_id: &'a str,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct WorkerRegisterResponse {
        pub registered: bool,
        pub generation: Option<i64>,
        pub lease_expires_at: Option<String>,
        pub reason: Option<String>,
    }

    #[derive(Debug, Serialize)]
    pub struct WorkerHeartbeatRequest<'a> {
        pub worker_name: &'a str,
        pub instance_id: &'a str,
        pub generation: i64,
        pub status: &'a str,
        pub dispatch_ready: bool,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct WorkerHeartbeatResponse {
        pub accepted: bool,
        pub lease_expires_at: Option<String>,
        pub reason: Option<String>,
    }

    #[derive(Debug, Serialize)]
    pub struct DeliveryPullRequest<'a> {
        pub worker: &'a str,
        pub instance_id: &'a str,
        pub generation: i64,
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
    pub struct DeliveryAckRequest<'a> {
        pub attempt_id: &'a str,
        pub receipt_id: &'a str,
        pub worker: &'a str,
        pub instance_id: &'a str,
        pub generation: i64,
        pub task_revision: i64,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct DeliveryAckResponse {
        pub acknowledged: bool,
        pub idempotent: Option<bool>,
        pub reason: Option<String>,
    }

    #[derive(Debug, Serialize)]
    pub struct ExecutionHeartbeatRequest<'a> {
        pub attempt_id: &'a str,
        pub worker: &'a str,
        pub instance_id: &'a str,
        pub generation: i64,
        pub task_revision: i64,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct ExecutionHeartbeatResponse {
        pub accepted: bool,
        #[serde(default)]
        pub reason: Option<String>,
    }

    #[derive(Debug, Serialize)]
    pub struct ExecutionStartRequest<'a> {
        pub task_id: &'a str,
        pub worker: &'a str,
        pub instance_id: &'a str,
        pub generation: i64,
        pub expected_revision: i64,
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
    pub struct ExecutionSettleRequest<'a> {
        pub attempt_id: &'a str,
        pub worker: &'a str,
        pub instance_id: &'a str,
        pub generation: i64,
        pub task_revision: i64,
        pub outcome: &'a str,
        pub to_status: &'a str,
        pub reason: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub cost_microusd: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub review_pr_number: Option<Option<i64>>,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct ExecutionSettleResponse {
        pub settled: bool,
        #[serde(rename = "taskRevision", default)]
        pub task_revision: Option<i64>,
        #[serde(default)]
        pub reason: Option<String>,
    }
}

fn wire() -> Value {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/amux-main-rust-wire-v1.json"
    ))
    .unwrap()
}

fn exchange(name: &str) -> Value {
    wire()["exchanges"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == name)
        .unwrap_or_else(|| panic!("fixture exchange {name}"))
        .clone()
}

fn str_at<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_else(|| panic!("{key}"))
}

fn i64_at(value: &Value, key: &str) -> i64 {
    value[key].as_i64().unwrap_or_else(|| panic!("{key}"))
}

fn queue_wire(name: &str) -> Value {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/amux-queue-wire-compat-v1.json"
    ))
    .unwrap();
    fixtures[name].clone()
}

fn routing_wire(name: &str) -> Value {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/amux-routing-snapshot-v1.json"
    ))
    .unwrap();
    fixtures[name].clone()
}

/// Serializes the fixture request with the frozen struct and the current one;
/// both must equal the body the server accepted.
fn assert_request_parity<A: serde::Serialize, B: serde::Serialize>(name: &str, frozen: A, current: B) {
    let expected = exchange(name)["request"].clone();
    assert_eq!(serde_json::to_value(frozen).unwrap(), expected, "frozen {name}");
    assert_eq!(serde_json::to_value(current).unwrap(), expected, "current {name}");
}

fn response(name: &str) -> Value {
    exchange(name)["response"].clone()
}

#[test]
fn every_request_body_is_what_main_and_this_tree_serialize() {
    let register = exchange("worker_register")["request"].clone();
    assert_request_parity(
        "worker_register",
        frozen::WorkerRegisterRequest {
            worker_name: str_at(&register, "worker_name"),
            instance_id: str_at(&register, "instance_id"),
        },
        WorkerRegisterRequest {
            worker_name: str_at(&register, "worker_name"),
            instance_id: str_at(&register, "instance_id"),
        },
    );

    let heartbeat = exchange("worker_heartbeat")["request"].clone();
    assert_request_parity(
        "worker_heartbeat",
        frozen::WorkerHeartbeatRequest {
            worker_name: str_at(&heartbeat, "worker_name"),
            instance_id: str_at(&heartbeat, "instance_id"),
            generation: i64_at(&heartbeat, "generation"),
            status: str_at(&heartbeat, "status"),
            dispatch_ready: true,
        },
        WorkerHeartbeatRequest {
            worker_name: str_at(&heartbeat, "worker_name"),
            instance_id: str_at(&heartbeat, "instance_id"),
            generation: i64_at(&heartbeat, "generation"),
            status: str_at(&heartbeat, "status"),
            dispatch_ready: true,
        },
    );

    let pull = exchange("delivery_pull")["request"].clone();
    assert_request_parity(
        "delivery_pull",
        frozen::DeliveryPullRequest {
            worker: str_at(&pull, "worker"),
            instance_id: str_at(&pull, "instance_id"),
            generation: i64_at(&pull, "generation"),
        },
        DeliveryPullRequest {
            worker: str_at(&pull, "worker"),
            instance_id: str_at(&pull, "instance_id"),
            generation: i64_at(&pull, "generation"),
        },
    );

    let ack = exchange("delivery_ack")["request"].clone();
    assert_request_parity(
        "delivery_ack",
        frozen::DeliveryAckRequest {
            attempt_id: str_at(&ack, "attempt_id"),
            receipt_id: str_at(&ack, "receipt_id"),
            worker: str_at(&ack, "worker"),
            instance_id: str_at(&ack, "instance_id"),
            generation: i64_at(&ack, "generation"),
            task_revision: i64_at(&ack, "task_revision"),
        },
        DeliveryAckRequest {
            attempt_id: str_at(&ack, "attempt_id"),
            receipt_id: str_at(&ack, "receipt_id"),
            worker: str_at(&ack, "worker"),
            instance_id: str_at(&ack, "instance_id"),
            generation: i64_at(&ack, "generation"),
            task_revision: i64_at(&ack, "task_revision"),
        },
    );

    let start = exchange("execution_start")["request"].clone();
    assert_request_parity(
        "execution_start",
        frozen::ExecutionStartRequest {
            task_id: str_at(&start, "task_id"),
            worker: str_at(&start, "worker"),
            instance_id: str_at(&start, "instance_id"),
            generation: i64_at(&start, "generation"),
            expected_revision: i64_at(&start, "expected_revision"),
        },
        ExecutionStartRequest {
            task_id: str_at(&start, "task_id"),
            worker: str_at(&start, "worker"),
            instance_id: str_at(&start, "instance_id"),
            generation: i64_at(&start, "generation"),
            expected_revision: i64_at(&start, "expected_revision"),
        },
    );

    let execution_heartbeat = exchange("execution_heartbeat")["request"].clone();
    assert_request_parity(
        "execution_heartbeat",
        frozen::ExecutionHeartbeatRequest {
            attempt_id: str_at(&execution_heartbeat, "attempt_id"),
            worker: str_at(&execution_heartbeat, "worker"),
            instance_id: str_at(&execution_heartbeat, "instance_id"),
            generation: i64_at(&execution_heartbeat, "generation"),
            task_revision: i64_at(&execution_heartbeat, "task_revision"),
        },
        ExecutionHeartbeatRequest {
            attempt_id: str_at(&execution_heartbeat, "attempt_id"),
            worker: str_at(&execution_heartbeat, "worker"),
            instance_id: str_at(&execution_heartbeat, "instance_id"),
            generation: i64_at(&execution_heartbeat, "generation"),
            task_revision: i64_at(&execution_heartbeat, "task_revision"),
        },
    );

    // Settle: the PR number is a number, an explicit null, or absent.
    for (name, review_pr_number) in [
        ("execution_settle_review_with_pr", Some(Some(1740))),
        ("execution_settle_review_without_pr", Some(None)),
        ("execution_settle_blocked", None),
        ("execution_settle_fenced", None),
    ] {
        let settle = exchange(name)["request"].clone();
        let reason = settle["reason"].as_str();
        assert_request_parity(
            name,
            frozen::ExecutionSettleRequest {
                attempt_id: str_at(&settle, "attempt_id"),
                worker: str_at(&settle, "worker"),
                instance_id: str_at(&settle, "instance_id"),
                generation: i64_at(&settle, "generation"),
                task_revision: i64_at(&settle, "task_revision"),
                outcome: str_at(&settle, "outcome"),
                to_status: str_at(&settle, "to_status"),
                reason,
                cost_microusd: None,
                review_pr_number,
            },
            ExecutionSettleRequest {
                attempt_id: str_at(&settle, "attempt_id"),
                worker: str_at(&settle, "worker"),
                instance_id: str_at(&settle, "instance_id"),
                generation: i64_at(&settle, "generation"),
                task_revision: i64_at(&settle, "task_revision"),
                outcome: str_at(&settle, "outcome"),
                to_status: str_at(&settle, "to_status"),
                reason,
                cost_microusd: None,
                review_pr_number,
            },
        );
    }
}

#[test]
fn the_claim_request_and_routing_snapshot_request_are_unchanged_since_main() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/amux-claim-request-rust-v1.json"
    ))
    .unwrap();
    let signals = fixture["decision"]["signals"].clone();
    let frozen_claim = serde_json::to_value(frozen::ClaimRequest {
        task_id: "TASK-1",
        worker: "codex-a",
        expected_revision: 1,
        decision: frozen::ClaimDecision {
            scheduler_score: 32,
            scoring_version: "amux-global-priority-v1".to_owned(),
            signals,
        },
    })
    .unwrap();
    assert_eq!(frozen_claim, fixture);

    let frozen_routing = serde_json::to_value(frozen::RoutingSnapshotRequest {
        task_id: "TASK-1",
        expected_revision: 1,
    })
    .unwrap();
    let current_routing = serde_json::to_value(RoutingSnapshotRequest {
        task_id: "TASK-1",
        expected_revision: 1,
    })
    .unwrap();
    assert_eq!(frozen_routing, current_routing);
}

#[test]
fn main_structs_parse_every_lifecycle_response_the_server_sends() {
    let register: frozen::WorkerRegisterResponse =
        serde_json::from_value(response("worker_register")).unwrap();
    assert!(register.registered);
    assert_eq!(register.generation, Some(3));
    let refused: frozen::WorkerRegisterResponse =
        serde_json::from_value(response("worker_register_unconfigured")).unwrap();
    assert!(!refused.registered);

    let heartbeat: frozen::WorkerHeartbeatResponse =
        serde_json::from_value(response("worker_heartbeat")).unwrap();
    assert!(heartbeat.accepted);

    let pull: frozen::DeliveryPullResponse =
        serde_json::from_value(response("delivery_pull")).unwrap();
    assert!(pull.available);
    assert_eq!(pull.delivery.unwrap().task_revision, 3);

    let ack: frozen::DeliveryAckResponse =
        serde_json::from_value(response("delivery_ack")).unwrap();
    assert!(ack.acknowledged);

    let start: frozen::ExecutionStartResponse =
        serde_json::from_value(response("execution_start")).unwrap();
    assert!(start.started);
    assert_eq!(start.task_revision, Some(3));

    let execution_heartbeat: frozen::ExecutionHeartbeatResponse =
        serde_json::from_value(response("execution_heartbeat")).unwrap();
    assert!(execution_heartbeat.accepted);

    for name in [
        "execution_settle_review_with_pr",
        "execution_settle_review_without_pr",
        "execution_settle_blocked",
    ] {
        let settled: frozen::ExecutionSettleResponse =
            serde_json::from_value(response(name)).unwrap();
        assert!(settled.settled, "{name}");
        assert_eq!(settled.task_revision, Some(4), "{name}");
    }
    let fenced: frozen::ExecutionSettleResponse =
        serde_json::from_value(response("execution_settle_fenced")).unwrap();
    assert!(!fenced.settled);
    assert_eq!(fenced.reason.as_deref(), Some("fenced_out"));
}

#[test]
fn current_structs_parse_every_lifecycle_response_the_server_sends() {
    serde_json::from_value::<WorkerRegisterResponse>(response("worker_register")).unwrap();
    serde_json::from_value::<WorkerRegisterResponse>(response("worker_register_unconfigured"))
        .unwrap();
    serde_json::from_value::<WorkerHeartbeatResponse>(response("worker_heartbeat")).unwrap();
    serde_json::from_value::<DeliveryPullResponse>(response("delivery_pull")).unwrap();
    serde_json::from_value::<DeliveryAckResponse>(response("delivery_ack")).unwrap();
    serde_json::from_value::<ExecutionStartResponse>(response("execution_start")).unwrap();
    serde_json::from_value::<ExecutionHeartbeatResponse>(response("execution_heartbeat"))
        .unwrap();
    for name in [
        "execution_settle_review_with_pr",
        "execution_settle_review_without_pr",
        "execution_settle_blocked",
        "execution_settle_fenced",
    ] {
        serde_json::from_value::<ExecutionSettleResponse>(response(name))
            .unwrap_or_else(|error| panic!("{name}: {error}"));
    }
}

#[test]
fn main_and_current_structs_parse_every_claim_response_the_server_sends() {
    for entry in wire()["claim_responses"].as_array().unwrap() {
        let body = entry["response"].clone();
        let frozen: frozen::ClaimResponse = serde_json::from_value(body.clone()).unwrap();
        let status = reqwest::StatusCode::from_u16(entry["status"].as_u64().unwrap() as u16).unwrap();
        let current =
            parse_claim_response_body(status, &serde_json::to_vec(&body).unwrap()).unwrap();
        match current {
            ClaimResponse::Claimed { revision, .. } => {
                assert!(frozen.claimed);
                assert_eq!(frozen.revision, Some(revision));
            }
            ClaimResponse::CasLost => {
                assert!(!frozen.claimed);
                assert!(frozen.reason.is_none());
            }
            ClaimResponse::Refused { .. } => {
                assert!(!frozen.claimed);
                assert!(frozen.reason.is_some());
            }
        }
    }
}

#[test]
fn main_structs_parse_the_queue_owned_queue_and_routing_bodies_the_server_sends() {
    let queue: frozen::QueueTask = serde_json::from_value(queue_wire("queue_server")).unwrap();
    assert_eq!(queue.title, "Fix the window");
    assert_eq!(queue.status, "todo");
    assert_eq!(queue.owner, None);
    assert_eq!(queue.dependencies, vec!["TASK-0".to_owned()]);
    assert_eq!(queue.scheduler_signals.type_weight, 12);
    // The minimal shape is what a later server may send; main's Rust cannot
    // read it, which is why the server keeps the full shape for now.
    assert!(serde_json::from_value::<frozen::QueueTask>(queue_wire("queue_minimal")).is_err());

    let owned: frozen::OwnedTodoTask = serde_json::from_value(queue_wire("owned_server")).unwrap();
    assert_eq!(owned.owner, "claude-impl");
    assert!(serde_json::from_value::<frozen::OwnedTodoTask>(queue_wire("owned_minimal")).is_err());

    for name in ["eligible", "refusal"] {
        let snapshot: frozen::RoutingSnapshotResponse =
            serde_json::from_value(routing_wire(name)).unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(snapshot.eligible, name == "eligible");
    }
}
