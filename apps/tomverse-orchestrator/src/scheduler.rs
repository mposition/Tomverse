use std::time::Duration;

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::time::Instant;
use tracing::{info, warn};

use crate::tomverse_api::{QueueTask, TomverseApi};

const SCORING_VERSION: &str = "amux-global-priority-v2";
const RECOVERY_INTERVAL: Duration = Duration::from_secs(30);
const MAX_ROUTING_PROBES_PER_TICK: usize = 16;

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
    fn total(&self) -> i64 {
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
}

impl Scheduler {
    pub fn new(api: TomverseApi) -> Self {
        Self { api, scan_offset: 0 }
    }

    pub async fn run(mut self) -> Result<()> {
        let mut next_recovery = Instant::now();
        loop {
            if Instant::now() >= next_recovery {
                match self.api.execution_recover().await {
                    Ok(outcome) if outcome.recovered => info!(
                        reclaimed_executions = outcome.reclaimed.unwrap_or(0),
                        reclaimed_claims = outcome.reclaimed_claims.unwrap_or(0),
                        quota_observations_deleted =
                            outcome.quota_observations_deleted.unwrap_or(0),
                        "AMUX recovery sweep completed"
                    ),
                    Ok(outcome) => info!(
                        reason = ?outcome.reason,
                        quota_observations_deleted =
                            outcome.quota_observations_deleted.unwrap_or(0),
                        "AMUX execution recovery is disabled; quota evidence swept"
                    ),
                    Err(error) => warn!(%error, "AMUX recovery sweep failed"),
                }
                next_recovery = Instant::now() + RECOVERY_INTERVAL;
            }

            if let Err(error) = self.tick().await {
                warn!(%error, "scheduler tick failed");
            }

            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    }

    async fn tick(&mut self) -> Result<()> {
        let queue = self.api.queue().await?;
        let ranked = rank_global_priority_at(queue, Utc::now());
        // Selection-only observes the highest priority task without taking
        // ownership or reading worker-specific routing state.
        let selection_only = !execution_enabled();
        if selection_only {
            self.scan_offset = 0;
        }
        let (start, end) = routing_scan_window(
            ranked.len(),
            if selection_only { 0 } else { self.scan_offset },
        );
        let queue_len = ranked.len();
        for (index, (task, score)) in ranked
            .into_iter()
            .enumerate()
            .skip(start)
            .take(end - start)
        {
        // Advance for each attempted candidate, before a fallible request.
        // Advancing to the end of the window upfront would permanently skip
        // the remaining candidates after a deterministic API error.
        self.scan_offset = next_routing_offset(queue_len, index);
        info!(
            task_id = %task.id,
            title = %task.title,
            priority = %task.priority,
            kind = %task.kind,
            dependency_count = task.dependencies.len(),
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

        let snapshot = self
            .api
            .routing_snapshot(&task.id, task.revision)
            .await?;

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

        let routing = crate::worker::score_execute_candidates(
            &profile,
            &snapshot.candidates,
        );

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

        let outcome = self
            .api
            .claim(
                &task.id,
                &worker,
                task.revision,
                score.total(),
                scoring_version,
                signals,
            )
            .await?;

        info!(
            task_id = %task.id,
            worker = %worker,
            claimed = outcome.claimed,
            revision = ?outcome.revision,
            decision_id = ?outcome.decision_id,
            reason = ?outcome.reason,
            measured = true,
            verdict = if outcome.claimed { "claimed" } else { "claim_lost" },
            "Tomverse task claim result"
        );
        if outcome.claimed {
            self.scan_offset = 0;
            return Ok(());
        }
        // A claim can lose its revision or hard gate after the queue read.
        // That task must not make every later runnable task invisible.
        }
        Ok(())
    }
}

fn next_routing_offset(queue_len: usize, index: usize) -> usize {
    if index + 1 == queue_len { 0 } else { index + 1 }
}

fn routing_scan_window(queue_len: usize, offset: usize) -> (usize, usize) {
    if queue_len == 0 {
        return (0, 0);
    }
    let start = if offset >= queue_len { 0 } else { offset };
    let end = start.saturating_add(MAX_ROUTING_PROBES_PER_TICK).min(queue_len);
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
        .map(|created| {
            (now - created.with_timezone(&Utc))
                .num_hours()
                .max(0)
        })
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
        .filter(|task| {
            task.status == "todo"
                && task.owner.as_deref().unwrap_or("").trim().is_empty()
        })
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
    use chrono::TimeZone;

    fn task(
        id: &str,
        kind: &str,
        priority: &str,
        created_at: &str,
    ) -> QueueTask {
        QueueTask {
            id: id.into(),
            title: id.into(),
            status: "todo".into(),
            kind: kind.into(),
            priority: priority.into(),
            pinned: false,
            drag: 0,
            owner: None,
            revision: 0,
            created_at: created_at.into(),
            dependencies: Vec::new(),
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
    fn legacy_queue_payload_defaults_advanced_signals_for_rolling_deploys() {
        let legacy: QueueTask = serde_json::from_value(serde_json::json!({
            "id": "LEGACY",
            "title": "legacy",
            "status": "todo",
            "kind": "code",
            "priority": "p1",
            "pinned": false,
            "drag": 0,
            "owner": null,
            "revision": 0,
            "created_at": "2026-09-20T12:00:00Z",
            "dependencies": [],
            "dependent_count": 0
        }))
        .unwrap();

        assert_eq!(legacy.scoring_version, "");
        assert_eq!(legacy.scheduler_signals, ScoreBreakdown::default());
        assert_eq!(score_at(&legacy, now()).urgency, 0);
    }

    #[test]
    fn v2_queue_payload_uses_the_server_authoritative_breakdown_verbatim() {
        let mut authoritative = task(
            "SERVER-SCORED",
            "chore",
            "p3",
            "2026-09-01T00:00:00Z",
        );
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
        let mut critical =
            task("CRITICAL-PATH", "chore", "p3", "2026-09-20T11:00:00Z");
        critical.dependent_count = 5;

        let ordinary =
            task("ORDINARY", "code", "p3", "2026-09-20T11:00:00Z");

        let selected =
            select_global_priority_at(vec![ordinary, critical], now()).unwrap();

        assert_eq!(selected.0.id, "CRITICAL-PATH");
    }

    #[test]
    fn pin_dominates_normal_priority_signals() {
        let mut pinned =
            task("PINNED", "chore", "p3", "2026-09-20T11:00:00Z");
        pinned.pinned = true;

        let p0 =
            task("P0", "blocker", "p0", "2026-09-20T11:00:00Z");

        let selected =
            select_global_priority_at(vec![p0, pinned], now()).unwrap();

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
}
