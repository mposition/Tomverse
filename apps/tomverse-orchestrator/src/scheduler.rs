use std::time::Duration;

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use tracing::{info, warn};

use crate::tomverse_api::{ClaimResponse, QueueTask, TomverseApi};

const SCORING_VERSION: &str = "amux-global-priority-v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SchedulerDisposition {
    Continue,
    Dormant,
}

fn claim_verdict(outcome: &ClaimResponse) -> &'static str {
    match outcome {
        ClaimResponse::Claimed { .. } => "claimed",
        ClaimResponse::CasLost => "claim_lost",
        ClaimResponse::Refused { reason } => reason.as_str(),
    }
}

fn claim_disposition(outcome: &ClaimResponse) -> SchedulerDisposition {
    match outcome {
        ClaimResponse::Claimed { .. } => SchedulerDisposition::Continue,
        ClaimResponse::CasLost | ClaimResponse::Refused { .. } => SchedulerDisposition::Dormant,
    }
}

fn claim_result_disposition(outcome: &Result<ClaimResponse>) -> SchedulerDisposition {
    match outcome {
        Ok(outcome) => claim_disposition(outcome),
        Err(_) => SchedulerDisposition::Dormant,
    }
}

pub fn execution_enabled() -> bool {
    std::env::var("TOMVERSE_AMUX_EXECUTE")
        .ok()
        .is_some_and(|value| value.trim() == "1")
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ScoreBreakdown {
    pub pin: i64,
    pub age_hours: i64,
    pub type_weight: i64,
    pub priority_weight: i64,
    pub dependents: i64,
    pub dependent_weight: i64,
    pub drag: i64,
}

impl ScoreBreakdown {
    fn total(&self) -> i64 {
        self.pin
            + self.age_hours
            + self.type_weight
            + self.priority_weight
            + self.dependent_weight
            + self.drag
    }
}

pub struct Scheduler {
    api: TomverseApi,
    execution_enabled: bool,
}

impl Scheduler {
    pub fn new(api: TomverseApi) -> Self {
        Self {
            api,
            execution_enabled: execution_enabled(),
        }
    }

    #[cfg(test)]
    fn for_test(api: TomverseApi, execution_enabled: bool) -> Self {
        Self {
            api,
            execution_enabled,
        }
    }

    pub async fn run(self) -> Result<()> {
        loop {
            match self.tick().await {
                Ok(SchedulerDisposition::Continue) => {}
                Ok(SchedulerDisposition::Dormant) => {
                    warn!(
                        measured = true,
                        verdict = "dormant_until_process_restart",
                        "Tomverse AMUX scheduler stopped at a terminal claim containment boundary"
                    );

                    return Ok(());
                }
                Err(_) => {
                    warn!(
                        incident_id = %uuid::Uuid::new_v4(),
                        endpoint = "internal_api",
                        error_code = "AMUX_INTERNAL_API_UNVERIFIED",
                        measured = false,
                        verdict = "internal_api_outcome_unknown_dormant",
                        "scheduler stopped after a bounded internal API failure"
                    );

                    // `main` joins the scheduler and runtime with try_join!.
                    // An Ok here would leave the board loop running after an
                    // unverified claim, so propagate a terminal error and
                    // cancel every sibling loop in this process.
                    return Err(anyhow::anyhow!("AMUX_INTERNAL_API_UNVERIFIED"));
                }
            }

            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    }

    async fn tick(&self) -> Result<SchedulerDisposition> {
        let queue = self.api.queue().await?;

        let Some((task, score)) = select_global_priority(queue) else {
            return Ok(SchedulerDisposition::Continue);
        };

        info!(
            task_id = %task.id,
            priority = %task.priority,
            kind = %task.kind,
            dependent_count = task.dependent_count,
            scheduler_score = score.total(),
            scoring_version = SCORING_VERSION,
            "global priority scheduler selected task"
        );

        // Selection and execution are deliberately separate.
        if !self.execution_enabled {
            info!(
                task_id = %task.id,
                measured = true,
                verdict = "selection_only",
                "Tomverse AMUX execution disabled; task was not claimed"
            );
            return Ok(SchedulerDisposition::Continue);
        }

        let snapshot = self.api.routing_snapshot(&task.id, task.revision).await?;

        if !snapshot.eligible {
            warn!(
                task_id = %task.id,
                reason = ?snapshot.reason,
                measured = false,
                verdict = "worker_routing_unavailable",
                "Tomverse AMUX refused claim because worker routing facts were unavailable"
            );
            return Ok(SchedulerDisposition::Continue);
        }

        let Some(profile) = snapshot.task else {
            warn!(
                task_id = %task.id,
                measured = false,
                verdict = "invalid_routing_snapshot",
                "Tomverse AMUX routing snapshot was eligible but had no task profile"
            );
            return Ok(SchedulerDisposition::Continue);
        };

        let routing = crate::worker::score_execute_candidates(&profile, &snapshot.candidates);

        let Some(worker) = routing.selected_worker.clone() else {
            warn!(
                task_id = %task.id,
                preferred_worker = ?routing.preferred_worker,
                candidate_count = routing.candidates.len(),
                measured = true,
                verdict = "no_selected_worker",
                "Tomverse AMUX worker router found no eligible worker"
            );
            return Ok(SchedulerDisposition::Continue);
        };

        info!(
            task_id = %task.id,
            preferred_worker = ?routing.preferred_worker,
            selected_worker = %worker,
            preferred_score = ?routing.preferred_score,
            selected_score = ?routing.selected_score,
            candidate_count = routing.candidates.len(),
            measured = true,
            verdict = "selected",
            "Tomverse AMUX worker router selected worker"
        );

        // Worker scoring is measurable before execution lifecycle is complete,
        // but ownership must not be stranded on a worker Tomverse cannot yet
        // start and deliver to.
        if !snapshot.execution_ready {
            warn!(
                task_id = %task.id,
                selected_worker = %worker,
                measured = true,
                verdict = "execution_lifecycle_unavailable",
                "Tomverse AMUX refused ownership claim because execution lifecycle is not ready"
            );
            return Ok(SchedulerDisposition::Continue);
        }

        let signals = serde_json::json!({
            "scheduler": &score,
            "routing": {
                "scoring_version": "amux-worker-router-v1",
                "preferred_worker": &routing.preferred_worker,
                "selected_worker": &routing.selected_worker,
                "preferred_score": routing.preferred_score,
                "selected_score": routing.selected_score,
                "candidates": &routing.candidates,
            }
        });

        let claim_result = self
            .api
            .claim(&task.id, &worker, task.revision, score.total(), signals)
            .await;
        let claim_result_disposition = claim_result_disposition(&claim_result);
        let outcome = match claim_result {
            Ok(outcome) => outcome,
            Err(_) => {
                warn!(
                    task_id = %task.id,
                    task_revision = task.revision,
                    worker = %worker,
                    incident_id = %uuid::Uuid::new_v4(),
                    endpoint = "claim",
                    error_code = "AMUX_CLAIM_OUTCOME_UNKNOWN",
                    measured = false,
                    verdict = "claim_outcome_unknown_dormant",
                    "Tomverse AMUX stopped after an unverified claim outcome"
                );

                return Err(anyhow::anyhow!("AMUX_CLAIM_OUTCOME_UNKNOWN"));
            }
        };

        let verdict = claim_verdict(&outcome);

        if let ClaimResponse::Refused { reason } = &outcome {
            warn!(
                task_id = %task.id,
                worker = %worker,
                reason = reason.as_str(),
                measured = true,
                verdict,
                "Tomverse AMUX scheduler became dormant after a closed claim refusal"
            );
            return Ok(claim_result_disposition);
        }

        let (claimed, revision, decision_id, reason) = match &outcome {
            ClaimResponse::Claimed {
                revision,
                decision_id,
            } => (true, Some(*revision), Some(decision_id.as_str()), None),
            ClaimResponse::CasLost => (false, None, None, None),
            ClaimResponse::Refused { reason } => (false, None, None, Some(reason)),
        };

        info!(
            task_id = %task.id,
            worker = %worker,
            claimed,
            revision = ?revision,
            decision_id = ?decision_id,
            reason = ?reason,
            measured = true,
            verdict,
            "Tomverse task claim result"
        );

        Ok(claim_result_disposition)
    }
}

fn type_weight(kind: &str) -> i64 {
    match kind.trim().to_ascii_lowercase().as_str() {
        "blocker" | "escalation" => 30,
        "bug" => 24,
        "code" | "ops" => 12,
        "investigation" => 6,
        "research" | "chore" | "doc" => 0,
        _ => 6,
    }
}

fn priority_weight(priority: &str) -> i64 {
    match priority.trim().to_ascii_lowercase().as_str() {
        "p0" => 40,
        "p1" => 20,
        "p2" => 10,
        "p3" => 0,
        _ => 0,
    }
}

fn age_hours_at(task: &QueueTask, now: DateTime<Utc>) -> i64 {
    DateTime::parse_from_rfc3339(&task.created_at)
        .ok()
        .map(|created| (now - created.with_timezone(&Utc)).num_hours().max(0))
        .unwrap_or(0)
}

fn score_at(task: &QueueTask, now: DateTime<Utc>) -> ScoreBreakdown {
    let dependents = task.dependent_count.max(0);

    ScoreBreakdown {
        pin: if task.pinned { 10_000 } else { 0 },
        age_hours: age_hours_at(task, now),
        type_weight: type_weight(&task.kind),
        priority_weight: priority_weight(&task.priority),
        dependents,
        dependent_weight: dependents.saturating_mul(5),
        drag: task.drag.clamp(0, 8),
    }
}

fn select_global_priority(tasks: Vec<QueueTask>) -> Option<(QueueTask, ScoreBreakdown)> {
    select_global_priority_at(tasks, Utc::now())
}

fn select_global_priority_at(
    tasks: Vec<QueueTask>,
    now: DateTime<Utc>,
) -> Option<(QueueTask, ScoreBreakdown)> {
    let mut ranked: Vec<_> = tasks
        .into_iter()
        .map(|task| {
            let score = score_at(&task, now);
            (task, score)
        })
        .collect();

    ranked.sort_by(|(a_task, a_score), (b_task, b_score)| {
        b_score
            .total()
            .cmp(&a_score.total())
            .then(a_task.created_at.cmp(&b_task.created_at))
            .then(a_task.id.cmp(&b_task.id))
    });

    ranked.into_iter().next()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tomverse_api::ClaimRefusalReason;
    use chrono::TimeZone;
    use std::{
        io::{ErrorKind, Read, Write},
        net::TcpListener,
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            mpsc, Arc,
        },
        thread,
    };

    const QUEUE_BODY: &str = r#"[{"id":"TASK-1","kind":"code","priority":"p1","pinned":false,"drag":0,"revision":1,"created_at":"2026-09-20T12:00:00Z","dependent_count":0}]"#;
    const ROUTING_BODY: &str = r#"{"eligible":true,"execution_ready":true,"reason":null,"task":{"task_kind":"feature","complexity":5,"risk":1,"files_expected":1},"candidates":[{"worker":{"worker_name":"codex-test","provider":"codex","model":null,"routing_roles":["feature"],"running":false,"status":"stopped","dispatch_ready":false,"archived":false,"paused":false,"isolated":false,"blocked":false},"predicted_success":1.0,"quota_remaining":1.0,"expected_speed":1.0,"low_rework":1.0,"low_human_attention":1.0,"cost_efficiency":1.0,"provider_exhausted":false}]}"#;

    enum SlowStage {
        Queue,
        Routing,
        Claim,
    }

    enum ServerMode {
        ClaimResponse { status: String, body: String },
        CommitThenDropClaim,
        QueueResponse { status: String, body: String },
        Stall(SlowStage),
        TrickleClaim,
    }

    struct DoneOnDrop(Option<mpsc::Sender<()>>);

    impl Drop for DoneOnDrop {
        fn drop(&mut self) {
            if let Some(done) = self.0.take() {
                let _ = done.send(());
            }
        }
    }

    struct SchedulerTestServer {
        api: TomverseApi,
        claim_requests: Arc<AtomicUsize>,
        committed_claims: Arc<AtomicUsize>,
        requests: Arc<AtomicUsize>,
        stop: Arc<AtomicBool>,
        done: mpsc::Receiver<()>,
        handle: Option<thread::JoinHandle<()>>,
    }

    impl SchedulerTestServer {
        fn spawn(mode: ServerMode) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let address = listener.local_addr().unwrap();
            let claim_requests = Arc::new(AtomicUsize::new(0));
            let committed_claims = Arc::new(AtomicUsize::new(0));
            let requests = Arc::new(AtomicUsize::new(0));
            let stop = Arc::new(AtomicBool::new(false));
            let (done_tx, done) = mpsc::channel();
            let server_claim_requests = Arc::clone(&claim_requests);
            let server_committed_claims = Arc::clone(&committed_claims);
            let server_requests = Arc::clone(&requests);
            let server_stop = Arc::clone(&stop);

            let handle = thread::spawn(move || {
                let _done = DoneOnDrop(Some(done_tx));

                while !server_stop.load(Ordering::SeqCst) {
                    let (mut stream, _) = match listener.accept() {
                        Ok(connection) => connection,
                        Err(error) if error.kind() == ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(5));
                            continue;
                        }
                        Err(error) => panic!("scheduler test server accept failed: {error}"),
                    };

                    stream
                        .set_read_timeout(Some(Duration::from_millis(200)))
                        .unwrap();
                    stream
                        .set_write_timeout(Some(Duration::from_millis(200)))
                        .unwrap();

                    let mut request = [0_u8; 16 * 1024];
                    let read = match stream.read(&mut request) {
                        Ok(read) => read,
                        Err(error)
                            if matches!(
                                error.kind(),
                                ErrorKind::WouldBlock | ErrorKind::TimedOut
                            ) =>
                        {
                            continue;
                        }
                        Err(error) => panic!("scheduler test request read failed: {error}"),
                    };
                    server_requests.fetch_add(1, Ordering::SeqCst);
                    let request = String::from_utf8_lossy(&request[..read]);
                    let request_line = request.lines().next().unwrap_or_default();

                    let stage = if request_line.contains("/api/internal/amux/queue") {
                        SlowStage::Queue
                    } else if request_line.contains("/api/internal/amux/routing-snapshot") {
                        SlowStage::Routing
                    } else if request_line.contains("/api/internal/amux/claim") {
                        server_claim_requests.fetch_add(1, Ordering::SeqCst);
                        SlowStage::Claim
                    } else {
                        panic!("unexpected scheduler request: {request_line}");
                    };

                    let should_stall = matches!(
                        (&mode, &stage),
                        (ServerMode::Stall(SlowStage::Queue), SlowStage::Queue)
                            | (ServerMode::Stall(SlowStage::Routing), SlowStage::Routing)
                            | (ServerMode::Stall(SlowStage::Claim), SlowStage::Claim)
                    );
                    if matches!(
                        (&mode, &stage),
                        (ServerMode::CommitThenDropClaim, SlowStage::Claim)
                    ) {
                        // The mock persisted the claim but lost the HTTP
                        // response before the scheduler could confirm it.
                        server_committed_claims.fetch_add(1, Ordering::SeqCst);
                        continue;
                    }
                    if should_stall {
                        while !server_stop.load(Ordering::SeqCst) {
                            thread::sleep(Duration::from_millis(5));
                        }
                        continue;
                    }

                    if matches!(
                        (&mode, &stage),
                        (ServerMode::TrickleClaim, SlowStage::Claim)
                    ) {
                        let body = br#"{"claimed":false,"reason":"execution_api_disabled"}"#;
                        let _ = write!(
                            stream,
                            "HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
                        );

                        for byte in body {
                            if server_stop.load(Ordering::SeqCst) {
                                break;
                            }
                            if write!(stream, "1\r\n{}\r\n", char::from(*byte)).is_err()
                                || stream.flush().is_err()
                            {
                                break;
                            }
                            thread::sleep(Duration::from_millis(40));
                        }
                        continue;
                    }

                    let (status, body) = match stage {
                        SlowStage::Queue => match &mode {
                            ServerMode::QueueResponse { status, body } => {
                                (status.as_str(), body.as_str())
                            }
                            _ => ("200 OK", QUEUE_BODY),
                        },
                        SlowStage::Routing => ("200 OK", ROUTING_BODY),
                        SlowStage::Claim => match &mode {
                            ServerMode::ClaimResponse { status, body } => {
                                (status.as_str(), body.as_str())
                            }
                            ServerMode::Stall(_)
                            | ServerMode::CommitThenDropClaim
                            | ServerMode::TrickleClaim
                            | ServerMode::QueueResponse { .. } => {
                                panic!("claim mode did not handle the claim response")
                            }
                        },
                    };

                    write!(
                        stream,
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len(),
                    )
                    .unwrap();
                    stream.flush().unwrap();
                }
            });

            let api = TomverseApi::for_test_with_timeouts(
                format!("http://{address}"),
                Duration::from_millis(50),
                Duration::from_millis(200),
            );

            Self {
                api,
                claim_requests,
                committed_claims,
                requests,
                stop,
                done,
                handle: Some(handle),
            }
        }

        fn finish(mut self) {
            self.stop.store(true, Ordering::SeqCst);
            self.done
                .recv_timeout(Duration::from_secs(1))
                .expect("scheduler test server did not stop within one second");
            self.handle
                .take()
                .expect("scheduler test server handle missing")
                .join()
                .expect("scheduler test server panicked");
        }
    }

    fn task(id: &str, kind: &str, priority: &str, created_at: &str) -> QueueTask {
        QueueTask {
            id: id.into(),
            kind: kind.into(),
            priority: priority.into(),
            pinned: false,
            drag: 0,
            revision: 0,
            created_at: created_at.into(),
            dependent_count: 0,
        }
    }

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, 20, 12, 0, 0)
            .single()
            .unwrap()
    }

    async fn assert_scheduler_stops(
        mode: ServerMode,
        expected_claims: usize,
        expected_error: bool,
    ) {
        let server = SchedulerTestServer::spawn(mode);
        let run = tokio::time::timeout(
            Duration::from_secs(1),
            Scheduler::for_test(server.api.clone(), true).run(),
        )
        .await;
        let claim_requests = server.claim_requests.load(Ordering::SeqCst);
        server.finish();

        let outcome = run.expect("scheduler did not stop within the bounded test timeout");
        assert_eq!(outcome.is_err(), expected_error);
        assert_eq!(claim_requests, expected_claims);
    }

    async fn assert_scheduler_stops_after_claim_response(
        status: &str,
        body: &str,
        expected_error: bool,
    ) {
        assert_scheduler_stops(
            ServerMode::ClaimResponse {
                status: status.to_owned(),
                body: body.to_owned(),
            },
            1,
            expected_error,
        )
        .await;
    }

    #[test]
    fn global_priority_has_all_four_explicit_levels() {
        assert_eq!(priority_weight("p0"), 40);
        assert_eq!(priority_weight("p1"), 20);
        assert_eq!(priority_weight("p2"), 10);
        assert_eq!(priority_weight("p3"), 0);
    }

    #[test]
    fn fresh_p0_outranks_a_modestly_older_p3() {
        let tasks = vec![
            task("OLD-P3", "chore", "p3", "2026-09-19T20:00:00Z"),
            task("NEW-P0", "chore", "p0", "2026-09-20T11:00:00Z"),
        ];

        let selected = select_global_priority_at(tasks, now()).unwrap();
        assert_eq!(selected.0.id, "NEW-P0");
    }

    #[test]
    fn age_eventually_prevents_starvation() {
        let tasks = vec![
            task("VERY-OLD-P3", "chore", "p3", "2026-09-17T00:00:00Z"),
            task("NEW-P0", "chore", "p0", "2026-09-20T11:00:00Z"),
        ];

        let selected = select_global_priority_at(tasks, now()).unwrap();
        assert_eq!(selected.0.id, "VERY-OLD-P3");
    }

    #[test]
    fn dependents_can_lift_critical_path_work() {
        let mut critical = task("CRITICAL-PATH", "chore", "p3", "2026-09-20T11:00:00Z");
        critical.dependent_count = 5;

        let ordinary = task("ORDINARY", "code", "p3", "2026-09-20T11:00:00Z");

        let selected = select_global_priority_at(vec![ordinary, critical], now()).unwrap();

        assert_eq!(selected.0.id, "CRITICAL-PATH");
    }

    #[test]
    fn pin_dominates_normal_priority_signals() {
        let mut pinned = task("PINNED", "chore", "p3", "2026-09-20T11:00:00Z");
        pinned.pinned = true;

        let p0 = task("P0", "blocker", "p0", "2026-09-20T11:00:00Z");

        let selected = select_global_priority_at(vec![p0, pinned], now()).unwrap();

        assert_eq!(selected.0.id, "PINNED");
    }

    #[test]
    fn equal_scores_break_by_created_time_then_id() {
        let tasks = vec![
            task("B", "code", "p1", "2026-09-20T10:00:00Z"),
            task("A", "code", "p1", "2026-09-20T10:00:00Z"),
        ];

        let selected = select_global_priority_at(tasks, now()).unwrap();
        assert_eq!(selected.0.id, "A");
    }

    #[test]
    fn claim_kill_switch_refusal_is_not_a_generic_claim_loss() {
        let outcome = ClaimResponse::Refused {
            reason: ClaimRefusalReason::ExecutionApiDisabled,
        };

        assert_eq!(claim_verdict(&outcome), "execution_api_disabled");
    }

    #[tokio::test]
    async fn scheduler_run_stops_after_one_claim_for_every_closed_refusal() {
        for reason in ClaimRefusalReason::CLOSED {
            assert_scheduler_stops_after_claim_response(
                "409 Conflict",
                &format!(r#"{{"claimed":false,"reason":"{}"}}"#, reason.as_str(),),
                false,
            )
            .await;
        }
    }

    #[tokio::test]
    async fn contradictory_claim_responses_are_dormant_with_zero_retries() {
        let invalid = [
            (
                "200 OK",
                r#"{"claimed":true,"revision":4,"decision_id":"decision-1","reason":"execution_api_disabled"}"#,
            ),
            (
                "409 Conflict",
                r#"{"claimed":true,"revision":4,"decision_id":"decision-1","reason":"execution_api_disabled"}"#,
            ),
            ("409 Conflict", r#"{"claimed":false}"#),
            (
                "200 OK",
                r#"{"claimed":false,"reason":"execution_api_disabled"}"#,
            ),
            ("200 OK", r#"{"claimed":true,"revision":4}"#),
            ("200 OK", r#"{"claimed":true,"decision_id":"decision-1"}"#),
            ("200 OK", r#"{"claimed":false,"revision":4}"#),
            ("200 OK", r#"{"claimed":false,"decision_id":"decision-1"}"#),
            (
                "201 Created",
                r#"{"claimed":true,"revision":4,"decision_id":"decision-1"}"#,
            ),
            ("204 No Content", ""),
            ("206 Partial Content", r#"{"claimed":false}"#),
        ];

        for (status, body) in invalid {
            assert_scheduler_stops_after_claim_response(status, body, true).await;
        }
    }

    #[tokio::test]
    async fn lost_claim_response_cancels_runtime_before_execution_start() {
        let server = SchedulerTestServer::spawn(ServerMode::CommitThenDropClaim);
        let committed_claims = Arc::clone(&server.committed_claims);
        let execution_start_calls = Arc::new(AtomicUsize::new(0));
        let runtime_start_calls = Arc::clone(&execution_start_calls);

        let mock_runtime = async move {
            let mut tasks = tokio::task::JoinSet::new();
            tasks.spawn(async move {
                while committed_claims.load(Ordering::SeqCst) == 0 {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                // This is the same spawned-task ownership pattern used by
                // RuntimeService. If its JoinSet survives the scheduler's
                // unknown outcome, BoardDriver would start this execution.
                tokio::time::sleep(Duration::from_millis(400)).await;
                runtime_start_calls.fetch_add(1, Ordering::SeqCst);
            });
            while let Some(joined) = tasks.join_next().await {
                joined?;
            }
            Ok::<(), anyhow::Error>(())
        };

        let outcome = tokio::time::timeout(Duration::from_secs(1), async {
            crate::supervise_amux(
                Scheduler::for_test(server.api.clone(), true).run(),
                mock_runtime,
            )
            .await
        })
        .await
        .expect("the unverified claim must stop the process loops");

        assert!(outcome.is_err());
        assert_eq!(server.committed_claims.load(Ordering::SeqCst), 1);
        tokio::time::sleep(Duration::from_millis(450)).await;
        assert_eq!(execution_start_calls.load(Ordering::SeqCst), 0);
        server.finish();
    }

    #[tokio::test]
    async fn queue_wire_overflow_or_private_fields_never_reach_routing_or_claim() {
        let row = &QUEUE_BODY[1..QUEUE_BODY.len() - 1];
        let overflow = format!("[{}]", vec![row; 513].join(","));
        let cases = [
            ("200 OK", r#"[{"id":"TASK-1","title":"private","kind":"code","priority":"p1","pinned":false,"drag":0,"revision":1,"created_at":"2026-09-20T12:00:00Z","dependent_count":0}]"#.to_owned()),
            ("200 OK", overflow),
            ("201 Created", QUEUE_BODY.to_owned()),
        ];
        for (status, body) in cases {
            let server = SchedulerTestServer::spawn(ServerMode::QueueResponse {
                status: status.to_owned(),
                body: body.to_owned(),
            });
            let api = server.api.clone();
            tokio::time::timeout(Duration::from_secs(1), Scheduler::for_test(api, true).run())
                .await
                .expect("scheduler must become dormant")
                .expect_err("invalid queue must stop the full runtime");
            assert_eq!(server.requests.load(Ordering::SeqCst), 1);
            assert_eq!(server.claim_requests.load(Ordering::SeqCst), 0);
            server.finish();
        }
    }

    #[tokio::test]
    async fn bounded_internal_deadlines_stop_stalls_trickles_and_partial_server_use() {
        for mode in [
            ServerMode::Stall(SlowStage::Queue),
            ServerMode::Stall(SlowStage::Routing),
            ServerMode::Stall(SlowStage::Claim),
            ServerMode::TrickleClaim,
        ] {
            let expected_claims = usize::from(matches!(
                &mode,
                ServerMode::Stall(SlowStage::Claim) | ServerMode::TrickleClaim
            ));
            assert_scheduler_stops(mode, expected_claims, true).await;
        }

        // Regression: the server no longer blocks forever waiting for a fixed
        // queue/routing/claim request count before its thread can be joined.
        let server = SchedulerTestServer::spawn(ServerMode::ClaimResponse {
            status: "409 Conflict".to_owned(),
            body: r#"{"claimed":false,"reason":"execution_api_disabled"}"#.to_owned(),
        });
        let queue = server.api.queue().await.unwrap();
        assert_eq!(queue.len(), 1);
        assert_eq!(server.requests.load(Ordering::SeqCst), 1);
        assert_eq!(server.claim_requests.load(Ordering::SeqCst), 0);
        server.finish();
    }
}
