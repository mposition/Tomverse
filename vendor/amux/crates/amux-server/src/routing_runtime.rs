//! Transactional bridge from routing facts to board ownership.
//!
//! This layer still does NOT claim or execute work. It:
//! 1. verifies a task is still an unowned To Do;
//! 2. reads its persisted classification;
//! 3. combines quota + historical evidence;
//! 4. runs the pure scorer;
//! 5. atomically records the route decision and assigns board ownership.
//!
//! The existing board-drive claim path remains responsible for:
//! todo -> doing, leases, task_attempts, worker wakeup and delivery.

use rusqlite::Connection;
use serde_json::Value;

use crate::db::board_store;
use crate::db::routing_store::{
    self, NewRouteDecision, TaskClassification,
};
use crate::routing_signals;
use crate::task_router::{
    self, RoutingScoreResult, RoutingTaskProfile,
};
use crate::worker_catalog::RoutingWorkerCandidate;

const ROUTE_SAVEPOINT: &str = "amux_intelligent_route";

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum RouteAssignmentOutcome {
    Assigned {
        task_id: String,
        preferred_worker: Option<String>,
        selected_worker: String,
        selected_score: Option<f64>,
    },
    Unclassified {
        task_id: String,
    },
    NotEligible {
        task_id: String,
    },
    NoSelection {
        task_id: String,
        preferred_worker: Option<String>,
    },
}

/// Score and assign one known task using one already-captured usage snapshot.
///
/// The mutable pair — board ownership plus route-decision persistence — is
/// protected by a SQLite SAVEPOINT. This remains atomic both standalone and
/// when the caller is already inside Store::write_async's write transaction.
pub(crate) fn route_one_unassigned_with_snapshot(
    conn: &Connection,
    task_id: &str,
    workers: Vec<RoutingWorkerCandidate>,
    usage_snapshot: &Value,
    now: i64,
) -> rusqlite::Result<RouteAssignmentOutcome> {
    if !still_unowned_todo(conn, task_id)? {
        return Ok(RouteAssignmentOutcome::NotEligible {
            task_id: task_id.to_string(),
        });
    }

    let Some(classification) =
        routing_store::get_classification(conn, task_id)?
    else {
        return Ok(RouteAssignmentOutcome::Unclassified {
            task_id: task_id.to_string(),
        });
    };

    let (mut candidates, quota) =
        routing_signals::attach_quota_from_snapshot(
            workers,
            usage_snapshot,
        );

    let _history = routing_signals::attach_history(
        conn,
        &classification.task_kind,
        &mut candidates,
    )?;

    let profile = task_profile(&classification);
    let score =
        task_router::score_execute_candidates(&profile, &candidates);

    let Some(selected_worker) = score.selected_worker.clone() else {
        return Ok(RouteAssignmentOutcome::NoSelection {
            task_id: task_id.to_string(),
            preferred_worker: score.preferred_worker.clone(),
        });
    };

    let decision = build_decision(
        task_id,
        &classification,
        &score,
        &quota,
        now,
    )?;

    let assigned = persist_assignment_and_decision(
        conn,
        task_id,
        &selected_worker,
        &decision,
        now,
    )?;

    if !assigned {
        return Ok(RouteAssignmentOutcome::NotEligible {
            task_id: task_id.to_string(),
        });
    }

    Ok(RouteAssignmentOutcome::Assigned {
        task_id: task_id.to_string(),
        preferred_worker: score.preferred_worker,
        selected_worker,
        selected_score: score.selected_score,
    })
}

fn still_unowned_todo(
    conn: &Connection,
    task_id: &str,
) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(
             SELECT 1
               FROM issues
              WHERE id = ?1
                AND deleted IS NULL
                AND COALESCE(archived, 0) = 0
                AND owner_type = 'agent'
                AND status = 'todo'
                AND COALESCE(type, '') != 'epic'
                AND (session IS NULL OR trim(session) = '')
                AND (lease_owner IS NULL OR trim(lease_owner) = '')
         )",
        [task_id],
        |row| row.get::<_, i64>(0),
    )
    .map(|value| value != 0)
}

fn task_profile(
    classification: &TaskClassification,
) -> RoutingTaskProfile {
    RoutingTaskProfile {
        task_kind: classification.task_kind.clone(),
        complexity: classification.complexity,
        risk: classification.risk,
        files_expected: files_expected_count(
            classification.files_expected_json.as_deref(),
        ),
    }
}

