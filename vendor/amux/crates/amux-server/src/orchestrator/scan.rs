//! Terminal scan loop with demotion (RR-0067, D1).
//!
//! The scraper is the FALLBACK voice, never the control plane: a worker
//! whose structured protocol session is live is not scanned at all — its
//! own reports outrank any scrape (the D1 exit, applied from day one
//! instead of retrofitted like the Python's AMUX_SCAN_DEMOTE_S). Only
//! workers with a live TERMINAL session and no protocol session get their
//! panes captured and run through the TerminalAdapter.
//!
//! The same exit, applied to a whole backend (#84): a backend that can
//! REPORT its hosted agents' lifecycle state (herdr `agent_status`) has
//! that answer outrank the pane scrape too — one batched
//! [`SessionBackend::agent_states`] read per pass, no per-lane probe.
//! Precedence: the worker's own protocol voice (above) > the backend's
//! native report > the scrape.
//!
//! Consecutive identical scan results are deduped by content hash — the
//! Python system's two-scan persistence gate, done once here so every
//! event consumer inherits it (a rate-limit banner sitting in scrollback
//! must not re-fire state changes every cycle). A frame showing the worker
//! generating clears that memory: the yield that ends the working phase is a
//! new occurrence even when it is byte-identical to the one before it.
//!
//! For a hookless lane the scrape is also the turn ledger's only voice
//! (Invariant 6): its working frames open a turn, and only its own idle
//! prompt or failure can end it. A turn spans a rate limit or a wait and is
//! resumed by the next working frame (operator decision 2026-10-08); see
//! [`apply_scraped_event`].

use crate::backend::{ProcessRef, SessionBackend};
use crate::db::{PendingEvent, SharedStore, WriteOutcome};
use crate::opencode::AgentProtocol;
use amux_core::ids::{TurnId, WorkerId};
use amux_core::provider::ProviderId;
use amux_core::protocol::{ExitStatus, TurnResult, WaitReason, WorkerEvent};
use amux_core::revision::{EntityType, MutationKind};
use amux_core::worker::WorkerState;
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::Digest;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::{OnceLock, RwLock};

pub struct ScanLoop {
    pub store: SharedStore,
    pub backends: Vec<Arc<dyn SessionBackend>>,
    pub protocol: Option<Arc<dyn AgentProtocol>>,
    /// worker -> hash of the last scan's emitted events (dedupe).
    last_scan: Mutex<BTreeMap<WorkerId, String>>,
}

/// What one scan pass did — returned so callers (and tests) see the
/// demotion decisions instead of inferring them from silence (the
/// /api/debug/scan lesson: a skip that leaves no trace is indistinguishable
/// from a scan that found nothing).
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct ScanReport {
    pub scanned: Vec<String>,
    pub demoted_structured: Vec<String>,
    /// Workers whose capture was skipped because the BACKEND reported their
    /// agent state natively (#84: herdr `agent_status` via one batched
    /// `workspace list`). Same trace discipline as `demoted_structured`.
    pub demoted_native: Vec<String>,
    /// Backends whose native-status read failed this pass; their lanes fell
    /// back to the scrape, and the failure is named rather than silent.
    pub native_status_failures: Vec<String>,
    /// Backend-confirmed exits, distinct from text inferred by the adapter.
    pub process_exits: BTreeMap<String, ExitStatus>,
    pub process_exit_failures: Vec<String>,
    /// Exit observations rejected atomically because their session ended or changed.
    pub stale_process_exits: BTreeMap<String, StaleProcessExit>,
    /// Workers whose capture or native report was not applied because the
    /// session it was read from ended or was replaced before the write (the
    /// same atomic check as `stale_process_exits`).
    pub stale_observations: Vec<String>,
    pub events_applied: usize,
    pub capture_failures: Vec<String>,
}

/// The session a backend observation (a capture, a native status report) was
/// read from. The observation describes THAT process: once the session has
/// ended or been replaced, applying it would act on the new process with the
/// old one's screen, e.g. end the new session's turn on an idle prompt it
/// never showed and confirm a command it never ran.
#[derive(Debug, Clone)]
struct Observed {
    session: String,
    backend: String,
    backend_ref: String,
}

impl Observed {
    /// Checked inside the writer transaction, like the exit path: a pre-write
    /// read would leave the same race open.
    fn is_live(&self, conn: &Connection, wid: &str) -> rusqlite::Result<bool> {
        Ok(crate::db::queries::live_session_for(conn, wid)?.is_some_and(|s| {
            s.id == self.session && s.backend == self.backend && s.backend_ref == self.backend_ref
        }))
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct StaleProcessExit {
    pub observed_session: String,
    pub current_session: Option<String>,
    pub backend_ref: String,
}

/// The last completed scan pass, published for `GET /api/debug/scan` (AF-80):
/// its demotion decisions plus the per-worker dedupe state, so "which lanes
/// were skipped/demoted and why" is answerable without inferring it from
/// silence (ethos rule 4, the D1 "scan" deviation: a skip that leaves no trace
/// is indistinguishable from a scan that found nothing). Same `last_report()`
/// shape as `board_drive`/`autofix`/`storage`: one publish per completed pass,
/// read in-process so there is no second copy of the fact to drift.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct ScanState {
    /// Unix seconds when the last pass finished. `None` until the loop has run
    /// once, which is itself the answer to "has the terminal-scan loop ever
    /// run?".
    pub last_pass_at: Option<f64>,
    /// The last pass's decisions: scanned / demoted_structured / demoted_native
    /// / native_status_failures / capture_failures / events_applied.
    pub report: ScanReport,
    /// worker id -> content hash of the events the scrape last emitted for it.
    /// An identical hash on the next pass means the banner is still on screen,
    /// not a fresh occurrence, so a lane sitting here explains why its state did
    /// not re-fire. A lane whose pane last showed it generating has no entry.
    pub deduped: BTreeMap<String, String>,
}

static LAST_SCAN_STATE: OnceLock<RwLock<Option<ScanState>>> = OnceLock::new();

fn scan_state_slot() -> &'static RwLock<Option<ScanState>> {
    LAST_SCAN_STATE.get_or_init(|| RwLock::new(None))
}

fn publish_scan_state(state: ScanState) {
    if let Ok(mut slot) = scan_state_slot().write() {
        *slot = Some(state);
    }
}

/// The last completed scan pass, or `None` if the loop has never run, which is
/// itself the answer to "is the terminal-scan loop alive?". Read by `GET
/// /api/debug/scan` and the `terminal-scan` outcome in `/api/system-jobs`.
pub fn last_scan_state() -> Option<ScanState> {
    scan_state_slot().read().ok().and_then(|s| s.clone())
}

impl ScanLoop {
    pub fn new(
        store: SharedStore,
        backends: Vec<Arc<dyn SessionBackend>>,
        protocol: Option<Arc<dyn AgentProtocol>>,
    ) -> Self {
        ScanLoop {
            store,
            backends,
            protocol,
            last_scan: Mutex::new(BTreeMap::new()),
        }
    }

    /// Run `write` in the writer transaction only while `observed` is still the
    /// worker's live session. `Ok(None)`: the observation was stale and nothing
    /// was written.
    async fn write_observed<F>(
        &self,
        worker: &WorkerId,
        observed: &Observed,
        write: F,
    ) -> anyhow::Result<Option<crate::db::WriteReply>>
    where
        F: FnOnce(&Connection) -> rusqlite::Result<WriteOutcome> + Send + 'static,
    {
        let stale = Arc::new(AtomicBool::new(false));
        let (flag, w, obs) = (stale.clone(), worker.clone(), observed.clone());
        let reply = self
            .store
            .write_async(move |conn| {
                if !obs.is_live(conn, w.as_str())? {
                    flag.store(true, Ordering::Relaxed);
                    return Ok(WriteOutcome { applied: false, events: vec![] });
                }
                write(conn)
            })
            .await?;
        if stale.load(Ordering::Relaxed) {
            tracing::info!(worker = %worker, observed_session = %observed.session,
                backend_ref = %observed.backend_ref, applied = false,
                "scan observation belongs to an ended or replaced session");
            return Ok(None);
        }
        Ok(Some(reply))
    }

