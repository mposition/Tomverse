//! Adapters from measured runtime facts into the pure task-routing scorer.
//!
//! Provider probes do not live here. Production quota input comes from the
//! same cached `/api/usage` snapshot used by the dashboard, so routing cannot
//! independently hammer or disagree with the subscription probes.

use serde::Serialize;
use serde_json::Value;

use crate::task_router::CandidateRoutingSignals;
use crate::worker_catalog::RoutingWorkerCandidate;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct QuotaSignal {
    /// Provider spelling stored on the worker/session.
    pub configured_provider: String,

    /// Canonical ProviderAdapter identity.
    pub canonical_provider: String,

    /// Provider id used by the shaped `/api/usage` response.
    pub usage_provider: String,

    /// 0.0..=1.0. `None` means no trustworthy quota observation.
    ///
    /// With multiple quota windows the minimum remaining fraction wins:
    /// the tightest real cap is the capacity that constrains new work.
    pub quota_remaining: Option<f64>,

    /// True only when a fresh/measured quota window positively reports zero
    /// remaining. Unknown, unavailable, stale, or absent data never exhausts.
    pub provider_exhausted: bool,

    pub observed: bool,
    pub window_count: usize,
}

/// Fetch the shared production usage snapshot exactly once and attach its quota
/// facts to the routing candidates.
///
/// Historical-performance signals remain `None` here; a later adapter enriches
/// those fields from task_attempts/task_attempt_metrics.
pub(crate) async fn attach_live_quota(
    workers: Vec<RoutingWorkerCandidate>,
) -> (Vec<CandidateRoutingSignals>, Vec<QuotaSignal>) {
    let snapshot = crate::api::usage::routing_usage_snapshot().await;
    attach_quota_from_snapshot(workers, &snapshot)
}

/// Pure/testable transformation from the shaped usage snapshot into scorer
/// inputs. No network, clock, DB, or process calls occur here.
pub(crate) fn attach_quota_from_snapshot(
    workers: Vec<RoutingWorkerCandidate>,
    snapshot: &Value,
) -> (Vec<CandidateRoutingSignals>, Vec<QuotaSignal>) {
    let mut candidates = Vec::with_capacity(workers.len());
    let mut quota = Vec::with_capacity(workers.len());

    for worker in workers {
        let signal = quota_signal_from_snapshot(snapshot, &worker.provider);

        candidates.push(CandidateRoutingSignals {
            worker,
            predicted_success: None,
            quota_remaining: signal.quota_remaining,
            expected_speed: None,
            low_rework: None,
            low_human_attention: None,
            cost_efficiency: None,
            provider_exhausted: signal.provider_exhausted,
        });

        quota.push(signal);
    }

    (candidates, quota)
}

pub(crate) fn quota_signal_from_snapshot(
    snapshot: &Value,
    configured_provider: &str,
) -> QuotaSignal {
    let (canonical_provider, usage_provider) =
        provider_ids(configured_provider);

    let unknown = || QuotaSignal {
        configured_provider: configured_provider.to_string(),
        canonical_provider: canonical_provider.clone(),
        usage_provider: usage_provider.clone(),
        quota_remaining: None,
        provider_exhausted: false,
        observed: false,
        window_count: 0,
    };

    let Some(row) = snapshot
        .get("providers")
        .and_then(Value::as_array)
        .and_then(|rows| {
            rows.iter().find(|row| {
                row.get("id").and_then(Value::as_str)
                    == Some(usage_provider.as_str())
            })
        })
    else {
        return unknown();
    };

    // A provider row is actionable only when it represents a current measured
    // subscription reading. Unknown/unavailable/stale must fail open.
    if row.get("available") != Some(&Value::Bool(true))
        || row.get("measured") != Some(&Value::Bool(true))
        || row.get("stale") == Some(&Value::Bool(true))
        || row.get("metered") == Some(&Value::Bool(false))
    {
        return unknown();
    }

    let Some(windows) = row.get("windows").and_then(Value::as_array) else {
        return unknown();
    };

    let remaining = windows
        .iter()
        .filter_map(|window| {
            window
                .get("remaining_percent")
                .and_then(Value::as_f64)
        })
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(0.0, 100.0))
        .collect::<Vec<_>>();

    if remaining.is_empty() {
        return unknown();
    }

    let provider_exhausted =
        remaining.iter().any(|remaining| *remaining <= 0.0);

    let min_remaining = remaining
        .iter()
        .copied()
        .fold(f64::INFINITY, f64::min);

    QuotaSignal {
        configured_provider: configured_provider.to_string(),
        canonical_provider,
        usage_provider,
        quota_remaining: Some(min_remaining / 100.0),
        provider_exhausted,
        observed: true,
        window_count: remaining.len(),
    }
}

