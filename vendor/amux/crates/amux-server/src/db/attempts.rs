//! Task attempts (RR-0052, Invariant 1: every worker execution belongs to a
//! task attempt).
//!
//! A lease is the CURRENT holding; an attempt is the durable record of each
//! one. A card on its fourth try reads as attempt #4 with three recorded
//! outcomes, not as a `lease_generation` of 8. The only writer is
//! [`record_lease_change`], called at the two lease choke points after the card
//! is saved, so a refused transition never leaves an attempt behind, and the
//! attempt log and the lease can only disagree when a path bypasses both.
//! [`reconcile_orphans`] closes those.
//!
//! WHY THE TABLE IS ENSURED HERE AND NOT IN A NUMBERED MIGRATION. On
//! 2026-09-14 the live database recorded migration 69 as
//! `0069_worker_lifecycle`, applied by a dirty build from the shared checkout
//! while origin/main registered only 68 (AMUX-4533). `migrate.rs` skips a
//! version it has already applied without reading the name, so a
//! `0069_task_attempts` landing on origin would boot green on that box and
//! never create this table, and every lease change would then fail its write
//! transaction. `CREATE TABLE IF NOT EXISTS` at the point of use cannot be
//! skipped that way. Move it into a migration once the version collision is
//! resolved on origin.
//!
//! Outcome vocabulary (NULL while the attempt runs):
//! done | review | blocked | parked | needs_input | failed | discarded |
//! released (put back in todo by a worker or human) | abandoned (the lease
//! reaper reclaimed it from a silent holder) | reassigned (another lane took
//! the lease) | orphaned (the card left its lease through a path that bypassed
//! both choke points).

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashMap;

/// The actor the lease reaper advances as. An attempt it ends is `abandoned`.
pub const LEASE_REAPER_ACTOR: &str = "amux:lease-reaper";

/// Create the table and its indexes if absent. Cheap (a no-op parse once the
/// table exists) and only called on lease changes, which are rare next to reads.
pub fn ensure_table(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS task_attempts (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            card        TEXT    NOT NULL,
            attempt     INTEGER NOT NULL,
            worker      TEXT    NOT NULL,
            generation  INTEGER NOT NULL,
            started_at  INTEGER NOT NULL,
            ended_at    INTEGER,
            outcome     TEXT,
            to_status   TEXT,
            ended_by    TEXT,
            reason      TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_task_attempts_card_attempt ON task_attempts(card, attempt);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_task_attempts_running ON task_attempts(card) WHERE ended_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_task_attempts_worker ON task_attempts(worker, started_at);",
    )
}

/// A read against a database where no lease has changed since this shipped has
/// no table yet. That is "no attempts", not an error.
fn missing_table(e: &rusqlite::Error) -> bool {
    e.to_string().contains("no such table: task_attempts")
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Attempt {
    pub attempt: i64,
    pub worker: String,
    pub generation: i64,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    /// None while running.
    pub outcome: Option<String>,
    pub to_status: Option<String>,
    pub ended_by: Option<String>,
    pub reason: Option<String>,
}

/// How an attempt ended, from where the card went and who moved it. The three
/// outcomes the redesign names map directly: `done`/`review` (DONE), `blocked`
/// and `parked` (BLOCKED), `failed` (FAILED). The rest say who ended it when the
/// worker did not.
pub fn outcome_for(to_status: &str, actor: &str, reassigned: bool) -> &'static str {
    if reassigned {
        return "reassigned";
    }
    match to_status {
        "done" | "verified" => "done",
        "review" => "review",
        "blocked" => "blocked",
        "backlog" => "parked",
        "needsyou" | "needs_you" => "needs_input",
        "quarantined" => "failed",
        "discarded" => "discarded",
        "todo" if actor == LEASE_REAPER_ACTOR => "abandoned",
        _ => "released",
    }
}

fn close_running(
    conn: &Connection,
    card: &str,
    outcome: &str,
    to_status: &str,
    ended_by: &str,
    reason: Option<&str>,
    now: i64,
) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE task_attempts SET ended_at = ?2, outcome = ?3, to_status = ?4, ended_by = ?5, reason = ?6 \
         WHERE card = ?1 AND ended_at IS NULL",
        params![card, now, outcome, to_status, ended_by, reason.map(|r| truncate(r, 400))],
    )
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect::<String>() + "…"
}

