use std::time::Duration;

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::time::Instant;
use tracing::{info, warn};

use crate::tomverse_api::{
    is_database_busy, ClaimResponse, QueueTask, SelectionRead, TomverseApi,
    BOARD_CAPACITY_EXCEEDED, DATABASE_BUSY,
};

const SCORING_VERSION: &str = "amux-global-priority-v2";
const RECOVERY_INTERVAL: Duration = Duration::from_secs(30);
/// Policy version 15: the system consumer of pre-approved promotion grants.
const AUTO_PROMOTION_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// Policy version 15. Claim-only mode claims ownerless Todo for a runtime the
/// server reports execution-ready and starts no runtime or executor here; the
/// WSL runner executes. Opened only by this latch and `TOMVERSE_AMUX_CLAIM`
/// exactly `1`.
pub const CLAIM_ONLY_CODE_LATCH: bool = true;
pub const CLAIM_ONLY_ENV_NAME: &str = "TOMVERSE_AMUX_CLAIM";

pub fn claim_only_permitted(latch: bool, env_value: Option<&str>) -> bool {
    latch && env_value == Some("1")
}

pub fn claim_only_enabled() -> bool {
    claim_only_permitted(
        CLAIM_ONLY_CODE_LATCH,
        std::env::var(CLAIM_ONLY_ENV_NAME).ok().as_deref(),
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimMode {
    SelectionOnly,
    ClaimOnly,
    Execute,
    Conflict,
}

/// Both switches together is a configuration error: execute mode starts a
/// Railway runtime that would compete with the WSL runner for the same work.
pub fn claim_mode(execute: bool, claim_only: bool) -> ClaimMode {
    match (execute, claim_only) {
        (true, true) => ClaimMode::Conflict,
        (true, false) => ClaimMode::Execute,
        (false, true) => ClaimMode::ClaimOnly,
        (false, false) => ClaimMode::SelectionOnly,
    }
}

pub fn current_claim_mode() -> ClaimMode {
    claim_mode(execution_enabled(), claim_only_enabled())
}
const MAX_ROUTING_PROBES_PER_TICK: usize = 16;

/// What the scan does after a claim answer the server actually gave. An
/// answer it did not give (transport error, unexpected status or body) is an
/// unknown outcome and stops the process instead (AMUX_CLAIM_OUTCOME_UNKNOWN).
///
/// A refusal from the closed vocabulary and a lost CAS are known outcomes:
/// no ownership changed. main's scheduler moved on to the next candidate after
/// either (#1595), so one task the server refuses cannot hide every later
/// runnable task, and the claim-only orchestrator that runs the production
/// loop keeps running through a routine refusal such as one open card per
/// worker. A develop merge had made both terminal for the process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClaimFollowUp {
    EndTick,
    NextCandidate,
}

fn claim_verdict(outcome: &ClaimResponse) -> &'static str {
    match outcome {
        ClaimResponse::Claimed { .. } => "claimed",
        ClaimResponse::CasLost => "claim_lost",
        ClaimResponse::Refused { reason } => reason.as_str(),
    }
}

fn claim_follow_up(outcome: &ClaimResponse) -> ClaimFollowUp {
    match outcome {
        ClaimResponse::Claimed { .. } => ClaimFollowUp::EndTick,
        ClaimResponse::CasLost | ClaimResponse::Refused { .. } => ClaimFollowUp::NextCandidate,
    }
}

pub fn execution_enabled() -> bool {
    std::env::var("TOMVERSE_AMUX_EXECUTE")
        .ok()
        .is_some_and(|value| value.trim() == "1")
}

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

impl ScoreBreakdown {
    pub(crate) fn total(&self) -> i64 {
        self.pin
            + self.age_hours
            + self.type_weight
            + self.priority_weight
            + self.dependent_weight
            + self.drag
            + self.urgency
            + self.capacity_weight
            + self.incident_bonus
    }
}

pub struct Scheduler {
    api: TomverseApi,
    scan_offset: usize,
    execution_enabled: bool,
}

impl Scheduler {
    pub fn new(api: TomverseApi) -> Self {
        Self {
            api,
            scan_offset: 0,
            execution_enabled: execution_enabled(),
        }
    }