/// Resolve the session's provider spelling through the real registry first.
///
/// The usage API intentionally calls Claude "claude" while the canonical
/// ProviderAdapter id is "claude-code"; keep that presentation alias here,
/// after registry resolution, rather than teaching the scorer provider aliases.
fn provider_ids(configured_provider: &str) -> (String, String) {
    let configured = configured_provider
        .trim()
        .to_ascii_lowercase();

    let registry = crate::provider::default_registry();

    let canonical = registry
        .resolve(&configured)
        .map(|adapter| adapter.id().as_str().to_string())
        .unwrap_or_else(|| configured.clone());

    let usage = match canonical.as_str() {
        "claude-code" => "claude".to_string(),
        other => other.to_string(),
    };

    (canonical, usage)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn worker(
        name: &str,
        provider: &str,
    ) -> RoutingWorkerCandidate {
        RoutingWorkerCandidate {
            worker_name: name.into(),
            provider: provider.into(),
            model: None,
            routing_roles: vec!["feature".into()],
            running: true,
            status: "idle".into(),
            dispatch_ready: true,
            archived: false,
            paused: false,
            isolated: false,
            blocked: false,
        }
    }

    #[test]
    fn claude_worker_alias_resolves_to_canonical_provider_and_usage_row() {
        let snapshot = json!({
            "providers": [{
                "id": "claude",
                "available": true,
                "measured": true,
                "metered": true,
                "windows": [
                    {"remaining_percent": 72.0},
                    {"remaining_percent": 41.0}
                ]
            }]
        });

        let signal = quota_signal_from_snapshot(&snapshot, "claude");

        assert_eq!(signal.canonical_provider, "claude-code");
        assert_eq!(signal.usage_provider, "claude");
        assert_eq!(signal.quota_remaining, Some(0.41));
        assert!(!signal.provider_exhausted);
        assert!(signal.observed);
        assert_eq!(signal.window_count, 2);
    }

    #[test]
    fn tightest_window_controls_remaining_capacity() {
        let snapshot = json!({
            "providers": [{
                "id": "codex",
                "available": true,
                "measured": true,
                "metered": true,
                "windows": [
                    {"remaining_percent": 83.0},
                    {"remaining_percent": 19.5}
                ]
            }]
        });

        let signal = quota_signal_from_snapshot(&snapshot, "codex");

        assert_eq!(signal.quota_remaining, Some(0.195));
        assert!(!signal.provider_exhausted);
    }

    #[test]
    fn zero_remaining_is_positive_exhaustion_evidence() {
        let snapshot = json!({
            "providers": [{
                "id": "codex",
                "available": true,
                "measured": true,
                "metered": true,
                "windows": [
                    {"remaining_percent": 64.0},
                    {"remaining_percent": 0.0}
                ]
            }]
        });

        let signal = quota_signal_from_snapshot(&snapshot, "codex");

        assert_eq!(signal.quota_remaining, Some(0.0));
        assert!(signal.provider_exhausted);
        assert!(signal.observed);
    }

    #[test]
    fn stale_or_unmeasured_quota_never_exhausts_a_provider() {
        for row in [
            json!({
                "id": "claude",
                "available": true,
                "measured": true,
                "metered": true,
                "stale": true,
                "windows": [{"remaining_percent": 0.0}]
            }),
            json!({
                "id": "claude",
                "available": false,
                "measured": false,
                "windows": []
            }),
        ] {
            let snapshot = json!({"providers": [row]});
            let signal =
                quota_signal_from_snapshot(&snapshot, "claude");

            assert_eq!(signal.quota_remaining, None);
            assert!(!signal.provider_exhausted);
            assert!(!signal.observed);
        }
    }

    #[test]
    fn devin_without_a_real_usage_source_remains_unknown() {
        let snapshot = json!({
            "providers": [{
                "id": "codex",
                "available": true,
                "measured": true,
                "metered": true,
                "windows": [{"remaining_percent": 50.0}]
            }]
        });

        let signal =
            quota_signal_from_snapshot(&snapshot, "devin");

        assert_eq!(signal.canonical_provider, "devin");
        assert_eq!(signal.usage_provider, "devin");
        assert_eq!(signal.quota_remaining, None);
        assert!(!signal.provider_exhausted);
        assert!(!signal.observed);
    }

    #[test]
    fn quota_adapter_populates_only_quota_fields() {
        let snapshot = json!({
            "providers": [{
                "id": "codex",
                "available": true,
                "measured": true,
                "metered": true,
                "windows": [{"remaining_percent": 37.0}]
            }]
        });

        let (candidates, quota) = attach_quota_from_snapshot(
            vec![worker("codex-impl", "codex")],
            &snapshot,
        );

        assert_eq!(candidates.len(), 1);
        assert_eq!(quota.len(), 1);

        let candidate = &candidates[0];
        assert_eq!(candidate.quota_remaining, Some(0.37));
        assert!(!candidate.provider_exhausted);

        assert_eq!(candidate.predicted_success, None);
        assert_eq!(candidate.expected_speed, None);
        assert_eq!(candidate.low_rework, None);
        assert_eq!(candidate.low_human_attention, None);
        assert_eq!(candidate.cost_efficiency, None);
    }
}

