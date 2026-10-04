//! Post-attempt intelligent-routing telemetry finalization.
//!
//! Attempt lifecycle truth remains in `task_attempts`.  This module enriches
//! the supplemental `task_attempt_metrics` row only after an attempt has ended.
//!
//! No provider/network I/O belongs in the DB transaction.  The async caller
//! obtains one shared usage snapshot first, then passes it to the pure writer
//! below.

use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::api::AppState;

const JOB: &str =
    super::registry::ids::ROUTING_TELEMETRY;
const TICK_SECS: u64 = 30;
const QUOTA_AFTER_MAX_LAG_S: i64 = 300;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FinalizeReport {
    pub considered: usize,
    pub finalized: usize,
    pub stale: usize,
}

/// Effective wall-clock time represented by the shared usage snapshot.
///
/// The production usage surface is cached. `requested_at` is therefore NOT
/// automatically the quota observation time. `cache_age_s` is the outer
/// cache's explicit age contract and is preferred because it also remains
/// conservative when one provider is served from stale fallback.
///
/// No provenance means no timestamp: callers must defer rather than invent one.
fn snapshot_observed_at(
    snapshot: &Value,
    requested_at: i64,
) -> Option<i64> {
    if let Some(age) = snapshot
        .get("cache_age_s")
        .and_then(Value::as_u64)
    {
        let age = i64::try_from(age).unwrap_or(i64::MAX);
        return Some(requested_at.saturating_sub(age));
    }

    snapshot
        .get("observed_at")
        .and_then(Value::as_i64)
        .filter(|observed| *observed <= requested_at)
}

/// Finalize quota-after for ended attempts whose claim-time metrics row exists.
///
/// `usage_snapshot` was obtained OUTSIDE this DB write.  We never manufacture a
/// historical quota reading: if finalization is more than five minutes late,
/// persist an explicit unmeasured marker instead of pretending today's quota
/// was the quota at attempt end.
pub(crate) fn finalize_quota_after_from_snapshot(
    conn: &Connection,
    usage_snapshot: &Value,
    observed_at: i64,
) -> rusqlite::Result<FinalizeReport> {
    let mut stmt = conn.prepare(
        "SELECT
             ta.card,
             ta.attempt,
             ta.ended_at,
             tm.provider
         FROM task_attempts ta
         JOIN task_attempt_metrics tm
           ON tm.task_id = ta.card
          AND tm.attempt = ta.attempt
        WHERE ta.ended_at IS NOT NULL
          AND ta.ended_at <= ?1
          AND tm.quota_after_json IS NULL
        ORDER BY ta.ended_at ASC, ta.card ASC, ta.attempt ASC
        LIMIT 128",
    )?;

    let rows = stmt
        .query_map([observed_at], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    drop(stmt);

    let mut report = FinalizeReport {
        considered: rows.len(),
        finalized: 0,
        stale: 0,
    };

    for (task_id, attempt, ended_at, provider) in rows {
        let lag_s = observed_at.saturating_sub(ended_at);

        let payload = if lag_s > QUOTA_AFTER_MAX_LAG_S {
            report.stale += 1;
            json!({
                "observed": false,
                "reason": "finalization_lag_exceeded",
                "attempt_ended_at": ended_at,
                "observed_at": observed_at,
                "lag_s": lag_s,
                "max_lag_s": QUOTA_AFTER_MAX_LAG_S
            })
        } else if let Some(provider) =
            provider.as_deref().filter(|p| !p.trim().is_empty())
        {
            let signal =
                crate::routing_signals::quota_signal_from_snapshot(
                    usage_snapshot,
                    provider,
                );

            json!({
                "attempt_ended_at": ended_at,
                "observed_at": observed_at,
                "lag_s": lag_s,
                "signal": signal
            })
        } else {
            json!({
                "observed": false,
                "reason": "provider_unknown",
                "attempt_ended_at": ended_at,
                "observed_at": observed_at,
                "lag_s": lag_s
            })
        }
        .to_string();

        let changed = conn.execute(
            "UPDATE task_attempt_metrics
                SET quota_after_json=?3
              WHERE task_id=?1
                AND attempt=?2
                AND quota_after_json IS NULL",
            params![task_id, attempt, payload],
        )?;

        report.finalized += usize::from(changed == 1);
    }

    Ok(report)
}

fn table_exists(
    conn: &Connection,
    name: &str,
) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(
             SELECT 1
               FROM sqlite_master
              WHERE type='table' AND name=?1
         )",
        [name],
        |row| row.get::<_, i64>(0),
    )
    .map(|value| value != 0)
}