    pub async fn run(mut self) -> Result<()> {
        let mut next_recovery = Instant::now();
        let mut next_auto_promotion = Instant::now();
        loop {
            if Instant::now() >= next_auto_promotion {
                match self.api.auto_promotion_tick().await {
                    Ok(outcome) => info!(
                        promoted = outcome.promoted,
                        reason = ?outcome.reason,
                        consumption_id = ?outcome.consumption_id,
                        expired_grants = outcome.expired.unwrap_or(0),
                        "AMUX automatic promotion tick"
                    ),
                    Err(error) => warn!(%error, "AMUX automatic promotion tick failed"),
                }
                next_auto_promotion = Instant::now() + AUTO_PROMOTION_INTERVAL;
            }

            if Instant::now() >= next_recovery {
                self.recovery_pass().await?;
                next_recovery = Instant::now() + RECOVERY_INTERVAL;
            }

            if let Err(error) = self.tick().await {
                warn!(
                    %error,
                    incident_id = %uuid::Uuid::new_v4(),
                    endpoint = "internal_api",
                    error_code = "AMUX_INTERNAL_API_UNVERIFIED",
                    measured = false,
                    verdict = "internal_api_outcome_unknown_dormant",
                    "scheduler stopped after a bounded internal API failure"
                );
                return Err(anyhow::anyhow!("AMUX_INTERNAL_API_UNVERIFIED"));
            }

            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    }

    /// One recovery sweep. The route is a series of writes; only the exact
    /// database-busy answer says the sweep did not start (its first
    /// transaction, before the route wrote anything, could not get a
    /// connection), so only that is a skipped pass. Every other failure is an
    /// unknown outcome and stops the run, as before.
    async fn recovery_pass(&self) -> Result<()> {
        match self.api.execution_recover().await {
            Ok(outcome) if outcome.recovered => info!(
                reclaimed_executions = outcome.reclaimed.unwrap_or(0),
                reclaimed_claims = outcome.reclaimed_claims.unwrap_or(0),
                quota_observations_deleted = outcome.quota_observations_deleted.unwrap_or(0),
                more = outcome.more.unwrap_or(false),
                "AMUX recovery sweep completed"
            ),
            Ok(outcome) => info!(
                reason = ?outcome.reason,
                quota_observations_deleted = outcome.quota_observations_deleted.unwrap_or(0),
                "AMUX execution recovery is disabled; quota evidence swept"
            ),
            Err(error) if is_database_busy(&error) => warn!(
                endpoint = "execution_recover",
                reason = DATABASE_BUSY,
                measured = true,
                verdict = "recovery_skipped",
                "Tomverse AMUX database was busy before the recovery sweep started; nothing was written; retrying next interval"
            ),
            Err(error) => {
                warn!(
                    %error,
                    incident_id = %uuid::Uuid::new_v4(),
                    endpoint = "execution_recover",
                    error_code = "AMUX_RECOVERY_OUTCOME_UNKNOWN",
                    measured = false,
                    verdict = "recovery_outcome_unknown_dormant",
                    "AMUX recovery sweep outcome is unknown; stopping this process run"
                );
                return Err(anyhow::anyhow!("AMUX_RECOVERY_OUTCOME_UNKNOWN"));
            }
        }
        Ok(())
    }

    async fn tick(&mut self) -> Result<()> {
        let queue = match self.api.queue().await? {
            SelectionRead::Ready(queue) => queue,
            SelectionRead::BoardCapacityExceeded => {
                skip_tick_for_board_capacity("queue");
                return Ok(());
            }
            SelectionRead::DatabaseBusy => {
                skip_tick_for_database_busy("queue");
                return Ok(());
            }
        };
        let ranked = rank_global_priority_at(queue, Utc::now());
        // Selection-only observes the highest priority task without taking
        // ownership or reading worker-specific routing state. Both switches
        // together also falls back to selection: never claim on a conflict.
        // Execution comes from the field fixed at construction; claim-only is
        // read from its latch and environment on each pass.
        let mode = claim_mode(self.execution_enabled, claim_only_enabled());
        if mode == ClaimMode::Conflict {
            warn!(
                measured = true,
                verdict = "claim_mode_conflict",
                "TOMVERSE_AMUX_EXECUTE and TOMVERSE_AMUX_CLAIM are both set; not claiming"
            );
        }
        let selection_only = !matches!(mode, ClaimMode::ClaimOnly | ClaimMode::Execute);
        if selection_only {
            self.scan_offset = 0;
        }
        let (start, end) = routing_scan_window(
            ranked.len(),
            if selection_only { 0 } else { self.scan_offset },
        );
        let queue_len = ranked.len();
        for (index, (task, score)) in ranked.into_iter().enumerate().skip(start).take(end - start) {
            // Advance for each attempted candidate, before a fallible request.
            // Advancing to the end of the window upfront would permanently skip
            // the remaining candidates after a deterministic API error.
            self.scan_offset = next_routing_offset(queue_len, index);
            info!(
                task_id = %task.id,
                priority = %task.priority,
                kind = %task.kind,
                dependent_count = task.dependent_count,
                scheduler_score = score.total(),
                server_scheduler_score = task.scheduler_score,
                scoring_version = %task.scoring_version,
                "global priority scheduler selected task"
            );

            // Selection and execution are deliberately separate.
            if selection_only {
                self.scan_offset = 0;
                info!(
                    task_id = %task.id,
                    measured = true,
                    verdict = "selection_only",
                    "Tomverse AMUX execution disabled; task was not claimed"
                );
                return Ok(());
            }

            let snapshot = match self.api.routing_snapshot(&task.id, task.revision).await? {
                SelectionRead::Ready(snapshot) => snapshot,
                // The snapshot's size comes from the worker catalog, not this
                // task, so every other task in the window would get the same
                // answer. Skip the tick; the next one reads the queue again.
                SelectionRead::BoardCapacityExceeded => {
                    skip_tick_for_board_capacity("routing_snapshot");
                    return Ok(());
                }
                // A busy database would answer the next task's read the same
                // way, and nothing was written or claimed. Skip the tick.
                SelectionRead::DatabaseBusy => {
                    skip_tick_for_database_busy("routing_snapshot");
                    return Ok(());
                }
            };

            if !snapshot.eligible {
                warn!(
                    task_id = %task.id,
                    reason = ?snapshot.reason,
                    measured = false,
                    verdict = "worker_routing_unavailable",
                    "Tomverse AMUX refused claim because worker routing facts were unavailable"
                );
                continue;
            }

            let Some(profile) = snapshot.task else {
                warn!(
                    task_id = %task.id,
                    measured = false,
                    verdict = "invalid_routing_snapshot",
                    "Tomverse AMUX routing snapshot was eligible but had no task profile"
                );
                continue;
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
                continue;
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

            // Ownership must not be stranded unless a matching live worker can
            // accept the execution immediately.
            if !snapshot.execution_ready {
                warn!(
                    task_id = %task.id,
                    selected_worker = %worker,
                    measured = true,
                    verdict = "execution_lifecycle_unavailable",
                    "Tomverse AMUX refused ownership claim because execution lifecycle is not ready"
                );
                continue;
            }

            let server_v2 = task.scoring_version == SCORING_VERSION;
            let scheduler_signals = if server_v2 {
                serde_json::json!(&score)
            } else {
                serde_json::json!({
                    "pin": score.pin,
                    "age_hours": score.age_hours,
                    "type_weight": score.type_weight,
                    "priority_weight": score.priority_weight,
                    "dependents": score.dependents,
                    "dependent_weight": score.dependent_weight,
                    "drag": score.drag,
                })
            };
            let worker_router_version = if server_v2 {
                "amux-worker-router-v2"
            } else {
                "amux-worker-router-v1"
            };
            let scoring_version = if server_v2 {
                SCORING_VERSION
            } else {
                "amux-global-priority-v1"
            };
            let signals = serde_json::json!({
                "scheduler": scheduler_signals,
                "routing": {
                    "scoring_version": worker_router_version,
                    "preferred_worker": &routing.preferred_worker,
                    "selected_worker": &routing.selected_worker,
                    "preferred_score": routing.preferred_score,
                    "selected_score": routing.selected_score,
                    "candidates": &routing.candidates,
                }
            });

            let claim_result = self
                .api
                .claim(
                    &task.id,
                    &worker,
                    task.revision,
                    score.total(),
                    scoring_version,
                    signals,
                )
                .await;
            let outcome = match claim_result {
                Ok(outcome) => outcome,
                // The claim transaction never started, and nothing before it
                // in the route wrote: ownership did not change. Skip the tick;
                // the next one reads the queue again.
                Err(error) if is_database_busy(&error) => {
                    warn!(
                        task_id = %task.id,
                        task_revision = task.revision,
                        worker = %worker,
                        endpoint = "claim",
                        reason = DATABASE_BUSY,
                        measured = true,
                        verdict = "claim_skipped",
                        "Tomverse AMUX database was busy before the claim started; nothing was written; skipping this tick"
                    );
                    return Ok(());
                }
                Err(error) => {
                    warn!(
                        %error,
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
            let follow_up = claim_follow_up(&outcome);
            let (claimed, revision, decision_id, reason) = match &outcome {
                ClaimResponse::Claimed {
                    revision,
                    decision_id,
                } => (true, Some(*revision), Some(decision_id.as_str()), None),
                ClaimResponse::CasLost => (false, None, None, None),
                ClaimResponse::Refused { reason } => (false, None, None, Some(reason.as_str())),
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
            match follow_up {
                ClaimFollowUp::EndTick => {
                    self.scan_offset = 0;
                    return Ok(());
                }
                // A refusal or a lost CAS changed no ownership. The next
                // candidate in the bounded window is tried; the next tick
                // re-reads the queue.
                ClaimFollowUp::NextCandidate => continue,
            }
        }
        Ok(())
    }
}

/// A board too large for one complete selection response is a known answer
/// that wrote nothing, not an unknown outcome: log it and try again next tick.
/// Recovery and automatic promotion keep their own cadence meanwhile.
fn skip_tick_for_board_capacity(endpoint: &'static str) {
    warn!(
        endpoint,
        reason = BOARD_CAPACITY_EXCEEDED,
        measured = true,
        verdict = "selection_skipped",
        "Tomverse AMUX board exceeds one complete selection response; skipping this tick"
    );
}

/// A selection read the app's database could not take just then. A read
/// wrote nothing, so this is not an unknown outcome: log it and try again on
/// the next tick. A claim, recovery and every other status still stop the run.
fn skip_tick_for_database_busy(endpoint: &'static str) {
    warn!(
        endpoint,
        reason = DATABASE_BUSY,
        measured = true,
        verdict = "selection_skipped",
        "Tomverse AMUX database was busy for a selection read; nothing was written; skipping this tick"
    );
}

fn next_routing_offset(queue_len: usize, index: usize) -> usize {
    if index + 1 == queue_len {
        0
    } else {
        index + 1
    }
}

fn routing_scan_window(queue_len: usize, offset: usize) -> (usize, usize) {
    if queue_len == 0 {
        return (0, 0);
    }
    let start = if offset >= queue_len { 0 } else { offset };
    let end = start
        .saturating_add(MAX_ROUTING_PROBES_PER_TICK)
        .min(queue_len);
    (start, end)
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
    // A v2 queue row already carries the server-authoritative breakdown.
    // Recomputing even its age term here would create a second clock boundary
    // between queue selection and claim. Legacy rows have no such evidence,
    // so retain the original local scorer only for rolling compatibility.
    if task.scoring_version == SCORING_VERSION {
        return task.scheduler_signals.clone();
    }

    let dependents = task.dependent_count.max(0);

    ScoreBreakdown {
        pin: if task.pinned { 10_000 } else { 0 },
        age_hours: age_hours_at(task, now),
        type_weight: type_weight(&task.kind),
        priority_weight: priority_weight(&task.priority),
        dependents,
        dependent_weight: dependents.saturating_mul(5),
        drag: task.drag.clamp(0, 8),
        urgency: 0,
        capacity_weight: 0,
        incident_bonus: 0,
    }
}

#[cfg(test)]
fn select_global_priority_at(
    tasks: Vec<QueueTask>,
    now: DateTime<Utc>,
) -> Option<(QueueTask, ScoreBreakdown)> {
    rank_global_priority_at(tasks, now).into_iter().next()
}

fn rank_global_priority_at(
    tasks: Vec<QueueTask>,
    now: DateTime<Utc>,
) -> Vec<(QueueTask, ScoreBreakdown)> {
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

    ranked
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tomverse_api::ClaimRefusalReason;
    use chrono::TimeZone;

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
            scheduler_score: 0,
            scoring_version: String::new(),
            scheduler_signals: ScoreBreakdown {
                pin: 0,
                age_hours: 0,
                type_weight: 0,
                priority_weight: 0,
                dependents: 0,
                dependent_weight: 0,
                drag: 0,
                urgency: 0,
                capacity_weight: 0,
                incident_bonus: 0,
            },
            ..Default::default()
        }
    }

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, 20, 12, 0, 0)
            .single()
            .unwrap()
    }

    #[test]
    fn global_priority_has_all_four_explicit_levels() {
        assert_eq!(priority_weight("p0"), 40);
        assert_eq!(priority_weight("p1"), 20);
        assert_eq!(priority_weight("p2"), 10);
        assert_eq!(priority_weight("p3"), 0);
    }

    #[test]
    fn claim_refusals_and_cas_loss_move_to_the_next_candidate() {
        assert_eq!(
            claim_follow_up(&ClaimResponse::CasLost),
            ClaimFollowUp::NextCandidate,
        );
        for reason in ClaimRefusalReason::CLOSED {
            let outcome = ClaimResponse::Refused { reason: *reason };
            assert_eq!(claim_follow_up(&outcome), ClaimFollowUp::NextCandidate);
            assert_eq!(claim_verdict(&outcome), reason.as_str());
        }
        let claimed = ClaimResponse::Claimed {
            revision: 2,
            decision_id: "decision".into(),
        };
        assert_eq!(claim_follow_up(&claimed), ClaimFollowUp::EndTick);
    }

    #[test]
    fn legacy_queue_payload_defaults_advanced_signals_for_rolling_deploys() {
        let legacy: QueueTask = serde_json::from_value(serde_json::json!({
            "id": "LEGACY",
            "kind": "code",
            "priority": "p1",
            "pinned": false,
            "drag": 0,
            "revision": 0,
            "created_at": "2026-09-20T12:00:00Z",
            "dependent_count": 0
        }))
        .unwrap();

        assert_eq!(legacy.scoring_version, "");
        assert_eq!(legacy.scheduler_signals, ScoreBreakdown::default());
        assert_eq!(score_at(&legacy, now()).urgency, 0);
    }

    #[test]
    fn v2_queue_payload_uses_the_server_authoritative_breakdown_verbatim() {
        let mut authoritative = task("SERVER-SCORED", "chore", "p3", "2026-09-01T00:00:00Z");
        authoritative.scoring_version = SCORING_VERSION.into();
        authoritative.scheduler_score = 173;
        authoritative.scheduler_signals = ScoreBreakdown {
            pin: 0,
            age_hours: 7,
            type_weight: 1,
            priority_weight: 2,
            dependents: 3,
            dependent_weight: 15,
            drag: 8,
            urgency: 120,
            capacity_weight: 20,
            incident_bonus: 0,
        };

        let score = score_at(&authoritative, now());

        assert_eq!(score, authoritative.scheduler_signals);
        assert_eq!(score.total(), authoritative.scheduler_score);
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
    fn ranked_queue_keeps_lower_priority_tasks_available_for_fallthrough() {
        let ranked = rank_global_priority_at(
            vec![
                task("LOWER", "chore", "p3", "2026-09-20T11:00:00Z"),
                task("UNROUTABLE-TOP", "bug", "p0", "2026-09-20T11:00:00Z"),
            ],
            now(),
        );

        assert_eq!(ranked.len(), 2);
        assert_eq!(ranked[0].0.id, "UNROUTABLE-TOP");
        assert_eq!(ranked[1].0.id, "LOWER");
    }

    #[test]
    fn routing_fallthrough_is_bounded_and_reaches_later_candidates() {
        assert_eq!(routing_scan_window(37, 0), (0, 16));
        assert_eq!(routing_scan_window(37, 16), (16, 32));
        assert_eq!(routing_scan_window(37, 32), (32, 37));
        assert_eq!(routing_scan_window(37, 100), (0, 16));
        assert_eq!(routing_scan_window(0, 100), (0, 0));
        // An error on the first request retries from the *next* candidate,
        // without losing the other fifteen candidates in the current window.
        assert_eq!(next_routing_offset(37, 0), 1);
        assert_eq!(routing_scan_window(37, next_routing_offset(37, 0)), (1, 17));
        assert_eq!(next_routing_offset(37, 36), 0);
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
    fn claim_only_opens_only_on_the_latch_and_exactly_one() {
        assert!(claim_only_permitted(true, Some("1")));
        for value in [None, Some(""), Some("0"), Some(" 1"), Some("1 "), Some("true"), Some("enabled")] {
            assert!(!claim_only_permitted(true, value), "{value:?}");
        }
        assert!(!claim_only_permitted(false, Some("1")));
    }

    #[test]
    fn claim_mode_refuses_both_switches_together() {
        assert_eq!(claim_mode(false, false), ClaimMode::SelectionOnly);
        assert_eq!(claim_mode(false, true), ClaimMode::ClaimOnly);
        assert_eq!(claim_mode(true, false), ClaimMode::Execute);
        assert_eq!(claim_mode(true, true), ClaimMode::Conflict);
    }

    #[test]
    fn a_conflict_never_claims() {
        let source = include_str!("scheduler.rs");
        assert!(source.contains(
            "let selection_only = !matches!(mode, ClaimMode::ClaimOnly | ClaimMode::Execute);"
        ));
    }

    /// Answers each request by its path from a fixed table, one connection per
    /// request, and records the paths it was asked for.
    async fn serve_selection(
        answers: Vec<(&'static str, &'static str, String)>,
    ) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let mut request = Vec::new();
                let mut buffer = [0_u8; 4096];
                // Headers, then the declared body.
                let head_end = loop {
                    let read = stream.read(&mut buffer).await.unwrap();
                    if read == 0 {
                        break None;
                    }
                    request.extend_from_slice(&buffer[..read]);
                    if let Some(at) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                        break Some(at + 4);
                    }
                };
                let Some(head_end) = head_end else { continue };
                let head = String::from_utf8_lossy(&request[..head_end]).to_string();
                let length = head
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())?
                    })
                    .unwrap_or(0);
                while request.len() < head_end + length {
                    let read = stream.read(&mut buffer).await.unwrap();
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..read]);
                }
                let path = head.split_whitespace().nth(1).unwrap_or("").to_owned();
                log.lock().unwrap().push(path.clone());
                let (status, body) = answers
                    .iter()
                    .find(|(suffix, _, _)| path.ends_with(suffix))
                    .map(|(_, status, body)| (*status, body.clone()))
                    .unwrap_or(("500 Internal Server Error", "{}".to_owned()));
                let reply = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len(),
                );
                stream.write_all(reply.as_bytes()).await.unwrap();
                let _ = stream.shutdown().await;
            }
        });
        (format!("http://{address}"), seen)
    }

    fn scheduler_for(base_url: String) -> Scheduler {
        let mut scheduler = Scheduler::new(TomverseApi::for_test_with_timeouts(
            base_url,
            Duration::from_millis(500),
            Duration::from_secs(2),
        ));
        // Claim path, so the tick reaches the routing snapshot. The latch and
        // TOMVERSE_AMUX_CLAIM are not set in tests, so this is Execute mode.
        scheduler.execution_enabled = true;
        scheduler
    }

    fn queue_row() -> String {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/amux-queue-wire-compat-v1.json"
        ))
        .unwrap();
        format!("[{}]", fixtures["queue_server"])
    }

    const QUEUE_CAPACITY_BODY: &str =
        r#"{"error":"Queue capacity exceeded.","reason":"board_capacity_exceeded"}"#;
    const ROUTING_CAPACITY_BODY: &str = r#"{"eligible":false,"reason":"board_capacity_exceeded"}"#;

    #[tokio::test]
    async fn a_board_capacity_refusal_from_the_queue_skips_the_tick() {
        let (base_url, seen) = serve_selection(vec![(
            "/api/internal/amux/queue",
            "409 Conflict",
            QUEUE_CAPACITY_BODY.to_owned(),
        )])
        .await;
        let mut scheduler = scheduler_for(base_url);

        scheduler.tick().await.expect("a capacity refusal is a skipped tick, not an exit");
        assert_eq!(*seen.lock().unwrap(), vec!["/api/internal/amux/queue".to_owned()]);
    }

    #[tokio::test]
    async fn a_board_capacity_refusal_from_the_routing_snapshot_skips_the_tick() {
        let (base_url, seen) = serve_selection(vec![
            ("/api/internal/amux/queue", "200 OK", queue_row()),
            (
                "/api/internal/amux/routing-snapshot",
                "409 Conflict",
                ROUTING_CAPACITY_BODY.to_owned(),
            ),
        ])
        .await;
        let mut scheduler = scheduler_for(base_url);

        scheduler.tick().await.expect("a capacity refusal is a skipped tick, not an exit");
        // No claim follows a refused snapshot.
        assert_eq!(
            *seen.lock().unwrap(),
            vec![
                "/api/internal/amux/queue".to_owned(),
                "/api/internal/amux/routing-snapshot".to_owned(),
            ]
        );
    }

    // The exact body lib/amux/internalRoute.ts sends for a busy read.
    const DATABASE_BUSY_BODY: &str =
        r#"{"error":"AMUX database is busy.","reason":"amux_database_busy"}"#;

    #[tokio::test]
    async fn a_database_busy_answer_from_the_queue_skips_the_tick() {
        let (base_url, seen) = serve_selection(vec![(
            "/api/internal/amux/queue",
            "503 Service Unavailable",
            DATABASE_BUSY_BODY.to_owned(),
        )])
        .await;
        let mut scheduler = scheduler_for(base_url);

        scheduler.tick().await.expect("a busy read is a skipped tick, not an exit");
        assert_eq!(*seen.lock().unwrap(), vec!["/api/internal/amux/queue".to_owned()]);
    }

    #[tokio::test]
    async fn a_database_busy_answer_from_the_routing_snapshot_skips_the_tick() {
        let (base_url, seen) = serve_selection(vec![
            ("/api/internal/amux/queue", "200 OK", queue_row()),
            (
                "/api/internal/amux/routing-snapshot",
                "503 Service Unavailable",
                DATABASE_BUSY_BODY.to_owned(),
            ),
        ])
        .await;
        let mut scheduler = scheduler_for(base_url);

        scheduler.tick().await.expect("a busy read is a skipped tick, not an exit");
        // No claim follows a busy snapshot.
        assert_eq!(
            *seen.lock().unwrap(),
            vec![
                "/api/internal/amux/queue".to_owned(),
                "/api/internal/amux/routing-snapshot".to_owned(),
            ]
        );
    }

    #[tokio::test]
    async fn a_database_busy_answer_to_a_claim_skips_the_tick() {
        // The claim did not start and the route wrote nothing before it: no
        // ownership changed, so this is a skipped tick, not an unknown outcome.
        let (base_url, seen) = serve_selection(claim_answers(
            "503 Service Unavailable",
            DATABASE_BUSY_BODY,
        ))
        .await;
        let mut scheduler = scheduler_for(base_url);

        scheduler.tick().await.expect("a busy claim is a skipped tick, not an exit");
        assert_eq!(
            seen.lock().unwrap().last().map(String::as_str),
            Some("/api/internal/amux/claim")
        );
        // One claim, no second candidate in the same tick.
        assert_eq!(
            seen.lock()
                .unwrap()
                .iter()
                .filter(|path| path.ends_with("/claim"))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn any_other_claim_failure_still_stops_the_run() {
        for (status, body) in [
            (
                "503 Service Unavailable",
                r#"{"error":"AMUX database outcome is unknown.","reason":"amux_outcome_unknown","incident_id":"0b8e9a52-6d8c-4f0e-9b1a-2c3d4e5f6a7b"}"#,
            ),
            (
                "503 Service Unavailable",
                r#"{"error":"AMUX database deadline exceeded.","reason":"amux_database_deadline_exceeded"}"#,
            ),
            (
                "503 Service Unavailable",
                r#"{"error":"AMUX database is busy.","reason":"amux_database_busy","extra":1}"#,
            ),
            ("500 Internal Server Error", DATABASE_BUSY_BODY),
            ("502 Bad Gateway", DATABASE_BUSY_BODY),
        ] {
            let (base_url, _) = serve_selection(claim_answers(status, body)).await;
            let mut scheduler = scheduler_for(base_url);
            let error = scheduler
                .tick()
                .await
                .expect_err("a claim answer outside its contract stops");
            assert_eq!(error.to_string(), "AMUX_CLAIM_OUTCOME_UNKNOWN", "{status} {body}");
        }
    }

    /// Queue and snapshot answer so the tick reaches the claim, which answers
    /// `status` and `body`.
    fn claim_answers(
        status: &'static str,
        body: &str,
    ) -> Vec<(&'static str, &'static str, String)> {
        let routing: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/amux-routing-snapshot-v1.json"
        ))
        .unwrap();
        vec![
            ("/api/internal/amux/queue", "200 OK", queue_row()),
            (
                "/api/internal/amux/routing-snapshot",
                "200 OK",
                routing["eligible"].to_string(),
            ),
            ("/api/internal/amux/claim", status, body.to_owned()),
        ]
    }

    #[tokio::test]
    async fn a_database_busy_answer_to_recovery_skips_the_pass_and_anything_else_stops() {
        let (base_url, seen) = serve_selection(vec![(
            "/api/internal/amux/execution/recover",
            "503 Service Unavailable",
            DATABASE_BUSY_BODY.to_owned(),
        )])
        .await;
        let scheduler = scheduler_for(base_url);
        scheduler
            .recovery_pass()
            .await
            .expect("a busy recovery sweep did not start; the pass is skipped");
        assert_eq!(
            *seen.lock().unwrap(),
            vec!["/api/internal/amux/execution/recover".to_owned()]
        );

        for (status, body) in [
            (
                "503 Service Unavailable",
                r#"{"error":"AMUX database outcome is unknown.","reason":"amux_outcome_unknown","incident_id":"0b8e9a52-6d8c-4f0e-9b1a-2c3d4e5f6a7b"}"#,
            ),
            (
                "503 Service Unavailable",
                r#"{"error":"AMUX database is busy.","reason":"amux_database_busy","extra":1}"#,
            ),
            ("500 Internal Server Error", DATABASE_BUSY_BODY),
            ("500 Internal Server Error", r#"{"error":"Internal server error."}"#),
        ] {
            let (base_url, _) = serve_selection(vec![(
                "/api/internal/amux/execution/recover",
                status,
                body.to_owned(),
            )])
            .await;
            let error = scheduler_for(base_url)
                .recovery_pass()
                .await
                .expect_err("any other recovery answer is an unknown outcome");
            assert_eq!(error.to_string(), "AMUX_RECOVERY_OUTCOME_UNKNOWN", "{status} {body}");
        }
    }

    #[tokio::test]
    async fn any_other_selection_failure_is_still_an_unknown_outcome() {
        for (status, body) in [
            ("409 Conflict", r#"{"error":"Queue capacity exceeded.","reason":"other"}"#),
            ("409 Conflict", r#"{"error":"x","reason":"board_capacity_exceeded","extra":1}"#),
            ("503 Service Unavailable", r#"{"reason":"amux_outcome_unknown"}"#),
            (
                "503 Service Unavailable",
                r#"{"error":"AMUX database outcome is unknown.","reason":"amux_outcome_unknown","incident_id":"0b8e9a52-6d8c-4f0e-9b1a-2c3d4e5f6a7b"}"#,
            ),
            (
                "503 Service Unavailable",
                r#"{"error":"AMUX database deadline exceeded.","reason":"amux_database_deadline_exceeded"}"#,
            ),
            (
                "503 Service Unavailable",
                r#"{"error":"AMUX database is busy.","reason":"amux_database_busy","extra":1}"#,
            ),
            ("500 Internal Server Error", DATABASE_BUSY_BODY),
            ("500 Internal Server Error", r#"{"error":"Internal server error."}"#),
        ] {
            let (base_url, _) = serve_selection(vec![(
                "/api/internal/amux/queue",
                status,
                body.to_owned(),
            )])
            .await;
            let mut scheduler = scheduler_for(base_url);
            assert!(scheduler.tick().await.is_err(), "{status} {body}");
        }

        let (base_url, _) = serve_selection(vec![
            ("/api/internal/amux/queue", "200 OK", queue_row()),
            (
                "/api/internal/amux/routing-snapshot",
                "409 Conflict",
                r#"{"eligible":true,"reason":"board_capacity_exceeded"}"#.to_owned(),
            ),
        ])
        .await;
        let mut scheduler = scheduler_for(base_url);
        assert!(scheduler.tick().await.is_err());
    }
}