// ---------------------------------------------------------------------------
// Historical performance signals
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct HistoricalSignal {
    pub worker_name: String,
    pub task_kind: String,

    /// Completed attempts for this exact worker + classified task kind.
    pub completed_attempts: usize,

    /// `done` vs `failed` only. Other outcomes such as review/blocked/released
    /// do not prove success or failure and therefore are excluded.
    pub success_samples: usize,
    pub predicted_success: Option<f64>,

    /// Raw duration evidence retained for later relative speed normalization.
    pub speed_samples: usize,
    pub avg_agent_active_ms: Option<f64>,

    /// Direct first-pass evidence.
    pub rework_samples: usize,
    pub low_rework: Option<f64>,

    /// Average fraction of observed work time that did NOT require a human.
    pub attention_samples: usize,
    pub low_human_attention: Option<f64>,
}

/// Enrich already quota-attached candidates with historical evidence for the
/// current task kind.
///
/// No task-kind match means no history signal. There is deliberately no
/// cross-kind fallback: architecture history must not silently become evidence
/// about migrations.
///
/// `expected_speed` remains None until AMUX has enough same-kind cross-worker
/// history to normalize raw milliseconds without inventing an absolute scale.
pub(crate) fn attach_history(
    conn: &rusqlite::Connection,
    task_kind: &str,
    candidates: &mut [CandidateRoutingSignals],
) -> rusqlite::Result<Vec<HistoricalSignal>> {
    let mut out = Vec::with_capacity(candidates.len());

    for candidate in candidates {
        let signal = historical_signal(
            conn,
            &candidate.worker.worker_name,
            task_kind,
        )?;

        candidate.predicted_success = signal.predicted_success;
        candidate.low_rework = signal.low_rework;
        candidate.low_human_attention = signal.low_human_attention;

        // Raw agent_active_ms is retained in HistoricalSignal but deliberately
        // not converted to a 0..1 score without a relative baseline.
        candidate.expected_speed = None;

        // No reliable per-attempt provider cost/quota economics yet.
        candidate.cost_efficiency = None;

        out.push(signal);
    }

    Ok(out)
}

pub(crate) fn historical_signal(
    conn: &rusqlite::Connection,
    worker_name: &str,
    task_kind: &str,
) -> rusqlite::Result<HistoricalSignal> {
    let rows = match historical_rows(conn, worker_name, task_kind) {
        Ok(rows) => rows,
        Err(error)
            if error
                .to_string()
                .contains("no such table: task_attempts") =>
        {
            Vec::new()
        }
        Err(error) => return Err(error),
    };

    Ok(aggregate_history(worker_name, task_kind, &rows))
}

#[derive(Debug, Clone, PartialEq)]
struct HistoricalRow {
    outcome: Option<String>,
    agent_active_ms: Option<i64>,
    human_attention_ms: Option<i64>,
    first_pass: Option<bool>,
}

fn historical_rows(
    conn: &rusqlite::Connection,
    worker_name: &str,
    task_kind: &str,
) -> rusqlite::Result<Vec<HistoricalRow>> {
    let mut stmt = conn.prepare(
        "SELECT
             ta.outcome,
             tm.agent_active_ms,
             tm.human_attention_ms,
             tm.first_pass
         FROM task_attempts ta
         JOIN task_classification tc
           ON tc.task_id = ta.card
          AND tc.task_kind = ?2
         LEFT JOIN task_attempt_metrics tm
           ON tm.task_id = ta.card
          AND tm.attempt = ta.attempt
         WHERE ta.worker = ?1
           AND ta.ended_at IS NOT NULL
         ORDER BY ta.started_at ASC, ta.attempt ASC",
    )?;

    let rows = stmt.query_map(
        rusqlite::params![worker_name, task_kind],
        |row| {
            let first_pass: Option<i64> = row.get(3)?;

            Ok(HistoricalRow {
                outcome: row.get(0)?,
                agent_active_ms: row.get(1)?,
                human_attention_ms: row.get(2)?,
                first_pass: first_pass.map(|value| value != 0),
            })
        },
    )?;

    rows.collect()
}

