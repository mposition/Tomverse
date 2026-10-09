//! Persistence for intelligent task routing.
//!
//! Board state owns lifecycle and assignment. `task_attempts` owns durable
//! execution attempts. This module stores only what those structures do not:
//! classification, explainable route decisions and per-attempt economics.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TaskClassification {
    pub task_id: String,
    pub task_kind: String,
    pub complexity: i64,
    pub risk: i64,
    pub files_expected_json: Option<String>,
    pub classified_by: String,
    pub classifier_version: String,
    pub classified_at: i64,
    pub confidence: f64,
    pub classification_method: String,
    pub classification_trace_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NewRouteDecision {
    pub task_id: String,
    pub phase: String,
    pub attempt: Option<i64>,
    pub preferred_worker: Option<String>,
    pub selected_worker: Option<String>,
    pub routing_score: Option<f64>,
    pub score_breakdown_json: Option<String>,
    pub routing_reason: String,
    pub quota_snapshot_json: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RouteDecisionRow {
    pub id: i64,
    pub task_id: String,
    pub phase: String,
    pub attempt: Option<i64>,
    pub preferred_worker: Option<String>,
    pub selected_worker: Option<String>,
    pub routing_score: Option<f64>,
    pub score_breakdown_json: Option<String>,
    pub routing_reason: String,
    pub quota_snapshot_json: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AttemptMetrics {
    pub task_id: String,
    pub attempt: i64,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub agent_active_ms: Option<i64>,
    pub human_attention_ms: Option<i64>,
    pub quota_before_json: Option<String>,
    pub quota_after_json: Option<String>,
    pub files_changed: Option<i64>,
    pub tests_added: Option<i64>,
    pub human_interventions: i64,
    pub first_pass: Option<bool>,
    pub review_result: Option<String>,
}

pub fn upsert_classification(conn: &Connection, row: &TaskClassification) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT INTO task_classification (
             task_id, task_kind, complexity, risk, files_expected_json,
             classified_by, classifier_version, classified_at,
             confidence, classification_method, classification_trace_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(task_id) DO UPDATE SET
             task_kind=excluded.task_kind,
             complexity=excluded.complexity,
             risk=excluded.risk,
             files_expected_json=excluded.files_expected_json,
             classified_by=excluded.classified_by,
             classifier_version=excluded.classifier_version,
             classified_at=excluded.classified_at,
             confidence=excluded.confidence,
             classification_method=excluded.classification_method,
             classification_trace_json=excluded.classification_trace_json",
        params![
            row.task_id,
            row.task_kind,
            row.complexity,
            row.risk,
            row.files_expected_json,
            row.classified_by,
            row.classifier_version,
            row.classified_at,
            row.confidence,
            row.classification_method,
            row.classification_trace_json,
        ],
    )
}

pub fn get_classification(conn: &Connection, task_id: &str) -> rusqlite::Result<Option<TaskClassification>> {
    conn.query_row(
        "SELECT task_id, task_kind, complexity, risk, files_expected_json,
                classified_by, classifier_version, classified_at,
                confidence, classification_method, classification_trace_json
         FROM task_classification
         WHERE task_id = ?1",
        [task_id],
        |r| {
            Ok(TaskClassification {
                task_id: r.get(0)?,
                task_kind: r.get(1)?,
                complexity: r.get(2)?,
                risk: r.get(3)?,
                files_expected_json: r.get(4)?,
                classified_by: r.get(5)?,
                classifier_version: r.get(6)?,
                classified_at: r.get(7)?,
                confidence: r.get(8)?,
                classification_method: r.get(9)?,
                classification_trace_json: r.get(10)?,
            })
        },
    )
    .optional()
}

pub fn insert_route_decision(conn: &Connection, row: &NewRouteDecision) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO task_route_decisions (
             task_id, phase, attempt, preferred_worker, selected_worker,
             routing_score, score_breakdown_json, routing_reason,
             quota_snapshot_json, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            row.task_id,
            row.phase,
            row.attempt,
            row.preferred_worker,
            row.selected_worker,
            row.routing_score,
            row.score_breakdown_json,
            row.routing_reason,
            row.quota_snapshot_json,
            row.created_at,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_route_decisions(conn: &Connection, task_id: &str) -> rusqlite::Result<Vec<RouteDecisionRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, task_id, phase, attempt, preferred_worker, selected_worker,
                routing_score, score_breakdown_json, routing_reason,
                quota_snapshot_json, created_at
         FROM task_route_decisions
         WHERE task_id = ?1
         ORDER BY created_at ASC, id ASC",
    )?;
    let rows = stmt.query_map([task_id], |r| {
        Ok(RouteDecisionRow {
            id: r.get(0)?,
            task_id: r.get(1)?,
            phase: r.get(2)?,
            attempt: r.get(3)?,
            preferred_worker: r.get(4)?,
            selected_worker: r.get(5)?,
            routing_score: r.get(6)?,
            score_breakdown_json: r.get(7)?,
            routing_reason: r.get(8)?,
            quota_snapshot_json: r.get(9)?,
            created_at: r.get(10)?,
        })
    })?;
    rows.collect()
}