fn files_expected_count(raw: Option<&str>) -> Option<usize> {
    let raw = raw?.trim();

    if raw.is_empty() {
        return None;
    }

    let value: Value = serde_json::from_str(raw).ok()?;

    match value {
        Value::Array(items) => Some(items.len()),
        Value::Number(number) => {
            number.as_u64().and_then(|n| usize::try_from(n).ok())
        }
        _ => None,
    }
}

fn build_decision(
    task_id: &str,
    classification: &TaskClassification,
    score: &RoutingScoreResult,
    quota: &[routing_signals::QuotaSignal],
    now: i64,
) -> rusqlite::Result<NewRouteDecision> {
    let score_breakdown_json =
        serde_json::to_string(score).map_err(json_sql_error)?;

    let quota_snapshot_json =
        serde_json::to_string(quota).map_err(json_sql_error)?;

    let preferred = score
        .preferred_worker
        .as_deref()
        .unwrap_or("none");

    let selected = score
        .selected_worker
        .as_deref()
        .unwrap_or("none");

    Ok(NewRouteDecision {
        task_id: task_id.to_string(),
        phase: "execute".to_string(),

        // Ownership assignment precedes the execution attempt.
        attempt: None,

        preferred_worker: score.preferred_worker.clone(),
        selected_worker: score.selected_worker.clone(),
        routing_score: score.selected_score,
        score_breakdown_json: Some(score_breakdown_json),
        routing_reason: format!(
            "intelligent-routing owner assignment; \
             task_kind={}; classifier={}; preferred={}; selected={}",
            classification.task_kind,
            classification.classification_method,
            preferred,
            selected,
        ),
        quota_snapshot_json: Some(quota_snapshot_json),
        created_at: now,
    })
}

/// Commit owner assignment and explainable decision as one mutation.
///
/// A failed decision insert rolls the owner assignment back. A lost ownership
/// CAS records no decision, because that scorer result never became board truth.
fn persist_assignment_and_decision(
    conn: &Connection,
    task_id: &str,
    selected_worker: &str,
    decision: &NewRouteDecision,
    now: i64,
) -> rusqlite::Result<bool> {
    conn.execute_batch(&format!(
        "SAVEPOINT {ROUTE_SAVEPOINT}"
    ))?;

    let result = (|| -> rusqlite::Result<bool> {
        let assigned = board_store::assign_unowned_todo(
            conn,
            task_id,
            selected_worker,
            now,
        )?;

        if !assigned {
            return Ok(false);
        }

        routing_store::insert_route_decision(conn, decision)?;

        Ok(true)
    })();

    match result {
        Ok(true) => {
            conn.execute_batch(&format!(
                "RELEASE SAVEPOINT {ROUTE_SAVEPOINT}"
            ))?;
            Ok(true)
        }
        Ok(false) => {
            conn.execute_batch(&format!(
                "ROLLBACK TO SAVEPOINT {ROUTE_SAVEPOINT}; \
                 RELEASE SAVEPOINT {ROUTE_SAVEPOINT}"
            ))?;
            Ok(false)
        }
        Err(error) => {
            let _ = conn.execute_batch(&format!(
                "ROLLBACK TO SAVEPOINT {ROUTE_SAVEPOINT}; \
                 RELEASE SAVEPOINT {ROUTE_SAVEPOINT}"
            ));
            Err(error)
        }
    }
}