fn aggregate_history(
    worker_name: &str,
    task_kind: &str,
    rows: &[HistoricalRow],
) -> HistoricalSignal {
    let mut success_sum = 0.0;
    let mut success_samples = 0usize;

    let mut speed_sum = 0.0;
    let mut speed_samples = 0usize;

    let mut rework_sum = 0.0;
    let mut rework_samples = 0usize;

    let mut attention_sum = 0.0;
    let mut attention_samples = 0usize;

    for row in rows {
        match row.outcome.as_deref() {
            Some("done") => {
                success_sum += 1.0;
                success_samples += 1;
            }
            Some("failed") => {
                success_samples += 1;
            }
            _ => {
                // review/blocked/parked/released/etc. are not adjudicated
                // success/failure evidence.
            }
        }

        if let Some(active_ms) = row.agent_active_ms.filter(|v| *v >= 0) {
            speed_sum += active_ms as f64;
            speed_samples += 1;
        }

        if let Some(first_pass) = row.first_pass {
            rework_sum += if first_pass { 1.0 } else { 0.0 };
            rework_samples += 1;
        }

        if let (Some(active), Some(human)) = (
            row.agent_active_ms.filter(|v| *v >= 0),
            row.human_attention_ms.filter(|v| *v >= 0),
        ) {
            let total = active + human;

            if total > 0 {
                attention_sum += active as f64 / total as f64;
                attention_samples += 1;
            }
        }
    }

    HistoricalSignal {
        worker_name: worker_name.to_string(),
        task_kind: task_kind.to_string(),
        completed_attempts: rows.len(),

        success_samples,
        predicted_success: ratio(success_sum, success_samples),

        speed_samples,
        avg_agent_active_ms: ratio(speed_sum, speed_samples),

        rework_samples,
        low_rework: ratio(rework_sum, rework_samples),

        attention_samples,
        low_human_attention: ratio(
            attention_sum,
            attention_samples,
        ),
    }
}

fn ratio(sum: f64, samples: usize) -> Option<f64> {
    (samples > 0).then(|| sum / samples as f64)
}

#[cfg(test)]
mod historical_tests {
    use super::*;

    fn row(
        outcome: Option<&str>,
        active: Option<i64>,
        human: Option<i64>,
        first_pass: Option<bool>,
    ) -> HistoricalRow {
        HistoricalRow {
            outcome: outcome.map(str::to_string),
            agent_active_ms: active,
            human_attention_ms: human,
            first_pass,
        }
    }

    #[test]
    fn empty_history_produces_no_invented_metrics() {
        let signal =
            aggregate_history("worker", "feature", &[]);

        assert_eq!(signal.completed_attempts, 0);
        assert_eq!(signal.predicted_success, None);
        assert_eq!(signal.avg_agent_active_ms, None);
        assert_eq!(signal.low_rework, None);
        assert_eq!(signal.low_human_attention, None);
    }

    #[test]
    fn success_uses_only_adjudicated_done_and_failed_outcomes() {
        let rows = vec![
            row(Some("done"), None, None, None),
            row(Some("failed"), None, None, None),
            row(Some("review"), None, None, None),
            row(Some("blocked"), None, None, None),
        ];

        let signal =
            aggregate_history("worker", "feature", &rows);

        assert_eq!(signal.completed_attempts, 4);
        assert_eq!(signal.success_samples, 2);
        assert_eq!(signal.predicted_success, Some(0.5));
    }

    #[test]
    fn first_pass_is_the_low_rework_signal() {
        let rows = vec![
            row(Some("done"), None, None, Some(true)),
            row(Some("done"), None, None, Some(true)),
            row(Some("done"), None, None, Some(false)),
        ];

        let signal =
            aggregate_history("worker", "bugfix", &rows);

        assert_eq!(signal.rework_samples, 3);
        assert!(
            (signal.low_rework.unwrap() - (2.0 / 3.0)).abs()
                < 1e-12
        );
    }

    #[test]
    fn human_attention_is_normalized_by_observed_work_time() {
        let rows = vec![
            // 90% agent / 10% human.
            row(Some("done"), Some(90), Some(10), None),
            // 50% agent / 50% human.
            row(Some("done"), Some(50), Some(50), None),
        ];

        let signal =
            aggregate_history("worker", "feature", &rows);

        assert_eq!(signal.attention_samples, 2);
        assert_eq!(signal.low_human_attention, Some(0.7));
    }

