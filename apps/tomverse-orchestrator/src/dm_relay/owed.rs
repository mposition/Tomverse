//! The records the relay still owes the app and the local AMUX (owner
//! direction 2026-11-16: an unknown or refused write never stops the relay
//! until a person restarts it).
//!
//! A write whose answer was lost, or that was refused for a reason that says
//! nothing about the request -- a busy database, the routes closed, the
//! bridge refused -- is not dropped and does not stop the relay: it is kept
//! here and sent again on every tick, beside the other questions, until the
//! answer is the ledger's own word for it. Every record is keyed by its
//! request, and the app writes each at most once and answers what the ledger
//! already holds -- a closed request, an outcome already recorded, the
//! (request, digest) pair already settled -- so sending one again is its
//! read-back and can never write it twice. A result is read back by its
//! (request, digest) pair (`results/lookup`) before it is submitted again,
//! and the app accepts that submission after a `result_unknown` of the same
//! digest (migration 20261116140000_amux_dm_request_windows).
//!
//! Two records also hold something back while they are owed: a cleanup
//! report its instance (nothing more is sent to an instance whose §5 latch the
//! app may not know it owes), and a session's pause that session (no other
//! answer is delivered to a session whose delivery is unknown before its pause
//! is confirmed, §9).
//!
//! The records survive a restart (`OwedStore`, owner review 2026-11-16): the
//! relay restarts often now -- after any halt of an older binary and after a
//! reboot -- and a result whose answer was lost, a cleanup report, or a
//! session's pause held only in memory would be forgotten with the process,
//! with the instance and session blocks they carry. Every change to the
//! records is written to one local file the moment it is made (`OwedBook`:
//! before the first call that could be lost), and the first tick reads it back.

use std::collections::BTreeSet;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::flow::{AppRoute, DmApp, DmLocal, LocalRoute};
use super::wire::{lookup_settled, read_app_answer, submission_settled, AppAnswer, HttpAnswer};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OwedRecord {
    /// §2-3: close an assigned request whose card was not sent.
    Discard { request_id: String },
    /// §10: a transmission's receipt, or its unknown outcome.
    TransmitOutcome {
        request_id: String,
        instance: String,
        outcome: String,
    },
    /// §5: a cleanup the broker could not confirm. Nothing more is sent to
    /// the instance while it is owed.
    CleanupUnknown {
        request_id: String,
        instance: String,
    },
    /// §9: a result whose answer was lost and that its lookup did not find.
    Result {
        request_id: String,
        instance: String,
        submission: Value,
        result_digest: String,
        /// Whether `results/unknown` has its answer (or has nothing to record).
        unknown_settled: bool,
    },
    /// Stage S2-2b3: a delivery decision's outcome -- `receipt`, `unknown`,
    /// or `not_sent` with its reason.
    DeliveryOutcome {
        request_id: String,
        outcome: String,
        reason: Option<String>,
    },
    /// §9: pause the session of a delivery whose result is unknown, and read
    /// its receipt. No other answer goes to the session while it is owed.
    Pause {
        card_id: String,
        question_revision: i64,
        request_id: String,
        session: String,
    },
}

impl OwedRecord {
    /// The instance this record holds back, if any.
    pub fn held_instance(&self) -> Option<&str> {
        match self {
            OwedRecord::CleanupUnknown { instance, .. } => Some(instance),
            _ => None,
        }
    }

    /// The session this record holds back, if any.
    pub fn held_session(&self) -> Option<&str> {
        match self {
            OwedRecord::Pause { session, .. } => Some(session),
            _ => None,
        }
    }

    /// A short name for the log line: the request id and a code, never a body.
    pub fn code(&self) -> &'static str {
        match self {
            OwedRecord::Discard { .. } => "assignment_discard",
            OwedRecord::TransmitOutcome { .. } => "transmit_outcome",
            OwedRecord::CleanupUnknown { .. } => "cleanup_unknown",
            OwedRecord::Result { .. } => "result",
            OwedRecord::DeliveryOutcome { .. } => "delivery_outcome",
            OwedRecord::Pause { .. } => "session_pause",
        }
    }

    pub fn request_id(&self) -> &str {
        match self {
            OwedRecord::Discard { request_id }
            | OwedRecord::TransmitOutcome { request_id, .. }
            | OwedRecord::CleanupUnknown { request_id, .. }
            | OwedRecord::Result { request_id, .. }
            | OwedRecord::DeliveryOutcome { request_id, .. }
            | OwedRecord::Pause { request_id, .. } => request_id,
        }
    }
}

/// A refusal that says nothing about the request: the write is still owed.
/// Every other refusal is the ledger's own answer -- the record is there, or
/// can never be -- and settles it.
pub fn refused_for_now(reason: &str) -> bool {
    reason.starts_with("amux_database_")
        || matches!(
            reason,
            "unauthorized"
                | "dm_routing_disabled"
                | "dm_digest_keys_unavailable"
                | "dm_digest_key_unavailable"
                | "settings_unreadable"
                | "state_unreadable"
                // The wire codes of those two (lib/amux/decisionMakerInternalRoute.ts,
                // a 503 that recorded nothing; review r-20261116-195913-289714).
                | "dm_settings_unreadable"
                | "dm_state_unreadable"
                // A returned refusal the results route answers at 503
                // (dmReturnedRefusalStatus; review r-20261116-200908-ddabe2).
                | "digest_key_unavailable"
                | "dm_key_period_changed"
        )
}