/// Maximum age of a route decision that may be treated as the cause of a
/// newly-opened execution attempt.
///
/// Routing ownership and claim normally happen in the same board-drive pass.
/// Without an explicit decision->attempt foreign key, time is only a guard
/// against false attribution, not proof of causality. Five minutes leaves
/// ample dispatch slack while refusing historical route rows.
const ROUTE_TO_CLAIM_MAX_LAG_S: i64 = 300;

/// Seed the economics row when an execution attempt actually opens.
///
/// This deliberately records only evidence already durable at claim time:
/// - task/attempt identity comes from `task_attempts`;
/// - provider and quota-before come from the latest matching execute route;
/// - everything not yet measured remains NULL.
///
/// Telemetry is supplemental to the lease/attempt truth. Older databases and
/// partial test schemas may not contain the routing tables, so absence is a
/// clean no-op rather than a reason to refuse a real claim.
fn seed_attempt_metrics(
    conn: &Connection,
    card: &str,
    attempt: i64,
    worker: &str,
    started_at: i64,
) -> rusqlite::Result<()> {
    let table_exists = |name: &str| -> rusqlite::Result<bool> {
        conn.query_row(
            "SELECT EXISTS(
                 SELECT 1
                   FROM sqlite_master
                  WHERE type='table' AND name=?1
             )",
            [name],
            |row| row.get::<_, i64>(0),
        )
        .map(|v| v != 0)
    };

    if !table_exists("task_attempt_metrics")? {
        return Ok(());
    }

    let mut provider: Option<String> = None;
    let mut quota_before_json: Option<String> = None;

    if table_exists("task_route_decisions")? {
        let routed: Option<(Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT score_breakdown_json, quota_snapshot_json
                   FROM task_route_decisions
                  WHERE task_id=?1
                    AND phase='execute'
                    AND selected_worker=?2
                    AND created_at<=?3
                    AND created_at>=(?3 - ?4)
                  ORDER BY created_at DESC, id DESC
                  LIMIT 1",
                params![
                    card,
                    worker,
                    started_at,
                    ROUTE_TO_CLAIM_MAX_LAG_S
                ],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;

        if let Some((score_breakdown_json, quota_json)) = routed {
            provider = score_breakdown_json
                .as_deref()
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
                .and_then(|value| {
                    value
                        .get("candidates")?
                        .as_array()?
                        .iter()
                        .find(|candidate| {
                            candidate
                                .get("worker_name")
                                .and_then(serde_json::Value::as_str)
                                == Some(worker)
                        })
                        .and_then(|candidate| {
                            candidate
                                .get("provider")
                                .and_then(serde_json::Value::as_str)
                        })
                        .map(str::to_owned)
                });

            quota_before_json = quota_json;
        }
    }

    conn.execute(
        "INSERT INTO task_attempt_metrics (
             task_id, attempt, provider, model,
             agent_active_ms, human_attention_ms,
             quota_before_json, quota_after_json,
             files_changed, tests_added,
             human_interventions, first_pass, review_result
         ) VALUES (
             ?1, ?2, ?3, NULL,
             NULL, NULL,
             ?4, NULL,
             NULL, NULL,
             0, NULL, NULL
         )
         ON CONFLICT(task_id, attempt) DO NOTHING",
        params![card, attempt, provider, quota_before_json],
    )?;

    Ok(())
}

/// Record what a SAVED lease change means for the card's attempts. A no-op when
/// the holder did not change (a self-renewal, or a card that never had a lease).
#[allow(clippy::too_many_arguments)]
pub fn record_lease_change(
    conn: &Connection,
    card: &str,
    prev_holder: Option<&str>,
    new_holder: Option<&str>,
    generation: i64,
    to_status: &str,
    actor: &str,
    reason: Option<&str>,
    now: i64,
) -> rusqlite::Result<()> {
    if prev_holder == new_holder {
        return Ok(());
    }
    ensure_table(conn)?;
    if prev_holder.is_some() {
        let outcome = outcome_for(to_status, actor, new_holder.is_some());
        close_running(conn, card, outcome, to_status, actor, reason, now)?;
    }
    if let Some(worker) = new_holder {
        // A running attempt left by a bypass path would violate the one-running
        // index; close it honestly as orphaned rather than failing the claim.
        close_running(conn, card, "orphaned", to_status, actor, Some("superseded by a new lease"), now)?;
        let next: i64 = conn.query_row(
            "SELECT COALESCE(MAX(attempt), 0) + 1 FROM task_attempts WHERE card = ?1",
            [card],
            |r| r.get(0),
        )?;
        conn.execute(
            "INSERT INTO task_attempts (card, attempt, worker, generation, started_at) VALUES (?1,?2,?3,?4,?5)",
            params![card, next, worker, generation, now],
        )?;

        if let Err(error) =
            seed_attempt_metrics(conn, card, next, worker, now)
        {
            tracing::warn!(
                card,
                attempt = next,
                worker,
                %error,
                "attempt opened but routing metrics seed failed"
            );
        }
    }
    Ok(())
}