fn json_sql_error(
    error: serde_json::Error,
) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn schema(conn: &Connection) {
        conn.execute_batch(
            "
            CREATE TABLE issues (
                id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                session TEXT,
                owner_type TEXT NOT NULL,
                archived INTEGER NOT NULL DEFAULT 0,
                deleted INTEGER,
                rev INTEGER NOT NULL DEFAULT 0,
                version INTEGER NOT NULL DEFAULT 0,
                updated INTEGER NOT NULL DEFAULT 0,
                lease_owner TEXT,
                type TEXT NOT NULL DEFAULT 'code'
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

            CREATE TABLE task_route_decisions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL,
                phase TEXT NOT NULL,
                attempt INTEGER,
                preferred_worker TEXT,
                selected_worker TEXT,
                routing_score REAL,
                score_breakdown_json TEXT,
                routing_reason TEXT NOT NULL,
                quota_snapshot_json TEXT,
                created_at INTEGER NOT NULL
            );

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

    fn add_issue(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT INTO issues (
                 id, status, session, owner_type, archived,
                 rev, version, updated, lease_owner
             ) VALUES (?1, 'todo', NULL, 'agent', 0, 2, 3, 10, NULL)",
            [id],
        )
        .unwrap();
    }

    fn classify(
        conn: &Connection,
        id: &str,
        kind: &str,
        complexity: i64,
    ) {
        conn.execute(
            "INSERT INTO task_classification (
                 task_id, task_kind, complexity, risk,
                 files_expected_json, classified_by,
                 classifier_version, classified_at,
                 confidence, classification_method,
                 classification_trace_json
             ) VALUES (
                 ?1, ?2, ?3, 1,
                 '[\"a.rs\",\"b.rs\"]', 'test',
                 'test-v1', 1,
                 1.0, 'rules', NULL
             )",
            rusqlite::params![id, kind, complexity],
        )
        .unwrap();
    }

    fn worker(
        name: &str,
        provider: &str,
        roles: &[&str],
    ) -> RoutingWorkerCandidate {
        RoutingWorkerCandidate {
            worker_name: name.to_string(),
            provider: provider.to_string(),
            model: None,
            routing_roles: roles
                .iter()
                .map(|role| (*role).to_string())
                .collect(),
            running: true,
            status: "idle".into(),
            dispatch_ready: true,
            archived: false,
            paused: false,
            isolated: false,
            blocked: false,
        }
    }

    fn usage() -> Value {
        json!({
            "providers": [
                {
                    "id": "codex",
                    "available": true,
                    "measured": true,
                    "metered": true,
                    "windows": [
                        {"remaining_percent": 74.0}
                    ]
                },
                {
                    "id": "claude",
                    "available": true,
                    "measured": true,
                    "metered": true,
                    "windows": [
                        {"remaining_percent": 74.0}
                    ]
                }
            ]
        })
    }

    #[test]
    fn successful_route_assigns_owner_and_persists_explainable_decision() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        add_issue(&conn, "R-1");
        classify(&conn, "R-1", "feature", 4);

        let outcome = route_one_unassigned_with_snapshot(
            &conn,
            "R-1",
            vec![
                worker(
                    "codex-impl",
                    "codex",
                    &["feature", "implementation"],
                ),
                worker(
                    "claude-review",
                    "claude",
                    &["review", "security"],
                ),
            ],
            &usage(),
            1234,
        )
        .unwrap();

        assert!(matches!(
            outcome,
            RouteAssignmentOutcome::Assigned {
                ref selected_worker,
                ..
            } if selected_worker == "codex-impl"
        ));

        let board: (
            String,
            Option<String>,
            i64,
            i64,
            i64,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT status, session, rev, version, updated, lease_owner
                   FROM issues WHERE id='R-1'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .unwrap();

        assert_eq!(board.0, "todo");
        assert_eq!(board.1.as_deref(), Some("codex-impl"));
        assert_eq!(board.2, 3);
        assert_eq!(board.3, 4);
        assert_eq!(board.4, 1234);
        assert_eq!(board.5, None);

        let decision: (
            String,
            Option<i64>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT phase, attempt, preferred_worker, selected_worker,
                        score_breakdown_json, quota_snapshot_json
                   FROM task_route_decisions
                  WHERE task_id='R-1'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .unwrap();

        assert_eq!(decision.0, "execute");
        assert_eq!(decision.1, None);
        assert_eq!(decision.3.as_deref(), Some("codex-impl"));
        assert!(decision.4.is_some());
        assert!(decision.5.is_some());

        // Ownership assignment is not an execution attempt.
        let attempts: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM task_attempts",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(attempts, 0);
    }

    #[test]
    fn unclassified_task_remains_unowned_and_records_no_decision() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        add_issue(&conn, "R-2");

        let outcome = route_one_unassigned_with_snapshot(
            &conn,
            "R-2",
            vec![worker(
                "codex-impl",
                "codex",
                &["feature"],
            )],
            &usage(),
            1234,
        )
        .unwrap();

        assert_eq!(
            outcome,
            RouteAssignmentOutcome::Unclassified {
                task_id: "R-2".into()
            }
        );

        let owner: Option<String> = conn
            .query_row(
                "SELECT session FROM issues WHERE id='R-2'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(owner, None);

        let decisions: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM task_route_decisions",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(decisions, 0);
    }

    #[test]
    fn operator_disabled_workers_produce_no_assignment() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        add_issue(&conn, "R-3");
        classify(&conn, "R-3", "feature", 4);

        let mut blocked = worker(
            "codex-impl",
            "codex",
            &["feature", "implementation"],
        );
        blocked.blocked = true;

        let outcome = route_one_unassigned_with_snapshot(
            &conn,
            "R-3",
            vec![blocked],
            &usage(),
            1234,
        )
        .unwrap();

        assert!(matches!(
            outcome,
            RouteAssignmentOutcome::NoSelection { .. }
        ));

        let owner: Option<String> = conn
            .query_row(
                "SELECT session FROM issues WHERE id='R-3'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(owner, None);
    }

    #[test]
    fn an_existing_owner_wins_the_cas_and_gets_no_new_route_decision() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        add_issue(&conn, "R-4");
        classify(&conn, "R-4", "feature", 4);

        conn.execute(
            "UPDATE issues SET session='human-picked' WHERE id='R-4'",
            [],
        )
        .unwrap();

        let outcome = route_one_unassigned_with_snapshot(
            &conn,
            "R-4",
            vec![worker(
                "codex-impl",
                "codex",
                &["feature"],
            )],
            &usage(),
            1234,
        )
        .unwrap();

        assert_eq!(
            outcome,
            RouteAssignmentOutcome::NotEligible {
                task_id: "R-4".into()
            }
        );

        let decisions: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM task_route_decisions",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(decisions, 0);
    }

    #[test]
    fn failed_decision_insert_rolls_back_owner_assignment() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        add_issue(&conn, "R-5");
        classify(&conn, "R-5", "feature", 4);

        // Force the second half of the atomic pair to fail AFTER the owner
        // assignment UPDATE has succeeded.
        conn.execute_batch(
            "
            CREATE TRIGGER reject_route_decision
            BEFORE INSERT ON task_route_decisions
            BEGIN
                SELECT RAISE(ABORT, 'forced route-decision failure');
            END;
            ",
        )
        .unwrap();

        let result = route_one_unassigned_with_snapshot(
            &conn,
            "R-5",
            vec![worker(
                "codex-impl",
                "codex",
                &["feature", "implementation"],
            )],
            &usage(),
            1234,
        );

        assert!(
            result.is_err(),
            "forced decision persistence failure must surface"
        );

        let board: (Option<String>, i64, i64, i64) = conn
            .query_row(
                "SELECT session, rev, version, updated
                   FROM issues
                  WHERE id='R-5'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                    ))
                },
            )
            .unwrap();

        // SAVEPOINT rollback must erase the preceding ownership mutation too.
        assert_eq!(board.0, None);
        assert_eq!(board.1, 2);
        assert_eq!(board.2, 3);
        assert_eq!(board.3, 10);

        let decisions: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM task_route_decisions",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(decisions, 0);
    }

    #[test]
    fn epic_is_never_worker_route_eligible() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        add_issue(&conn, "EPIC-1");
        classify(&conn, "EPIC-1", "feature", 8);

        conn.execute(
            "UPDATE issues SET type='epic' WHERE id='EPIC-1'",
            [],
        )
        .unwrap();

        let outcome = route_one_unassigned_with_snapshot(
            &conn,
            "EPIC-1",
            vec![worker(
                "codex-impl",
                "codex",
                &["feature", "implementation"],
            )],
            &usage(),
            1234,
        )
        .unwrap();

        assert_eq!(
            outcome,
            RouteAssignmentOutcome::NotEligible {
                task_id: "EPIC-1".into()
            }
        );

        let owner: Option<String> = conn
            .query_row(
                "SELECT session FROM issues WHERE id='EPIC-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(owner, None);

        let decisions: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM task_route_decisions",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(decisions, 0);
    }

    #[test]
    fn files_expected_count_accepts_array_or_numeric_evidence_only() {
        assert_eq!(
            files_expected_count(Some(r#"["a","b","c"]"#)),
            Some(3)
        );
        assert_eq!(
            files_expected_count(Some("7")),
            Some(7)
        );
        assert_eq!(
            files_expected_count(Some(r#"{"guess":7}"#)),
            None
        );
        assert_eq!(files_expected_count(None), None);
    }
}