pub fn upsert_attempt_metrics(conn: &Connection, row: &AttemptMetrics) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT INTO task_attempt_metrics (
             task_id, attempt, provider, model, agent_active_ms,
             human_attention_ms, quota_before_json, quota_after_json,
             files_changed, tests_added, human_interventions, first_pass,
             review_result
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(task_id, attempt) DO UPDATE SET
             provider=excluded.provider,
             model=excluded.model,
             agent_active_ms=excluded.agent_active_ms,
             human_attention_ms=excluded.human_attention_ms,
             quota_before_json=excluded.quota_before_json,
             quota_after_json=excluded.quota_after_json,
             files_changed=excluded.files_changed,
             tests_added=excluded.tests_added,
             human_interventions=excluded.human_interventions,
             first_pass=excluded.first_pass,
             review_result=excluded.review_result",
        params![
            row.task_id,
            row.attempt,
            row.provider,
            row.model,
            row.agent_active_ms,
            row.human_attention_ms,
            row.quota_before_json,
            row.quota_after_json,
            row.files_changed,
            row.tests_added,
            row.human_interventions,
            row.first_pass.map(|v| if v { 1i64 } else { 0i64 }),
            row.review_result,
        ],
    )
}

pub fn get_attempt_metrics(conn: &Connection, task_id: &str, attempt: i64) -> rusqlite::Result<Option<AttemptMetrics>> {
    conn.query_row(
        "SELECT task_id, attempt, provider, model, agent_active_ms,
                human_attention_ms, quota_before_json, quota_after_json,
                files_changed, tests_added, human_interventions, first_pass,
                review_result
         FROM task_attempt_metrics
         WHERE task_id = ?1 AND attempt = ?2",
        params![task_id, attempt],
        |r| {
            let first_pass: Option<i64> = r.get(11)?;
            Ok(AttemptMetrics {
                task_id: r.get(0)?,
                attempt: r.get(1)?,
                provider: r.get(2)?,
                model: r.get(3)?,
                agent_active_ms: r.get(4)?,
                human_attention_ms: r.get(5)?,
                quota_before_json: r.get(6)?,
                quota_after_json: r.get(7)?,
                files_changed: r.get(8)?,
                tests_added: r.get(9)?,
                human_interventions: r.get(10)?,
                first_pass: first_pass.map(|v| v != 0),
                review_result: r.get(12)?,
            })
        },
    )
    .optional()
}


pub const DETERMINISTIC_CLASSIFIER_VERSION: &str = "deterministic-v1";
pub const DETERMINISTIC_CLASSIFIED_BY: &str = "amux:deterministic-rules";

