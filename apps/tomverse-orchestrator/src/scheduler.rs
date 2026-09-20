use std::time::Duration;

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use tracing::{info, warn};

use crate::tomverse_api::{QueueTask, TomverseApi};

const SCORING_VERSION: &str = "amux-global-priority-v1";

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
}

impl Scheduler {
    pub fn new(api: TomverseApi) -> Self {
        Self { api }
    }

    pub async fn run(self) -> Result<()> {
        loop {
            if let Err(error) = self.tick().await {
                warn!(%error, "scheduler tick failed");
            }

            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    }

    async fn tick(&self) -> Result<()> {
        let queue = self.api.queue().await?;

        let Some((task, score)) = select_global_priority(queue) else {
            return Ok(());
        };

        info!(
            task_id = %task.id,
            title = %task.title,
            priority = %task.priority,
            kind = %task.kind,
            dependency_count = task.dependencies.len(),
            dependent_count = task.dependent_count,
            scheduler_score = score.total(),
            scoring_version = SCORING_VERSION,
            "global priority scheduler selected task"
        );

        // Selection and execution are deliberately separate.
        if !execution_enabled() {
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
            return Ok(());
        }

        let Some(profile) = snapshot.task else {
            warn!(
                task_id = %task.id,
                measured = false,
                verdict = "invalid_routing_snapshot",
                "Tomverse AMUX routing snapshot was eligible but had no task profile"
            );
            return Ok(());
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
            return Ok(());
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
            return Ok(());
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

        let outcome = self
            .api
            .claim(
                &task.id,
                &worker,
                task.revision,
                score.total(),
                signals,
            )
            .await?;

        info!(
            task_id = %task.id,
            worker = %worker,
            claimed = outcome.claimed,
            revision = ?outcome.revision,
            decision_id = ?outcome.decision_id,
            measured = true,
            verdict = if outcome.claimed { "claimed" } else { "claim_lost" },
            "Tomverse task claim result"
        );

        Ok(())
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
        .map(|created| {
            (now - created.with_timezone(&Utc))
                .num_hours()
                .max(0)
        })
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

fn select_global_priority(
    tasks: Vec<QueueTask>,
) -> Option<(QueueTask, ScoreBreakdown)> {
    select_global_priority_at(tasks, Utc::now())
}

fn select_global_priority_at(
    tasks: Vec<QueueTask>,
    now: DateTime<Utc>,
) -> Option<(QueueTask, ScoreBreakdown)> {
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

    ranked.into_iter().next()
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