/// Whether one answer settles a keyed record.
fn settles(answer: &AppAnswer) -> bool {
    match answer {
        AppAnswer::Done(_) => true,
        AppAnswer::Refused(reason) => !refused_for_now(reason),
        AppAnswer::Unknown => false,
    }
}

async fn app_write<A: DmApp + ?Sized>(app: &A, route: AppRoute, body: Value) -> AppAnswer {
    read_app_answer(&app.post(route, body).await, route.envelope())
}

/// Sends one owed record once. True when it is settled; a record still owed
/// may have changed (a result whose `results/unknown` was answered).
pub async fn settle<A, L>(app: &A, local: &L, record: &mut OwedRecord) -> bool
where
    A: DmApp + ?Sized,
    L: DmLocal + ?Sized,
{
    match record {
        OwedRecord::Discard { request_id } => settles(
            &app_write(
                app,
                AppRoute::AssignmentDiscard,
                json!({"request_id": request_id}),
            )
            .await,
        ),
        OwedRecord::TransmitOutcome {
            request_id,
            instance,
            outcome,
        } => settles(
            &app_write(
                app,
                AppRoute::TransmissionOutcome,
                json!({"request_id": request_id, "instance": instance, "outcome": outcome}),
            )
            .await,
        ),
        OwedRecord::CleanupUnknown {
            request_id,
            instance,
        } => settles(
            &app_write(
                app,
                AppRoute::CleanupUnknown,
                json!({"request_id": request_id, "instance": instance}),
            )
            .await,
        ),
        OwedRecord::DeliveryOutcome {
            request_id,
            outcome,
            reason,
        } => {
            let body = match reason {
                Some(reason) => {
                    json!({"request_id": request_id, "outcome": outcome, "reason": reason})
                }
                None => json!({"request_id": request_id, "outcome": outcome}),
            };
            settles(&app_write(app, AppRoute::DeliveryOutcome, body).await)
        }
        OwedRecord::Pause {
            card_id,
            question_revision,
            request_id,
            session,
        } => {
            let paused = local
                .post(
                    LocalRoute::AnswerUnknown,
                    json!({"card_id": card_id, "question_revision": question_revision,
                        "request_id": request_id, "session": session}),
                )
                .await;
            pause_confirmed(&paused)
        }
        OwedRecord::Result {
            request_id,
            instance,
            submission,
            result_digest,
            unknown_settled,
        } => {
            // The read-back first: the pair may be on the ledger already.
            if let AppAnswer::Done(value) = app_write(
                app,
                AppRoute::ResultLookup,
                json!({"request_id": request_id, "result_digest": result_digest}),
            )
            .await
            {
                if lookup_settled(&value) == Some(true) {
                    return true;
                }
            }
            match app_write(app, AppRoute::Results, submission.clone()).await {
                AppAnswer::Done(value) if submission_settled(&value) => return true,
                AppAnswer::Refused(reason) if !refused_for_now(&reason) => return true,
                _ => {}
            }
            if !*unknown_settled {
                match app_write(
                    app,
                    AppRoute::ResultUnknown,
                    json!({"request_id": request_id, "instance": instance, "result_digest": result_digest}),
                )
                .await
                {
                    AppAnswer::Refused(reason)
                        if reason == "already_accepted" || reason == "already_rejected" =>
                    {
                        return true
                    }
                    answer if settles(&answer) => *unknown_settled = true,
                    _ => {}
                }
            }
            false
        }
    }
}

/// The local AMUX confirmed the session paused.
pub fn pause_confirmed(answer: &HttpAnswer) -> bool {
    matches!(answer, HttpAnswer::Answered { status: 200, body }
        if serde_json::from_slice::<Value>(body).ok().and_then(|value| value.get("paused").and_then(Value::as_bool)) == Some(true))
}

/// The instances held back by the owed records.
pub fn held_instances(owed: &[OwedRecord]) -> BTreeSet<String> {
    owed.iter()
        .filter_map(OwedRecord::held_instance)
        .map(str::to_owned)
        .collect()
}

/// The sessions held back by the owed records.
pub fn held_sessions(owed: &[OwedRecord]) -> BTreeSet<String> {
    owed.iter()
        .filter_map(OwedRecord::held_session)
        .map(str::to_owned)
        .collect()
}

/// How often the owed records are written even when unchanged, and how old the
/// last good write may be before the relay starts nothing new.
const STATE_REWRITE: Duration = Duration::from_secs(60);

#[derive(Debug)]
struct Entry {
    id: u64,
    record: OwedRecord,
}