/// Cheap gate before touching any provider usage surface.
///
/// The common steady state is "nothing ended since the last pass". That state
/// must cost one SQLite EXISTS and zero Claude/Codex/Gemini probes.
fn has_pending_quota_after(
    conn: &Connection,
) -> rusqlite::Result<bool> {
    if !table_exists(conn, "task_attempts")?
        || !table_exists(conn, "task_attempt_metrics")?
    {
        return Ok(false);
    }

    conn.query_row(
        "SELECT EXISTS(
             SELECT 1
               FROM task_attempts ta
               JOIN task_attempt_metrics tm
                 ON tm.task_id=ta.card
                AND tm.attempt=ta.attempt
              WHERE ta.ended_at IS NOT NULL
                AND tm.quota_after_json IS NULL
              LIMIT 1
         )",
        [],
        |row| row.get::<_, i64>(0),
    )
    .map(|value| value != 0)
}

pub fn tick_secs() -> u64 {
    std::env::var(super::per_job_disable_var(JOB))
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(TICK_SECS)
}

/// Finalize any newly-ended attempt metrics.
///
/// Ordering is deliberate:
/// 1. prove pending DB work exists;
/// 2. drop that read connection;
/// 3. obtain ONE shared usage snapshot;
/// 4. derive the real observation boundary from snapshot provenance;
/// 5. reopen the writer and finalize only attempts that ended before it.
///
/// No SQLite connection is held across provider/cache awaits.
pub(crate) async fn tick(
    state: &AppState,
) -> Option<FinalizeReport> {
    let pending = {
        let conn = match state.store.read() {
            Ok(conn) => conn,
            Err(error) => {
                tracing::warn!(
                    target: "amux::routing_telemetry",
                    %error,
                    verdict = "pending_read_failed",
                    "routing telemetry could not inspect pending attempts"
                );
                return None;
            }
        };

        match has_pending_quota_after(&conn) {
            Ok(value) => value,
            Err(error) => {
                tracing::warn!(
                    target: "amux::routing_telemetry",
                    %error,
                    verdict = "pending_query_failed",
                    "routing telemetry pending query failed"
                );
                return None;
            }
        }
    };

    if !pending {
        return None;
    }

    // This is intentionally captured BEFORE the await. If a cold provider
    // probe takes several seconds, treating its eventual return time as the
    // earliest quota observation would let work that ended during the probe
    // consume a pre-end reading.
    let requested_at = chrono::Utc::now().timestamp();

    let snapshot =
        crate::api::usage::routing_usage_snapshot().await;

    let Some(observed_at) =
        snapshot_observed_at(&snapshot, requested_at)
    else {
        tracing::warn!(
            target: "amux::routing_telemetry",
            requested_at,
            measured = false,
            verdict = "snapshot_provenance_missing",
            "routing telemetry deferred quota-after because usage snapshot \
             has no trustworthy observation time"
        );
        return None;
    };

    let slot =
        std::sync::Arc::new(std::sync::Mutex::new(None));
    let slot_w = slot.clone();

    let write = state
        .store
        .write_async(move |conn| {
            let report =
                finalize_quota_after_from_snapshot(
                    conn,
                    &snapshot,
                    observed_at,
                )?;

            *slot_w
                .lock()
                .expect(
                    "routing telemetry result slot poisoned"
                ) = Some(report.clone());

            // Supplemental telemetry is not an entity mutation and must not
            // bump the global board revision or emit SSE task events.
            Ok(crate::db::WriteOutcome {
                applied: false,
                events: vec![],
            })
        })
        .await;

    if let Err(error) = write {
        tracing::warn!(
            target: "amux::routing_telemetry",
            %error,
            observed_at,
            verdict = "finalize_write_failed",
            "routing telemetry quota-after write failed"
        );
        return None;
    }

    let report = slot
        .lock()
        .expect("routing telemetry result slot poisoned")
        .clone();

    if let Some(report) = &report {
        if report.considered > 0 {
            tracing::info!(
                target: "amux::routing_telemetry",
                observed_at,
                considered = report.considered,
                finalized = report.finalized,
                stale = report.stale,
                measured = true,
                verdict = "quota_after_finalized",
                "routing telemetry finalized ended attempts"
            );
        }
    }

    report
}

pub fn spawn(state: AppState) -> super::PeriodicTask {
    let secs = tick_secs();

    super::spawn_periodic(JOB, secs, move || {
        let state = state.clone();

        async move {
            let _ = tick(&state).await;
        }
    })
}