/// Every attempt on one card, oldest first.
pub fn list_for_card(conn: &Connection, card: &str) -> rusqlite::Result<Vec<Attempt>> {
    match list_for_card_inner(conn, card) {
        Err(e) if missing_table(&e) => Ok(Vec::new()),
        other => other,
    }
}

fn list_for_card_inner(conn: &Connection, card: &str) -> rusqlite::Result<Vec<Attempt>> {
    let mut st = conn.prepare(
        "SELECT attempt, worker, generation, started_at, ended_at, outcome, to_status, ended_by, reason \
         FROM task_attempts WHERE card = ?1 ORDER BY attempt ASC",
    )?;
    let rows = st.query_map([card], |r| {
        Ok(Attempt {
            attempt: r.get(0)?,
            worker: r.get(1)?,
            generation: r.get(2)?,
            started_at: r.get(3)?,
            ended_at: r.get(4)?,
            outcome: r.get(5)?,
            to_status: r.get(6)?,
            ended_by: r.get(7)?,
            reason: r.get(8)?,
        })
    })?;
    rows.collect()
}

/// Running attempt number per card, for list rows. One query over the running
/// set, which is bounded by the number of leased cards, not the board size.
pub fn running_attempt_numbers(conn: &Connection) -> rusqlite::Result<HashMap<String, i64>> {
    let inner = || -> rusqlite::Result<HashMap<String, i64>> {
        let mut st = conn.prepare("SELECT card, attempt FROM task_attempts WHERE ended_at IS NULL")?;
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        rows.collect()
    };
    match inner() {
        Err(e) if missing_table(&e) => Ok(HashMap::new()),
        other => other,
    }
}

/// One card this worker is still holding with nothing recorded about how the
/// work stands.
pub struct OpenHold {
    pub card: String,
    pub attempt: i64,
    pub status: String,
    /// When the attempt began, in epoch SECONDS (the unit `task_attempts`
    /// stores). The caller subtracts it from its own `now` rather than reading
    /// a duration computed at a different moment than the decision.
    pub started_at: i64,
}

/// What this worker is still holding, for the turn boundary (RR-0052 Inv 4).
///
/// Matched on the LEASE rather than on `task_attempts.worker`: the lease is
/// what says the card is this lane's to move right now, and a rename moves
/// `lease_owner` while the attempt keeps the name it was claimed under. Asking
/// the attempt's worker instead would miss a renamed lane's own card.
///
/// Open means NOTHING has been recorded about where the work stands, so both
/// halves of a close are checked. [`close_running`] writes `ended_at` and
/// `outcome` together, and either one alone still answers the question this
/// asks: an `outcome` says where the work landed, and an `ended_at` says the
/// attempt is over and no longer this lane's to answer for.
pub fn open_holds_for_worker(conn: &Connection, worker: &str) -> rusqlite::Result<Vec<OpenHold>> {
    let inner = || -> rusqlite::Result<Vec<OpenHold>> {
        let mut st = conn.prepare(
            "SELECT a.card, a.attempt, i.status, a.started_at \
             FROM task_attempts a JOIN issues i ON i.id = a.card \
             WHERE i.lease_owner = ?1 AND i.deleted IS NULL \
               AND a.ended_at IS NULL AND a.outcome IS NULL \
             ORDER BY a.started_at",
        )?;
        let rows = st.query_map([worker], |r| {
            Ok(OpenHold {
                card: r.get(0)?,
                attempt: r.get(1)?,
                status: r.get(2)?,
                started_at: r.get(3)?,
            })
        })?;
        rows.collect()
    };
    match inner() {
        Err(e) if missing_table(&e) => Ok(Vec::new()),
        other => other,
    }
}