    /// One pass over live terminal sessions.
    pub async fn scan_once(&self) -> anyhow::Result<ScanReport> {
        let mut report = ScanReport::default();
        // Capture session identity BEFORE asynchronous backend reads. Backend refs
        // survive restarts and cannot identify the generation an exit belongs to.
        let targets: Vec<(String, String, String, String, String)> = {
            let conn = self.store.read()?;
            let mut stmt = conn.prepare(
                "SELECT s.worker_id, s.backend, s.backend_ref,
                        COALESCE(w.provider, 'claude'), s.id
                 FROM _amux_sessions s
                 LEFT JOIN _amux_workers w ON w.id = s.worker_id
                 WHERE s.ended_at IS NULL AND s.backend IN ('tmux', 'herdr')",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })?;
            rows.collect::<Result<_, _>>()?
        };

        // #84: ONE batched native-status read per backend for the whole
        // pass. An empty result (tmux, or a herdr session with no
        // recognized agents) contributes nothing; a FAILED read is named in
        // the report and that backend's lanes keep the scrape this tick —
        // "cannot answer" must not read as "stopped".
        let mut native: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
        let mut exits = BTreeMap::new();
        for backend in &self.backends {
            match backend.process_exits().await {
                Ok(found) => {
                    exits.insert(backend.name().to_string(), found);
                }
                Err(e) => report
                    .process_exit_failures
                    .push(format!("{}: {e}", backend.name())),
            }
            match backend.agent_states().await {
                Ok(states) if !states.is_empty() => {
                    native.insert(backend.name().to_string(), states);
                }
                Ok(_) => {}
                Err(e) => report
                    .native_status_failures
                    .push(format!("{}: {e}", backend.name())),
            }
        }

        for (wid_str, backend_name, backend_ref, provider, session_id) in targets {
            let Ok(worker) = WorkerId::parse(&wid_str) else { continue };
            // Every capture and native report below was read from THIS session;
            // each write re-checks it (write_observed).
            let source = Observed {
                session: session_id.clone(),
                backend: backend_name.clone(),
                backend_ref: backend_ref.clone(),
            };

            // DEMOTION: a live structured session means the worker speaks
            // for itself. Skip — and SAY so.
            if let Some(p) = &self.protocol {
                if p.state(&worker).await.is_ok() {
                    report.demoted_structured.push(wid_str.clone());
                    continue;
                }
            }

            // NATIVE (#84): the backend reported this worker's agent state
            // — capture is demoted and the state is applied as the event it
            // already is in WorkerEvent terms. Stays BELOW the protocol
            // demotion above: the worker's own voice outranks its host's
            // observation of it.
            if let Some(status) = native
                .get(&backend_name)
                .and_then(|m| m.get(&backend_ref))
                .filter(|status| matches!(status.as_str(), "working" | "blocked" | "idle" | "done"))
            {
                report.demoted_native.push(wid_str.clone());
                let (w, status) = (worker.clone(), status.clone());
                match self
                    .write_observed(&worker, &source, move |conn| {
                        apply_status_report(conn, &w, &status, chrono::Utc::now())
                    })
                    .await
                {
                    Ok(Some(reply)) if reply.applied => report.events_applied += 1,
                    Ok(Some(_)) => {}
                    Ok(None) => report.stale_observations.push(wid_str.clone()),
                    Err(e) => {
                        tracing::warn!(worker = %worker, error = %e, "native status event apply failed")
                    }
                }
                continue;
            }

            let Some(backend) = self.backends.iter().find(|b| b.name() == backend_name)
            else {
                continue;
            };
            let proc = ProcessRef {
                backend_ref: backend_ref.clone(),
                pid: None,
            };
            if let Some(status) = exits.get(&backend_name).and_then(|m| m.get(&backend_ref)) {
                let event = WorkerEvent::Exited(status.clone());
                let w = worker.clone();
                let observed = session_id.clone();
                let expected_backend = backend_name.clone();
                let expected_ref = backend_ref.clone();
                let stale = Arc::new(Mutex::new(None));
                let stale_write = stale.clone();
                let applied = self
                    .store
                    .write_async(move |conn| {
                        // Store executes this closure inside its authoritative writer
                        // transaction. A pre-write read would leave the same race open.
                        let current = crate::db::queries::live_session_for(conn, w.as_str())?;
                        if !current.as_ref().is_some_and(|s| s.id == observed
                            && s.backend == expected_backend && s.backend_ref == expected_ref)
                        {
                            let rejected = StaleProcessExit {
                                observed_session: observed,
                                current_session: current.map(|s| s.id),
                                backend_ref: expected_ref,
                            };
                            tracing::warn!(worker = %w,
                                observed_session = %rejected.observed_session,
                                current_session = ?rejected.current_session,
                                backend_ref = %rejected.backend_ref,
                                measured = true, n_considered = 1, applied = false,
                                "terminal_process_exit_stale: exit observation belongs to an ended or replaced session");
                            *stale_write.lock().expect("exit result mutex") = Some(rejected);
                            return Ok(crate::db::WriteOutcome { applied: false, events: vec![] });
                        }
                        crate::orchestrator::events::apply_event(
                            conn, &w, &event, chrono::Utc::now(),
                        )
                    })
                    .await;
                match applied {
                    Ok(reply) if reply.applied => {
                        report.events_applied += 1;
                        report.process_exits.insert(wid_str.clone(), status.clone());
                        tracing::warn!(worker = %worker, backend_ref = %backend_ref,
                            session = %session_id,
                            exit_code = ?status.code, signal = ?status.signal,
                            measured = true, n_considered = 1,
                            "terminal_process_exit: retained session no longer hosts a live process");
                    }
                    Ok(_) => {
                        if let Some(rejected) = stale.lock().expect("exit result mutex").take() {
                            report.stale_process_exits.insert(wid_str.clone(), rejected);
                        }
                    }
                    Err(e) => report
                        .process_exit_failures
                        .push(format!("{wid_str}: apply exit: {e}")),
                }
                continue;
            }
            let captured = match backend.capture(&proc, 60).await {
                Ok(c) => c,
                Err(e) => {
                    report.capture_failures.push(format!("{wid_str}: {e}"));
                    continue;
                }
            };
            report.scanned.push(wid_str.clone());

            let adapter =
                crate::backend::adapter::TerminalAdapter::new(ProviderId(provider.clone()));

            // ACTIVE via scrape (AMUX-3165). A hookless pane's working row
            // ("• Working (…esc to interrupt)" for codex/ollama) is the ONLY
            // signal that reaches the store that the worker is generating — it
            // has no Stop/UserPromptSubmit hooks (claude) and no structured
            // session (opencode), so unlike every other lane its active state
            // has nowhere else to come from. `scan` cannot carry it (Active
            // needs a turn id and `scan` is pure), so it is reported as a
            // boolean and minted here, treated EXACTLY like a backend's native
            // `working` report: `native_status_event` fires TurnStarted on the
            // EDGE into Active only and returns None once Active, so a pane
            // that stays working across scans does not mint a turn row +
            // StatusChanged every pass (Invariant 37, ethos rule 5).
            //
            // The working row is the pane's CURRENT state, so nothing else the
            // frame shows (a limit banner or an error still in the scrollback
            // above it) is applied: applying it would flip the lane off Active
            // and back every pass. And the dedupe memory is cleared, so the
            // yield that ends this working phase applies even when it is
            // byte-identical to the one before it (idle -> working -> idle,
            // limit -> working -> limit). Before this, the pre-turn idle
            // prompt's hash survived the turn, the identical prompt after it
            // read as "still on screen", and the worker stayed Active with its
            // turn open.
            if adapter.generating(&captured) {
                self.last_scan.lock().unwrap().remove(&worker);
                let w = worker.clone();
                match self
                    .write_observed(&worker, &source, move |conn| {
                        apply_status_report(conn, &w, "working", chrono::Utc::now())
                    })
                    .await
                {
                    Ok(Some(reply)) if reply.applied => report.events_applied += 1,
                    Ok(Some(_)) => {}
                    Ok(None) => report.stale_observations.push(wid_str.clone()),
                    Err(e) => {
                        tracing::warn!(worker = %worker, error = %e, "scraped working event apply failed")
                    }
                }
                continue;
            }

            let events = adapter.scan(&captured);
            if events.is_empty() {
                continue;
            }
            // Dedupe: same events from the same worker as last pass = the
            // banner is still on screen, not a new occurrence.
            let hash = {
                let mut h = sha2::Sha256::new();
                h.update(serde_json::to_string(&events).unwrap_or_default());
                hex::encode(h.finalize())
            };
            {
                let mut last = self.last_scan.lock().unwrap();
                if last.get(&worker).map(|s| s.as_str()) == Some(hash.as_str()) {
                    continue;
                }
                last.insert(worker.clone(), hash);
            }
            for ev in events {
                let w = worker.clone();
                let applied = self
                    .write_observed(&worker, &source, move |conn| {
                        apply_scraped_event(conn, &w, &ev, chrono::Utc::now())
                    })
                    .await;
                match applied {
                    Ok(Some(_)) => report.events_applied += 1,
                    Ok(None) => {
                        // The frame belongs to an ended or replaced session:
                        // drop the rest of it, and forget its hash so the new
                        // session's own identical frame is not deduped
                        // against a screen that was never applied.
                        self.last_scan.lock().unwrap().remove(&worker);
                        report.stale_observations.push(wid_str.clone());
                        break;
                    }
                    Err(e) => {
                        tracing::warn!(worker = %worker, error = %e, "scan event apply failed")
                    }
                }
            }
        }
        // Publish this pass for GET /api/debug/scan (AF-80): the demotion
        // decisions and per-worker dedupe state, so a skip leaves a trace
        // instead of reading as a scan that found nothing (ethos rule 4, the
        // D1 "scan" deviation). Every pass publishes, including an empty one,
        // so a fresh last_pass_at also proves the loop is ticking.
        let deduped = self
            .last_scan
            .lock()
            .map(|m| m.iter().map(|(k, v)| (k.to_string(), v.clone())).collect())
            .unwrap_or_default();
        publish_scan_state(ScanState {
            last_pass_at: Some(crate::runtime_jobs::registry::unix_now()),
            report: report.clone(),
            deduped,
        });
        Ok(report)
    }

    /// The loop: scan every `interval_secs`, forever.
    pub async fn run(self: Arc<Self>, interval_secs: u64) {
        let mut interval =
            tokio::time::interval(std::time::Duration::from_secs(interval_secs.max(5)));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            crate::runtime_jobs::registry::tick(crate::runtime_jobs::registry::ids::SCAN);
            match self.scan_once().await {
                Ok(r) if !r.scanned.is_empty()
                        || !r.capture_failures.is_empty()
                        || !r.demoted_native.is_empty()
                        || !r.process_exits.is_empty()
                        || !r.process_exit_failures.is_empty()
                        || !r.stale_process_exits.is_empty()
                        || !r.stale_observations.is_empty()
                        || !r.native_status_failures.is_empty() =>
                {
                    tracing::debug!(
                        scanned = r.scanned.len(),
                        demoted = r.demoted_structured.len(),
                        demoted_native = r.demoted_native.len(),
                        native_failures = r.native_status_failures.len(),
                        process_exits = r.process_exits.len(),
                        process_exit_failures = r.process_exit_failures.len(),
                        stale_process_exits = r.stale_process_exits.len(),
                        stale_observations = r.stale_observations.len(),
                        events = r.events_applied,
                        failures = r.capture_failures.len(),
                        "terminal scan pass"
                    );
                }
                Ok(_) => {}
                Err(e) => tracing::warn!(error = %e, "terminal scan pass failed"),
            }
        }
    }
}

