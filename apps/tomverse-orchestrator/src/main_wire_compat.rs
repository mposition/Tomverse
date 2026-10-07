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

// Two serde facts about the frozen structs that the compatibility argument
// rests on, pinned here because a review read them the other way:
//
// 1. A missing key for an `Option<T>` field is `None`. serde derive treats an
//    absent `Option` field as `None` without `#[serde(default)]`, so main's
//    Rust parses the reason-less success bodies and the field-less refusal
//    bodies the server sends. Production parses them today.
// 2. main 7724fd683 has no `#[serde(deny_unknown_fields)]` on any API struct:
//    `git grep deny_unknown_fields 7724fd683 -- apps/tomverse-orchestrator/src`
//    finds it only in executor.rs (the local lane configuration), never in
//    tomverse_api.rs, scheduler.rs or worker.rs. So main's Rust ignores keys it
//    does not know, such as the routing snapshot's `telemetry` and
//    `scheduler_signals.total`. The frozen copies above carry no
//    `deny_unknown_fields` either, because the originals have none.

fn wire() -> Value {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/amux-main-rust-wire-v1.json"
    ))
    .unwrap()
}

fn exchanges() -> Vec<Value> {
    wire()["exchanges"].as_array().unwrap().clone()
}

fn exchange(name: &str) -> Value {
    exchanges()
        .into_iter()
        .find(|entry| entry["name"] == name)
        .unwrap_or_else(|| panic!("fixture exchange {name}"))
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

fn response(name: &str) -> Value {
    exchange(name)["response"].clone()
}

/// The keys the server leaves out of this body. Each must be absent, so a
/// parse of it proves the missing-key behaviour and not a present `null`.
fn assert_absent(body: &Value, keys: &[&str], name: &str) {
    let object = body.as_object().unwrap_or_else(|| panic!("{name} is an object"));
    for key in keys {
        assert!(!object.contains_key(*key), "{name} must omit {key}");
    }
}

/// Serializes the fixture request with the frozen struct and the current one;
/// both must equal the body the server accepted.
fn assert_request_parity<A: serde::Serialize, B: serde::Serialize>(name: &str, frozen: A, current: B) {
    let expected = exchange(name)["request"].clone();
    assert_eq!(serde_json::to_value(frozen).unwrap(), expected, "frozen {name}");
    assert_eq!(serde_json::to_value(current).unwrap(), expected, "current {name}");
}

#[test]
fn every_request_body_is_what_main_and_this_tree_serialize() {
    for entry in exchanges() {
        let name = str_at(&entry, "name").to_owned();
        let request = entry["request"].clone();
        match str_at(&entry, "path") {
            "workers/register" => assert_request_parity(
                &name,
                frozen::WorkerRegisterRequest {
                    worker_name: str_at(&request, "worker_name"),
                    instance_id: str_at(&request, "instance_id"),
                },
                WorkerRegisterRequest {
                    worker_name: str_at(&request, "worker_name"),
                    instance_id: str_at(&request, "instance_id"),
                },
            ),
            "workers/heartbeat" => assert_request_parity(
                &name,
                frozen::WorkerHeartbeatRequest {
                    worker_name: str_at(&request, "worker_name"),
                    instance_id: str_at(&request, "instance_id"),
                    generation: i64_at(&request, "generation"),
                    status: str_at(&request, "status"),
                    dispatch_ready: request["dispatch_ready"].as_bool().unwrap(),
                },
                WorkerHeartbeatRequest {
                    worker_name: str_at(&request, "worker_name"),
                    instance_id: str_at(&request, "instance_id"),
                    generation: i64_at(&request, "generation"),
                    status: str_at(&request, "status"),
                    dispatch_ready: request["dispatch_ready"].as_bool().unwrap(),
                },
            ),
            "delivery/pull" => assert_request_parity(
                &name,
                frozen::DeliveryPullRequest {
                    worker: str_at(&request, "worker"),
                    instance_id: str_at(&request, "instance_id"),
                    generation: i64_at(&request, "generation"),
                },
                DeliveryPullRequest {
                    worker: str_at(&request, "worker"),
                    instance_id: str_at(&request, "instance_id"),
                    generation: i64_at(&request, "generation"),
                },
            ),
            "delivery/ack" => assert_request_parity(
                &name,
                frozen::DeliveryAckRequest {
                    attempt_id: str_at(&request, "attempt_id"),
                    receipt_id: str_at(&request, "receipt_id"),
                    worker: str_at(&request, "worker"),
                    instance_id: str_at(&request, "instance_id"),
                    generation: i64_at(&request, "generation"),
                    task_revision: i64_at(&request, "task_revision"),
                },
                DeliveryAckRequest {
                    attempt_id: str_at(&request, "attempt_id"),
                    receipt_id: str_at(&request, "receipt_id"),
                    worker: str_at(&request, "worker"),
                    instance_id: str_at(&request, "instance_id"),
                    generation: i64_at(&request, "generation"),
                    task_revision: i64_at(&request, "task_revision"),
                },
            ),
            "execution/start" => assert_request_parity(
                &name,
                frozen::ExecutionStartRequest {
                    task_id: str_at(&request, "task_id"),
                    worker: str_at(&request, "worker"),
                    instance_id: str_at(&request, "instance_id"),
                    generation: i64_at(&request, "generation"),
                    expected_revision: i64_at(&request, "expected_revision"),
                },
                ExecutionStartRequest {
                    task_id: str_at(&request, "task_id"),
                    worker: str_at(&request, "worker"),
                    instance_id: str_at(&request, "instance_id"),
                    generation: i64_at(&request, "generation"),
                    expected_revision: i64_at(&request, "expected_revision"),
                    assignment_id: None,
                },
            ),
            "execution/heartbeat" => assert_request_parity(
                &name,
                frozen::ExecutionHeartbeatRequest {
                    attempt_id: str_at(&request, "attempt_id"),
                    worker: str_at(&request, "worker"),
                    instance_id: str_at(&request, "instance_id"),
                    generation: i64_at(&request, "generation"),
                    task_revision: i64_at(&request, "task_revision"),
                },
                ExecutionHeartbeatRequest {
                    attempt_id: str_at(&request, "attempt_id"),
                    worker: str_at(&request, "worker"),
                    instance_id: str_at(&request, "instance_id"),
                    generation: i64_at(&request, "generation"),
                    task_revision: i64_at(&request, "task_revision"),
                },
            ),
            "execution/settle" => {
                // The PR number is a number, an explicit null, or absent.
                let review_pr_number = match request.get("review_pr_number") {
                    None => None,
                    Some(Value::Null) => Some(None),
                    Some(value) => Some(Some(value.as_i64().unwrap())),
                };
                let reason = request["reason"].as_str();
                assert_request_parity(
                    &name,
                    frozen::ExecutionSettleRequest {
                        attempt_id: str_at(&request, "attempt_id"),
                        worker: str_at(&request, "worker"),
                        instance_id: str_at(&request, "instance_id"),
                        generation: i64_at(&request, "generation"),
                        task_revision: i64_at(&request, "task_revision"),
                        outcome: str_at(&request, "outcome"),
                        to_status: str_at(&request, "to_status"),
                        reason,
                        cost_microusd: None,
                        review_pr_number,
                    },
                    ExecutionSettleRequest {
                        attempt_id: str_at(&request, "attempt_id"),
                        worker: str_at(&request, "worker"),
                        instance_id: str_at(&request, "instance_id"),
                        generation: i64_at(&request, "generation"),
                        task_revision: i64_at(&request, "task_revision"),
                        outcome: str_at(&request, "outcome"),
                        to_status: str_at(&request, "to_status"),
                        reason,
                        cost_microusd: None,
                        review_pr_number,
                    },
                );
            }
            other => panic!("no request parity for {other}"),
        }
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
fn mains_structs_read_every_key_the_server_omits_as_none() {
    // Fact 1. Each body is exactly what the route sends
    // (tests/server-contract/amux-main-rust-wire-parity.test.ts requires the
    // real routes to answer these bytes), and each listed key is absent.

    // Claim: success without reason; lost CAS without revision, decision_id or
    // reason; refusal without revision or decision_id.
    for entry in wire()["claim_responses"].as_array().unwrap() {
        let body = entry["response"].clone();
        let claim: frozen::ClaimResponse = serde_json::from_value(body.clone()).unwrap();
        if claim.claimed {
            assert_absent(&body, &["reason"], "claim success");
            assert!(claim.revision.is_some() && claim.decision_id.is_some());
            assert!(claim.reason.is_none());
        } else if body.get("reason").is_some() {
            assert_absent(&body, &["revision", "decision_id"], "claim refusal");
            assert!(claim.revision.is_none() && claim.decision_id.is_none());
            assert!(claim.reason.is_some());
        } else {
            assert_absent(&body, &["revision", "decision_id", "reason"], "lost claim");
            assert!(claim.revision.is_none() && claim.decision_id.is_none());
            assert!(claim.reason.is_none());
        }
    }

    let body = response("worker_register");
    assert_absent(&body, &["reason"], "worker_register");
    let register: frozen::WorkerRegisterResponse = serde_json::from_value(body).unwrap();
    assert!(register.registered && register.reason.is_none());
    let body = response("worker_register_unconfigured");
    assert_absent(&body, &["generation", "lease_expires_at"], "worker_register_unconfigured");
    let register: frozen::WorkerRegisterResponse = serde_json::from_value(body).unwrap();
    assert!(!register.registered);
    assert!(register.generation.is_none() && register.lease_expires_at.is_none());

    let body = response("worker_heartbeat");
    assert_absent(&body, &["reason"], "worker_heartbeat");
    let heartbeat: frozen::WorkerHeartbeatResponse = serde_json::from_value(body).unwrap();
    assert!(heartbeat.accepted && heartbeat.reason.is_none());
    let body = response("worker_heartbeat_active_execution");
    assert_absent(&body, &["lease_expires_at"], "worker_heartbeat_active_execution");
    let heartbeat: frozen::WorkerHeartbeatResponse = serde_json::from_value(body).unwrap();
    assert!(!heartbeat.accepted && heartbeat.lease_expires_at.is_none());
    assert_eq!(heartbeat.reason.as_deref(), Some("active_execution"));

    let body = response("delivery_pull");
    assert_absent(&body, &["reason"], "delivery_pull");
    let pull: frozen::DeliveryPullResponse = serde_json::from_value(body).unwrap();
    assert!(pull.available && pull.delivery.is_some() && pull.reason.is_none());
    let body = response("delivery_pull_none");
    assert_absent(&body, &["delivery"], "delivery_pull_none");
    let pull: frozen::DeliveryPullResponse = serde_json::from_value(body).unwrap();
    assert!(!pull.available && pull.delivery.is_none());

    let body = response("delivery_ack");
    assert_absent(&body, &["reason"], "delivery_ack");
    let ack: frozen::DeliveryAckResponse = serde_json::from_value(body).unwrap();
    assert!(ack.acknowledged && ack.reason.is_none());
    let body = response("delivery_ack_fenced");
    assert_absent(&body, &["idempotent"], "delivery_ack_fenced");
    let ack: frozen::DeliveryAckResponse = serde_json::from_value(body).unwrap();
    assert!(!ack.acknowledged && ack.idempotent.is_none());

    let body = response("execution_start");
    assert_absent(&body, &["reason"], "execution_start");
    let start: frozen::ExecutionStartResponse = serde_json::from_value(body).unwrap();
    assert!(start.started && start.reason.is_none());
    let body = response("execution_start_refused");
    assert_absent(
        &body,
        &["attempt_id", "task_revision", "lease_expires_at"],
        "execution_start_refused",
    );
    let start: frozen::ExecutionStartResponse = serde_json::from_value(body).unwrap();
    assert!(!start.started);
    assert!(start.attempt_id.is_none() && start.task_revision.is_none());
    assert!(start.lease_expires_at.is_none());

    let body = response("execution_heartbeat");
    assert_absent(&body, &["reason"], "execution_heartbeat");
    let heartbeat: frozen::ExecutionHeartbeatResponse = serde_json::from_value(body).unwrap();
    assert!(heartbeat.accepted && heartbeat.reason.is_none());

    let body = response("execution_settle_fenced");
    assert_absent(&body, &["taskRevision"], "execution_settle_fenced");
    let settle: frozen::ExecutionSettleResponse = serde_json::from_value(body).unwrap();
    assert!(!settle.settled && settle.task_revision.is_none());
}

#[test]
fn mains_structs_ignore_keys_they_do_not_know() {
    // Fact 2. The routing snapshot carries `telemetry`, which main's struct
    // does not declare.
    for name in ["eligible", "refusal"] {
        let body = routing_wire(name);
        assert!(body.get("telemetry").is_some(), "{name} carries telemetry");
        let snapshot: frozen::RoutingSnapshotResponse = serde_json::from_value(body)
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(snapshot.eligible, name == "eligible");
    }

    // The queue's scheduler_signals carries `total`, which main's
    // ScoreBreakdown does not declare.
    for name in ["queue_main", "queue_server"] {
        let body = queue_wire(name);
        assert_eq!(body["scheduler_signals"]["total"], 32, "{name} carries total");
        let queue: frozen::QueueTask = serde_json::from_value(body).unwrap();
        assert_eq!(queue.scheduler_signals.type_weight, 12, "{name}");
        assert_eq!(queue.scheduler_signals.priority_weight, 20, "{name}");
    }

    // And any key at all, on every response the server sends.
    for entry in exchanges() {
        let name = str_at(&entry, "name").to_owned();
        let mut body = entry["response"].clone();
        body["future_field"] = serde_json::json!(true);
        let parsed = match str_at(&entry, "path") {
            "workers/register" => serde_json::from_value::<frozen::WorkerRegisterResponse>(body).map(|_| ()),
            "workers/heartbeat" => serde_json::from_value::<frozen::WorkerHeartbeatResponse>(body).map(|_| ()),
            "delivery/pull" => serde_json::from_value::<frozen::DeliveryPullResponse>(body).map(|_| ()),
            "delivery/ack" => serde_json::from_value::<frozen::DeliveryAckResponse>(body).map(|_| ()),
            "execution/start" => serde_json::from_value::<frozen::ExecutionStartResponse>(body).map(|_| ()),
            "execution/heartbeat" => serde_json::from_value::<frozen::ExecutionHeartbeatResponse>(body).map(|_| ()),
            "execution/settle" => serde_json::from_value::<frozen::ExecutionSettleResponse>(body).map(|_| ()),
            other => panic!("no response struct for {other}"),
        };
        parsed.unwrap_or_else(|error| panic!("{name}: {error}"));
    }
    for entry in wire()["claim_responses"].as_array().unwrap() {
        let mut body = entry["response"].clone();
        body["future_field"] = serde_json::json!(true);
        serde_json::from_value::<frozen::ClaimResponse>(body).unwrap();
    }
}

#[test]
fn current_structs_parse_every_lifecycle_response_the_server_sends() {
    for entry in exchanges() {
        let name = str_at(&entry, "name").to_owned();
        let body = entry["response"].clone();
        let parsed = match str_at(&entry, "path") {
            "workers/register" => serde_json::from_value::<WorkerRegisterResponse>(body).map(|_| ()),
            "workers/heartbeat" => serde_json::from_value::<WorkerHeartbeatResponse>(body).map(|_| ()),
            "delivery/pull" => serde_json::from_value::<DeliveryPullResponse>(body).map(|_| ()),
            "delivery/ack" => serde_json::from_value::<DeliveryAckResponse>(body).map(|_| ()),
            "execution/start" => serde_json::from_value::<ExecutionStartResponse>(body).map(|_| ()),
            "execution/heartbeat" => serde_json::from_value::<ExecutionHeartbeatResponse>(body).map(|_| ()),
            "execution/settle" => serde_json::from_value::<ExecutionSettleResponse>(body).map(|_| ()),
            other => panic!("no response struct for {other}"),
        };
        parsed.unwrap_or_else(|error| panic!("{name}: {error}"));
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
    // The server sends *_server; *_main is what main's server sent. Both parse.
    for name in ["queue_main", "queue_server"] {
        let queue: frozen::QueueTask = serde_json::from_value(queue_wire(name)).unwrap();
        assert_eq!(queue.title, "Fix the window", "{name}");
        assert_eq!(queue.status, "todo", "{name}");
        assert_eq!(queue.owner, None, "{name}");
        assert_eq!(queue.dependencies, vec!["TASK-0".to_owned()], "{name}");
    }
    assert_absent(&queue_wire("queue_server"), &["owner"], "queue_server");
    // The minimal shape is what a later server may send; main's Rust cannot
    // read it, which is why the server keeps the required fields for now.
    assert!(serde_json::from_value::<frozen::QueueTask>(queue_wire("queue_minimal")).is_err());

    for name in ["owned_main", "owned_server"] {
        let owned: frozen::OwnedTodoTask = serde_json::from_value(queue_wire(name)).unwrap();
        assert_eq!(owned.owner, "claude-impl", "{name}");
        assert_eq!(owned.kind, "code", "{name}");
    }
    let server: frozen::OwnedTodoTask = serde_json::from_value(queue_wire("owned_server")).unwrap();
    assert_absent(&queue_wire("owned_server"), &["description", "claimed_at"], "owned_server");
    assert!(server.description.is_none() && server.claimed_at.is_none());
    assert!(serde_json::from_value::<frozen::OwnedTodoTask>(queue_wire("owned_minimal")).is_err());

    for name in ["eligible", "refusal"] {
        let snapshot: frozen::RoutingSnapshotResponse =
            serde_json::from_value(routing_wire(name)).unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(snapshot.eligible, name == "eligible");
    }
}