/// Close running attempts whose card no longer holds a lease. Matched on the
/// CARD, not the worker name: a lane rename moves `lease_owner` but keeps the
/// attempt's `worker` as the name it held the card under, and that attempt is
/// still running.
/// A card can leave `doing` through a raw UPDATE (board hygiene) or a create
/// straight into a terminal status, and neither passes a lease choke point.
/// Returns how many were closed, which the reaper publishes: a steady nonzero
/// count names a bypass path worth routing through `advance`.
pub fn reconcile_orphans(conn: &Connection, now: i64) -> rusqlite::Result<usize> {
    ensure_table(conn)?;
    conn.execute(
        "UPDATE task_attempts SET ended_at = ?1, outcome = 'orphaned', ended_by = 'amux:attempt-reconcile', \
             to_status = (SELECT status FROM issues i WHERE i.id = task_attempts.card), \
             reason = 'card left its lease without passing a lease choke point' \
         WHERE ended_at IS NULL AND NOT EXISTS ( \
             SELECT 1 FROM issues i WHERE i.id = task_attempts.card AND i.status = 'doing' \
               AND i.lease_owner IS NOT NULL AND i.deleted IS NULL)",
        [now],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(conn: &Connection, id: &str, status: &str, owner: Option<&str>) {
        conn.execute(
            "INSERT OR REPLACE INTO issues (id,title,desc,status,session,created,updated,owner_type,type,lease_owner) \
             VALUES (?1,?1,'',?2,'lane',1,1,'agent','code',?3)",
            params![id, status, owner],
        )
        .unwrap();
    }

    #[test]
    fn outcomes_name_the_three_endings_and_who_ended_it_otherwise() {
        assert_eq!(outcome_for("done", "lane", false), "done");
        assert_eq!(outcome_for("review", "lane", false), "review");
        assert_eq!(outcome_for("blocked", "lane", false), "blocked");
        assert_eq!(outcome_for("quarantined", "lane", false), "failed");
        assert_eq!(outcome_for("todo", LEASE_REAPER_ACTOR, false), "abandoned");
        assert_eq!(outcome_for("todo", "lane", false), "released");
        assert_eq!(outcome_for("doing", "other", true), "reassigned");
    }

    #[test]
    fn a_claim_opens_attempt_one_and_each_later_holding_counts_up() {
        let conn = crate::db::migrate::test_memdb();
        card(&conn, "C", "doing", Some("a"));
        record_lease_change(&conn, "C", None, Some("a"), 1, "doing", "a", None, 100).unwrap();
        assert_eq!(running_attempt_numbers(&conn).unwrap().get("C"), Some(&1));

        // Reaper reclaims: attempt 1 abandoned, nothing running.
        record_lease_change(&conn, "C", Some("a"), None, 2, "todo", LEASE_REAPER_ACTOR, Some("silent"), 200).unwrap();
        assert!(running_attempt_numbers(&conn).unwrap().is_empty());

        // Re-claimed by b, then b hands it to c mid-doing.
        record_lease_change(&conn, "C", None, Some("b"), 3, "doing", "b", None, 300).unwrap();
        record_lease_change(&conn, "C", Some("b"), Some("c"), 4, "doing", "c", None, 400).unwrap();
        // c finishes.
        record_lease_change(&conn, "C", Some("c"), None, 5, "review", "c", None, 500).unwrap();

        let all = list_for_card(&conn, "C").unwrap();
        let got: Vec<(i64, &str, Option<&str>)> =
            all.iter().map(|a| (a.attempt, a.worker.as_str(), a.outcome.as_deref())).collect();
        assert_eq!(
            got,
            vec![(1, "a", Some("abandoned")), (2, "b", Some("reassigned")), (3, "c", Some("review"))]
        );
        assert_eq!(all[0].reason.as_deref(), Some("silent"));
    }

    #[test]
    fn a_self_renewal_or_a_leaseless_card_records_nothing() {
        let conn = crate::db::migrate::test_memdb();
        // Before any lease change the table does not exist; reads say "none".
        assert!(list_for_card(&conn, "C").unwrap().is_empty());
        assert!(running_attempt_numbers(&conn).unwrap().is_empty());
        record_lease_change(&conn, "C", Some("a"), Some("a"), 1, "doing", "a", None, 1).unwrap();
        record_lease_change(&conn, "C", None, None, 1, "done", "a", None, 1).unwrap();
        assert!(list_for_card(&conn, "C").unwrap().is_empty());
    }

    #[test]
    fn an_attempt_whose_card_left_doing_by_a_bypass_is_closed_as_orphaned() {
        let conn = crate::db::migrate::test_memdb();
        card(&conn, "KEEP", "doing", Some("a"));
        card(&conn, "GONE", "doing", Some("a"));
        record_lease_change(&conn, "KEEP", None, Some("a"), 1, "doing", "a", None, 1).unwrap();
        record_lease_change(&conn, "GONE", None, Some("a"), 1, "doing", "a", None, 1).unwrap();
        // A raw UPDATE, the way board hygiene discards: no choke point sees it.
        conn.execute("UPDATE issues SET status='discarded', lease_owner=NULL WHERE id='GONE'", []).unwrap();
        assert_eq!(reconcile_orphans(&conn, 9).unwrap(), 1);
        let gone = list_for_card(&conn, "GONE").unwrap();
        assert_eq!(gone[0].outcome.as_deref(), Some("orphaned"));
        assert_eq!(gone[0].to_status.as_deref(), Some("discarded"));
        assert_eq!(running_attempt_numbers(&conn).unwrap().get("KEEP"), Some(&1));
    }
}

#[cfg(test)]
mod attempt_metrics_seed_tests {
    use super::*;

    fn add_metrics_table(conn: &Connection) {
        conn.execute_batch(
            "
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

    fn add_route_table(conn: &Connection) {
        conn.execute_batch(
            "
            CREATE TABLE task_route_decisions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL,
                phase TEXT NOT NULL,
                selected_worker TEXT,
                score_breakdown_json TEXT,
                quota_snapshot_json TEXT,
                created_at INTEGER NOT NULL
            );
            ",
        )
        .unwrap();
    }

    #[test]
    fn routed_claim_seeds_provider_and_quota_before() {
        let conn = Connection::open_in_memory().unwrap();
        add_metrics_table(&conn);
        add_route_table(&conn);

        let score = serde_json::json!({
            "candidates": [
                {
                    "worker_name": "codex-impl",
                    "provider": "codex"
                },
                {
                    "worker_name": "devin-worker",
                    "provider": "devin"
                }
            ]
        })
        .to_string();

        let quota = serde_json::json!([
            {
                "configured_provider": "codex",
                "canonical_provider": "codex",
                "usage_provider": "codex",
                "quota_remaining": 0.24,
                "observed": true
            }
        ])
        .to_string();

        conn.execute(
            "INSERT INTO task_route_decisions (
                 task_id, phase, selected_worker,
                 score_breakdown_json, quota_snapshot_json, created_at
             ) VALUES (?1, 'execute', ?2, ?3, ?4, ?5)",
            params!["T-ROUTED", "codex-impl", score, quota, 99i64],
        )
        .unwrap();

        record_lease_change(
            &conn,
            "T-ROUTED",
            None,
            Some("codex-impl"),
            1,
            "doing",
            "amux:board-drive",
            None,
            100,
        )
        .unwrap();

        let attempt: (i64, String, i64) = conn
            .query_row(
                "SELECT attempt, worker, generation
                   FROM task_attempts
                  WHERE card='T-ROUTED'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();

        assert_eq!(attempt, (1, "codex-impl".into(), 1));

        let metrics: (
            Option<String>,
            Option<String>,
            Option<String>,
            Option<i64>,
            Option<i64>,
            Option<i64>,
            Option<i64>,
            i64,
            Option<i64>,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT
                     provider,
                     model,
                     quota_before_json,
                     agent_active_ms,
                     human_attention_ms,
                     files_changed,
                     tests_added,
                     human_interventions,
                     first_pass,
                     review_result
                   FROM task_attempt_metrics
                  WHERE task_id='T-ROUTED' AND attempt=1",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                        row.get(9)?,
                    ))
                },
            )
            .unwrap();

        assert_eq!(metrics.0.as_deref(), Some("codex"));
        assert_eq!(metrics.1, None);
        assert_eq!(metrics.2.as_deref(), Some(quota.as_str()));
        assert_eq!(metrics.3, None);
        assert_eq!(metrics.4, None);
        assert_eq!(metrics.5, None);
        assert_eq!(metrics.6, None);
        assert_eq!(metrics.7, 0);
        assert_eq!(metrics.8, None);
        assert_eq!(metrics.9, None);
    }

    #[test]
    fn route_at_freshness_boundary_still_seeds_metrics() {
        let conn = Connection::open_in_memory().unwrap();
        add_metrics_table(&conn);
        add_route_table(&conn);

        let score = serde_json::json!({
            "candidates": [{
                "worker_name": "codex-impl",
                "provider": "codex"
            }]
        })
        .to_string();

        let quota = serde_json::json!({
            "configured_provider": "codex",
            "quota_remaining": 0.24,
            "observed": true
        })
        .to_string();

        conn.execute(
            "INSERT INTO task_route_decisions (
                 task_id, phase, selected_worker,
                 score_breakdown_json, quota_snapshot_json, created_at
             ) VALUES (?1, 'execute', ?2, ?3, ?4, ?5)",
            params![
                "T-FRESH-BOUNDARY",
                "codex-impl",
                score.as_str(),
                quota.as_str(),
                100i64
            ],
        )
        .unwrap();

        record_lease_change(
            &conn,
            "T-FRESH-BOUNDARY",
            None,
            Some("codex-impl"),
            1,
            "doing",
            "amux:board-drive",
            None,
            400,
        )
        .unwrap();

        let metrics: (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT provider, quota_before_json
                   FROM task_attempt_metrics
                  WHERE task_id='T-FRESH-BOUNDARY'
                    AND attempt=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(metrics.0.as_deref(), Some("codex"));
        assert_eq!(metrics.1.as_deref(), Some(quota.as_str()));
    }

    #[test]
    fn stale_route_is_not_attributed_to_a_later_claim() {
        let conn = Connection::open_in_memory().unwrap();
        add_metrics_table(&conn);
        add_route_table(&conn);

        let score = serde_json::json!({
            "candidates": [{
                "worker_name": "codex-impl",
                "provider": "codex"
            }]
        })
        .to_string();

        let quota = serde_json::json!({
            "configured_provider": "codex",
            "quota_remaining": 0.24,
            "observed": true
        })
        .to_string();

        conn.execute(
            "INSERT INTO task_route_decisions (
                 task_id, phase, selected_worker,
                 score_breakdown_json, quota_snapshot_json, created_at
             ) VALUES (?1, 'execute', ?2, ?3, ?4, ?5)",
            params![
                "T-STALE-ROUTE",
                "codex-impl",
                score.as_str(),
                quota.as_str(),
                100i64
            ],
        )
        .unwrap();

        // 301 seconds later: same task+worker is NOT enough to prove this
        // historical route caused the new attempt.
        record_lease_change(
            &conn,
            "T-STALE-ROUTE",
            None,
            Some("codex-impl"),
            2,
            "doing",
            "human",
            None,
            401,
        )
        .unwrap();

        let metrics: (Option<String>, Option<String>, i64) = conn
            .query_row(
                "SELECT
                     provider,
                     quota_before_json,
                     human_interventions
                   FROM task_attempt_metrics
                  WHERE task_id='T-STALE-ROUTE'
                    AND attempt=1",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                    ))
                },
            )
            .unwrap();

        assert_eq!(metrics, (None, None, 0));
    }

    #[test]
    fn manual_claim_seeds_no_invented_provider_or_quota() {
        let conn = Connection::open_in_memory().unwrap();
        add_metrics_table(&conn);

        // No task_route_decisions table at all: this is a manual/non-router claim.
        record_lease_change(
            &conn,
            "T-MANUAL",
            None,
            Some("codex-impl"),
            1,
            "doing",
            "human",
            None,
            200,
        )
        .unwrap();

        let metrics: (Option<String>, Option<String>, i64) = conn
            .query_row(
                "SELECT provider, quota_before_json, human_interventions
                   FROM task_attempt_metrics
                  WHERE task_id='T-MANUAL' AND attempt=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();

        assert_eq!(metrics, (None, None, 0));
    }

    #[test]
    fn missing_metrics_table_never_breaks_a_real_claim() {
        let conn = Connection::open_in_memory().unwrap();

        // record_lease_change creates task_attempts itself. There is deliberately
        // no task_attempt_metrics or task_route_decisions table.
        record_lease_change(
            &conn,
            "T-LEGACY",
            None,
            Some("legacy-worker"),
            7,
            "doing",
            "amux:board-drive",
            None,
            300,
        )
        .unwrap();

        let row: (i64, String, i64, i64) = conn
            .query_row(
                "SELECT attempt, worker, generation, started_at
                   FROM task_attempts
                  WHERE card='T-LEGACY'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();

        assert_eq!(row, (1, "legacy-worker".into(), 7, 300));
    }
}