#[derive(Debug)]
struct BookState {
    entries: Vec<Entry>,
    next_id: u64,
    store: Option<OwedStore>,
    /// Whether `entries` hold what the file held. Until they do the relay does
    /// not know what it owes, so it starts nothing new.
    loaded: bool,
    /// What the file holds now: the records of the last load or save.
    persisted: Vec<OwedRecord>,
    /// The last save failed: the file is behind `entries`.
    save_failed: bool,
    /// When the file was last written successfully.
    last_written: Option<Instant>,
}

impl BookState {
    fn records(&self) -> Vec<OwedRecord> {
        self.entries
            .iter()
            .map(|entry| entry.record.clone())
            .collect()
    }

    /// Writes the records when they differ from the file or the file is old.
    /// A write that fails is tried again at every call, and nothing new starts
    /// while it does: a record the file does not hold would be forgotten by a
    /// restart.
    fn save(&mut self) {
        let Some(store) = &self.store else {
            return;
        };
        if !self.loaded {
            return;
        }
        let records = self.records();
        let fresh = self
            .last_written
            .is_some_and(|at| at.elapsed() < STATE_REWRITE);
        if records == self.persisted && !self.save_failed && fresh {
            return;
        }
        match store.save(&records) {
            Ok(()) => {
                self.persisted = records;
                self.save_failed = false;
                self.last_written = Some(Instant::now());
            }
            Err(reason) => {
                self.save_failed = true;
                println!(
                    "amux dm relay: the owed records cannot be written to {} ({reason}); \
                     nothing new is sent or delivered until they can, and the write is tried again every tick",
                    store.path().display()
                );
            }
        }
    }
}

/// Every record the relay owes, in memory and in the file, in one place that
/// the question and delivery flows write to the moment an obligation exists
/// (review r-20261116-191958-8b665b): a record is kept -- and the file
/// replaced -- before the first network call that could be lost, so a restart
/// during that call still finds it. A run is never handed its records to keep
/// at its end.
///
/// A save that fails does not stop the calls a run has begun: they are keyed
/// writes the app answers from its ledger and a record that shrinks what is
/// owed, stopping them would only leave the obligation open longer, and the
/// record stays in memory and is sent again every tick. What a failed save
/// stops is anything new -- the next question, delivery or v22 sync starts
/// nothing while `may_start_new` is false -- and no flow starts a new external
/// action after it kept a record (a record is made after the broker's answer,
/// the local send, or a failed step that ends the run).
///
/// Interior mutability: the flows hold `&OwedBook` beside `&app` and `&local`,
/// and the guard is never held across an await.
#[derive(Debug)]
pub struct OwedBook {
    state: Mutex<BookState>,
}

impl Default for OwedBook {
    fn default() -> Self {
        Self::new()
    }
}

impl OwedBook {
    /// Records kept in memory only.
    pub fn new() -> Self {
        Self {
            state: Mutex::new(BookState {
                entries: Vec::new(),
                next_id: 0,
                store: None,
                loaded: true,
                persisted: Vec::new(),
                save_failed: false,
                last_written: None,
            }),
        }
    }

    /// Records kept in `store`, read back by the first `load`.
    pub fn with_store(store: OwedStore) -> Self {
        let book = Self::new();
        {
            let mut state = book.lock();
            state.store = Some(store);
            state.loaded = false;
        }
        book
    }

    fn lock(&self) -> MutexGuard<'_, BookState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Reads the file the first time (and again every call until it could be
    /// read). A file the relay cannot read or trust is never taken for an
    /// empty one: what it owes, and the instances and sessions that holds
    /// back, are not known, so nothing new is started until it reads (a
    /// person fixes or removes the file). Only the code and the reason are
    /// logged, never a record.
    pub fn load(&self) -> bool {
        let mut state = self.lock();
        if state.loaded {
            return true;
        }
        let Some(store) = state.store.clone() else {
            state.loaded = true;
            return true;
        };
        match store.load() {
            Ok(loaded) => {
                if !loaded.is_empty() {
                    println!(
                        "amux dm relay: {} owed record(s) restored from {}",
                        loaded.len(),
                        store.path().display()
                    );
                }
                state.persisted = loaded.clone();
                let mut entries: Vec<Entry> = loaded
                    .into_iter()
                    .enumerate()
                    .map(|(id, record)| Entry {
                        id: id as u64,
                        record,
                    })
                    .collect();
                let base = entries.len() as u64;
                // What was kept before the file was read follows what it held.
                for (offset, entry) in state.entries.drain(..).enumerate() {
                    entries.push(Entry {
                        id: base + offset as u64,
                        record: entry.record,
                    });
                }
                state.next_id = entries.len() as u64;
                state.entries = entries;
                state.loaded = true;
                true
            }
            Err(reason) => {
                println!(
                    "amux dm relay: the owed records in {} cannot be read ({reason}); \
                     nothing new is sent or delivered until they can, and the read is tried again every tick",
                    store.path().display()
                );
                false
            }
        }
    }

    pub fn save(&self) {
        self.lock().save();
    }