    #[test]
    fn active_time_is_retained_raw_not_pretended_to_be_a_speed_score() {
        let rows = vec![
            row(Some("done"), Some(1000), None, None),
            row(Some("done"), Some(3000), None, None),
        ];

        let signal =
            aggregate_history("worker", "feature", &rows);

        assert_eq!(signal.speed_samples, 2);
        assert_eq!(signal.avg_agent_active_ms, Some(2000.0));
    }
}

#[cfg(test)]
mod historical_db_tests {
    use super::*;

    fn schema(conn: &rusqlite::Connection) {
        conn.execute_batch(
            "
            CREATE TABLE task_attempts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                card TEXT NOT NULL,
                attempt INTEGER NOT NULL,
                worker TEXT NOT NULL,
                generation INTEGER NOT NULL,
                started_at INTEGER NOT NULL,
                ended_at INTEGER,
                outcome TEXT,
                to_status TEXT,
                ended_by TEXT,
                reason TEXT
            );

            CREATE TABLE task_classification (
                task_id TEXT PRIMARY KEY,
                task_kind TEXT NOT NULL,
                complexity INTEGER NOT NULL,
                risk INTEGER NOT NULL,
                files_expected_json TEXT,
                classified_by TEXT NOT NULL,
                classifier_version TEXT NOT NULL,
                classified_at INTEGER NOT NULL,
                confidence REAL NOT NULL,
                classification_method TEXT NOT NULL,
                classification_trace_json TEXT
            );

            CREATE TABLE task_attempt_metrics (
                task_id TEXT NOT NULL,
                attempt INTEGER NOT NULL,
                provider TEXT,
                model TEXT,
                agent_active_ms INTEGER,
                human_attention_ms INTEGER,
                quota_before_json TEXT,
                quota_after_json TEXT,
                files_changed INTEGER,
                tests_added INTEGER,
                human_interventions INTEGER NOT NULL DEFAULT 0,
                first_pass INTEGER,
                review_result TEXT,
                PRIMARY KEY (task_id, attempt)
            );
            ",
        )
        .unwrap();
    }

    #[test]
    fn historical_query_joins_exact_worker_attempt_and_task_kind() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        schema(&conn);

        conn.execute_batch(
            "
            INSERT INTO task_classification
                (task_id, task_kind, complexity, risk,
                 classified_by, classifier_version, classified_at,
                 confidence, classification_method)
            VALUES
                ('F-1', 'feature', 4, 1, 'rules', 'v1', 1, 1.0, 'rules'),
                ('F-2', 'feature', 4, 1, 'rules', 'v1', 1, 1.0, 'rules'),
                ('B-1', 'bugfix', 4, 1, 'rules', 'v1', 1, 1.0, 'rules');

            INSERT INTO task_attempts
                (card, attempt, worker, generation, started_at, ended_at, outcome)
            VALUES
                ('F-1', 1, 'codex-impl', 1, 10, 20, 'done'),
                ('F-2', 1, 'codex-impl', 1, 30, 40, 'failed'),
                ('B-1', 1, 'codex-impl', 1, 50, 60, 'done'),
                ('F-1', 2, 'claude-impl', 2, 70, 80, 'done');

            INSERT INTO task_attempt_metrics
                (task_id, attempt, agent_active_ms, human_attention_ms,
                 human_interventions, first_pass)
            VALUES
                ('F-1', 1, 900, 100, 0, 1),
                ('F-2', 1, 1500, 500, 1, 0),
                ('B-1', 1, 200, 0, 0, 1),
                ('F-1', 2, 300, 0, 0, 1);
            ",
        )
        .unwrap();

        let signal =
            historical_signal(&conn, "codex-impl", "feature").unwrap();

        assert_eq!(signal.completed_attempts, 2);
        assert_eq!(signal.success_samples, 2);
        assert_eq!(signal.predicted_success, Some(0.5));

        assert_eq!(signal.speed_samples, 2);
        assert_eq!(signal.avg_agent_active_ms, Some(1200.0));

        assert_eq!(signal.rework_samples, 2);
        assert_eq!(signal.low_rework, Some(0.5));

        assert_eq!(signal.attention_samples, 2);
        assert_eq!(signal.low_human_attention, Some(0.825));
    }

    #[test]
    fn missing_task_attempts_table_means_no_history_not_failure() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();

        let signal =
            historical_signal(&conn, "codex-impl", "feature").unwrap();

        assert_eq!(signal.completed_attempts, 0);
        assert_eq!(signal.predicted_success, None);
        assert_eq!(signal.avg_agent_active_ms, None);
        assert_eq!(signal.low_rework, None);
        assert_eq!(signal.low_human_attention, None);
    }
}