/// Run the pure first-stage classifier and persist its result for `task_id`.
///
/// This is the bridge between `amux-core`'s deterministic policy and the
/// server's durable routing metadata.  Model escalation is deliberately not
/// performed here: `needs_model` is recorded in the trace for the next stage.
pub fn persist_deterministic_classification(
    conn: &Connection,
    task_id: &str,
    input: &amux_core::task_classifier::ClassificationInput<'_>,
    classified_at: i64,
) -> rusqlite::Result<amux_core::task_classifier::DeterministicClassification> {
    let result = amux_core::task_classifier::classify(input);

    let files_expected_json = if input.expected_files.is_empty() {
        None
    } else {
        Some(
            serde_json::Value::Array(
                input
                    .expected_files
                    .iter()
                    .cloned()
                    .map(serde_json::Value::String)
                    .collect(),
            )
            .to_string(),
        )
    };

    let trace = serde_json::json!({
        "stage": "deterministic",
        "classifier_version": DETERMINISTIC_CLASSIFIER_VERSION,
        "risk_floor": result.risk_floor,
        "signals": result.signals,
        "needs_model": result.needs_model,
    })
    .to_string();

    let row = TaskClassification {
        task_id: task_id.to_string(),
        task_kind: result.task_kind.as_str().to_string(),
        complexity: i64::from(result.complexity),
        risk: i64::from(result.risk),
        files_expected_json,
        classified_by: DETERMINISTIC_CLASSIFIED_BY.to_string(),
        classifier_version: DETERMINISTIC_CLASSIFIER_VERSION.to_string(),
        classified_at,
        confidence: result.confidence,
        classification_method: "rules".to_string(),
        classification_trace_json: Some(trace),
    };

    upsert_classification(conn, &row)?;
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../migrations/0081_task_intelligent_routing.sql"))
            .unwrap();
        conn.execute_batch(include_str!("../../migrations/0082_task_classification_provenance.sql"))
            .unwrap();
        conn
    }

    #[test]
    fn classification_round_trips_and_upserts() {
        let conn = db();
        let mut row = TaskClassification {
            task_id: "T-1".into(),
            task_kind: "feature".into(),
            complexity: 6,
            risk: 2,
            files_expected_json: Some(r#"["src/auth.rs"]"#.into()),
            classified_by: "claude-architect".into(),
            classifier_version: "v1".into(),
            classified_at: 100,
            confidence: 0.82,
            classification_method: "hybrid".into(),
            classification_trace_json: Some(
                r#"{"rules":{"risk_floor":2},"models":[{"tier":"normal","model":"test-model"}]}"#.into(),
            ),
        };
        upsert_classification(&conn, &row).unwrap();
        assert_eq!(get_classification(&conn, "T-1").unwrap(), Some(row.clone()));
        row.complexity = 8;
        row.classified_at = 200;
        row.confidence = 0.96;
        row.classification_method = "premium_adjudication".into();
        upsert_classification(&conn, &row).unwrap();
        assert_eq!(get_classification(&conn, "T-1").unwrap(), Some(row));
    }

    #[test]
    fn route_decisions_are_append_only_and_ordered() {
        let conn = db();
        let base = NewRouteDecision {
            task_id: "T-2".into(),
            phase: "execute".into(),
            attempt: Some(1),
            preferred_worker: Some("devin-worker".into()),
            selected_worker: Some("devin-worker".into()),
            routing_score: Some(0.91),
            score_breakdown_json: Some(r#"{"task_fit":0.95}"#.into()),
            routing_reason: "best task fit".into(),
            quota_snapshot_json: Some(r#"{"devin":{"remaining":0.8}}"#.into()),
            created_at: 100,
        };
        insert_route_decision(&conn, &base).unwrap();
        let mut second = base.clone();
        second.selected_worker = Some("codex-impl".into());
        second.routing_reason = "Devin capacity exhausted".into();
        second.created_at = 200;
        insert_route_decision(&conn, &second).unwrap();
        let rows = list_route_decisions(&conn, "T-2").unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].selected_worker.as_deref(), Some("devin-worker"));
        assert_eq!(rows[1].selected_worker.as_deref(), Some("codex-impl"));
        assert!(rows[0].id < rows[1].id);
    }

    #[test]
    fn attempt_metrics_round_trip() {
        let conn = db();
        let row = AttemptMetrics {
            task_id: "T-3".into(),
            attempt: 1,
            provider: Some("devin".into()),
            model: Some("SWE-2 High".into()),
            agent_active_ms: Some(120_000),
            human_attention_ms: Some(5_000),
            quota_before_json: Some(r#"{"remaining":1.0}"#.into()),
            quota_after_json: Some(r#"{"remaining":0.96}"#.into()),
            files_changed: Some(7),
            tests_added: Some(4),
            human_interventions: 1,
            first_pass: Some(true),
            review_result: Some("pass".into()),
        };
        upsert_attempt_metrics(&conn, &row).unwrap();
        assert_eq!(get_attempt_metrics(&conn, "T-3", 1).unwrap(), Some(row));
    }

    #[test]
    fn migration_constraints_reject_bad_classification() {
        let conn = db();
        let bad = TaskClassification {
            task_id: "T-4".into(),
            task_kind: "made_up".into(),
            complexity: 11,
            risk: 4,
            files_expected_json: None,
            classified_by: "test".into(),
            classifier_version: "v1".into(),
            classified_at: 1,
            confidence: 0.5,
            classification_method: "rules".into(),
            classification_trace_json: None,
        };
        assert!(upsert_classification(&conn, &bad).is_err());
    }

    #[test]
    fn migration_constraints_reject_bad_classification_provenance() {
        let conn = db();
        let mut row = TaskClassification {
            task_id: "T-5".into(),
            task_kind: "feature".into(),
            complexity: 5,
            risk: 2,
            files_expected_json: None,
            classified_by: "test".into(),
            classifier_version: "v1".into(),
            classified_at: 1,
            confidence: 1.1,
            classification_method: "rules".into(),
            classification_trace_json: None,
        };
        assert!(upsert_classification(&conn, &row).is_err());

        row.confidence = 0.8;
        row.classification_method = "made_up".into();
        assert!(upsert_classification(&conn, &row).is_err());
    }

    #[test]
    fn deterministic_bridge_persists_task_id_files_and_escalation_trace() {
        let conn = db();
        let tags = vec!["database".to_string()];
        let files = vec![
            "migrations/0083_add_index.sql".to_string(),
            "src/db/store.rs".to_string(),
        ];
        let input = amux_core::task_classifier::ClassificationInput {
            title: "Perform PostgreSQL schema migration",
            desc: "Migrate the database schema and backfill existing rows.",
            item_type: amux_core::board::ItemType::Code,
            tags: &tags,
            expected_files: &files,
        };

        let result =
            persist_deterministic_classification(&conn, "AMUX-9001", &input, 1234).unwrap();
        assert_eq!(
            result.task_kind,
            amux_core::task_classifier::TaskKind::Migration
        );
        assert_eq!(result.risk, 3);
        assert!(result.needs_model);

        let row = get_classification(&conn, "AMUX-9001").unwrap().unwrap();
        assert_eq!(row.task_id, "AMUX-9001");
        assert_eq!(row.task_kind, "migration");
        assert_eq!(row.risk, 3);
        assert_eq!(row.classification_method, "rules");
        assert_eq!(
            row.classifier_version,
            DETERMINISTIC_CLASSIFIER_VERSION
        );
        assert_eq!(row.classified_by, DETERMINISTIC_CLASSIFIED_BY);

        let expected_files: serde_json::Value =
            serde_json::from_str(row.files_expected_json.as_deref().unwrap()).unwrap();
        assert_eq!(expected_files.as_array().unwrap().len(), 2);

        let trace: serde_json::Value =
            serde_json::from_str(row.classification_trace_json.as_deref().unwrap()).unwrap();
        assert_eq!(trace["stage"], "deterministic");
        assert_eq!(trace["risk_floor"], 3);
        assert_eq!(trace["needs_model"], true);
        assert!(trace["signals"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s == "risk:db_migration"));
    }

    #[test]
    fn deterministic_bridge_leaves_empty_expected_files_null() {
        let conn = db();
        let tags = vec!["docs".to_string()];
        let files = Vec::<String>::new();
        let input = amux_core::task_classifier::ClassificationInput {
            title: "Fix typo in README",
            desc: "Correct spelling only.",
            item_type: amux_core::board::ItemType::Doc,
            tags: &tags,
            expected_files: &files,
        };

        let result =
            persist_deterministic_classification(&conn, "AMUX-9002", &input, 5678).unwrap();
        assert!(!result.needs_model);

        let row = get_classification(&conn, "AMUX-9002").unwrap().unwrap();
        assert_eq!(row.task_kind, "iteration");
        assert_eq!(row.risk, 1);
        assert_eq!(row.complexity, 1);
        assert_eq!(row.confidence, 0.97);
        assert!(row.files_expected_json.is_none());

        let trace: serde_json::Value =
            serde_json::from_str(row.classification_trace_json.as_deref().unwrap()).unwrap();
        assert_eq!(trace["needs_model"], false);
    }
}