    /// Whether the relay may start something new: it knows what it owes, the
    /// file holds it, and the file was written lately.
    pub fn may_start_new(&self) -> bool {
        let state = self.lock();
        state.loaded
            && !state.save_failed
            && (state.store.is_none()
                || state
                    .last_written
                    .is_some_and(|at| at.elapsed() < STATE_REWRITE))
    }

    /// Whether the records were read (always, with no file).
    pub fn is_loaded(&self) -> bool {
        self.lock().loaded
    }

    /// Keeps `record` and writes the file now, before anything is sent for it.
    /// A write that fails leaves the record in memory (`may_start_new` says
    /// so). Returns the record's handle for `settle_new`, `settle_one` and
    /// `update`.
    pub fn keep(&self, record: OwedRecord) -> u64 {
        let mut state = self.lock();
        let id = state.next_id;
        state.next_id += 1;
        state.entries.push(Entry { id, record });
        state.save();
        id
    }

    /// Replaces a kept record, or removes it (`None`: the app has it), and
    /// writes the file.
    pub fn update(&self, id: u64, record: Option<OwedRecord>) {
        let mut state = self.lock();
        match record {
            Some(record) => {
                if let Some(entry) = state.entries.iter_mut().find(|entry| entry.id == id) {
                    entry.record = record;
                }
            }
            None => state.entries.retain(|entry| entry.id != id),
        }
        state.save();
    }

    /// A kept result whose `results/unknown` has its answer (or has nothing to
    /// record); written when it changes.
    pub fn set_unknown_settled(&self, id: u64, settled: bool) {
        let mut state = self.lock();
        let mut changed = false;
        if let Some(Entry {
            record: OwedRecord::Result {
                unknown_settled, ..
            },
            ..
        }) = state.entries.iter_mut().find(|entry| entry.id == id)
        {
            changed = *unknown_settled != settled;
            *unknown_settled = settled;
        }
        if changed {
            state.save();
        }
    }

    pub fn get(&self, id: u64) -> Option<OwedRecord> {
        self.lock()
            .entries
            .iter()
            .find(|entry| entry.id == id)
            .map(|entry| entry.record.clone())
    }

    /// A point to ask `since` from: the records kept after it were kept by the
    /// run that took it.
    pub fn mark(&self) -> u64 {
        self.lock().next_id
    }

    /// The records kept since `mark` that are still owed.
    pub fn since(&self, mark: u64) -> Vec<OwedRecord> {
        self.lock()
            .entries
            .iter()
            .filter(|entry| entry.id >= mark)
            .map(|entry| entry.record.clone())
            .collect()
    }

    pub fn records(&self) -> Vec<OwedRecord> {
        self.lock().records()
    }

    /// The instances held back by the owed records.
    pub fn held_instances(&self) -> BTreeSet<String> {
        held_instances(&self.records())
    }

    /// The sessions held back by the owed records.
    pub fn held_sessions(&self) -> BTreeSet<String> {
        held_sessions(&self.records())
    }

    /// Sends a kept record once. True when it is settled and gone; a record
    /// still owed may have changed (a result whose `results/unknown` was
    /// answered), and the change is written.
    pub async fn settle_one<A, L>(&self, app: &A, local: &L, id: u64) -> bool
    where
        A: DmApp + ?Sized,
        L: DmLocal + ?Sized,
    {
        let Some(mut record) = self.get(id) else {
            return true;
        };
        let settled = settle(app, local, &mut record).await;
        self.update(id, if settled { None } else { Some(record) });
        settled
    }

    /// `settle_one` for a record just kept: one still owed is logged as such.
    pub async fn settle_new<A, L>(&self, app: &A, local: &L, id: u64) -> bool
    where
        A: DmApp + ?Sized,
        L: DmLocal + ?Sized,
    {
        let settled = self.settle_one(app, local, id).await;
        if !settled {
            if let Some(record) = self.get(id) {
                println!(
                    "amux dm relay: {} for request {} is owed; it is sent again every tick",
                    record.code(),
                    record.request_id()
                );
            }
        }
        settled
    }

    /// Keeps `record`, then sends it once: persisted before the send.
    pub async fn send<A, L>(&self, app: &A, local: &L, record: OwedRecord) -> bool
    where
        A: DmApp + ?Sized,
        L: DmLocal + ?Sized,
    {
        let id = self.keep(record);
        self.settle_new(app, local, id).await
    }

    /// Sends every kept record once, in order, and keeps the ones still owed.
    /// Returns how many were settled.
    pub async fn settle_all<A, L>(&self, app: &A, local: &L) -> usize
    where
        A: DmApp + ?Sized,
        L: DmLocal + ?Sized,
    {
        let ids: Vec<u64> = self.lock().entries.iter().map(|entry| entry.id).collect();
        let mut settled = 0;
        for id in ids {
            let Some(record) = self.get(id) else {
                continue;
            };
            let (code, request_id) = (record.code(), record.request_id().to_owned());
            if self.settle_one(app, local, id).await {
                settled += 1;
                println!("amux dm relay: owed {code} for request {request_id} recorded");
            }
        }
        settled
    }
}

// ---------------------------------------------------------------------------
// The records on disk
// ---------------------------------------------------------------------------