/// The worker's open turn in its LIVE session, if any — the turn an idle
/// report must close to keep the turn ledger truthful, and the one a working
/// report resumes. Scoped to the live session on purpose: a turn left open
/// by a session that crashed or was replaced is not this process's to resume,
/// and closing it on this session's idle prompt would confirm a command the
/// new process never received. `None` means no open turn here: a working
/// report mints one, and a native idle report synthesizes one so
/// `apply_event` names the missed TurnStarted in the log (e.g. the working
/// phase happened while the server was down).
fn open_turn_id(conn: &Connection, wid: &str) -> rusqlite::Result<Option<TurnId>> {
    let Some(session) = crate::db::queries::live_session_for(conn, wid)? else {
        return Ok(None);
    };
    Ok(conn
        .query_row(
            "SELECT id FROM _amux_turns
             WHERE worker_id = ?1 AND session_id = ?2 AND ended_at IS NULL
             ORDER BY started_at DESC LIMIT 1",
            params![wid, session.id],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .and_then(|t| TurnId::parse(&t).ok()))
}

/// Map a backend-reported agent status (#84: herdr `working|blocked|idle|
/// done`) onto the WorkerEvent that moves the store toward it, or `None`
/// when it is already there. Pure so the mapping table is testable
/// without a DB. The scrape's working frames use the `working` row too.
///
/// Equilibrium returns `None` on purpose: `write_state` writes
/// unconditionally, so re-applying every tick would push a StatusChanged
/// event per tick and bump the revision for no change (Invariant 37).
/// `done ≡ idle`: herdr 0.8.0 surfaces `done` and amux has no state for
/// "the agent process finished but the pane lives" — idle is the honest
/// reading either way (#84 evidence).
///
/// `working` after a yield (blocked, a rate limit, a wait) RESUMES the open
/// turn instead of minting a second row beside it: the turn spans the yield
/// and ends once, at idle or failure (operator decision 2026-10-08). Only
/// with no open turn does a new one start.
fn native_status_event(
    prior: Option<&WorkerState>,
    status: &str,
    open_turn: Option<TurnId>,
) -> Option<WorkerEvent> {
    match status {
        "working" => match prior {
            Some(WorkerState::Active { .. }) => None,
            _ => Some(WorkerEvent::TurnStarted {
                turn_id: open_turn.unwrap_or_else(|| TurnId::from_ulid(ulid::Ulid::new())),
            }),
        },
        "blocked" => match prior {
            // WorkerState::Waiting carries the reason as a flat String
            // (the WaitReason shape belongs to the event, not the state).
            Some(WorkerState::Waiting { reason }) if reason == "herdr_agent_blocked" => None,
            _ => Some(WorkerEvent::Waiting(WaitReason {
                reason: "herdr_agent_blocked".into(),
                detail: None,
            })),
        },
        "idle" | "done" => match prior {
            Some(WorkerState::Idle { .. }) => None,
            _ => Some(WorkerEvent::TurnCompleted(amux_core::protocol::TurnResult {
                turn_id: open_turn.unwrap_or_else(|| TurnId::from_ulid(ulid::Ulid::new())),
                outcome: "herdr agent idle".into(),
            })),
        },
        // `parse_workspace_statuses` never routes anything else here; a
        // future herdr status word falls through to the scrape rather than
        // being guessed at.
        _ => None,
    }
}

/// Apply a status report — a backend's native status, or `working` for a
/// pane the scrape saw generating — through [`native_status_event`]: a
/// working report starts a turn or resumes the live session's open one, an
/// idle report ends it. Decided inside the writer transaction, so the prior
/// state and open-turn reads cannot race another writer. Equilibrium writes
/// nothing (Invariant 37).
fn apply_status_report(
    conn: &Connection,
    worker: &WorkerId,
    status: &str,
    now: DateTime<Utc>,
) -> rusqlite::Result<WriteOutcome> {
    let prior = crate::db::queries::get_worker(conn, worker.as_str())?.map(|r| r.state);
    let open_turn = open_turn_id(conn, worker.as_str())?;
    match native_status_event(prior.as_ref(), status, open_turn) {
        Some(event) => crate::orchestrator::events::apply_event(conn, worker, &event, now),
        None => Ok(WriteOutcome { applied: false, events: vec![] }),
    }
}

/// Apply one scraped event. The scrape is a hookless lane's only voice, so it
/// is also the only thing that can END the turn its working frames opened
/// (Invariant 6):
///
/// - the idle prompt ends the live session's open turn with `TurnCompleted`,
///   the one transition that confirms a Delivered command (Invariant 34).
///   When the worker went idle straight from a rate limit or a wait, with no
///   resumed work between, it still confirms (operator decision 2026-10-08)
///   and the outcome says so rather than claiming work nobody observed;
/// - a failure is applied FIRST, because its attempt record reads the open
///   turn (tokens, wall clock, start), and the turn is ended after it in the
///   same transaction. The failure has already moved the command off
///   Delivered;
/// - a rate limit or any other wait leaves the turn open for the next
///   working frame to resume ([`apply_status_report`]).
fn apply_scraped_event(
    conn: &Connection,
    worker: &WorkerId,
    event: &WorkerEvent,
    now: DateTime<Utc>,
) -> rusqlite::Result<WriteOutcome> {
    use crate::orchestrator::events::apply_event;
    let wid = worker.as_str();
    match event {
        WorkerEvent::Waiting(wait) if wait.reason == "idle_prompt" => {
            let Some(turn_id) = open_turn_id(conn, wid)? else {
                return apply_event(conn, worker, event, now);
            };
            let outcome = match crate::db::queries::get_worker(conn, wid)?.map(|r| r.state) {
                Some(WorkerState::RateLimited { .. }) => {
                    "terminal idle prompt after a rate limit; no resumed work observed".to_string()
                }
                Some(WorkerState::Waiting { reason }) => format!(
                    "terminal idle prompt after waiting ({reason}); no resumed work observed"
                ),
                _ => "terminal idle prompt".to_string(),
            };
            apply_event(
                conn,
                worker,
                &WorkerEvent::TurnCompleted(TurnResult { turn_id, outcome }),
                now,
            )
        }
        WorkerEvent::Failed(failure) => {
            let open_turn = open_turn_id(conn, wid)?;
            let mut reply = apply_event(conn, worker, event, now)?;
            if let Some(turn_id) = open_turn {
                let outcome =
                    serde_json::json!({ "outcome": format!("failed: {}", failure.reason) });
                let n = conn.execute(
                    "UPDATE _amux_turns SET ended_at = ?2, outcome = ?3
                     WHERE id = ?1 AND ended_at IS NULL",
                    params![turn_id.as_str(), now.to_rfc3339(), outcome.to_string()],
                )?;
                if n > 0 {
                    reply.events.push(PendingEvent {
                        entity_type: EntityType::Turn,
                        entity_id: turn_id.to_string(),
                        mutation: MutationKind::Updated,
                        payload: None,
                    });
                    reply.applied = true;
                }
            }
            Ok(reply)
        }
        _ => apply_event(conn, worker, event, now),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::{AttachInfo, BackendError, BackendSession, BackendStatus, SessionSpec};
    use crate::db::WriteOutcome;
    use crate::opencode::mock::MockProtocol;
    use crate::opencode::AgentState;
    use amux_core::ids::{CommandId, TaskId};
    use amux_core::protocol::{CommandState, CommandTransition, DeliveryTiming, WorkerCommand};
    use async_trait::async_trait;
    use rusqlite::params;

    /// Backend whose capture returns a scripted frame.
    #[derive(Default)]
    struct ScriptedBackend {
        name: &'static str,
        frame: String,
        /// Native agent states the backend reports (backend_ref -> status).
        /// Empty = the tmux default (no native voice).
        native: BTreeMap<String, String>,
        exits: BTreeMap<String, ExitStatus>,
        exit_probe_fails: bool,
        /// Runs once, inside the next native-status read: the store changing
        /// between that report and the write that applies it.
        during_states: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    }

    #[async_trait]
    impl SessionBackend for ScriptedBackend {
        fn name(&self) -> &'static str {
            self.name
        }
        async fn spawn(&self, _s: &SessionSpec) -> crate::backend::Result<ProcessRef> {
            Err(BackendError::SpawnFailed("scripted".into()))
        }
        async fn terminate(&self, _p: &ProcessRef) -> crate::backend::Result<()> {
            Ok(())
        }
        async fn status(&self, _p: &ProcessRef) -> crate::backend::Result<BackendStatus> {
            Ok(BackendStatus::Running)
        }
        async fn attach_info(&self, _p: &ProcessRef) -> crate::backend::Result<AttachInfo> {
            Ok(AttachInfo { command: "true".into() })
        }
        async fn reconcile(&self) -> crate::backend::Result<Vec<BackendSession>> {
            Ok(vec![])
        }
        async fn capture(&self, _p: &ProcessRef, _l: u32) -> crate::backend::Result<String> {
            Ok(self.frame.clone())
        }
        async fn agent_states(&self) -> crate::backend::Result<BTreeMap<String, String>> {
            let during = self.during_states.lock().unwrap().take();
            if let Some(f) = during {
                f();
            }
            Ok(self.native.clone())
        }
        async fn process_exits(&self) -> crate::backend::Result<BTreeMap<String, ExitStatus>> {
            if self.exit_probe_fails {
                Err(BackendError::CommandFailed("controlled unreadable exit census".into()))
            } else { Ok(self.exits.clone()) }
        }
    }

    fn store() -> SharedStore {
        let dir = tempfile::tempdir().unwrap();
        let s = Arc::new(crate::db::Store::open(&dir.path().join("t.db")).unwrap());
        std::mem::forget(dir);
        s
    }

    fn wid(n: u128) -> WorkerId {
        WorkerId::from_ulid(ulid::Ulid::from_parts(1_700_000_000_000, 800 + n))
    }

    fn seed_terminal_worker(store: &SharedStore, w: &WorkerId) {
        seed_worker(store, w, "tmux", "amux-x");
    }

    fn seed_herdr_worker(store: &SharedStore, w: &WorkerId, backend_ref: &str) {
        seed_worker(store, w, "herdr", backend_ref);
    }

    /// A tmux worker whose provider is codex (hookless: the scrape is its only
    /// voice), for the AMUX-3165 active-via-scrape path.
    fn seed_codex_worker(store: &SharedStore, w: &WorkerId) {
        seed_hookless_worker(store, w, "codex");
    }

    fn seed_hookless_worker(store: &SharedStore, w: &WorkerId, provider: &str) {
        let (id, sid, provider) = (w.to_string(), format!("ses_{w}"), provider.to_string());
        store
            .write(move |conn| {
                conn.execute(
                    "INSERT INTO _amux_workers (id, display_name, provider, created_at, updated_at)
                     VALUES (?1, 'term', ?2, 'now', 'now')",
                    params![id, provider],
                )?;
                conn.execute(
                    "INSERT INTO _amux_sessions (id, worker_id, backend, backend_ref, started_at)
                     VALUES (?1, ?2, 'tmux', 'amux-cx', 'now')",
                    params![sid, id],
                )?;
                Ok(WriteOutcome { applied: true, events: vec![] })
            })
            .unwrap();
    }

    fn seed_worker(store: &SharedStore, w: &WorkerId, backend: &str, backend_ref: &str) {
        let (id, sid) = (w.to_string(), format!("ses_{w}"));
        let (backend, backend_ref) = (backend.to_string(), backend_ref.to_string());
        store
            .write(move |conn| {
                conn.execute(
                    "INSERT INTO _amux_workers (id, display_name, provider, created_at, updated_at)
                     VALUES (?1, 'term', 'claude-code', 'now', 'now')",
                    params![id],
                )?;
                conn.execute(
                    "INSERT INTO _amux_sessions (id, worker_id, backend, backend_ref, started_at)
                     VALUES (?1, ?2, ?3, ?4, 'now')",
                    params![sid, id, backend, backend_ref],
                )?;
                Ok(WriteOutcome { applied: true, events: vec![] })
            })
            .unwrap();
    }

    fn worker_state(store: &SharedStore, w: &WorkerId) -> WorkerState {
        let conn = store.read().unwrap();
        crate::db::queries::get_worker(&conn, w.as_str())
            .unwrap()
            .expect("worker row")
            .state
    }

    // A frame the Claude adapter flags: the weekly limit banner (fixture
    // shape from adapter.rs's corpus).
    const LIMIT_FRAME: &str = "\n\u{23fa} did things\nYou've reached your weekly limit \u{00b7} resets 3pm\n\u{276f} \n";

    #[tokio::test]
    async fn exit_probe_absence_failure_or_another_worker_cannot_stop_a_live_worker() {
        for (n, fails, foreign) in [(1, false, false), (2, true, false), (3, false, true)] {
            let store = store();
            let w = wid(100 + n);
            seed_terminal_worker(&store, &w);
            let id = w.to_string();
            store.write(move |conn| {
                let now = chrono::Utc::now();
                crate::db::queries::update_worker_state(conn, &id,
                    &WorkerState::Idle { since: now }, &now.to_rfc3339())?;
                Ok(WriteOutcome { applied: true, events: vec![] })
            }).unwrap();
            let scan = ScanLoop::new(store.clone(), vec![Arc::new(ScriptedBackend {
                name: "tmux", frame: String::new(), exit_probe_fails: fails,
                exits: if foreign { BTreeMap::from([("amux-other".into(),
                    ExitStatus { code: Some(1), signal: None })]) } else { BTreeMap::new() },
                ..Default::default()
            })], None);
            let report = scan.scan_once().await.unwrap();
            assert!(matches!(worker_state(&store, &w), WorkerState::Idle { .. }));
            assert_eq!(report.events_applied, 0);
            assert!(report.process_exits.is_empty());
            assert_eq!(report.process_exit_failures.len(), usize::from(fails));
            let conn = store.read().unwrap();
            assert!(crate::db::queries::live_session_for(&conn, w.as_str()).unwrap().is_some());
        }
    }

    #[tokio::test]
    async fn structured_session_is_demoted_not_scanned() {
        let store = store();
        let w = wid(1);
        seed_terminal_worker(&store, &w);
        let protocol = Arc::new(MockProtocol::new());
        protocol.register(w.clone(), AgentState::Idle); // structured = live
        let scan = ScanLoop::new(
            store,
            vec![Arc::new(ScriptedBackend {
                name: "tmux",
                frame: LIMIT_FRAME.into(),
                native: BTreeMap::new(),
                exits: BTreeMap::from([("amux-x".into(), ExitStatus { code: Some(1), signal: None })]),
                ..Default::default()
            })],
            Some(protocol),
        );
        let r = scan.scan_once().await.unwrap();
        assert_eq!(r.demoted_structured, vec![w.to_string()]);
        assert!(r.scanned.is_empty(), "demoted worker must not be captured");
    }

    #[tokio::test]
    async fn hookless_worker_is_scanned_and_events_dedupe() {
        let store = store();
        let w = wid(2);
        seed_terminal_worker(&store, &w);
        // No protocol session: the scraper is this worker's only voice.
        let scan = ScanLoop::new(
            store.clone(),
            vec![Arc::new(ScriptedBackend {
                name: "tmux",
                frame: LIMIT_FRAME.into(),
                native: BTreeMap::new(),
                ..Default::default()
            })],
            Some(Arc::new(MockProtocol::new())),
        );
        let r1 = scan.scan_once().await.unwrap();
        assert_eq!(r1.scanned, vec![w.to_string()]);
        // Whether the fixture fires depends on the adapter's exact anchors;
        // what MUST hold: a second identical pass applies nothing new.
        let r2 = scan.scan_once().await.unwrap();
        assert_eq!(r2.events_applied, 0, "identical frame must dedupe: {r2:?}");
    }

    #[tokio::test]
    async fn capture_failure_is_reported_not_silent() {
        struct FailingBackend;
        #[async_trait]
        impl SessionBackend for FailingBackend {
            fn name(&self) -> &'static str { "tmux" }
            async fn spawn(&self, _s: &SessionSpec) -> crate::backend::Result<ProcessRef> {
                Err(BackendError::SpawnFailed("x".into()))
            }
            async fn terminate(&self, _p: &ProcessRef) -> crate::backend::Result<()> { Ok(()) }
            async fn status(&self, _p: &ProcessRef) -> crate::backend::Result<BackendStatus> {
                Ok(BackendStatus::NotFound)
            }
            async fn attach_info(&self, _p: &ProcessRef) -> crate::backend::Result<AttachInfo> {
                Ok(AttachInfo { command: "true".into() })
            }
            async fn reconcile(&self) -> crate::backend::Result<Vec<BackendSession>> { Ok(vec![]) }
            async fn capture(&self, _p: &ProcessRef, _l: u32) -> crate::backend::Result<String> {
                Err(BackendError::CommandFailed("pane gone".into()))
            }
        }
        let store = store();
        let w = wid(3);
        seed_terminal_worker(&store, &w);
        let scan = ScanLoop::new(store, vec![Arc::new(FailingBackend)], None);
        let r = scan.scan_once().await.unwrap();
        assert_eq!(r.capture_failures.len(), 1);
        assert!(r.capture_failures[0].contains("pane gone"));
    }

    // ---- native backend status (#84) ---------------------------------------

    fn native(ref_: &str, status: &str) -> BTreeMap<String, String> {
        BTreeMap::from([(ref_.to_string(), status.to_string())])
    }

    #[tokio::test]
    async fn native_working_starts_turn_and_demotes_capture() {
        let store = store();
        let w = wid(10);
        seed_herdr_worker(&store, &w, "amux-herdr-1");
        let scan = ScanLoop::new(
            store.clone(),
            vec![Arc::new(ScriptedBackend {
                name: "herdr",
                frame: LIMIT_FRAME.into(),
                native: native("amux-herdr-1", "working"),
                ..Default::default()
            })],
            Some(Arc::new(MockProtocol::new())),
        );
        let r = scan.scan_once().await.unwrap();
        assert_eq!(r.demoted_native, vec![w.to_string()]);
        assert!(r.scanned.is_empty(), "native answer must demote the scrape");
        assert_eq!(r.events_applied, 1, "TurnStarted: {r:?}");
        assert!(matches!(worker_state(&store, &w), WorkerState::Active { .. }));
    }

    #[tokio::test]
    async fn native_blocked_marks_waiting() {
        let store = store();
        let w = wid(11);
        seed_herdr_worker(&store, &w, "amux-herdr-1");
        let scan = ScanLoop::new(
            store.clone(),
            vec![Arc::new(ScriptedBackend {
                name: "herdr",
                frame: LIMIT_FRAME.into(),
                native: native("amux-herdr-1", "blocked"),
                ..Default::default()
            })],
            Some(Arc::new(MockProtocol::new())),
        );
        let r = scan.scan_once().await.unwrap();
        assert_eq!(r.demoted_native.len(), 1);
        assert!(matches!(
            worker_state(&store, &w),
            WorkerState::Waiting { ref reason } if reason == "herdr_agent_blocked"
        ));
    }

    #[tokio::test]
    async fn native_idle_completes_turn_and_equilibrium_applies_nothing() {
        let store = store();
        let w = wid(12);
        seed_herdr_worker(&store, &w, "amux-herdr-1");
        let scan = ScanLoop::new(
            store.clone(),
            vec![Arc::new(ScriptedBackend {
                name: "herdr",
                frame: LIMIT_FRAME.into(),
                native: native("amux-herdr-1", "working"),
                ..Default::default()
            })],
            Some(Arc::new(MockProtocol::new())),
        );
        let r1 = scan.scan_once().await.unwrap();
        assert_eq!(r1.events_applied, 1, "working -> TurnStarted");
        // Same working report again: equilibrium, no event, no revision churn.
        let r2 = scan.scan_once().await.unwrap();
        assert_eq!(r2.events_applied, 0, "equilibrium must apply nothing: {r2:?}");
        // The backend now reports idle (a fresh backend answers the same
        // lane — the store, not the loop, carries the prior state).
        let scan = ScanLoop::new(
            store.clone(),
            vec![Arc::new(ScriptedBackend {
                name: "herdr",
                frame: LIMIT_FRAME.into(),
                native: native("amux-herdr-1", "idle"),
                ..Default::default()
            })],
            Some(Arc::new(MockProtocol::new())),
        );
        let r3 = scan.scan_once().await.unwrap();
        assert_eq!(r3.events_applied, 1, "idle -> TurnCompleted");
        assert!(matches!(worker_state(&store, &w), WorkerState::Idle { .. }));
        // Idle again: nothing.
        let r4 = scan.scan_once().await.unwrap();
        assert_eq!(r4.events_applied, 0, "idle equilibrium must apply nothing");
    }

    #[tokio::test]
    async fn native_unknown_or_absent_falls_back_to_scrape() {
        let store = store();
        let w = wid(13);
        // `parse_workspace_statuses` omits `unknown` refs, so the map simply
        // does not carry this lane — the scrape stays its only voice.
        seed_herdr_worker(&store, &w, "amux-herdr-other");
        let scan = ScanLoop::new(
            store,
            vec![Arc::new(ScriptedBackend {
                name: "herdr",
                frame: LIMIT_FRAME.into(),
                native: native("amux-herdr-1", "unknown"),
                ..Default::default()
            })],
            Some(Arc::new(MockProtocol::new())),
        );
        let r = scan.scan_once().await.unwrap();
        assert_eq!(r.scanned, vec![w.to_string()]);
        assert!(r.demoted_native.is_empty());
    }

    #[tokio::test]
    async fn native_read_failure_falls_back_and_is_named() {
        struct FlakyNativeBackend;
        #[async_trait]
        impl SessionBackend for FlakyNativeBackend {
            fn name(&self) -> &'static str { "herdr" }
            async fn spawn(&self, _s: &SessionSpec) -> crate::backend::Result<ProcessRef> {
                Err(BackendError::SpawnFailed("x".into()))
            }
            async fn terminate(&self, _p: &ProcessRef) -> crate::backend::Result<()> { Ok(()) }
            async fn status(&self, _p: &ProcessRef) -> crate::backend::Result<BackendStatus> {
                Ok(BackendStatus::Running)
            }
            async fn attach_info(&self, _p: &ProcessRef) -> crate::backend::Result<AttachInfo> {
                Ok(AttachInfo { command: "true".into() })
            }
            async fn reconcile(&self) -> crate::backend::Result<Vec<BackendSession>> { Ok(vec![]) }
            async fn capture(&self, _p: &ProcessRef, _l: u32) -> crate::backend::Result<String> {
                Ok(LIMIT_FRAME.to_string())
            }
            async fn agent_states(&self) -> crate::backend::Result<BTreeMap<String, String>> {
                Err(BackendError::CommandFailed(
                    "server_not_running: herdr is down".into(),
                ))
            }
        }
        let store = store();
        let w = wid(14);
        seed_herdr_worker(&store, &w, "amux-herdr-1");
        let scan = ScanLoop::new(store, vec![Arc::new(FlakyNativeBackend)], None);
        let r = scan.scan_once().await.unwrap();
        assert_eq!(r.scanned, vec![w.to_string()], "scrape is the fallback");
        assert_eq!(r.native_status_failures.len(), 1);
        assert!(r.native_status_failures[0].contains("server_not_running"));
    }

    #[tokio::test]
    async fn protocol_voice_outranks_native_report() {
        let store = store();
        let w = wid(15);
        seed_herdr_worker(&store, &w, "amux-herdr-1");
        let protocol = Arc::new(MockProtocol::new());
        protocol.register(w.clone(), AgentState::Idle);
        let scan = ScanLoop::new(
            store.clone(),
            vec![Arc::new(ScriptedBackend {
                name: "herdr",
                frame: LIMIT_FRAME.into(),
                native: native("amux-herdr-1", "working"),
                ..Default::default()
            })],
            Some(protocol),
        );
        let r = scan.scan_once().await.unwrap();
        assert_eq!(r.demoted_structured, vec![w.to_string()]);
        assert!(r.demoted_native.is_empty());
        assert_eq!(r.events_applied, 0, "the worker speaks for itself");
        assert_eq!(worker_state(&store, &w), WorkerState::Stopped);
    }

    #[test]
    fn native_status_event_mapping_table() {
        let turn = || Some(TurnId::from_ulid(ulid::Ulid::from_parts(1, 1)));
        let active = WorkerState::Active { turn: None };
        let idle = WorkerState::Idle { since: chrono::Utc::now() };
        let waiting = WorkerState::Waiting { reason: "herdr_agent_blocked".into() };

        // Unknown status words never guess.
        assert!(native_status_event(Some(&idle), "unknown", turn()).is_none());
        assert!(native_status_event(Some(&idle), "somewhere-else", turn()).is_none());

        // working: only from not-Active. An open turn is resumed under its
        // own id; with none open, a fresh one starts.
        assert!(native_status_event(Some(&active), "working", turn()).is_none());
        for prior in [Some(&idle), Some(&waiting), None] {
            match native_status_event(prior, "working", turn()) {
                Some(WorkerEvent::TurnStarted { turn_id }) => assert_eq!(turn_id, turn().unwrap()),
                other => panic!("working from {prior:?} must resume the open turn, got {other:?}"),
            }
            match native_status_event(prior, "working", None) {
                Some(WorkerEvent::TurnStarted { turn_id }) => assert_ne!(turn_id, turn().unwrap()),
                other => panic!("working from {prior:?} must start a turn, got {other:?}"),
            }
        }

        // blocked: only from not-that-Waiting.
        assert!(native_status_event(Some(&waiting), "blocked", turn()).is_none());
        assert!(matches!(
            native_status_event(Some(&active), "blocked", turn()),
            Some(WorkerEvent::Waiting(_))
        ));

        // idle/done close an open turn; equilibrium applies nothing; the
        // done≡idle mapping is the same branch.
        assert!(native_status_event(Some(&idle), "idle", turn()).is_none());
        assert!(native_status_event(Some(&idle), "done", turn()).is_none());
        for st in ["idle", "done"] {
            match native_status_event(Some(&active), st, turn()) {
                Some(WorkerEvent::TurnCompleted(res)) => {
                    assert_eq!(res.turn_id, turn().unwrap());
                }
                other => panic!("{st} from Active must complete the open turn, got {other:?}"),
            }
        }
        // No open turn on record: a synthesized id still completes —
        // apply_event names the missing TurnStarted in the log.
        assert!(matches!(
            native_status_event(Some(&active), "idle", None),
            Some(WorkerEvent::TurnCompleted(_))
        ));
    }

    // ---- codex/ollama active via scrape (AMUX-3165) ------------------------

    // The pane the live incident showed: a working ollama lane that read
    // running=false the whole time because nothing emitted its active state.
    const CODEX_WORKING: &str = "\u{203a} do the thing\n\n\u{2022} Working (12s \u{2022} esc to interrupt)";
    // The idle model bar — must NOT mark the lane active.
    const CODEX_IDLE: &str = "\u{203a} implement {feature}\n\n  gpt-5.5 xhigh \u{b7} ~/Dev/amux";

    #[tokio::test]
    async fn codex_working_pane_marks_active_and_does_not_churn() {
        let store = store();
        let w = wid(20);
        seed_codex_worker(&store, &w);
        // Hookless: no protocol session, so the scrape is this lane's only voice.
        let scan = ScanLoop::new(
            store.clone(),
            vec![Arc::new(ScriptedBackend {
                name: "tmux",
                frame: CODEX_WORKING.into(),
                native: BTreeMap::new(),
                ..Default::default()
            })],
            Some(Arc::new(MockProtocol::new())),
        );
        let r1 = scan.scan_once().await.unwrap();
        assert_eq!(r1.scanned, vec![w.to_string()]);
        assert_eq!(r1.events_applied, 1, "working pane -> TurnStarted: {r1:?}");
        assert!(
            matches!(worker_state(&store, &w), WorkerState::Active { .. }),
            "a '• Working' codex pane must read Active, not running=false (AMUX-3165)"
        );
        // Still working next pass: EDGE-gated, so no new turn / StatusChanged
        // churn (Invariant 37) even though the fresh scan is not deduped.
        let r2 = scan.scan_once().await.unwrap();
        assert_eq!(r2.events_applied, 0, "already-Active must not re-fire: {r2:?}");
        assert!(matches!(worker_state(&store, &w), WorkerState::Active { .. }));
    }

    #[tokio::test]
    async fn codex_idle_pane_is_not_marked_active() {
        let store = store();
        let w = wid(21);
        seed_codex_worker(&store, &w);
        let scan = ScanLoop::new(
            store.clone(),
            vec![Arc::new(ScriptedBackend {
                name: "tmux",
                frame: CODEX_IDLE.into(),
                native: BTreeMap::new(),
                ..Default::default()
            })],
            Some(Arc::new(MockProtocol::new())),
        );
        let r = scan.scan_once().await.unwrap();
        assert_eq!(r.scanned, vec![w.to_string()]);
        // The idle model bar emits idle_prompt (Waiting), never Active.
        assert!(
            !matches!(worker_state(&store, &w), WorkerState::Active { .. }),
            "an idle codex model bar must not read Active"
        );
    }

    // ---- a scraped turn ends where the worker yields (Invariant 6) ---------
    //
    // Operator decision 2026-10-08: a scraped turn spans a rate limit or a
    // wait. The next working frame resumes the SAME turn; the turn ends at the
    // idle prompt (TurnCompleted, which confirms the Delivered command) or at a
    // failure (after the attempt is recorded). An idle prompt after a limit
    // with no resumed work still confirms, and its outcome says so.

    // A usage-limit banner above the resting composer: the adapter reads it as
    // RateLimited (the composer under it is chrome, not idle).
    const CODEX_LIMIT: &str = "\u{25a0} You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 4 days 2 hours.\n\n\u{203a} Ask Codex to do anything\n\n  gpt-5.5 xhigh \u{b7} ~/Dev/amux";
    // Codex's own auth-failure marker above the resting composer: Failed.
    const CODEX_AUTH: &str = "\u{203a} [09:04 AM] Reply only with isolated-ok.\n\n\u{25a0} Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.\n\n\u{203a} Ask Codex to do anything\n  gpt-5.5 xhigh \u{b7} ~/Dev/amux";

    /// A tmux pane the test repaints between passes, so ONE ScanLoop -- and
    /// its dedupe memory, which is where the defect lived -- sees the whole
    /// sequence.
    #[derive(Default)]
    struct Screen {
        frame: String,
        /// Runs once, inside the next capture: the store changing between the
        /// capture and the write that applies it.
        during_capture: Option<Box<dyn FnOnce() + Send>>,
    }

    struct Pane(Arc<Mutex<Screen>>);

    #[async_trait]
    impl SessionBackend for Pane {
        fn name(&self) -> &'static str { "tmux" }
        async fn spawn(&self, _s: &SessionSpec) -> crate::backend::Result<ProcessRef> {
            Err(BackendError::SpawnFailed("pane".into()))
        }
        async fn terminate(&self, _p: &ProcessRef) -> crate::backend::Result<()> { Ok(()) }
        async fn status(&self, _p: &ProcessRef) -> crate::backend::Result<BackendStatus> {
            Ok(BackendStatus::Running)
        }
        async fn attach_info(&self, _p: &ProcessRef) -> crate::backend::Result<AttachInfo> {
            Ok(AttachInfo { command: "true".into() })
        }
        async fn reconcile(&self) -> crate::backend::Result<Vec<BackendSession>> { Ok(vec![]) }
        async fn capture(&self, _p: &ProcessRef, _l: u32) -> crate::backend::Result<String> {
            let during = self.0.lock().unwrap().during_capture.take();
            if let Some(f) = during {
                f();
            }
            Ok(self.0.lock().unwrap().frame.clone())
        }
    }

    /// One `_amux_turns` row: (id, ended_at, outcome text).
    type TurnRow = (String, Option<String>, Option<String>);

    struct Lane {
        store: SharedStore,
        w: WorkerId,
        cmd: CommandId,
        screen: Arc<Mutex<Screen>>,
        scan: ScanLoop,
    }

    impl Lane {
        /// A hookless `provider` worker, idle, holding one Delivered command:
        /// the state the pump leaves after handing it a prompt.
        fn new(n: u128, provider: &str, command: WorkerCommand) -> Lane {
            let store = store();
            let w = wid(n);
            seed_hookless_worker(&store, &w, provider);
            let cmd = CommandId::from_ulid(ulid::Ulid::from_parts(1_700_000_000_000, 900 + n));
            let (id, worker, c) = (cmd.clone(), w.clone(), command);
            store
                .write(move |conn| {
                    let now = chrono::Utc::now();
                    crate::db::queries::update_worker_state(conn, worker.as_str(),
                        &WorkerState::Idle { since: now }, &now.to_rfc3339())?;
                    crate::db::commands::enqueue(conn, id.clone(), &worker, &c, "scan-turn",
                        &DeliveryTiming::Immediate, None, now)?;
                    for t in [CommandTransition::Dispatch, CommandTransition::Deliver] {
                        crate::db::commands::transition(conn, &id, t, 3)?;
                    }
                    Ok(WriteOutcome { applied: true, events: vec![] })
                })
                .unwrap();
            let screen = Arc::new(Mutex::new(Screen::default()));
            let scan = ScanLoop::new(store.clone(), vec![Arc::new(Pane(screen.clone()))], None);
            Lane { store, w, cmd, screen, scan }
        }

        async fn pass(&self, frame: &str) -> ScanReport {
            self.screen.lock().unwrap().frame = frame.to_string();
            self.scan.scan_once().await.unwrap()
        }


        fn state(&self) -> WorkerState {
            worker_state(&self.store, &self.w)
        }

        fn command(&self) -> CommandState {
            let conn = self.store.read().unwrap();
            crate::db::commands::by_id(&conn, &self.cmd).unwrap().unwrap().state
        }

        fn turns(&self) -> Vec<TurnRow> {
            let conn = self.store.read().unwrap();
            let mut stmt = conn
                .prepare(
                    "SELECT id, ended_at, json_extract(outcome, '$.outcome') FROM _amux_turns
                     WHERE worker_id = ?1 ORDER BY started_at, id",
                )
                .unwrap();
            stmt.query_map(params![self.w.as_str()], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        }

        /// Exactly one turn row, still open, and the worker Active on it.
        fn assert_one_open_turn(&self, label: &str) -> String {
            let turns = self.turns();
            assert_eq!(turns.len(), 1, "{label}: one turn row, got {turns:?}");
            assert!(turns[0].1.is_none(), "{label}: the turn must still be open: {turns:?}");
            turns[0].0.clone()
        }
    }

    fn active_on(state: &WorkerState) -> Option<String> {
        match state {
            WorkerState::Active { turn } => turn.as_ref().map(|t| t.to_string()),
            _ => None,
        }
    }

    // Copilot CLI 1.0.91 (adapter.rs fixtures): mid-turn running the shell
    // tool, and the composer at rest with the hints footer.
    const COPILOT_WORKING: &str = " ❯ Run the shell command `echo amux-copilot-probe` exactly once, then reply with only its output.   23:26
 $ Shell Run the requested echo command 1 line…
   echo amux-copilot-probe
 /tmp/copilot-probe-hpjC                                          Session: 0.19 AIC used
────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────
 ● Working · 106 B esc interrupt                                  Auto → GPT-6 Luna";
    const COPILOT_IDLE: &str = " ● amux-copilot-probe
 /tmp/copilot-probe-hpjC                                          Session: 0.21 AIC used
────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────
 ← open sidebar · Interactive · Allow All · / commands · ? help · tab next tab   GPT-5.6 Sol";

    #[tokio::test]
    async fn scraped_turn_ends_at_the_identical_idle_prompt_after_it() {
        for (n, provider, idle, working) in [
            (40, "codex", CODEX_IDLE, CODEX_WORKING),
            (41, "ollama", CODEX_IDLE, CODEX_WORKING),
            (49, "copilot", COPILOT_IDLE, COPILOT_WORKING),
        ] {
            let lane = Lane::new(n, provider, WorkerCommand::Continue);
            // The SAME idle frame before and after the turn: the second one was
            // deduped as "still on screen" and the worker stayed Active.
            lane.pass(idle).await;
            lane.pass(working).await;
            let turn = lane.assert_one_open_turn(provider);
            assert_eq!(active_on(&lane.state()), Some(turn.clone()), "{provider}");
            assert_eq!(lane.command(), CommandState::Delivered, "{provider}");

            lane.pass(idle).await;
            assert!(matches!(lane.state(), WorkerState::Idle { .. }), "{provider}: {:?}", lane.state());
            let turns = lane.turns();
            assert_eq!(turns.len(), 1, "{provider}: {turns:?}");
            assert!(turns[0].1.is_some(), "{provider}: the turn must end at the idle prompt: {turns:?}");
            assert_eq!(turns[0].2.as_deref(), Some("terminal idle prompt"), "{provider}");
            assert_eq!(lane.command(), CommandState::Confirmed, "{provider}");
            // Still idle: nothing more (Invariant 37).
            assert_eq!(lane.pass(idle).await.events_applied, 0, "{provider}");
        }
    }

    #[tokio::test]
    async fn scraped_turn_spans_limits_and_ends_once_at_idle() {
        for (n, provider) in [(42, "codex"), (43, "ollama")] {
            let lane = Lane::new(n, provider, WorkerCommand::Continue);
            lane.pass(CODEX_WORKING).await;
            let turn = lane.assert_one_open_turn(provider);

            for round in 1..=2 {
                // The SAME banner both times: the second must apply again.
                let r = lane.pass(CODEX_LIMIT).await;
                assert_eq!(r.events_applied, 1, "{provider} limit {round}: {r:?}");
                assert!(matches!(lane.state(), WorkerState::RateLimited { .. }),
                    "{provider} limit {round}: {:?}", lane.state());
                assert_eq!(lane.assert_one_open_turn(provider), turn, "{provider} limit {round}");
                assert_eq!(lane.command(), CommandState::Delivered, "{provider} limit {round}");
                // The banner staying up is not a new occurrence (Invariant 37).
                assert_eq!(lane.pass(CODEX_LIMIT).await.events_applied, 0, "{provider} limit {round}");

                // Work resumes: the same turn, not a new row.
                let r = lane.pass(CODEX_WORKING).await;
                assert_eq!(r.events_applied, 1, "{provider} resume {round}: {r:?}");
                assert_eq!(lane.assert_one_open_turn(provider), turn, "{provider} resume {round}");
                assert_eq!(active_on(&lane.state()), Some(turn.clone()), "{provider} resume {round}");
                assert_eq!(lane.pass(CODEX_WORKING).await.events_applied, 0, "{provider} resume {round}");
            }

            lane.pass(CODEX_IDLE).await;
            let turns = lane.turns();
            assert_eq!(turns.len(), 1, "{provider}: {turns:?}");
            assert_eq!(turns[0].0, turn);
            assert!(turns[0].1.is_some(), "{provider}: {turns:?}");
            assert_eq!(turns[0].2.as_deref(), Some("terminal idle prompt"), "{provider}");
            assert!(matches!(lane.state(), WorkerState::Idle { .. }), "{provider}");
            assert_eq!(lane.command(), CommandState::Confirmed, "{provider}");
        }
    }

    #[tokio::test]
    async fn a_banner_left_in_scrollback_does_not_hold_the_resumed_turn_open() {
        // A short turn resumed after a limit: the banner is still on screen
        // above it, but the idle prompt below it ends the turn.
        const RESUMED_WORKING: &str = "\u{25a0} You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 4 days 2 hours.\n\n\u{203a} [10:12 AM] continue\n\n\u{2022} Working (3s \u{2022} esc to interrupt)\n\u{203a} Ask Codex to do anything\n  gpt-5.5 xhigh \u{b7} ~/Dev/amux";
        const RESUMED_IDLE: &str = "\u{25a0} You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 4 days 2 hours.\n\n\u{203a} [10:12 AM] continue\n\n\u{2022} Done: the parser change is pushed.\n\n\u{2022} Worked for 41s\n\n\u{203a} Ask Codex to do anything\n\n  gpt-5.5 xhigh \u{b7} ~/Dev/amux";
        for (n, provider) in [(51, "codex"), (52, "ollama")] {
            let lane = Lane::new(n, provider, WorkerCommand::Continue);
            lane.pass(CODEX_WORKING).await;
            let turn = lane.assert_one_open_turn(provider);
            lane.pass(CODEX_LIMIT).await;
            assert!(matches!(lane.state(), WorkerState::RateLimited { .. }), "{provider}");
            lane.pass(RESUMED_WORKING).await;
            assert_eq!(active_on(&lane.state()), Some(turn.clone()), "{provider}");
            lane.pass(RESUMED_IDLE).await;
            let turns = lane.turns();
            assert_eq!(turns.len(), 1, "{provider}: {turns:?}");
            assert!(turns[0].1.is_some(), "{provider}: the banner must not hold the turn open: {turns:?}");
            assert_eq!(turns[0].2.as_deref(), Some("terminal idle prompt"), "{provider}");
            assert_eq!(lane.command(), CommandState::Confirmed, "{provider}");
            assert!(matches!(lane.state(), WorkerState::Idle { .. }), "{provider}");
        }
    }

    #[tokio::test]
    async fn idle_after_a_limit_with_no_resumed_work_confirms_and_says_so() {
        for (n, provider) in [(44, "codex"), (45, "ollama")] {
            let lane = Lane::new(n, provider, WorkerCommand::Continue);
            lane.pass(CODEX_WORKING).await;
            lane.pass(CODEX_LIMIT).await;
            assert_eq!(lane.command(), CommandState::Delivered, "{provider}");
            lane.pass(CODEX_IDLE).await;
            let turns = lane.turns();
            assert_eq!(turns.len(), 1, "{provider}: {turns:?}");
            assert!(turns[0].1.is_some(), "{provider}: {turns:?}");
            assert_eq!(
                turns[0].2.as_deref(),
                Some("terminal idle prompt after a rate limit; no resumed work observed"),
                "{provider}"
            );
            assert_eq!(lane.command(), CommandState::Confirmed, "{provider}");
            assert!(matches!(lane.state(), WorkerState::Idle { .. }), "{provider}");
        }
    }

    #[tokio::test]
    async fn scraped_failure_records_the_attempt_then_ends_the_turn() {
        for (n, provider) in [(46, "codex"), (47, "ollama")] {
            let task = TaskId::from_ulid(ulid::Ulid::from_parts(1_700_000_000_000, 700 + n));
            let lane = Lane::new(n, provider, WorkerCommand::ExecuteTask(task.clone()));
            lane.pass(CODEX_WORKING).await;
            let turn = lane.assert_one_open_turn(provider);
            // A provider-reported token total on the open turn: the attempt
            // record can only carry it if it reads the turn BEFORE it ends.
            let t = turn.clone();
            lane.store
                .write(move |conn| {
                    conn.execute("UPDATE _amux_turns SET tokens = ?2 WHERE id = ?1",
                        params![t, r#"{"reported_total":1234}"#])?;
                    Ok(WriteOutcome { applied: true, events: vec![] })
                })
                .unwrap();

            lane.pass(CODEX_AUTH).await;
            assert!(matches!(lane.state(), WorkerState::Error { .. }), "{provider}: {:?}", lane.state());
            assert!(matches!(lane.command(), CommandState::Failed { .. }), "{provider}");
            let turns = lane.turns();
            assert_eq!(turns.len(), 1, "{provider}: {turns:?}");
            assert!(turns[0].1.is_some(), "{provider}: a failed turn must end: {turns:?}");
            assert!(turns[0].2.as_deref().is_some_and(|o| o.starts_with("failed: provider authentication required")),
                "{provider}: {turns:?}");
            let record: String = {
                let conn = lane.store.read().unwrap();
                conn.query_row("SELECT record FROM _amux_attempts WHERE task_id = ?1",
                    params![task.as_str()], |r| r.get(0)).unwrap()
            };
            let record: serde_json::Value = serde_json::from_str(&record).unwrap();
            assert_eq!(record["tokens_spent"], 1234, "{provider}: {record}");
            // The failure staying on screen is not a new occurrence.
            assert_eq!(lane.pass(CODEX_AUTH).await.events_applied, 0, "{provider}");
        }
    }

    #[tokio::test]
    async fn a_dead_sessions_open_turn_is_neither_resumed_nor_closed() {
        let lane = Lane::new(48, "codex", WorkerCommand::Continue);
        lane.pass(CODEX_WORKING).await;
        let old = lane.assert_one_open_turn("first session");
        // The session is replaced; its turn row was never ended.
        let w = lane.w.to_string();
        lane.store
            .write(move |conn| {
                conn.execute("UPDATE _amux_sessions SET ended_at = 'then' WHERE worker_id = ?1", params![w])?;
                conn.execute(
                    "INSERT INTO _amux_sessions (id, worker_id, backend, backend_ref, started_at)
                     VALUES ('ses_second', ?1, 'tmux', 'amux-cx2', 'now2')",
                    params![w],
                )?;
                Ok(WriteOutcome { applied: true, events: vec![] })
            })
            .unwrap();
        // The new session's idle prompt says nothing about the old turn, and
        // must not confirm a command the new session never received.
        lane.pass(CODEX_IDLE).await;
        let turns = lane.turns();
        assert_eq!(turns.len(), 1, "{turns:?}");
        assert!(turns[0].1.is_none(), "{turns:?}");
        assert_eq!(lane.command(), CommandState::Delivered);
        // Its working frame opens its own turn.
        lane.pass(CODEX_WORKING).await;
        let turns = lane.turns();
        assert_eq!(turns.len(), 2, "{turns:?}");
        let new = active_on(&lane.state()).expect("active on a turn");
        assert_ne!(new, old);
    }

    /// The worker's session is replaced by a new one (on `backend`) that has
    /// already started its own turn on a newly Delivered command, after any
    /// command the old session held was confirmed. Returns that turn and that
    /// command.
    fn replace_session(store: &SharedStore, w: &WorkerId, backend: &str, n: u128) -> (String, CommandId) {
        let (wid, worker, backend) = (w.to_string(), w.clone(), backend.to_string());
        let turn = TurnId::from_ulid(ulid::Ulid::from_parts(1_700_000_000_000, 950 + n));
        let cmd = CommandId::from_ulid(ulid::Ulid::from_parts(1_700_000_000_000, 960 + n));
        let (t, c) = (turn.clone(), cmd.clone());
        store
            .write(move |conn| {
                while let Some(old) = crate::db::commands::in_flight(conn, &worker)? {
                    crate::db::commands::transition(conn, &old.id, CommandTransition::Confirm, 3)?;
                }
                conn.execute("UPDATE _amux_sessions SET ended_at = 'then' WHERE worker_id = ?1", params![wid])?;
                conn.execute(
                    "INSERT INTO _amux_sessions (id, worker_id, backend, backend_ref, started_at)
                     VALUES ('ses_replacement', ?1, ?2, 'amux-replacement', 'now2')",
                    params![wid, backend],
                )?;
                crate::db::commands::enqueue(conn, c.clone(), &worker, &WorkerCommand::Continue,
                    "replacement", &DeliveryTiming::Immediate, None, chrono::Utc::now())?;
                for step in [CommandTransition::Dispatch, CommandTransition::Deliver] {
                    crate::db::commands::transition(conn, &c, step, 3)?;
                }
                conn.execute(
                    "INSERT INTO _amux_turns (id, session_id, worker_id, started_at)
                     VALUES (?1, 'ses_replacement', ?2, 'now2')",
                    params![t.as_str(), wid],
                )?;
                let now = chrono::Utc::now();
                crate::db::queries::update_worker_state(conn, worker.as_str(),
                    &WorkerState::Active { turn: Some(t) }, &now.to_rfc3339())?;
                Ok(WriteOutcome { applied: true, events: vec![] })
            })
            .unwrap();
        (turn.to_string(), cmd)
    }

    fn command_state(store: &SharedStore, cmd: &CommandId) -> CommandState {
        let conn = store.read().unwrap();
        crate::db::commands::by_id(&conn, cmd).unwrap().unwrap().state
    }

    fn turn_ended(store: &SharedStore, turn: &str) -> bool {
        let conn = store.read().unwrap();
        conn.query_row("SELECT ended_at IS NOT NULL FROM _amux_turns WHERE id = ?1",
            params![turn], |r| r.get(0)).unwrap()
    }

    #[tokio::test]
    async fn a_frame_captured_from_a_replaced_session_is_not_applied() {
        // Review r-20261008-005845-e02935: the idle frame is captured from the
        // old session; before it is written, the session is replaced and the
        // new one starts a turn on a new Delivered command. The old screen
        // must neither end that turn nor confirm that command.
        let lane = Lane::new(50, "codex", WorkerCommand::Continue);
        lane.pass(CODEX_WORKING).await;
        let replaced = Arc::new(Mutex::new(None));
        let (out, store, w) = (replaced.clone(), lane.store.clone(), lane.w.clone());
        lane.screen.lock().unwrap().during_capture = Some(Box::new(move || {
            *out.lock().unwrap() = Some(replace_session(&store, &w, "tmux", 50));
        }));
        let r = lane.pass(CODEX_IDLE).await;
        let (turn, cmd) = replaced.lock().unwrap().take().expect("the capture replaced the session");
        assert_eq!(r.stale_observations, vec![lane.w.to_string()], "{r:?}");
        assert_eq!(r.events_applied, 0, "{r:?}");
        assert!(!turn_ended(&lane.store, &turn), "{:?}", lane.turns());
        assert_eq!(command_state(&lane.store, &cmd), CommandState::Delivered);
        assert_eq!(active_on(&lane.state()), Some(turn.clone()));

        // The new session's own idle prompt, identical on screen, still applies:
        // the stale frame left no dedupe memory behind.
        let r = lane.pass(CODEX_IDLE).await;
        assert!(r.stale_observations.is_empty(), "{r:?}");
        assert!(turn_ended(&lane.store, &turn), "{:?}", lane.turns());
        assert_eq!(command_state(&lane.store, &cmd), CommandState::Confirmed);
    }

    #[tokio::test]
    async fn a_native_report_from_a_replaced_session_is_not_applied() {
        let store = store();
        let w = wid(17);
        seed_herdr_worker(&store, &w, "amux-herdr-1");
        ScanLoop::new(store.clone(), vec![Arc::new(ScriptedBackend {
            name: "herdr",
            native: native("amux-herdr-1", "working"),
            ..Default::default()
        })], None)
        .scan_once()
        .await
        .unwrap();
        // The old session's agent reports idle, and the session is replaced
        // between that report and its write.
        let replaced = Arc::new(Mutex::new(None));
        let (out, s, ww) = (replaced.clone(), store.clone(), w.clone());
        let r = ScanLoop::new(store.clone(), vec![Arc::new(ScriptedBackend {
            name: "herdr",
            native: native("amux-herdr-1", "idle"),
            during_states: Mutex::new(Some(Box::new(move || {
                *out.lock().unwrap() = Some(replace_session(&s, &ww, "herdr", 17));
            }))),
            ..Default::default()
        })], None)
        .scan_once()
        .await
        .unwrap();
        let (turn, cmd) = replaced.lock().unwrap().take().expect("the read replaced the session");
        assert_eq!(r.stale_observations, vec![w.to_string()], "{r:?}");
        assert_eq!(r.events_applied, 0, "{r:?}");
        assert!(!turn_ended(&store, &turn));
        assert_eq!(command_state(&store, &cmd), CommandState::Delivered);
    }

    #[tokio::test]
    async fn native_blocked_then_working_resumes_the_same_turn() {
        let store = store();
        let w = wid(16);
        seed_herdr_worker(&store, &w, "amux-herdr-1");
        let pass = |status: &'static str| {
            let store = store.clone();
            async move {
                ScanLoop::new(store, vec![Arc::new(ScriptedBackend {
                    name: "herdr",
                    native: native("amux-herdr-1", status),
                    ..Default::default()
                })], None)
                .scan_once()
                .await
                .unwrap()
            }
        };
        let turns = || -> Vec<(String, Option<String>)> {
            let conn = store.read().unwrap();
            let mut stmt = conn
                .prepare("SELECT id, ended_at FROM _amux_turns WHERE worker_id = ?1")
                .unwrap();
            stmt.query_map(params![w.as_str()], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        pass("working").await;
        pass("blocked").await;
        pass("working").await;
        let open = turns();
        assert_eq!(open.len(), 1, "blocked -> working is the same turn: {open:?}");
        assert!(open[0].1.is_none());
        pass("idle").await;
        let done = turns();
        assert_eq!(done.len(), 1, "{done:?}");
        assert!(done[0].1.is_some(), "the one turn ends at idle: {done:?}");
    }

    // ---- /api/debug/scan publish (AF-80) -----------------------------------

    #[tokio::test]
    async fn scan_pass_publishes_state_for_the_debug_endpoint() {
        // A completed pass must leave a trace in last_scan_state(), the state
        // GET /api/debug/scan reads, or a demotion is indistinguishable from a
        // scan that found nothing (ethos rule 4, the D1 "scan" deviation). This
        // fails if the publish is removed from scan_once: with no test publishing,
        // the global stays None across the binary and the expect() below fires.
        let store = store();
        let w = wid(30);
        seed_terminal_worker(&store, &w);
        let protocol = Arc::new(MockProtocol::new());
        protocol.register(w.clone(), AgentState::Idle); // structured = demoted
        let scan = ScanLoop::new(
            store,
            vec![Arc::new(ScriptedBackend {
                name: "tmux",
                frame: LIMIT_FRAME.into(),
                native: BTreeMap::new(),
                ..Default::default()
            })],
            Some(protocol),
        );
        let _ = scan.scan_once().await.unwrap();
        let published = last_scan_state().expect("scan_once must publish the pass");
        assert!(
            published.last_pass_at.is_some(),
            "a completed pass must stamp last_pass_at, got {published:?}"
        );
        // Content (which lane was demoted) is asserted on the RETURNED report by
        // the tests above; the global is asserted only for its wiring, because a
        // peer test's pass can overwrite it between this publish and read.
    }
}