#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct ModelEnrichReport {
    pub(crate) candidates: usize,
    pub(crate) enriched: usize,
}

/// Fill an ended attempt's model only from unambiguous token-ledger evidence.
///
/// Evidence contract:
/// - same task
/// - same actual worker/session
/// - half-open attempt window [started_at, ended_at)
/// - blank ledger models carry no evidence
/// - exactly ONE distinct non-empty model must be observed
///
/// Zero models stays unknown. Multiple models stays unknown. We never infer a
/// missing model from worker configuration or neighbouring turns.
pub(crate) fn enrich_models_from_ledger(
    conn: &Connection,
) -> rusqlite::Result<ModelEnrichReport> {
    for table in [
        "task_attempts",
        "task_attempt_metrics",
        "token_ledger",
    ] {
        if !table_exists(conn, table)? {
            return Ok(ModelEnrichReport::default());
        }
    }

    let mut stmt = conn.prepare(
        "SELECT
             ta.card,
             ta.attempt,
             MIN(NULLIF(TRIM(l.model), '')) AS observed_model
         FROM task_attempts ta
         JOIN task_attempt_metrics tm
           ON tm.task_id=ta.card
          AND tm.attempt=ta.attempt
         JOIN token_ledger l
           ON l.task=ta.card
          AND l.session=ta.worker
          AND l.ts >= ta.started_at
          AND l.ts < ta.ended_at
        WHERE ta.ended_at IS NOT NULL
          AND (tm.model IS NULL OR TRIM(tm.model)='')
          AND NULLIF(TRIM(l.model), '') IS NOT NULL
        GROUP BY
             ta.card,
             ta.attempt,
             ta.worker,
             ta.started_at,
             ta.ended_at
        HAVING COUNT(
            DISTINCT NULLIF(TRIM(l.model), '')
        ) = 1
        ORDER BY
             ta.ended_at ASC,
             ta.card ASC,
             ta.attempt ASC
        LIMIT 128",
    )?;

    let candidates = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    drop(stmt);

    let mut report = ModelEnrichReport {
        candidates: candidates.len(),
        enriched: 0,
    };

    for (task_id, attempt, model) in candidates {
        let changed = conn.execute(
            "UPDATE task_attempt_metrics
                SET model=?3
              WHERE task_id=?1
                AND attempt=?2
                AND (model IS NULL OR TRIM(model)='')",
            params![task_id, attempt, model],
        )?;

        report.enriched += usize::from(changed == 1);
    }

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn add_token_ledger_table(conn: &Connection) {
        conn.execute_batch(
            "
            CREATE TABLE token_ledger (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                session TEXT NOT NULL DEFAULT '',
                model TEXT NOT NULL DEFAULT '',
                task TEXT NOT NULL DEFAULT ''
            );
            ",
        )
        .unwrap();
    }

    fn schema(conn: &Connection) {
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

    fn closed(
        conn: &Connection,
        task: &str,
        provider: Option<&str>,
        ended_at: i64,
    ) {
        conn.execute(
            "INSERT INTO task_attempts
                (card,attempt,worker,generation,started_at,ended_at,outcome)
             VALUES (?1,1,'codex-impl',1,?2,?3,'done')",
            params![task, ended_at - 100, ended_at],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO task_attempt_metrics
                (task_id,attempt,provider,human_interventions)
             VALUES (?1,1,?2,0)",
            params![task, provider],
        )
        .unwrap();
    }

    fn usage() -> Value {
        json!({
            "providers": [
                {
                    "id": "codex",
                    "available": true,
                    "measured": true,
                    "windows": [
                        {
                            "remaining_percent": 24.0
                        }
                    ]
                }
            ]
        })
    }

    #[test]
    fn unique_nonempty_model_enriches_and_blank_rows_do_not_vote() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        add_token_ledger_table(&conn);
        closed(&conn, "T-MODEL", Some("codex"), 1000);

        conn.execute(
            "INSERT INTO token_ledger
                (ts,session,model,task)
             VALUES
                (950,'codex-impl','','T-MODEL'),
                (960,'codex-impl','gpt-5.6-sol','T-MODEL'),
                (970,'codex-impl','','T-MODEL'),
                (980,'codex-impl','gpt-5.6-sol','T-MODEL')",
            [],
        )
        .unwrap();

        let report = enrich_models_from_ledger(&conn).unwrap();

        assert_eq!(
            report,
            ModelEnrichReport {
                candidates: 1,
                enriched: 1,
            }
        );

        let model: Option<String> = conn
            .query_row(
                "SELECT model
                   FROM task_attempt_metrics
                  WHERE task_id='T-MODEL' AND attempt=1",
                [],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(model.as_deref(), Some("gpt-5.6-sol"));
    }

    #[test]
    fn multiple_observed_models_remain_unknown() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        add_token_ledger_table(&conn);
        closed(&conn, "T-SWITCH", Some("codex"), 1000);

        conn.execute(
            "INSERT INTO token_ledger
                (ts,session,model,task)
             VALUES
                (950,'codex-impl','model-a','T-SWITCH'),
                (960,'codex-impl','model-b','T-SWITCH')",
            [],
        )
        .unwrap();

        let report = enrich_models_from_ledger(&conn).unwrap();

        assert_eq!(report, ModelEnrichReport::default());

        let model: Option<String> = conn
            .query_row(
                "SELECT model
                   FROM task_attempt_metrics
                  WHERE task_id='T-SWITCH' AND attempt=1",
                [],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(model, None);
    }

    #[test]
    fn half_open_attempt_windows_keep_boundary_model_on_next_attempt() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        add_token_ledger_table(&conn);

        conn.execute(
            "INSERT INTO task_attempts
                (card,attempt,worker,generation,started_at,ended_at,outcome)
             VALUES
                ('T-BOUND',1,'codex-impl',1,1000,1100,'released'),
                ('T-BOUND',2,'codex-impl',2,1100,1200,'done')",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO task_attempt_metrics
                (task_id,attempt,provider,human_interventions)
             VALUES
                ('T-BOUND',1,'codex',0),
                ('T-BOUND',2,'codex',0)",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO token_ledger
                (ts,session,model,task)
             VALUES
                (1099,'codex-impl','model-a','T-BOUND'),
                (1100,'codex-impl','model-b','T-BOUND')",
            [],
        )
        .unwrap();

        let report = enrich_models_from_ledger(&conn).unwrap();

        assert_eq!(report.candidates, 2);
        assert_eq!(report.enriched, 2);

        let first: String = conn
            .query_row(
                "SELECT model FROM task_attempt_metrics
                  WHERE task_id='T-BOUND' AND attempt=1",
                [],
                |r| r.get(0),
            )
            .unwrap();

        let second: String = conn
            .query_row(
                "SELECT model FROM task_attempt_metrics
                  WHERE task_id='T-BOUND' AND attempt=2",
                [],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(first, "model-a");
        assert_eq!(second, "model-b");
    }

    #[test]
    fn running_attempt_is_not_model_finalized() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        add_token_ledger_table(&conn);

        conn.execute(
            "INSERT INTO task_attempts
                (card,attempt,worker,generation,started_at)
             VALUES ('T-RUNNING-MODEL',1,'codex-impl',1,1000)",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO task_attempt_metrics
                (task_id,attempt,provider,human_interventions)
             VALUES ('T-RUNNING-MODEL',1,'codex',0)",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO token_ledger
                (ts,session,model,task)
             VALUES
                (1010,'codex-impl','gpt-5.6-sol','T-RUNNING-MODEL')",
            [],
        )
        .unwrap();

        let report = enrich_models_from_ledger(&conn).unwrap();

        assert_eq!(report, ModelEnrichReport::default());

        let model: Option<String> = conn
            .query_row(
                "SELECT model FROM task_attempt_metrics
                  WHERE task_id='T-RUNNING-MODEL' AND attempt=1",
                [],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(model, None);
    }

    #[test]
    fn pending_gate_opens_only_for_ended_unfinalized_metrics() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);

        assert!(!has_pending_quota_after(&conn).unwrap());

        conn.execute(
            "INSERT INTO task_attempts
                (card,attempt,worker,generation,started_at)
             VALUES ('T-PENDING',1,'codex-impl',1,900)",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO task_attempt_metrics
                (task_id,attempt,provider,human_interventions)
             VALUES ('T-PENDING',1,'codex',0)",
            [],
        )
        .unwrap();

        // Running work is not quota-after work.
        assert!(!has_pending_quota_after(&conn).unwrap());

        conn.execute(
            "UPDATE task_attempts
                SET ended_at=1000, outcome='done'
              WHERE card='T-PENDING'",
            [],
        )
        .unwrap();

        assert!(has_pending_quota_after(&conn).unwrap());

        conn.execute(
            "UPDATE task_attempt_metrics
                SET quota_after_json='{\"done\":true}'
              WHERE task_id='T-PENDING'",
            [],
        )
        .unwrap();

        assert!(!has_pending_quota_after(&conn).unwrap());
    }

    #[test]
    fn missing_attempt_tables_mean_no_provider_work() {
        let conn = Connection::open_in_memory().unwrap();

        assert!(!has_pending_quota_after(&conn).unwrap());
    }

    #[test]
    fn cache_age_defines_the_real_snapshot_boundary() {
        let snapshot = json!({
            "cache_age_s": 30,
            "observed_at": 9999
        });

        assert_eq!(
            snapshot_observed_at(&snapshot, 1000),
            Some(970)
        );
    }

    #[test]
    fn observed_at_is_a_fallback_and_missing_provenance_stays_unknown() {
        assert_eq!(
            snapshot_observed_at(
                &json!({"observed_at": 980}),
                1000
            ),
            Some(980)
        );

        assert_eq!(
            snapshot_observed_at(&json!({}), 1000),
            None
        );

        assert_eq!(
            snapshot_observed_at(
                &json!({"observed_at": 1001}),
                1000
            ),
            None
        );
    }

    #[test]
    fn recent_closed_attempt_gets_measured_quota_after() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        closed(&conn, "T-1", Some("codex"), 1000);

        let report =
            finalize_quota_after_from_snapshot(&conn, &usage(), 1010)
                .unwrap();

        assert_eq!(
            report,
            FinalizeReport {
                considered: 1,
                finalized: 1,
                stale: 0,
            }
        );

        let raw: String = conn
            .query_row(
                "SELECT quota_after_json
                   FROM task_attempt_metrics
                  WHERE task_id='T-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();

        let value: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["attempt_ended_at"], 1000);
        assert_eq!(value["observed_at"], 1010);
        assert_eq!(value["lag_s"], 10);
        assert_eq!(
            value["signal"]["quota_remaining"].as_f64(),
            Some(0.24)
        );
        assert_eq!(value["signal"]["observed"], true);
    }

    #[test]
    fn late_finalization_records_unknown_instead_of_fake_history() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        closed(&conn, "T-2", Some("codex"), 1000);

        let report =
            finalize_quota_after_from_snapshot(&conn, &usage(), 1400)
                .unwrap();

        assert_eq!(report.stale, 1);

        let raw: String = conn
            .query_row(
                "SELECT quota_after_json
                   FROM task_attempt_metrics
                  WHERE task_id='T-2'",
                [],
                |r| r.get(0),
            )
            .unwrap();

        let value: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["observed"], false);
        assert_eq!(
            value["reason"],
            "finalization_lag_exceeded"
        );
    }

    #[test]
    fn running_attempt_is_never_finalized() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);

        conn.execute(
            "INSERT INTO task_attempts
                (card,attempt,worker,generation,started_at)
             VALUES ('T-3',1,'codex-impl',1,1000)",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO task_attempt_metrics
                (task_id,attempt,provider,human_interventions)
             VALUES ('T-3',1,'codex',0)",
            [],
        )
        .unwrap();

        let report =
            finalize_quota_after_from_snapshot(&conn, &usage(), 1010)
                .unwrap();

        assert_eq!(report.considered, 0);

        let after: Option<String> = conn
            .query_row(
                "SELECT quota_after_json
                   FROM task_attempt_metrics
                  WHERE task_id='T-3'",
                [],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(after, None);
    }

    #[test]
    fn attempt_closed_after_snapshot_is_deferred_to_the_next_snapshot() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);

        // Snapshot boundary is 1010, but this attempt closes one second later.
        // A pre-close quota observation must never be called quota-after.
        closed(&conn, "T-FUTURE", Some("codex"), 1011);

        let report =
            finalize_quota_after_from_snapshot(&conn, &usage(), 1010)
                .unwrap();

        assert_eq!(report.considered, 0);
        assert_eq!(report.finalized, 0);

        let after: Option<String> = conn
            .query_row(
                "SELECT quota_after_json
                   FROM task_attempt_metrics
                  WHERE task_id='T-FUTURE'",
                [],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(after, None);
    }

    #[test]
    fn finalized_row_is_idempotent_and_never_overwritten() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        closed(&conn, "T-4", Some("codex"), 1000);

        conn.execute(
            "UPDATE task_attempt_metrics
                SET quota_after_json='{\"fixed\":true}'
              WHERE task_id='T-4'",
            [],
        )
        .unwrap();

        let report =
            finalize_quota_after_from_snapshot(&conn, &usage(), 1010)
                .unwrap();

        assert_eq!(report.considered, 0);

        let raw: String = conn
            .query_row(
                "SELECT quota_after_json
                   FROM task_attempt_metrics
                  WHERE task_id='T-4'",
                [],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(raw, "{\"fixed\":true}");
    }
}