/// A path for the state directory, for a run by hand; under systemd the unit's
/// `StateDirectory=` sets `STATE_DIRECTORY` and this is not needed.
pub const OWED_STATE_DIR_ENV: &str = "TOMVERSE_AMUX_DM_RELAY_STATE_DIR";
const SYSTEMD_STATE_DIR_ENV: &str = "STATE_DIRECTORY";
/// The one file in the state directory.
pub const OWED_STATE_FILE: &str = "owed-records.json";
const OWED_STATE_TMP: &str = ".owed-records.json.tmp";
/// The file's format. Another number is a file this binary cannot read.
const OWED_STATE_VERSION: u64 = 1;

#[derive(Serialize)]
struct StateOut<'a> {
    version: u64,
    records: &'a [OwedRecord],
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StateIn {
    #[allow(dead_code)]
    version: u64,
    records: Vec<OwedRecord>,
}

/// The owed records in one local file, replaced whole on every change.
///
/// The file holds what the relay would otherwise send again from memory: the
/// request keys and digests and a result's submission, the text the app's
/// ledger holds as well. It holds no token, secret or request key (no record
/// has such a field); it is still private to the relay's account: the
/// directory `0700`, the file `0600`, neither a symlink nor owned by another
/// account. There is no size limit: one result can hold a DM's whole output.
#[derive(Debug, Clone)]
pub struct OwedStore {
    dir: PathBuf,
}

/// A step of a replacement, for a test that fails one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SaveStep {
    BeforeRename,
}

impl OwedStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// The directory the environment names: this relay's own variable, else
    /// the first one systemd's `StateDirectory=` set. None when neither is.
    pub fn from_env() -> Option<Self> {
        let named = std::env::var(OWED_STATE_DIR_ENV)
            .ok()
            .filter(|dir| !dir.is_empty())
            .or_else(|| {
                std::env::var(SYSTEMD_STATE_DIR_ENV)
                    .ok()
                    .and_then(|dirs| dirs.split(':').next().map(str::to_owned))
                    .filter(|dir| !dir.is_empty())
            })?;
        Some(Self::new(named))
    }

    pub fn path(&self) -> PathBuf {
        self.dir.join(OWED_STATE_FILE)
    }

    /// The records the last save left. No file is no records. A file the relay
    /// cannot trust or read -- a symlink, another owner, readable by others,
    /// not JSON, another version, a record it does not know -- is an error:
    /// the caller must not go on as if nothing were owed.
    pub fn load(&self) -> Result<Vec<OwedRecord>, String> {
        match fs::symlink_metadata(&self.dir) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(format!("state directory is not readable: {error}")),
            Ok(meta) => check_private(&meta, "state directory", true)?,
        }
        let path = self.path();
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(format!("state file is not readable: {error}")),
            Ok(meta) => check_private(&meta, "state file", false)?,
        }
        let bytes =
            fs::read(&path).map_err(|error| format!("state file is not readable: {error}"))?;
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|error| format!("state file is not valid JSON: {error}"))?;
        match value.get("version").and_then(Value::as_u64) {
            Some(OWED_STATE_VERSION) => {}
            other => return Err(format!("state file has an unsupported version ({other:?})")),
        }
        serde_json::from_value::<StateIn>(value)
            .map(|state| state.records)
            .map_err(|error| format!("state file has an unreadable record: {error}"))
    }

    /// Replaces the file with `records`: the same directory's temporary file,
    /// written and synced, renamed over the file, and the directory synced. A
    /// failure at any step leaves the previous file as it was.
    pub fn save(&self, records: &[OwedRecord]) -> Result<(), String> {
        self.save_with(records, &|_| Ok(()))
    }

    fn save_with(
        &self,
        records: &[OwedRecord],
        hook: &dyn Fn(SaveStep) -> io::Result<()>,
    ) -> Result<(), String> {
        let bytes = serde_json::to_vec(&StateOut {
            version: OWED_STATE_VERSION,
            records,
        })
        .map_err(|error| format!("records cannot be written: {error}"))?;
        self.ensure_dir()?;
        let tmp = self.dir.join(OWED_STATE_TMP);
        let written = self.write_tmp(&tmp, &bytes).and_then(|()| {
            hook(SaveStep::BeforeRename).map_err(|error| format!("before rename: {error}"))?;
            fs::rename(&tmp, self.path()).map_err(|error| format!("rename: {error}"))
        });
        if let Err(reason) = written {
            let _ = fs::remove_file(&tmp);
            return Err(format!("state file was not replaced ({reason})"));
        }
        sync_dir(&self.dir).map_err(|error| format!("state directory was not synced: {error}"))
    }

    fn write_tmp(&self, tmp: &Path, bytes: &[u8]) -> Result<(), String> {
        // A leftover of a process that died mid-write; never followed.
        match fs::remove_file(tmp) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("leftover temporary file: {error}")),
        }
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(tmp)
            .map_err(|error| format!("create: {error}"))?;
        file.write_all(bytes)
            .map_err(|error| format!("write: {error}"))?;
        file.sync_all().map_err(|error| format!("sync: {error}"))
    }

    /// The directory exists, private to this account and no symlink; made
    /// `0700` when missing.
    fn ensure_dir(&self) -> Result<(), String> {
        if fs::symlink_metadata(&self.dir).is_err() {
            let mut builder = fs::DirBuilder::new();
            builder.recursive(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder
                .create(&self.dir)
                .map_err(|error| format!("state directory cannot be created: {error}"))?;
        }
        let meta = fs::symlink_metadata(&self.dir)
            .map_err(|error| format!("state directory is not readable: {error}"))?;
        check_private(&meta, "state directory", true)
    }
}

/// Not a symlink, the right kind, owned by this account, closed to group and
/// others. (Other platforms have no such modes; the relay runs on Ubuntu.)
fn check_private(meta: &fs::Metadata, what: &str, directory: bool) -> Result<(), String> {
    if meta.file_type().is_symlink() {
        return Err(format!("{what} is a symlink"));
    }
    if directory && !meta.is_dir() || !directory && !meta.is_file() {
        return Err(format!(
            "{what} is not a {}",
            if directory {
                "directory"
            } else {
                "regular file"
            }
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let Some(uid) = effective_uid() {
            if meta.uid() != uid {
                return Err(format!(
                    "{what} is owned by uid {}, not this account's {uid}",
                    meta.uid()
                ));
            }
        }
        if meta.mode() & 0o077 != 0 {
            return Err(format!(
                "{what} is open to group or others (mode {:o})",
                meta.mode() & 0o7777
            ));
        }
    }
    Ok(())
}

/// This process's effective uid from `/proc/self/status` (`Uid:` real,
/// effective, saved, filesystem); None where there is no such file.
#[cfg(unix)]
fn effective_uid() -> Option<u32> {
    let status = fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|line| line.starts_with("Uid:"))?;
    line.split_whitespace().nth(2)?.parse().ok()
}

#[cfg(unix)]
fn sync_dir(dir: &Path) -> io::Result<()> {
    fs::File::open(dir)?.sync_all()
}

/// Windows cannot open a directory to sync it; nothing runs the relay there.
#[cfg(not(unix))]
fn sync_dir(_dir: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dm_relay::flow::tests::{
        answered, recorded, refused, FakeApp, FakeLocal, REQUEST_ID,
    };

    #[test]
    fn only_a_refusal_about_nothing_in_the_request_keeps_a_record_owed() {
        for reason in [
            "amux_database_busy",
            "amux_database_deadline_exceeded",
            "unauthorized",
            "dm_routing_disabled",
            "settings_unreadable",
            "dm_settings_unreadable",
            "dm_state_unreadable",
            "dm_digest_key_unavailable",
            "dm_digest_keys_unavailable",
            "digest_key_unavailable",
        ] {
            assert!(refused_for_now(reason), "{reason}");
        }
        for reason in [
            "closed",
            "transmit_outcome_recorded",
            "outcome_recorded",
            "not_assigned",
            "invalid_input",
        ] {
            assert!(!refused_for_now(reason), "{reason}");
        }
    }

    #[tokio::test]
    async fn a_keyed_record_is_sent_again_until_the_ledger_answers_for_it() {
        let local = FakeLocal::default();
        for (answer, settled) in [
            (HttpAnswer::Lost, false),
            (refused(503, "recorded", "amux_database_busy"), false),
            (refused(409, "recorded", "dm_routing_disabled"), false),
            (refused(409, "recorded", "closed"), true),
            (recorded(), true),
        ] {
            let app = FakeApp::with(vec![(AppRoute::AssignmentDiscard, answer.clone())]);
            let mut record = OwedRecord::Discard {
                request_id: REQUEST_ID.into(),
            };
            assert_eq!(
                settle(&app, &local, &mut record).await,
                settled,
                "{answer:?}"
            );
        }
    }

    #[tokio::test]
    async fn an_owed_result_is_read_back_before_it_is_submitted_again() {
        let local = FakeLocal::default();
        let record = || OwedRecord::Result {
            request_id: REQUEST_ID.into(),
            instance: "decision-maker-openai".into(),
            submission: json!({"request_id": REQUEST_ID}),
            result_digest: "d".repeat(64),
            unknown_settled: true,
        };
        // Found by its pair: never submitted again.
        let app = FakeApp::with(vec![(
            AppRoute::ResultLookup,
            answered(200, json!({"found": true, "status": "accepted"})),
        )]);
        assert!(settle(&app, &local, &mut record()).await);
        assert_eq!(app.routes(), vec![AppRoute::ResultLookup]);
        // Not found: submitted again, and the ledger's answer settles it.
        let app = FakeApp::with(vec![
            (
                AppRoute::ResultLookup,
                answered(200, json!({"found": true, "status": "not_recorded"})),
            ),
            (
                AppRoute::Results,
                answered(200, json!({"submitted": true, "status": "accepted"})),
            ),
        ]);
        assert!(settle(&app, &local, &mut record()).await);
        assert_eq!(
            app.routes(),
            vec![AppRoute::ResultLookup, AppRoute::Results]
        );
        // Nothing answers: still owed.
        let app = FakeApp::default();
        assert!(!settle(&app, &local, &mut record()).await);
        // A result whose unknown is not recorded yet records it, and stays owed.
        let app = FakeApp::with(vec![(AppRoute::ResultUnknown, recorded())]);
        let mut owed = OwedRecord::Result {
            request_id: REQUEST_ID.into(),
            instance: "decision-maker-openai".into(),
            submission: json!({}),
            result_digest: "d".repeat(64),
            unknown_settled: false,
        };
        assert!(!settle(&app, &local, &mut owed).await);
        assert!(matches!(
            owed,
            OwedRecord::Result {
                unknown_settled: true,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn an_owed_pause_holds_its_session_until_the_local_amux_confirms_it() {
        let local = FakeLocal::default();
        let book = OwedBook::new();
        book.keep(OwedRecord::Pause {
            card_id: "AMUX-1".into(),
            question_revision: 1,
            request_id: REQUEST_ID.into(),
            session: "claude-impl".into(),
        });
        let app = FakeApp::default();
        assert_eq!(book.settle_all(&app, &local).await, 0);
        assert_eq!(
            book.held_sessions().into_iter().collect::<Vec<_>>(),
            vec!["claude-impl"]
        );
        local
            .answers
            .lock()
            .unwrap()
            .entry(LocalRoute::AnswerUnknown.path())
            .or_default()
            .push_back(answered(200, json!({"paused": true})));
        assert_eq!(book.settle_all(&app, &local).await, 1);
        assert!(book.records().is_empty());
    }

    /// One record of every kind, the result as large as a DM's whole output.
    fn every_kind() -> Vec<OwedRecord> {
        vec![
            OwedRecord::Discard {
                request_id: REQUEST_ID.into(),
            },
            OwedRecord::TransmitOutcome {
                request_id: REQUEST_ID.into(),
                instance: "decision-maker-openai".into(),
                outcome: "unknown".into(),
            },
            OwedRecord::CleanupUnknown {
                request_id: REQUEST_ID.into(),
                instance: "decision-maker-openai".into(),
            },
            OwedRecord::Result {
                request_id: REQUEST_ID.into(),
                instance: "decision-maker-openai".into(),
                submission: json!({"request_id": REQUEST_ID, "output": {"raw": "x".repeat(300 * 1024)}}),
                result_digest: "d".repeat(64),
                unknown_settled: false,
            },
            OwedRecord::DeliveryOutcome {
                request_id: REQUEST_ID.into(),
                outcome: "not_sent".into(),
                reason: Some("send_refused".into()),
            },
            OwedRecord::DeliveryOutcome {
                request_id: REQUEST_ID.into(),
                outcome: "receipt".into(),
                reason: None,
            },
            OwedRecord::Pause {
                card_id: "AMUX-1".into(),
                question_revision: 1,
                request_id: REQUEST_ID.into(),
                session: "claude-impl".into(),
            },
        ]
    }

    #[test]
    fn every_kind_of_record_is_read_back_as_it_was_saved_whatever_its_size() {
        let dir = tempfile::tempdir().unwrap();
        let store = OwedStore::new(dir.path().join("state"));
        assert_eq!(store.load(), Ok(Vec::new()), "no directory, no records");
        let records = every_kind();
        store.save(&records).unwrap();
        assert_eq!(store.load().unwrap(), records);
        // Replaced whole by the next save, however few records are left.
        store.save(&records[..1]).unwrap();
        assert_eq!(store.load().unwrap(), records[..1]);
        store.save(&[]).unwrap();
        assert_eq!(store.load(), Ok(Vec::new()));
        let leftovers: Vec<_> = fs::read_dir(dir.path().join("state"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(
            leftovers,
            vec![OWED_STATE_FILE],
            "no temporary file is left"
        );
    }

    #[test]
    fn a_record_serialises_its_own_fields_and_no_token_or_key() {
        // The fields of every kind, so a field added later is seen here before
        // it reaches a file: the request keys and the relay's tokens are not
        // part of any record.
        let mut seen = std::collections::BTreeMap::new();
        for record in every_kind() {
            let value = serde_json::to_value(&record).unwrap();
            let kind = value["kind"].as_str().unwrap().to_owned();
            let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
            keys.sort();
            seen.insert(kind, keys);
        }
        let expect = |kind: &str, keys: &[&str]| {
            assert_eq!(seen[kind], keys.to_vec(), "{kind}");
        };
        expect("discard", &["kind", "request_id"]);
        expect(
            "transmit_outcome",
            &["instance", "kind", "outcome", "request_id"],
        );
        expect("cleanup_unknown", &["instance", "kind", "request_id"]);
        expect(
            "result",
            &[
                "instance",
                "kind",
                "request_id",
                "result_digest",
                "submission",
                "unknown_settled",
            ],
        );
        expect(
            "delivery_outcome",
            &["kind", "outcome", "reason", "request_id"],
        );
        expect(
            "pause",
            &[
                "card_id",
                "kind",
                "question_revision",
                "request_id",
                "session",
            ],
        );
    }

    #[test]
    fn a_failure_while_replacing_the_file_leaves_the_previous_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = OwedStore::new(dir.path().join("state"));
        let before = every_kind();
        store.save(&before).unwrap();
        let bytes = fs::read(store.path()).unwrap();
        let error = store
            .save_with(&before[..2], &|step| {
                assert_eq!(step, SaveStep::BeforeRename);
                Err(io::Error::other("disk full"))
            })
            .unwrap_err();
        assert!(error.contains("disk full"), "{error}");
        assert_eq!(fs::read(store.path()).unwrap(), bytes);
        assert_eq!(store.load().unwrap(), before);
        assert!(!dir.path().join("state").join(OWED_STATE_TMP).exists());
        // A rename that cannot happen (a directory is in the way) fails the
        // same way, and the temporary file does not stay.
        let blocked = tempfile::tempdir().unwrap();
        let store = OwedStore::new(blocked.path().join("state"));
        fs::create_dir_all(store.path()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                blocked.path().join("state"),
                fs::Permissions::from_mode(0o700),
            )
            .unwrap();
        }
        assert!(store.save(&before).is_err());
        assert!(!blocked.path().join("state").join(OWED_STATE_TMP).exists());
    }

    /// A file the relay cannot read is an error, never "nothing owed".
    #[test]
    fn a_file_that_cannot_be_read_is_an_error_not_an_empty_list() {
        let dir = tempfile::tempdir().unwrap();
        let store = OwedStore::new(dir.path().join("state"));
        store.save(&every_kind()).unwrap();
        let good = fs::read_to_string(store.path()).unwrap();
        for (label, text) in [
            ("not JSON", "{".to_owned()),
            ("empty", String::new()),
            ("no version", r#"{"records": []}"#.to_owned()),
            (
                "another version",
                r#"{"version": 2, "records": []}"#.to_owned(),
            ),
            (
                "unknown record",
                r#"{"version": 1, "records": [{"kind": "mystery"}]}"#.to_owned(),
            ),
            (
                "a record missing a field",
                r#"{"version": 1, "records": [{"kind": "discard"}]}"#.to_owned(),
            ),
            (
                "an extra field",
                r#"{"version": 1, "records": [], "note": 1}"#.to_owned(),
            ),
            ("cut short", good[..good.len() / 2].to_owned()),
        ] {
            fs::write(store.path(), text).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(store.path(), fs::Permissions::from_mode(0o600)).unwrap();
            }
            assert!(store.load().is_err(), "{label}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_state_is_private_and_a_symlink_or_open_file_is_refused() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("state");
        let store = OwedStore::new(&state);
        store.save(&every_kind()).unwrap();
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&state), 0o700, "created private");
        assert_eq!(mode(&store.path()), 0o600);
        // Open to others: refused until a person closes it.
        fs::set_permissions(store.path(), fs::Permissions::from_mode(0o644)).unwrap();
        assert!(store
            .load()
            .unwrap_err()
            .contains("open to group or others"));
        fs::set_permissions(store.path(), fs::Permissions::from_mode(0o600)).unwrap();
        assert!(store.load().is_ok());
        fs::set_permissions(&state, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(store
            .load()
            .unwrap_err()
            .contains("open to group or others"));
        assert!(store.save(&[]).is_err());
        fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
        // The file a symlink to a good file.
        let real = dir.path().join("real.json");
        fs::copy(store.path(), &real).unwrap();
        fs::set_permissions(&real, fs::Permissions::from_mode(0o600)).unwrap();
        fs::remove_file(store.path()).unwrap();
        symlink(&real, store.path()).unwrap();
        assert!(store.load().unwrap_err().contains("symlink"));
        // The directory a symlink to a good directory.
        let link = dir.path().join("link");
        symlink(&state, &link).unwrap();
        let through = OwedStore::new(&link);
        assert!(through.load().unwrap_err().contains("symlink"));
        assert!(through.save(&[]).unwrap_err().contains("symlink"));
    }

    #[test]
    fn the_directory_comes_from_this_relays_variable_or_systemds() {
        // One test: the process environment is shared.
        let keep: Vec<_> = [OWED_STATE_DIR_ENV, SYSTEMD_STATE_DIR_ENV]
            .iter()
            .map(|name| (*name, std::env::var(name).ok()))
            .collect();
        std::env::remove_var(OWED_STATE_DIR_ENV);
        std::env::remove_var(SYSTEMD_STATE_DIR_ENV);
        assert!(OwedStore::from_env().is_none());
        std::env::set_var(SYSTEMD_STATE_DIR_ENV, "/var/lib/a:/var/lib/b");
        assert_eq!(
            OwedStore::from_env().unwrap().path(),
            Path::new("/var/lib/a").join(OWED_STATE_FILE)
        );
        std::env::set_var(OWED_STATE_DIR_ENV, "/srv/own");
        assert_eq!(
            OwedStore::from_env().unwrap().path(),
            Path::new("/srv/own").join(OWED_STATE_FILE)
        );
        for (name, value) in keep {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }
}
