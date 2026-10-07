use std::convert::Infallible;
use std::time::Duration;

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::time::Instant;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::orchestrator_halt::{
    classify_ack, classify_claim, classify_record, classify_recover, classify_state,
    classify_tick, gate, AckAnswer, AckKind, CallKind, ErrorLogClock, Gate, HaltBook, HaltReason,
    HaltRecordRequest, HaltState, RecordAnswer, StateAnswer, WaitState, WriteAnswer,
    AWAITING_DEADLINE_CEILING, AWAITING_DEADLINE_FLOOR,
};
use crate::tomverse_api::{
    ClaimResponse, NothingCommittedAnswer, QueueTask, RawAnswer, SelectionRead,
    SelectionReadTransientStatus, TomverseApi, UnacceptedStatus, WriteIds,
    BOARD_CAPACITY_EXCEEDED, DATABASE_BUSY,
};

const SCORING_VERSION: &str = "amux-global-priority-v2";
const RECOVERY_INTERVAL: Duration = Duration::from_secs(30);
/// Policy version 15: the system consumer of pre-approved promotion grants.
const AUTO_PROMOTION_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// How long `run()` sleeps between ticks when neither recovery nor
/// auto-promotion preempt it. Each tick calls at most one `queue` read and,
/// inside its loop, one `routing_snapshot` read per candidate it inspects --
/// but the first selection-read failure or skip ends the tick immediately,
/// so at most one *new* selection-read outcome per tick reaches
/// `handle_selection_read`'s counter.
const TICK_INTERVAL: Duration = Duration::from_secs(5);

/// Consecutive selection-read failures (`queue`, `routing_snapshot`) that are
/// skipped -- WARN and end the tick -- before the next one halts the
/// scheduler instead (orchestration policy version 20, section 1: "60번째
/// 연속 실패까지 tick만 건너뛰고 61번째에 ... 정지한다"). Five minutes of coverage
/// at one selection-read outcome per tick, `TICK_INTERVAL` apart, is
/// `(5 * 60) / TICK_INTERVAL.as_secs() = 60`. The board-capacity answer and the
/// three "nothing committed" 503 reasons are not counted.
const MAX_CONSECUTIVE_SELECTION_READ_SKIPS: u32 = (5 * 60) / TICK_INTERVAL.as_secs() as u32;

/// Policy version 20, sections 2 and 5: the halt state read, the halt record
/// retry and the acknowledgement retry, each every 30 seconds while halted or
/// waiting; one ERROR line every five minutes.
const HALT_POLL_INTERVAL: Duration = Duration::from_secs(30);
const HALT_ERROR_LOG_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// The scheduler's clocks. Production runs `Timing::PRODUCTION`; tests run
/// the same code with short intervals.
#[derive(Debug, Clone, Copy)]
pub struct Timing {
    pub tick: Duration,
    pub recovery: Duration,
    pub auto_promotion: Duration,
    /// The halt state read, the halt record retry and the ack retry.
    pub halt_poll: Duration,
    pub error_log: Duration,
    /// The bounds on the wait for undecided admissions (`awaiting_deadline`).
    pub deadline_floor: Duration,
    pub deadline_ceiling: Duration,
}

impl Timing {
    pub const PRODUCTION: Self = Self {
        tick: TICK_INTERVAL,
        recovery: RECOVERY_INTERVAL,
        auto_promotion: AUTO_PROMOTION_INTERVAL,
        halt_poll: HALT_POLL_INTERVAL,
        error_log: HALT_ERROR_LOG_INTERVAL,
        deadline_floor: AWAITING_DEADLINE_FLOOR,
        deadline_ceiling: AWAITING_DEADLINE_CEILING,
    };
}

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
/// unknown outcome and halts the scheduler instead (`claim_outcome_unknown`,
/// policy version 20).
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

/// Whether a stretch of scheduling goes on or has stopped on a halt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Flow {
    Continue,
    Halted,
}

/// A write call's answer once it has been acknowledged, or the halt it
/// became (policy version 20, sections 1, 2 and 4).
#[derive(Debug)]
enum Settled<T> {
    Definite(T),
    NothingCommitted(&'static str),
    Halted,
}

/// What the tick does after one selection read.
#[derive(Debug)]
enum SelectionStep<T> {
    Ready(T),
    EndTick,
    Halted,
}

/// What a selection read's answer means (policy version 20, section 1).
#[derive(Debug)]
enum SelectionClass<T> {
    Ready(T),
    /// The board-capacity refusal and the three "nothing committed" 503
    /// reasons: the tick ends without a claim, and nothing is counted.
    Uncounted(&'static str),
    /// A transport failure, a 404, a 5xx other than the three, a 429: counted.
    Counted(&'static str),
    /// Anything else: a `contract_violation` halt.
    Contract(&'static str),
}

fn classify_selection<T>(result: Result<SelectionRead<T>>) -> SelectionClass<T> {
    match result {
        Ok(SelectionRead::Ready(value)) => SelectionClass::Ready(value),
        Ok(SelectionRead::BoardCapacityExceeded) => {
            SelectionClass::Uncounted(BOARD_CAPACITY_EXCEEDED)
        }
        Ok(SelectionRead::DatabaseBusy) => SelectionClass::Uncounted(DATABASE_BUSY),
        Err(error) => {
            if let Some(answer) = error
                .chain()
                .find_map(|cause| cause.downcast_ref::<NothingCommittedAnswer>())
            {
                return SelectionClass::Uncounted(answer.reason);
            }
            if error
                .chain()
                .any(|cause| cause.downcast_ref::<reqwest::Error>().is_some())
            {
                return SelectionClass::Counted("transport");
            }
            if let Some(marker) = error
                .chain()
                .find_map(|cause| cause.downcast_ref::<SelectionReadTransientStatus>())
            {
                return SelectionClass::Counted(marker.error_class());
            }
            if error.chain().any(|cause| {
                cause
                    .downcast_ref::<UnacceptedStatus>()
                    .is_some_and(|marker| marker.status == reqwest::StatusCode::NOT_FOUND)
            }) {
                return SelectionClass::Counted("http_404");
            }
            SelectionClass::Contract("selection_contract")
        }
    }
}

/// A write call's raw answer as one of the known answers of section 1, or as
/// unknown. No answer at all (a transport failure, a timeout, a body the
/// client refused) is unknown.
fn write_answer<T>(
    raw: Result<RawAnswer>,
    classify: fn(&RawAnswer) -> WriteAnswer<T>,
) -> WriteAnswer<T> {
    match raw {
        Ok(answer) => classify(&answer),
        Err(_) => WriteAnswer::Unknown("no_response"),
    }
}

/// Startup's outcome: resumed, or refused by the one exit this loop keeps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Resume {
    Resumed,
    /// A 401 or 403 on the halt state read before the schedule ever started
    /// (policy version 20, section 3).
    RefusedAtStartup,
}

pub struct Scheduler {
    api: TomverseApi,
    /// Policy version 20, section 4: a new instance id for every process.
    instance_id: Uuid,
    timing: Timing,
    scan_offset: usize,
    execution_enabled: bool,
    /// Consecutive selection-read failures skipped in a row (see
    /// `MAX_CONSECUTIVE_SELECTION_READ_SKIPS`). Reset to zero only after a
    /// whole tick whose selection reads were all ready (see `tick`), and on
    /// every resume, never on one successful read: a tick whose queue
    /// succeeds and whose routing snapshot fails must still count.
    consecutive_selection_skips: u32,
    /// What this tick's selection reads did so far. Set by
    /// `handle_selection_read`, read once by `tick` when the tick ends.
    tick_selection: TickSelection,
    /// The halts this process holds until a person clears them.
    halts: HaltBook,
    error_log: ErrorLogClock,
}

/// The selection-read outcome of one tick. A counted failure or an uncounted
/// skip (the three 503 reasons, board capacity) overrides a ready read; only
/// a tick that stays `Ready` resets the consecutive-failure counter.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TickSelection {
    Untouched,
    Ready,
    UncountedSkip,
    CountedFailure,
}

impl Scheduler {
    pub fn new(api: TomverseApi) -> Self {
        Self::with_timing(api, Timing::PRODUCTION)
    }

    pub fn with_timing(api: TomverseApi, timing: Timing) -> Self {
        Self {
            api,
            instance_id: Uuid::new_v4(),
            timing,
            scan_offset: 0,
            execution_enabled: execution_enabled(),
            consecutive_selection_skips: 0,
            tick_selection: TickSelection::Untouched,
            halts: HaltBook::default(),
            error_log: ErrorLogClock::default(),
        }
    }

    pub fn instance_id(&self) -> Uuid {
        self.instance_id
    }

    /// The scheduler's whole life (policy version 20, section 6).
    ///
    /// Its first call is the halt state read, before any write or selection
    /// read. It then schedules only while the resume sentence holds, and every
    /// answer that is not a known one is a halt: it waits, reads the halt
    /// state every 30 seconds, and resumes only when a person has cleared
    /// every halt. It never returns except with the one exit section 3 keeps
    /// here -- a 401 or 403 on the halt state read before the schedule has
    /// ever started, which is a configuration error.
    pub async fn run(mut self) -> Result<Infallible> {
        self.run_loop().await
    }

    async fn run_loop(&mut self) -> Result<Infallible> {
        if self.await_resume(true).await == Resume::RefusedAtStartup {
            anyhow::bail!("AMUX_HALT_STATE_UNAUTHORIZED");
        }
        loop {
            // Section 1: the selection-read count starts again on resume.
            self.consecutive_selection_skips = 0;
            self.schedule_until_halt().await;
            // After startup a 401 or 403 is a contract violation, not an exit:
            // this call only returns once the schedule may resume.
            self.await_resume(false).await;
        }
    }

    /// Schedules until an answer halts it. Nothing here ends the process.
    async fn schedule_until_halt(&mut self) {
        let mut next_recovery = Instant::now();
        let mut next_auto_promotion = Instant::now();
        loop {
            if Instant::now() >= next_auto_promotion {
                if self.auto_promotion_step().await == Flow::Halted {
                    return;
                }
                next_auto_promotion = Instant::now() + self.timing.auto_promotion;
            }

            if Instant::now() >= next_recovery {
                if self.recovery_step().await == Flow::Halted {
                    return;
                }
                next_recovery = Instant::now() + self.timing.recovery;
            }

            if self.tick().await == Flow::Halted {
                return;
            }

            tokio::time::sleep(self.timing.tick).await;
        }
    }

    fn new_write_ids(&self) -> WriteIds {
        WriteIds {
            request_id: Uuid::new_v4(),
            instance_id: self.instance_id,
        }
    }

    /// Section 2: opens a halt in memory, at the point the answer is handled
    /// and before any next write call. It is recorded before the next state
    /// read, and kept until a read shows it recorded and cleared.
    fn open_halt(&mut self, reason: HaltReason, halt_key: Uuid, request_id: Option<Uuid>, class: &str) {
        self.halts.open(reason, halt_key, request_id);
        self.error_log.reset();
        error!(
            instance_id = %self.instance_id,
            halt_reason = reason.as_str(),
            halt_key = %halt_key,
            request_id = ?request_id.map(|id| id.to_string()),
            class,
            measured = false,
            verdict = "halted",
            "Tomverse AMUX orchestrator halted; no write call or selection read until a person clears the halt"
        );
    }

    fn open_contract_violation(&mut self, call: &'static str, class: &str) {
        let before = self.halts.halts().len();
        self.halts.open_contract_violation();
        if self.halts.halts().len() > before {
            let halt = self.halts.halts().last().cloned();
            self.error_log.reset();
            error!(
                instance_id = %self.instance_id,
                halt_reason = HaltReason::ContractViolation.as_str(),
                halt_key = ?halt.map(|halt| halt.halt_key.to_string()),
                call,
                class,
                measured = false,
                verdict = "halted",
                "Tomverse AMUX answered outside its contract; the orchestrator halted"
            );
        }
    }

    /// Section 2: one ERROR line every five minutes while halted or waiting,
    /// naming the reason code or the waiting state and the halt id. No
    /// credential, URL or response body.
    fn log_halted(&mut self, waiting: Option<WaitState>, state: Option<&HaltState>, class: &str) {
        if !self.error_log.due(Instant::now(), self.timing.error_log) {
            return;
        }
        let held = self.halts.halts().first();
        let other = state.and_then(|state| state.open_halts.first());
        let reason = held
            .map(|halt| halt.reason.as_str())
            .or_else(|| other.map(|halt| halt.reason_code.as_str()));
        let halt_id = held
            .and_then(|halt| halt.halt_id.clone())
            .or_else(|| other.map(|halt| halt.halt_id.clone()));
        error!(
            instance_id = %self.instance_id,
            state = waiting.map_or("halted", WaitState::as_str),
            halt_reason = ?reason,
            halt_id = ?halt_id,
            held_halts = self.halts.halts().len(),
            class,
            "Tomverse AMUX orchestrator is not scheduling"
        );
    }

    /// Section 5: records every halt held in memory that has not been
    /// recorded yet, each under its own key. A failure keeps it in memory and
    /// the next call (30 seconds later) sends the same key again.
    async fn record_unrecorded_halts(&mut self) {
        for halt in self.halts.unrecorded() {
            let request = HaltRecordRequest {
                halt_key: halt.halt_key.to_string(),
                reason_code: halt.reason.as_str(),
                request_id: halt.request_id.map(|id| id.to_string()),
            };
            let answer = match self.api.orchestrator_halt_record(&request).await {
                Ok(raw) => classify_record(&raw, halt.halt_key),
                Err(_) => RecordAnswer::Retry("transport"),
            };
            match answer {
                RecordAnswer::Recorded { halt_id } => {
                    info!(
                        instance_id = %self.instance_id,
                        halt_reason = halt.reason.as_str(),
                        halt_key = %halt.halt_key,
                        halt_id = %halt_id,
                        "Tomverse AMUX orchestrator halt recorded"
                    );
                    self.halts.mark_recorded(halt.halt_key, halt_id);
                }
                RecordAnswer::Retry(class) => warn!(
                    instance_id = %self.instance_id,
                    halt_reason = halt.reason.as_str(),
                    halt_key = %halt.halt_key,
                    class,
                    "Tomverse AMUX orchestrator halt not recorded yet; it stays in memory and is sent again"
                ),
                RecordAnswer::ContractViolation(class) => {
                    warn!(
                        instance_id = %self.instance_id,
                        halt_reason = halt.reason.as_str(),
                        halt_key = %halt.halt_key,
                        class,
                        "Tomverse AMUX refused the halt record outside its contract; it stays in memory"
                    );
                    if halt.reason != HaltReason::ContractViolation {
                        self.open_contract_violation("halt_record", class);
                    }
                }
            }
        }
    }

    /// Section 6: waits until the schedule may start or resume.
    ///
    /// Every pass records what is unrecorded, then reads the halt state -- at
    /// startup that read is the process's first call. A read it cannot make
    /// is `halt_unreadable`; undecided admissions alone are
    /// `awaiting_deadline`, read again once their latest deadline plus five
    /// seconds has passed; a request needing a person gets its
    /// `unacked_write_receipt` halt. It returns only when the resume sentence
    /// holds, or -- at startup only -- on a 401 or 403.
    async fn await_resume(&mut self, startup: bool) -> Resume {
        self.error_log.reset();
        loop {
            self.record_unrecorded_halts().await;
            let keys = self.halts.keys_to_read();
            let answer = match self.api.orchestrator_halt_state(&keys).await {
                Ok(raw) => classify_state(&raw),
                Err(_) => StateAnswer::Unreadable("transport"),
            };
            let wait = match answer {
                StateAnswer::Unauthorized if startup => {
                    error!(
                        instance_id = %self.instance_id,
                        verdict = "halt_state_unauthorized",
                        "Tomverse AMUX refused the orchestrator's credential on the startup halt state read; not starting"
                    );
                    return Resume::RefusedAtStartup;
                }
                StateAnswer::Unauthorized => {
                    self.open_contract_violation("halt_state", "http_401_403");
                    self.timing.halt_poll
                }
                StateAnswer::ContractViolation(class) => {
                    self.open_contract_violation("halt_state", class);
                    self.timing.halt_poll
                }
                StateAnswer::Unreadable(class) => {
                    let waiting = self.halts.is_empty().then_some(WaitState::HaltUnreadable);
                    self.log_halted(waiting, None, class);
                    self.timing.halt_poll
                }
                StateAnswer::State(state) => {
                    let released = self.halts.release_cleared(&state);
                    if released > 0 {
                        info!(
                            instance_id = %self.instance_id,
                            released,
                            "Tomverse AMUX orchestrator read its halts cleared by a person"
                        );
                    }
                    let mut opened = false;
                    for row in &state.human_required {
                        let Ok(request_id) = Uuid::parse_str(&row.request_id) else {
                            continue;
                        };
                        if !self.halts.halts().iter().any(|halt| halt.halt_key == request_id) {
                            self.open_halt(
                                HaltReason::UnackedWriteReceipt,
                                request_id,
                                Some(request_id),
                                "human_required",
                            );
                            opened = true;
                        }
                    }
                    if opened {
                        self.record_unrecorded_halts().await;
                    }
                    match gate(&self.halts, &state) {
                        Gate::Resume => {
                            info!(
                                instance_id = %self.instance_id,
                                verdict = "scheduling",
                                "Tomverse AMUX orchestrator is scheduling: no halt, no undecided write, nothing waiting on a person"
                            );
                            return Resume::Resumed;
                        }
                        Gate::AwaitDeadline(wait) => {
                            self.log_halted(Some(WaitState::AwaitingDeadline), Some(&state), "pending");
                            wait.clamp(self.timing.deadline_floor, self.timing.deadline_ceiling)
                        }
                        Gate::Halted => {
                            self.log_halted(None, Some(&state), "halted");
                            self.timing.halt_poll
                        }
                    }
                }
            };
            tokio::time::sleep(wait).await;
        }
    }

    /// Section 4: acknowledges a known answer. Until the ack succeeds -- or
    /// the request's halt is opened -- no other call is made: a failed ack
    /// is sent again, alone, every 30 seconds (`ack_pending`). It is not the
    /// write sent again. Returns false when the process is now halted.
    async fn acknowledge(&mut self, request_id: Uuid, kind: AckKind) -> bool {
        self.error_log.reset();
        loop {
            let answer = match self.api.orchestrator_ack(request_id, kind.as_str()).await {
                Ok(raw) => classify_ack(&raw),
                Err(_) => AckAnswer::Retry("transport"),
            };
            match answer {
                AckAnswer::Acked => return true,
                AckAnswer::Refused => {
                    self.open_halt(
                        HaltReason::UnackedWriteReceipt,
                        request_id,
                        Some(request_id),
                        "ack_refused",
                    );
                    return false;
                }
                AckAnswer::ContractViolation(class) => {
                    self.open_contract_violation("ack", class);
                    return false;
                }
                AckAnswer::Retry(class) => {
                    self.log_halted(Some(WaitState::AckPending), None, class);
                    tokio::time::sleep(self.timing.halt_poll).await;
                }
            }
        }
    }

    /// Sections 1 and 4: acknowledges a known answer or halts on an unknown
    /// one, with the request id as the halt key.
    async fn settle_write<T>(
        &mut self,
        kind: CallKind,
        request_id: Uuid,
        answer: WriteAnswer<T>,
    ) -> Settled<T> {
        match answer {
            WriteAnswer::Definite(value) => {
                if self.acknowledge(request_id, AckKind::Definite).await {
                    Settled::Definite(value)
                } else {
                    Settled::Halted
                }
            }
            WriteAnswer::NothingCommitted(reason) => {
                if self.acknowledge(request_id, AckKind::NoCommit).await {
                    Settled::NothingCommitted(reason)
                } else {
                    Settled::Halted
                }
            }
            WriteAnswer::Unknown(class) => {
                self.open_halt(kind.unknown_outcome(), request_id, Some(request_id), class);
                Settled::Halted
            }
        }
    }

    /// Policy version 15's system consumer of pre-approved grants, a write
    /// call since version 20.
    async fn auto_promotion_step(&mut self) -> Flow {
        let ids = self.new_write_ids();
        let answer = write_answer(self.api.auto_promotion_tick(ids).await, classify_tick);
        match self
            .settle_write(CallKind::AutoPromotionTick, ids.request_id, answer)
            .await
        {
            Settled::Definite(outcome) => {
                info!(
                    promoted = outcome.promoted,
                    reason = ?outcome.reason,
                    consumption_id = ?outcome.consumption_id,
                    policy_version = ?outcome.policy_version,
                    receipt_id = ?outcome.receipt_id,
                    task_id = ?outcome.task_id,
                    claimed = ?outcome.claimed,
                    assignment_id = ?outcome.assignment_id,
                    worker_name = ?outcome.worker_name,
                    expired_grants = outcome.expired.unwrap_or(0),
                    "AMUX automatic promotion tick"
                );
                Flow::Continue
            }
            Settled::NothingCommitted(reason) => {
                warn!(
                    endpoint = "auto_promotion_tick",
                    reason,
                    measured = true,
                    verdict = "auto_promotion_skipped",
                    "Tomverse AMUX committed nothing for the automatic promotion tick; trying again next interval"
                );
                Flow::Continue
            }
            Settled::Halted => Flow::Halted,
        }
    }

    /// One recovery sweep, a write call since version 20. The three "nothing
    /// committed" answers skip the pass; every other answer outside section 1
    /// halts `recovery_outcome_unknown`.
    async fn recovery_step(&mut self) -> Flow {
        let ids = self.new_write_ids();
        let answer = write_answer(self.api.execution_recover(ids).await, classify_recover);
        match self
            .settle_write(CallKind::Recover, ids.request_id, answer)
            .await
        {
            Settled::Definite(outcome) if outcome.recovered => {
                info!(
                    reclaimed_executions = outcome.reclaimed.unwrap_or(0),
                    reclaimed_claims = outcome.reclaimed_claims.unwrap_or(0),
                    quota_observations_deleted = outcome.quota_observations_deleted.unwrap_or(0),
                    more = outcome.more.unwrap_or(false),
                    "AMUX recovery sweep completed"
                );
                Flow::Continue
            }
            Settled::Definite(outcome) => {
                info!(
                    reason = ?outcome.reason,
                    quota_observations_deleted = outcome.quota_observations_deleted.unwrap_or(0),
                    "AMUX execution recovery is disabled; quota evidence swept"
                );
                Flow::Continue
            }
            Settled::NothingCommitted(reason) => {
                warn!(
                    endpoint = "execution_recover",
                    reason,
                    measured = true,
                    verdict = "recovery_skipped",
                    "Tomverse AMUX committed nothing for the recovery sweep; retrying next interval"
                );
                Flow::Continue
            }
            Settled::Halted => Flow::Halted,
        }
    }

    /// Handles one selection read's (`queue`, `routing_snapshot`) result
    /// (policy version 20, section 1). A selection read writes nothing, so a
    /// transport failure, a 404, a 5xx other than the three "nothing
    /// committed" reasons and a 429 are counted and the tick skipped, up to
    /// `MAX_CONSECUTIVE_SELECTION_READ_SKIPS` in a row; the next one halts
    /// `selection_read_failures`. The board-capacity answer and the three 503
    /// reasons end the tick without being counted. Anything else -- a body
    /// outside the contract, a 400, 401, 403 or another 409 -- halts
    /// `contract_violation`.
    fn handle_selection_read<T>(
        &mut self,
        endpoint: &'static str,
        result: Result<SelectionRead<T>>,
    ) -> SelectionStep<T> {
        match classify_selection(result) {
            SelectionClass::Ready(value) => {
                if self.tick_selection == TickSelection::Untouched {
                    self.tick_selection = TickSelection::Ready;
                }
                SelectionStep::Ready(value)
            }
            SelectionClass::Uncounted(reason) => {
                skip_tick_uncounted(endpoint, reason);
                self.tick_selection = TickSelection::UncountedSkip;
                SelectionStep::EndTick
            }
            SelectionClass::Counted(class) => {
                // At most once per tick: every counted failure ends the tick.
                self.tick_selection = TickSelection::CountedFailure;
                self.consecutive_selection_skips += 1;
                if self.consecutive_selection_skips > MAX_CONSECUTIVE_SELECTION_READ_SKIPS {
                    let consecutive = self.consecutive_selection_skips;
                    self.open_halt(HaltReason::SelectionReadFailures, Uuid::new_v4(), None, class);
                    warn!(
                        endpoint,
                        consecutive_skips = consecutive,
                        "Tomverse AMUX selection reads kept failing past the skip bound; halted"
                    );
                    return SelectionStep::Halted;
                }
                warn!(
                    endpoint,
                    error_class = class,
                    measured = false,
                    consecutive_skips = self.consecutive_selection_skips,
                    verdict = "selection_skipped",
                    "Tomverse AMUX selection read failed without writing anything; skipping this tick"
                );
                SelectionStep::EndTick
            }
            SelectionClass::Contract(class) => {
                self.open_contract_violation(endpoint, class);
                SelectionStep::Halted
            }
        }
    }

    /// One tick. The consecutive-failure counter is reset here, after the
    /// tick, and only when every selection read in it was ready: a tick that
    /// ended on an uncounted skip leaves the counter as it was, and a tick
    /// with a counted failure has already incremented it.
    async fn tick(&mut self) -> Flow {
        self.tick_selection = TickSelection::Untouched;
        let flow = self.tick_once().await;
        if self.tick_selection == TickSelection::Ready {
            self.consecutive_selection_skips = 0;
        }
        flow
    }

    async fn tick_once(&mut self) -> Flow {
        let queue_result = self.api.queue().await;
        let queue = match self.handle_selection_read("queue", queue_result) {
            SelectionStep::Ready(queue) => queue,
            SelectionStep::EndTick => return Flow::Continue,
            SelectionStep::Halted => return Flow::Halted,
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
                return Flow::Continue;
            }

            // Board capacity, the three "nothing committed" answers and a
            // counted failure would all answer the next candidate in the
            // window the same way, and none of them wrote or claimed
            // anything. Skip the tick; the next one reads the queue again.
            let snapshot_result = self.api.routing_snapshot(&task.id, task.revision).await;
            let snapshot = match self.handle_selection_read("routing_snapshot", snapshot_result) {
                SelectionStep::Ready(snapshot) => snapshot,
                SelectionStep::EndTick => return Flow::Continue,
                SelectionStep::Halted => return Flow::Halted,
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

            // Policy version 20, section 4: a new request id for this write.
            let ids = self.new_write_ids();
            let claim_result = self
                .api
                .claim(
                    ids,
                    &task.id,
                    &worker,
                    task.revision,
                    score.total(),
                    scoring_version,
                    signals,
                )
                .await;
            let outcome = match self
                .settle_write(
                    CallKind::Claim,
                    ids.request_id,
                    write_answer(claim_result, classify_claim),
                )
                .await
            {
                Settled::Definite(outcome) => outcome,
                // The claim committed nothing: ownership did not change. Skip
                // the tick; the next one reads the queue again.
                Settled::NothingCommitted(reason) => {
                    warn!(
                        task_id = %task.id,
                        task_revision = task.revision,
                        worker = %worker,
                        endpoint = "claim",
                        reason,
                        measured = true,
                        verdict = "claim_skipped",
                        "Tomverse AMUX committed nothing for the claim; skipping this tick"
                    );
                    return Flow::Continue;
                }
                Settled::Halted => return Flow::Halted,
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
                    return Flow::Continue;
                }
                // A refusal or a lost CAS changed no ownership. The next
                // candidate in the bounded window is tried; the next tick
                // re-reads the queue.
                ClaimFollowUp::NextCandidate => continue,
            }
        }
        Flow::Continue
    }
}

/// A selection-read answer that ends the tick without a claim and is not
/// counted: the board-capacity refusal, or one of the three 503 reasons that
/// say nothing was committed (policy version 20, section 1). Recovery and
/// automatic promotion keep their own cadence meanwhile.
fn skip_tick_uncounted(endpoint: &'static str, reason: &'static str) {
    warn!(
        endpoint,
        reason,
        measured = true,
        verdict = "selection_skipped",
        "Tomverse AMUX selection read wrote nothing and was not counted; skipping this tick"
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

    // ---------------------------------------------------------------------
    // HTTP-level behaviour against a scripted Tomverse. Orchestration policy
    // version 20: known answers (section 1), halts (section 2), the only
    // exits (section 3), acknowledgements (section 4), halt records and
    // state reads (section 5), startup and resume (section 6).
    // ---------------------------------------------------------------------

    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    const HALT_PATH: &str = "/api/internal/amux/orchestrator/halt";
    const ACK_PATH: &str = "/api/internal/amux/orchestrator/ack";
    const QUEUE_PATH: &str = "/api/internal/amux/queue";
    const ROUTING_PATH: &str = "/api/internal/amux/routing-snapshot";
    const CLAIM_PATH: &str = "/api/internal/amux/claim";
    const RECOVER_PATH: &str = "/api/internal/amux/execution/recover";
    const TICK_PATH: &str = "/api/internal/amux/auto-promotion/tick";

    #[derive(Clone, Debug)]
    struct Seen {
        method: String,
        path: String,
        query: String,
        request_id: Option<String>,
        instance_id: Option<String>,
        body: String,
    }

    impl Seen {
        fn is(&self, method: &str, path: &str) -> bool {
            self.method == method && self.path == path
        }
        fn json(&self) -> serde_json::Value {
            serde_json::from_str(&self.body).unwrap_or(serde_json::Value::Null)
        }
    }

    type Reply = (&'static str, String);
    type Handler = Arc<dyn Fn(&Seen) -> Option<Reply> + Send + Sync>;
    type Log = Arc<Mutex<Vec<Seen>>>;

    const CLEAR_STATE: &str = r#"{"open_halt_count":0,"open_halts":[],"pending_count":0,"latest_deadline_at":null,"retry_after_ms":null,"human_required_count":0,"human_required":[],"halts":[]}"#;

    /// Every call answered the way a healthy, quiet Tomverse answers it. A
    /// recorded halt's id is its key, so a test can name it cleared.
    fn default_reply(seen: &Seen) -> Reply {
        match (seen.method.as_str(), seen.path.as_str()) {
            ("GET", HALT_PATH) => ("200 OK", CLEAR_STATE.to_owned()),
            ("POST", HALT_PATH) => {
                let body = seen.json();
                (
                    "200 OK",
                    serde_json::json!({
                        "halt_id": body["halt_key"],
                        "halt_key": body["halt_key"],
                        "reason_code": body["reason_code"],
                        "request_id": body.get("request_id").cloned().unwrap_or(serde_json::Value::Null),
                        "opened_at": "2026-09-30T00:00:00.000Z",
                        "cleared": false,
                        "created": true,
                    })
                    .to_string(),
                )
            }
            ("POST", ACK_PATH) => ("200 OK", r#"{"acked":true}"#.to_owned()),
            ("POST", TICK_PATH) => (
                "200 OK",
                r#"{"promoted":false,"reason":"no_grant","expired":0}"#.to_owned(),
            ),
            ("POST", RECOVER_PATH) => (
                "409 Conflict",
                r#"{"recovered":false,"reason":"execution_api_disabled","quota_observations_deleted":0}"#
                    .to_owned(),
            ),
            ("POST", QUEUE_PATH) => ("200 OK", "[]".to_owned()),
            _ => ("500 Internal Server Error", "{}".to_owned()),
        }
    }

    /// A scripted Tomverse: `handler` answers first, the defaults otherwise.
    /// One connection per request; every request is logged.
    async fn serve(handler: Handler) -> (String, Log) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let log: Log = Arc::new(Mutex::new(Vec::new()));
        let seen_log = log.clone();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let mut request = Vec::new();
                let mut buffer = [0_u8; 8192];
                let head_end = loop {
                    let read = stream.read(&mut buffer).await.unwrap_or(0);
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
                let header = |name: &str| {
                    head.lines().find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.trim()
                            .eq_ignore_ascii_case(name)
                            .then(|| value.trim().to_owned())
                    })
                };
                let length = header("content-length")
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(0);
                while request.len() < head_end + length {
                    let read = stream.read(&mut buffer).await.unwrap_or(0);
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..read]);
                }
                let mut first = head.lines().next().unwrap_or("").split_whitespace();
                let method = first.next().unwrap_or("").to_owned();
                let target = first.next().unwrap_or("").to_owned();
                let (path, query) = target
                    .split_once('?')
                    .map(|(path, query)| (path.to_owned(), query.to_owned()))
                    .unwrap_or((target.clone(), String::new()));
                let seen = Seen {
                    method,
                    path,
                    query,
                    request_id: header("x-amux-request-id"),
                    instance_id: header("x-amux-instance-id"),
                    body: String::from_utf8_lossy(&request[head_end..]).to_string(),
                };
                seen_log.lock().unwrap().push(seen.clone());
                let (status, body) = handler(&seen).unwrap_or_else(|| default_reply(&seen));
                if status == "DROP" {
                    drop(stream);
                    continue;
                }
                let reply = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len(),
                );
                let _ = stream.write_all(reply.as_bytes()).await;
                let _ = stream.shutdown().await;
            }
        });
        (format!("http://{address}"), log)
    }

    const TEST_TIMING: Timing = Timing {
        tick: Duration::from_millis(1),
        recovery: Duration::from_secs(3600),
        auto_promotion: Duration::from_secs(3600),
        halt_poll: Duration::from_millis(5),
        error_log: Duration::from_secs(3600),
        deadline_floor: Duration::from_millis(5),
        deadline_ceiling: Duration::from_millis(50),
    };

    fn scheduler_for(base_url: String) -> Scheduler {
        let mut scheduler = Scheduler::with_timing(
            TomverseApi::for_test_with_timeouts(
                base_url,
                Duration::from_millis(500),
                Duration::from_secs(2),
            ),
            TEST_TIMING,
        );
        // Claim path, so the tick reaches the routing snapshot. The latch and
        // TOMVERSE_AMUX_CLAIM are not set in tests, so this is Execute mode.
        scheduler.execution_enabled = true;
        scheduler
    }

    fn handler(f: impl Fn(&Seen) -> Option<Reply> + Send + Sync + 'static) -> Handler {
        Arc::new(f)
    }

    fn queue_row() -> String {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/amux-queue-wire-compat-v1.json"
        ))
        .unwrap();
        format!("[{}]", fixtures["queue_server"])
    }

    fn eligible_snapshot() -> String {
        let routing: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/amux-routing-snapshot-v1.json"
        ))
        .unwrap();
        routing["eligible"].to_string()
    }

    /// Queue and snapshot answer so the tick reaches the claim, which answers
    /// `status` and `body`.
    fn claim_answers(status: &'static str, body: &str) -> Handler {
        let body = body.to_owned();
        handler(move |seen| match seen.path.as_str() {
            QUEUE_PATH => Some(("200 OK", queue_row())),
            ROUTING_PATH => Some(("200 OK", eligible_snapshot())),
            CLAIM_PATH => Some((status, body.clone())),
            _ => None,
        })
    }

    fn paths(log: &Log) -> Vec<String> {
        log.lock()
            .unwrap()
            .iter()
            .map(|seen| format!("{} {}", seen.method, seen.path))
            .collect()
    }

    fn only_halt(scheduler: &Scheduler) -> crate::orchestrator_halt::MemoryHalt {
        assert_eq!(scheduler.halts.halts().len(), 1, "{:?}", scheduler.halts.halts());
        scheduler.halts.halts()[0].clone()
    }

    const QUEUE_CAPACITY_BODY: &str =
        r#"{"error":"Queue capacity exceeded.","reason":"board_capacity_exceeded"}"#;
    const ROUTING_CAPACITY_BODY: &str = r#"{"eligible":false,"reason":"board_capacity_exceeded"}"#;
    // The exact bodies lib/amux/internalRoute.ts sends.
    const DATABASE_BUSY_BODY: &str =
        r#"{"error":"AMUX database is busy.","reason":"amux_database_busy"}"#;
    const DEADLINE_BODY: &str =
        r#"{"error":"AMUX database deadline exceeded.","reason":"amux_database_deadline_exceeded"}"#;
    const CEILING_BODY: &str =
        r#"{"error":"AMUX database call ceiling exceeded.","reason":"amux_database_call_ceiling_exceeded"}"#;
    const OUTCOME_UNKNOWN_BODY: &str = r#"{"error":"AMUX database outcome is unknown.","reason":"amux_outcome_unknown","incident_id":"0b8e9a52-6d8c-4f0e-9b1a-2c3d4e5f6a7b"}"#;

    #[tokio::test]
    async fn a_board_capacity_refusal_or_a_nothing_committed_503_ends_the_tick_uncounted() {
        for (status, body) in [
            ("409 Conflict", QUEUE_CAPACITY_BODY),
            ("503 Service Unavailable", DATABASE_BUSY_BODY),
            ("503 Service Unavailable", DEADLINE_BODY),
            ("503 Service Unavailable", CEILING_BODY),
        ] {
            let body = body.to_owned();
            let (base_url, log) = serve(handler(move |seen| {
                (seen.path == QUEUE_PATH).then(|| (status, body.clone()))
            }))
            .await;
            let mut scheduler = scheduler_for(base_url);
            scheduler.consecutive_selection_skips = 7;
            assert_eq!(scheduler.tick().await, Flow::Continue, "{status}");
            assert_eq!(paths(&log), vec![format!("POST {QUEUE_PATH}")]);
            assert!(scheduler.halts.is_empty());
            // Not counted, and not reset either.
            assert_eq!(scheduler.consecutive_selection_skips, 7, "{status}");
        }
        for (status, body) in [
            ("409 Conflict", ROUTING_CAPACITY_BODY),
            ("503 Service Unavailable", DATABASE_BUSY_BODY),
            ("503 Service Unavailable", DEADLINE_BODY),
            ("503 Service Unavailable", CEILING_BODY),
        ] {
            let body = body.to_owned();
            let (base_url, log) = serve(handler(move |seen| match seen.path.as_str() {
                QUEUE_PATH => Some(("200 OK", queue_row())),
                ROUTING_PATH => Some((status, body.clone())),
                _ => None,
            }))
            .await;
            let mut scheduler = scheduler_for(base_url);
            assert_eq!(scheduler.tick().await, Flow::Continue, "{status}");
            // No claim follows.
            assert_eq!(
                paths(&log),
                vec![format!("POST {QUEUE_PATH}"), format!("POST {ROUTING_PATH}")]
            );
            assert_eq!(scheduler.consecutive_selection_skips, 0);
            assert!(scheduler.halts.is_empty());
        }
    }

    #[tokio::test]
    async fn every_write_call_carries_a_new_request_id_and_the_process_instance_id() {
        let (base_url, log) = serve(claim_answers(
            "200 OK",
            r#"{"claimed":true,"revision":1,"decision_id":"c123456789012345678901234"}"#,
        ))
        .await;
        let mut scheduler = scheduler_for(base_url);
        assert_eq!(scheduler.auto_promotion_step().await, Flow::Continue);
        assert_eq!(scheduler.recovery_step().await, Flow::Continue);
        assert_eq!(scheduler.tick().await, Flow::Continue);

        let seen = log.lock().unwrap().clone();
        let writes: Vec<&Seen> = seen
            .iter()
            .filter(|seen| [TICK_PATH, RECOVER_PATH, CLAIM_PATH].contains(&seen.path.as_str()))
            .collect();
        assert_eq!(writes.len(), 3);
        let instance = scheduler.instance_id().to_string();
        let mut request_ids = std::collections::HashSet::new();
        for write in &writes {
            assert_eq!(write.instance_id.as_deref(), Some(instance.as_str()), "{}", write.path);
            let request_id = write.request_id.clone().expect("request id");
            assert_eq!(Uuid::parse_str(&request_id).unwrap().get_version_num(), 4);
            assert!(request_ids.insert(request_id));
        }
        // Each write is acknowledged, definite, before the next call.
        let acks: Vec<serde_json::Value> = seen
            .iter()
            .filter(|seen| seen.path == ACK_PATH)
            .map(Seen::json)
            .collect();
        assert_eq!(acks.len(), 3);
        for (ack, write) in acks.iter().zip(&writes) {
            assert_eq!(ack["request_id"], write.request_id.clone().unwrap());
            assert_eq!(ack["kind"], "definite");
        }
        // Reads and acks carry no write identity.
        for read in seen.iter().filter(|seen| [QUEUE_PATH, ROUTING_PATH, ACK_PATH].contains(&seen.path.as_str())) {
            assert_eq!(read.request_id, None, "{}", read.path);
        }
        // A second scheduler is a second process: a different instance id.
        assert_ne!(scheduler_for("http://127.0.0.1:9".into()).instance_id(), scheduler.instance_id());
    }

    #[tokio::test]
    async fn no_known_answer_halts_and_each_is_acknowledged_with_its_kind() {
        // Claim: 200 (claimed and CAS lost), each closed 409 refusal, and the
        // three 503 reasons.
        let mut cases: Vec<(&'static str, String, &'static str)> = vec![
            ("200 OK", r#"{"claimed":true,"revision":1,"decision_id":"c123456789012345678901234"}"#.into(), "definite"),
            ("200 OK", r#"{"claimed":false}"#.into(), "definite"),
            ("503 Service Unavailable", DATABASE_BUSY_BODY.into(), "no_commit"),
            ("503 Service Unavailable", DEADLINE_BODY.into(), "no_commit"),
            ("503 Service Unavailable", CEILING_BODY.into(), "no_commit"),
        ];
        for reason in crate::tomverse_api::ClaimRefusalReason::CLOSED {
            cases.push((
                "409 Conflict",
                format!(r#"{{"claimed":false,"reason":"{}"}}"#, reason.as_str()),
                "definite",
            ));
        }
        for (status, body, kind) in cases {
            let (base_url, log) = serve(claim_answers(status, &body)).await;
            let mut scheduler = scheduler_for(base_url);
            assert_eq!(scheduler.tick().await, Flow::Continue, "{status} {body}");
            assert!(scheduler.halts.is_empty(), "{status} {body}");
            let seen = log.lock().unwrap().clone();
            let claim = seen.iter().find(|seen| seen.path == CLAIM_PATH).unwrap();
            let ack = seen.iter().find(|seen| seen.path == ACK_PATH).unwrap().json();
            assert_eq!(ack["request_id"], claim.request_id.clone().unwrap());
            assert_eq!(ack["kind"], kind, "{status} {body}");
        }

        // Recover: its 409 execution_api_disabled, even after the quota sweep
        // deleted rows, and its 2xx.
        for (status, body, kind) in [
            ("409 Conflict", r#"{"recovered":false,"reason":"execution_api_disabled","quota_observations_deleted":7}"#, "definite"),
            ("200 OK", r#"{"recovered":true,"reclaimed":1,"reclaimed_claims":0,"quota_observations_deleted":0,"more":false}"#, "definite"),
            ("503 Service Unavailable", DEADLINE_BODY, "no_commit"),
        ] {
            let body = body.to_owned();
            let (base_url, log) = serve(handler(move |seen| {
                (seen.path == RECOVER_PATH).then(|| (status, body.clone()))
            }))
            .await;
            let mut scheduler = scheduler_for(base_url);
            assert_eq!(scheduler.recovery_step().await, Flow::Continue, "{status}");
            assert!(scheduler.halts.is_empty());
            let ack = log.lock().unwrap().iter().find(|seen| seen.path == ACK_PATH).unwrap().json();
            assert_eq!(ack["kind"], kind);
        }

        // Automatic promotion tick: any 200 reason, and the 409 apply_disabled.
        for (status, body) in [
            ("409 Conflict", r#"{"promoted":false,"reason":"apply_disabled","expired":0}"#),
            ("200 OK", r#"{"promoted":false,"reason":"graduation_unmet","expired":0}"#),
            ("200 OK", r#"{"promoted":false,"reason":"route_budget_exhausted","expired":3}"#),
            ("200 OK", r#"{"promoted":false,"reason":"auto_halted","expired":0}"#),
        ] {
            let body = body.to_owned();
            let (base_url, _) = serve(handler(move |seen| {
                (seen.path == TICK_PATH).then(|| (status, body.clone()))
            }))
            .await;
            let mut scheduler = scheduler_for(base_url);
            assert_eq!(scheduler.auto_promotion_step().await, Flow::Continue, "{status}");
            assert!(scheduler.halts.is_empty());
        }
    }

    #[tokio::test]
    async fn an_answer_outside_section_1_halts_before_the_next_write_and_is_never_acknowledged() {
        // Claim: the completion list's examples and no answer at all.
        for (status, body) in [
            ("500 Internal Server Error", r#"{"error":"Internal server error.","incident_id":"0b8e9a52-6d8c-4f0e-9b1a-2c3d4e5f6a7b"}"#),
            ("503 Service Unavailable", r#"{"error":"AMUX database commit check is missing.","reason":"amux_commit_check_missing","incident_id":"x"}"#),
            ("503 Service Unavailable", OUTCOME_UNKNOWN_BODY),
            ("503 Service Unavailable", r#"{"error":"AMUX database is busy.","reason":"amux_database_busy","extra":1}"#),
            ("429 Too Many Requests", r#"{"error":"Too Many Requests"}"#),
            ("409 Conflict", r#"{"error":"Duplicate request.","reason":"duplicate_request"}"#),
            ("DROP", ""),
        ] {
            let (base_url, log) = serve(claim_answers(status, body)).await;
            let mut scheduler = scheduler_for(base_url);
            assert_eq!(scheduler.tick().await, Flow::Halted, "{status} {body}");
            let halt = only_halt(&scheduler);
            assert_eq!(halt.reason, HaltReason::ClaimOutcomeUnknown);
            let seen = log.lock().unwrap().clone();
            let claim = seen.iter().find(|seen| seen.path == CLAIM_PATH).unwrap();
            let request_id = Uuid::parse_str(claim.request_id.as_deref().unwrap()).unwrap();
            assert_eq!(halt.halt_key, request_id);
            assert_eq!(halt.request_id, Some(request_id));
            // The claim was the last call: no ack, no second candidate.
            assert_eq!(seen.last().unwrap().path, CLAIM_PATH, "{status} {body}");
        }

        // Recover and the tick halt on theirs.
        for (path, status, body, reason) in [
            (RECOVER_PATH, "503 Service Unavailable", OUTCOME_UNKNOWN_BODY, HaltReason::RecoveryOutcomeUnknown),
            (RECOVER_PATH, "409 Conflict", r#"{"recovered":false,"reason":"other","quota_observations_deleted":0}"#, HaltReason::RecoveryOutcomeUnknown),
            (RECOVER_PATH, "DROP", "", HaltReason::RecoveryOutcomeUnknown),
            (TICK_PATH, "500 Internal Server Error", r#"{"promoted":false,"reason":"audit_unbound","expired":0}"#, HaltReason::PromotionOutcomeUnknown),
            (TICK_PATH, "409 Conflict", r#"{"promoted":false,"reason":"outcome_unknown","expired":0}"#, HaltReason::PromotionOutcomeUnknown),
            (TICK_PATH, "409 Conflict", r#"{"promoted":false,"reason":"expiry_outcome_unknown","expired":1}"#, HaltReason::PromotionOutcomeUnknown),
            (TICK_PATH, "429 Too Many Requests", "{}", HaltReason::PromotionOutcomeUnknown),
        ] {
            let body = body.to_owned();
            let (base_url, log) = serve(handler(move |seen| (seen.path == path).then(|| (status, body.clone())))).await;
            let mut scheduler = scheduler_for(base_url);
            let flow = if path == RECOVER_PATH {
                scheduler.recovery_step().await
            } else {
                scheduler.auto_promotion_step().await
            };
            assert_eq!(flow, Flow::Halted, "{path} {status}");
            assert_eq!(only_halt(&scheduler).reason, reason);
            assert!(log.lock().unwrap().iter().all(|seen| seen.path != ACK_PATH));
        }
    }

    #[tokio::test]
    async fn a_refused_no_commit_acknowledgement_is_an_unacked_write_receipt_halt() {
        let (base_url, log) = serve(handler(|seen| match seen.path.as_str() {
            QUEUE_PATH => Some(("200 OK", queue_row())),
            ROUTING_PATH => Some(("200 OK", eligible_snapshot())),
            CLAIM_PATH => Some(("503 Service Unavailable", DATABASE_BUSY_BODY.to_owned())),
            ACK_PATH => Some((
                "409 Conflict",
                r#"{"acked":false,"reason":"receipts_present"}"#.to_owned(),
            )),
            _ => None,
        }))
        .await;
        let mut scheduler = scheduler_for(base_url);
        assert_eq!(scheduler.tick().await, Flow::Halted);
        let halt = only_halt(&scheduler);
        assert_eq!(halt.reason, HaltReason::UnackedWriteReceipt);
        let claim_request = log.lock().unwrap().iter().find(|seen| seen.path == CLAIM_PATH).unwrap().request_id.clone().unwrap();
        assert_eq!(halt.halt_key.to_string(), claim_request);
        assert_eq!(log.lock().unwrap().last().unwrap().path, ACK_PATH);
    }

    #[tokio::test]
    async fn a_failed_acknowledgement_is_sent_again_alone_and_nothing_else_is_called_meanwhile() {
        let acks = Arc::new(AtomicUsize::new(0));
        let counter = acks.clone();
        let (base_url, log) = serve(handler(move |seen| match seen.path.as_str() {
            QUEUE_PATH => Some(("200 OK", queue_row())),
            ROUTING_PATH => Some(("200 OK", eligible_snapshot())),
            CLAIM_PATH => Some(("200 OK", r#"{"claimed":false}"#.to_owned())),
            ACK_PATH => {
                let attempt = counter.fetch_add(1, Ordering::SeqCst);
                Some(match attempt {
                    0 => ("DROP", String::new()),
                    1 => ("503 Service Unavailable", DATABASE_BUSY_BODY.to_owned()),
                    2 => ("404 Not Found", "{}".to_owned()),
                    _ => ("200 OK", r#"{"acked":true}"#.to_owned()),
                })
            }
            _ => None,
        }))
        .await;
        let mut scheduler = scheduler_for(base_url);
        // A lost CAS moves to the next candidate; the queue row is the only one.
        assert_eq!(scheduler.tick().await, Flow::Continue);
        assert!(scheduler.halts.is_empty());
        let seen = paths(&log);
        let claim_at = seen.iter().position(|path| path.ends_with(CLAIM_PATH)).unwrap();
        assert_eq!(
            &seen[claim_at..],
            &[
                format!("POST {CLAIM_PATH}"),
                format!("POST {ACK_PATH}"),
                format!("POST {ACK_PATH}"),
                format!("POST {ACK_PATH}"),
                format!("POST {ACK_PATH}"),
            ]
        );
        // The same request id every time: the ack is sent again, not the write.
        let ids: std::collections::HashSet<String> = log
            .lock()
            .unwrap()
            .iter()
            .filter(|seen| seen.path == ACK_PATH)
            .map(|seen| seen.json()["request_id"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(ids.len(), 1);
    }

    #[tokio::test]
    async fn an_acknowledgement_outside_its_contract_halts_contract_violation() {
        let (base_url, _) = serve(handler(|seen| match seen.path.as_str() {
            RECOVER_PATH => Some((
                "409 Conflict",
                r#"{"recovered":false,"reason":"execution_api_disabled","quota_observations_deleted":0}"#.to_owned(),
            )),
            ACK_PATH => Some(("401 Unauthorized", r#"{"error":"Unauthorized"}"#.to_owned())),
            _ => None,
        }))
        .await;
        let mut scheduler = scheduler_for(base_url);
        assert_eq!(scheduler.recovery_step().await, Flow::Halted);
        let halt = only_halt(&scheduler);
        assert_eq!(halt.reason, HaltReason::ContractViolation);
        assert_eq!(halt.request_id, None);
    }

    #[tokio::test]
    async fn a_selection_read_outside_its_contract_halts_and_a_404_is_counted() {
        for (status, body) in [
            ("409 Conflict", r#"{"error":"Queue capacity exceeded.","reason":"other"}"#),
            ("409 Conflict", r#"{"error":"x","reason":"board_capacity_exceeded","extra":1}"#),
            ("401 Unauthorized", r#"{"error":"Unauthorized"}"#),
            ("403 Forbidden", r#"{"error":"Forbidden"}"#),
            ("400 Bad Request", r#"{"error":"Invalid request."}"#),
            ("200 OK", "not json"),
            ("200 OK", r#"[{"id":"TASK-trailing-","kind":"code","priority":"p1","pinned":false,"drag":0,"revision":0,"created_at":"2026-09-20T12:00:00Z","dependent_count":0}]"#),
        ] {
            let body = body.to_owned();
            let (base_url, _) = serve(handler(move |seen| {
                (seen.path == QUEUE_PATH).then(|| (status, body.clone()))
            }))
            .await;
            let mut scheduler = scheduler_for(base_url);
            assert_eq!(scheduler.tick().await, Flow::Halted, "queue {status}");
            assert_eq!(only_halt(&scheduler).reason, HaltReason::ContractViolation);
        }
        for (status, body) in [
            // `eligible: true` contradicts a refusal: not board capacity.
            ("409 Conflict", r#"{"eligible":true,"reason":"board_capacity_exceeded"}"#),
            ("409 Conflict", r#"{"eligible":false,"reason":"not_eligible"}"#),
            ("401 Unauthorized", r#"{"error":"Unauthorized"}"#),
            ("400 Bad Request", r#"{"error":"Invalid request."}"#),
            ("200 OK", "not json"),
        ] {
            let body = body.to_owned();
            let (base_url, _) = serve(handler(move |seen| match seen.path.as_str() {
                QUEUE_PATH => Some(("200 OK", queue_row())),
                ROUTING_PATH => Some((status, body.clone())),
                _ => None,
            }))
            .await;
            let mut scheduler = scheduler_for(base_url);
            assert_eq!(scheduler.tick().await, Flow::Halted, "routing {status}");
            assert_eq!(only_halt(&scheduler).reason, HaltReason::ContractViolation);
        }

        for path in [QUEUE_PATH, ROUTING_PATH] {
            let (base_url, _) = serve(handler(move |seen| match seen.path.as_str() {
                QUEUE_PATH if path == ROUTING_PATH => Some(("200 OK", queue_row())),
                p if p == path => Some(("404 Not Found", r#"{"error":"Not Found"}"#.to_owned())),
                _ => None,
            }))
            .await;
            let mut scheduler = scheduler_for(base_url);
            assert_eq!(scheduler.tick().await, Flow::Continue, "{path}");
            assert_eq!(scheduler.consecutive_selection_skips, 1, "{path}");
            assert!(scheduler.halts.is_empty());
        }
    }

    #[tokio::test]
    async fn a_transport_failure_a_5xx_or_a_429_on_a_selection_read_is_counted_and_skipped() {
        for (status, body) in [
            ("DROP", String::new()),
            ("500 Internal Server Error", r#"{"error":"Internal server error."}"#.to_owned()),
            ("502 Bad Gateway", r#"{"error":"Bad Gateway"}"#.to_owned()),
            ("503 Service Unavailable", OUTCOME_UNKNOWN_BODY.to_owned()),
            ("500 Internal Server Error", DATABASE_BUSY_BODY.to_owned()),
            ("429 Too Many Requests", r#"{"error":"Too Many Requests"}"#.to_owned()),
        ] {
            for path in [QUEUE_PATH, ROUTING_PATH] {
                let body = body.clone();
                let (base_url, _) = serve(handler(move |seen| match seen.path.as_str() {
                    QUEUE_PATH if path == ROUTING_PATH => Some(("200 OK", queue_row())),
                    p if p == path => Some((status, body.clone())),
                    _ => None,
                }))
                .await;
                let mut scheduler = scheduler_for(base_url);
                assert_eq!(scheduler.tick().await, Flow::Continue, "{path} {status}");
                assert_eq!(scheduler.consecutive_selection_skips, 1, "{path} {status}");
                assert!(scheduler.halts.is_empty());
            }
        }
    }

    /// A queue that answers an empty, successful queue while `succeed` is set
    /// and a plain 500 otherwise.
    async fn serve_queue_toggle() -> (String, Arc<std::sync::atomic::AtomicBool>, Log) {
        let succeed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = succeed.clone();
        let (base_url, log) = serve(handler(move |seen| {
            (seen.path == QUEUE_PATH).then(|| {
                if flag.load(Ordering::SeqCst) {
                    ("200 OK", "[]".to_owned())
                } else {
                    ("500 Internal Server Error", r#"{"error":"boom"}"#.to_owned())
                }
            })
        }))
        .await;
        (base_url, succeed, log)
    }

    #[tokio::test]
    async fn the_61st_consecutive_selection_read_failure_is_a_halt_and_a_whole_ready_tick_resets_the_count() {
        let bound = MAX_CONSECUTIVE_SELECTION_READ_SKIPS;
        assert_eq!(bound, 60);
        let (base_url, succeed, _) = serve_queue_toggle().await;
        let mut scheduler = scheduler_for(base_url);

        for attempt in 1..bound {
            assert_eq!(scheduler.tick().await, Flow::Continue, "attempt {attempt}");
        }
        assert_eq!(scheduler.consecutive_selection_skips, bound - 1);

        // A whole successful tick resets it...
        succeed.store(true, Ordering::SeqCst);
        assert_eq!(scheduler.tick().await, Flow::Continue);
        assert_eq!(scheduler.consecutive_selection_skips, 0);

        // ...so the 60th failure since then is still a skip...
        succeed.store(false, Ordering::SeqCst);
        for attempt in 1..=bound {
            assert_eq!(scheduler.tick().await, Flow::Continue, "post-reset attempt {attempt}");
        }
        assert_eq!(scheduler.consecutive_selection_skips, bound);
        assert!(scheduler.halts.is_empty());

        // ...and the 61st halts: a halt, not an exit.
        assert_eq!(scheduler.tick().await, Flow::Halted);
        let halt = only_halt(&scheduler);
        assert_eq!(halt.reason, HaltReason::SelectionReadFailures);
        assert_eq!(halt.request_id, None);
    }

    #[tokio::test]
    async fn a_ready_queue_does_not_reset_the_count_when_the_snapshot_fails_in_the_same_tick() {
        let mode = Arc::new(AtomicUsize::new(0));
        let flag = mode.clone();
        let (base_url, _) = serve(handler(move |seen| {
            let current = flag.load(Ordering::SeqCst);
            match seen.path.as_str() {
                QUEUE_PATH if current == 2 => Some(("200 OK", "[]".to_owned())),
                QUEUE_PATH => Some(("200 OK", queue_row())),
                ROUTING_PATH if current == 1 => {
                    Some(("503 Service Unavailable", DATABASE_BUSY_BODY.to_owned()))
                }
                ROUTING_PATH => Some((
                    "500 Internal Server Error",
                    r#"{"error":"Internal server error."}"#.to_owned(),
                )),
                _ => None,
            }
        }))
        .await;
        let bound = MAX_CONSECUTIVE_SELECTION_READ_SKIPS;
        let mut scheduler = scheduler_for(base_url);
        for attempt in 1..bound {
            assert_eq!(scheduler.tick().await, Flow::Continue, "attempt {attempt}");
        }
        assert_eq!(scheduler.consecutive_selection_skips, bound - 1);
        // A busy snapshot after a ready queue keeps the count where it was.
        mode.store(1, Ordering::SeqCst);
        assert_eq!(scheduler.tick().await, Flow::Continue);
        assert_eq!(scheduler.consecutive_selection_skips, bound - 1);
        mode.store(0, Ordering::SeqCst);
        assert_eq!(scheduler.tick().await, Flow::Continue);
        assert_eq!(scheduler.tick().await, Flow::Halted);
        assert_eq!(only_halt(&scheduler).reason, HaltReason::SelectionReadFailures);
    }

    /// Runs the scheduler's whole loop for `duration`; it never returns by
    /// itself except with the startup exit.
    async fn run_for(scheduler: &mut Scheduler, duration: Duration) -> Option<anyhow::Error> {
        match tokio::time::timeout(duration, scheduler.run_loop()).await {
            Ok(Ok(never)) => match never {},
            Ok(Err(error)) => Some(error),
            Err(_) => None,
        }
    }

    fn state_body(open: usize, pending: u64, human: &[String], halts: &[(String, bool)]) -> String {
        let open_halts: Vec<serde_json::Value> = (0..open)
            .map(|_| {
                serde_json::json!({
                    "halt_id": Uuid::new_v4().to_string(),
                    "halt_key": Uuid::new_v4().to_string(),
                    "reason_code": "contract_violation",
                    "request_id": null,
                    "opened_at": "2026-09-30T00:00:00.000Z",
                })
            })
            .collect();
        serde_json::json!({
            "open_halt_count": open,
            "open_halts": open_halts,
            "pending_count": pending,
            "latest_deadline_at": if pending > 0 { serde_json::json!("2026-09-30T00:00:12.000Z") } else { serde_json::Value::Null },
            "retry_after_ms": if pending > 0 { serde_json::json!(1) } else { serde_json::Value::Null },
            "human_required_count": human.len(),
            "human_required": human.iter().map(|id| serde_json::json!({"request_id": id, "call_kind": "claim", "receipt_count": 1})).collect::<Vec<_>>(),
            "halts": halts.iter().map(|(key, cleared)| serde_json::json!({"halt_key": key, "halt_id": key, "cleared": cleared})).collect::<Vec<_>>(),
        })
        .to_string()
    }

    fn writes_or_reads(log: &Log) -> Vec<String> {
        log.lock()
            .unwrap()
            .iter()
            .filter(|seen| {
                [QUEUE_PATH, ROUTING_PATH, CLAIM_PATH, RECOVER_PATH, TICK_PATH]
                    .contains(&seen.path.as_str())
            })
            .map(|seen| seen.path.clone())
            .collect()
    }

    #[tokio::test]
    async fn startup_reads_the_halt_state_before_any_other_call_and_waits_while_it_is_unreadable() {
        let reads = Arc::new(AtomicUsize::new(0));
        let counter = reads.clone();
        let (base_url, log) = serve(handler(move |seen| {
            if seen.is("GET", HALT_PATH) {
                // The web has not deployed this version yet, then it is busy,
                // then the connection drops, then it answers.
                return Some(match counter.fetch_add(1, Ordering::SeqCst) {
                    0 => ("404 Not Found", "{}".to_owned()),
                    1 => ("503 Service Unavailable", DATABASE_BUSY_BODY.to_owned()),
                    2 => ("DROP", String::new()),
                    3 => ("500 Internal Server Error", "{}".to_owned()),
                    _ => ("200 OK", CLEAR_STATE.to_owned()),
                });
            }
            None
        }))
        .await;
        let mut scheduler = scheduler_for(base_url);
        assert!(run_for(&mut scheduler, Duration::from_millis(200)).await.is_none());
        let seen = log.lock().unwrap().clone();
        assert!(seen[0].is("GET", HALT_PATH), "the first call is the halt state read");
        let first_write = seen
            .iter()
            .position(|seen| seen.path != HALT_PATH)
            .expect("scheduling started once the state was readable");
        assert!(first_write >= 5, "no write or selection read while unreadable: {first_write}");
        assert!(seen[..first_write].iter().all(|seen| seen.is("GET", HALT_PATH)));
        assert!(scheduler.halts.is_empty(), "an unreadable state is not a halt");
    }

    #[tokio::test]
    async fn startup_does_not_schedule_while_an_unresolved_admission_exists() {
        // Section 6 and the completion list: a process that died after a
        // request and before its answer. The new process waits
        // (`awaiting_deadline`) while the server holds the admission
        // undecided; with nothing committed it then schedules.
        let reads = Arc::new(AtomicUsize::new(0));
        let counter = reads.clone();
        let (base_url, log) = serve(handler(move |seen| {
            seen.is("GET", HALT_PATH).then(|| {
                if counter.fetch_add(1, Ordering::SeqCst) < 4 {
                    ("200 OK", state_body(0, 1, &[], &[]))
                } else {
                    ("200 OK", CLEAR_STATE.to_owned())
                }
            })
        }))
        .await;
        let mut scheduler = scheduler_for(base_url);
        assert!(run_for(&mut scheduler, Duration::from_millis(300)).await.is_none());
        let seen = log.lock().unwrap().clone();
        let first_write = seen
            .iter()
            .position(|seen| seen.path != HALT_PATH)
            .expect("scheduling started once nothing was undecided");
        assert!(first_write >= 5, "{first_write}");
        assert!(seen[..first_write].iter().all(|seen| seen.is("GET", HALT_PATH)));
        assert!(scheduler.halts.is_empty());
    }

    #[tokio::test]
    async fn a_committed_write_of_a_dead_process_is_recorded_as_a_halt_and_waits_for_a_person() {
        // The same, with a receipt: the admission needs a person. Each such
        // request gets its `unacked_write_receipt` halt, keyed by the request
        // id, and the schedule does not start until a person clears it.
        let request = Uuid::new_v4().to_string();
        let cleared = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = cleared.clone();
        let key = request.clone();
        let (base_url, log) = serve(handler(move |seen| {
            if !seen.is("GET", HALT_PATH) {
                return None;
            }
            Some(if flag.load(Ordering::SeqCst) {
                ("200 OK", state_body(0, 0, &[], &[(key.clone(), true)]))
            } else if seen.query.contains(&key) {
                ("200 OK", state_body(1, 0, &[key.clone()], &[(key.clone(), false)]))
            } else {
                ("200 OK", state_body(0, 0, &[key.clone()], &[]))
            })
        }))
        .await;
        let mut scheduler = scheduler_for(base_url);
        assert!(run_for(&mut scheduler, Duration::from_millis(150)).await.is_none());
        assert!(writes_or_reads(&log).is_empty(), "nothing scheduled while a person is needed");
        let halt = only_halt(&scheduler);
        assert_eq!(halt.reason, HaltReason::UnackedWriteReceipt);
        assert_eq!(halt.halt_key.to_string(), request);
        let record = log
            .lock()
            .unwrap()
            .iter()
            .find(|seen| seen.is("POST", HALT_PATH))
            .unwrap()
            .json();
        assert_eq!(record["reason_code"], "unacked_write_receipt");
        assert_eq!(record["halt_key"], request.as_str());
        assert_eq!(record["request_id"], request.as_str());

        // A person clears it: the next read shows it cleared, and the
        // schedule starts.
        cleared.store(true, Ordering::SeqCst);
        assert!(run_for(&mut scheduler, Duration::from_millis(150)).await.is_none());
        assert!(scheduler.halts.is_empty());
        assert!(!writes_or_reads(&log).is_empty());
    }

    #[tokio::test]
    async fn an_open_halt_of_another_process_blocks_until_a_person_clears_it() {
        let cleared = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = cleared.clone();
        let (base_url, log) = serve(handler(move |seen| {
            seen.is("GET", HALT_PATH).then(|| {
                if flag.load(Ordering::SeqCst) {
                    ("200 OK", CLEAR_STATE.to_owned())
                } else {
                    ("200 OK", state_body(1, 0, &[], &[]))
                }
            })
        }))
        .await;
        let mut scheduler = scheduler_for(base_url);
        assert!(run_for(&mut scheduler, Duration::from_millis(100)).await.is_none());
        assert!(writes_or_reads(&log).is_empty());
        assert!(scheduler.halts.is_empty(), "another process's halt is not this one's");
        cleared.store(true, Ordering::SeqCst);
        assert!(run_for(&mut scheduler, Duration::from_millis(100)).await.is_none());
        assert!(!writes_or_reads(&log).is_empty());
    }

    #[tokio::test]
    async fn an_in_memory_halt_is_not_released_by_an_empty_read() {
        // Section 6: "빈 목록을 읽었다는 사실만으로는 사라지지 않는다". The server
        // says nothing is open and nothing is pending -- it has no row for the
        // halt at all -- and the schedule still does not resume.
        let cleared = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = cleared.clone();
        let halt_key = Uuid::new_v4();
        let key = halt_key.to_string();
        let (base_url, log) = serve(handler(move |seen| {
            if seen.is("POST", HALT_PATH) {
                // The record never reaches the server.
                return Some(("503 Service Unavailable", DATABASE_BUSY_BODY.to_owned()));
            }
            seen.is("GET", HALT_PATH).then(|| {
                if flag.load(Ordering::SeqCst) {
                    ("200 OK", state_body(0, 0, &[], &[(key.clone(), true)]))
                } else {
                    ("200 OK", CLEAR_STATE.to_owned())
                }
            })
        }))
        .await;
        let mut scheduler = scheduler_for(base_url);
        scheduler.halts.open(HaltReason::SelectionReadFailures, halt_key, None);
        let _ = tokio::time::timeout(Duration::from_millis(150), scheduler.await_resume(false)).await;
        assert!(writes_or_reads(&log).is_empty());
        assert_eq!(only_halt(&scheduler).halt_key, halt_key);
        // The record was sent again, with the same key, while it failed.
        let records: Vec<String> = log
            .lock()
            .unwrap()
            .iter()
            .filter(|seen| seen.is("POST", HALT_PATH))
            .map(|seen| seen.json()["halt_key"].as_str().unwrap().to_owned())
            .collect();
        assert!(records.len() >= 3, "{records:?}");
        assert!(records.iter().all(|record| *record == halt_key.to_string()));

        // Even a read that names it cleared does not release a halt that was
        // never recorded.
        cleared.store(true, Ordering::SeqCst);
        let _ = tokio::time::timeout(Duration::from_millis(80), scheduler.await_resume(false)).await;
        assert_eq!(scheduler.halts.halts().len(), 1);
    }

    #[tokio::test]
    async fn a_failed_record_is_sent_again_and_a_recorded_halt_is_released_by_reading_it_cleared() {
        // Sections 5 and 6: a record that failed (here a 404, the web not yet
        // on this version) keeps the halt in memory and is sent again with
        // the same key; once recorded, the halt goes only when a read shows
        // it cleared by a person.
        let cleared = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = cleared.clone();
        let halt_key = Uuid::new_v4();
        let key = halt_key.to_string();
        let records = Arc::new(AtomicUsize::new(0));
        let counter = records.clone();
        let (base_url, log) = serve(handler(move |seen| {
            if seen.is("POST", HALT_PATH) && counter.fetch_add(1, Ordering::SeqCst) == 0 {
                return Some(("404 Not Found", "{}".to_owned()));
            }
            seen.is("GET", HALT_PATH).then(|| {
                if flag.load(Ordering::SeqCst) {
                    ("200 OK", state_body(0, 0, &[], &[(key.clone(), true)]))
                } else {
                    ("200 OK", state_body(1, 0, &[], &[(key.clone(), false)]))
                }
            })
        }))
        .await;
        let mut scheduler = scheduler_for(base_url);
        scheduler.halts.open(HaltReason::SelectionReadFailures, halt_key, None);
        let _ = tokio::time::timeout(Duration::from_millis(80), scheduler.await_resume(false)).await;
        assert!(writes_or_reads(&log).is_empty());
        assert_eq!(scheduler.halts.halts()[0].halt_id.as_deref(), Some(halt_key.to_string().as_str()));
        let keys: std::collections::HashSet<String> = log
            .lock()
            .unwrap()
            .iter()
            .filter(|seen| seen.is("POST", HALT_PATH))
            .map(|seen| seen.json()["halt_key"].as_str().unwrap().to_owned())
            .collect();
        assert!(records.load(Ordering::SeqCst) >= 2);
        assert_eq!(keys.len(), 1, "the same key every time");
        // Each state read asks about the halt this process holds.
        assert!(log
            .lock()
            .unwrap()
            .iter()
            .filter(|seen| seen.is("GET", HALT_PATH))
            .all(|seen| seen.query == format!("halt_key={halt_key}")));

        cleared.store(true, Ordering::SeqCst);
        tokio::time::timeout(Duration::from_millis(200), scheduler.await_resume(false))
            .await
            .expect("resumes once the halt is read cleared");
        assert!(scheduler.halts.is_empty());
    }

    #[tokio::test]
    async fn run_loop_resets_the_selection_read_count_on_resume() {
        // The same rule through the loop itself: a count left at the bound by
        // a previous halt does not carry into the resumed schedule.
        let (base_url, _, _) = serve_queue_toggle().await;
        let mut scheduler = scheduler_for(base_url);
        scheduler.consecutive_selection_skips = MAX_CONSECUTIVE_SELECTION_READ_SKIPS;
        assert!(run_for(&mut scheduler, Duration::from_millis(40)).await.is_none());
        assert!(scheduler.halts.is_empty(), "the first failure after resume is not the 61st");
        assert!(scheduler.consecutive_selection_skips < MAX_CONSECUTIVE_SELECTION_READ_SKIPS);
    }

    #[tokio::test]
    async fn a_401_on_the_startup_state_read_exits_and_later_it_is_a_contract_violation() {
        let (base_url, log) = serve(handler(|seen| {
            seen.is("GET", HALT_PATH)
                .then(|| ("401 Unauthorized", r#"{"error":"Unauthorized"}"#.to_owned()))
        }))
        .await;
        let mut scheduler = scheduler_for(base_url);
        let error = run_for(&mut scheduler, Duration::from_millis(500)).await.expect("exits");
        assert_eq!(error.to_string(), "AMUX_HALT_STATE_UNAUTHORIZED");
        assert!(writes_or_reads(&log).is_empty());

        // After startup the same answer halts instead.
        let (base_url, _) = serve(handler(|seen| {
            seen.is("GET", HALT_PATH)
                .then(|| ("403 Forbidden", r#"{"error":"Forbidden"}"#.to_owned()))
        }))
        .await;
        let mut scheduler = scheduler_for(base_url);
        let _ = tokio::time::timeout(Duration::from_millis(50), scheduler.await_resume(false)).await;
        assert_eq!(only_halt(&scheduler).reason, HaltReason::ContractViolation);
    }

    #[tokio::test]
    async fn a_new_process_meets_the_same_unrecorded_condition_and_halts_again_counting_from_zero() {
        // Section 5's known limit: a `selection_read_failures` or
        // `contract_violation` halt that was never recorded is lost with its
        // process. A new process meeting the same condition halts again, and
        // its selection-read count starts at zero.
        let (base_url, _, log) = serve_queue_toggle().await;
        for process in 0..2 {
            let before = log
                .lock()
                .unwrap()
                .iter()
                .filter(|seen| seen.path == QUEUE_PATH)
                .count();
            let mut scheduler = scheduler_for(base_url.clone());
            let mut flow = Flow::Continue;
            while flow == Flow::Continue {
                flow = scheduler.tick().await;
            }
            assert_eq!(only_halt(&scheduler).reason, HaltReason::SelectionReadFailures);
            let reads = log
                .lock()
                .unwrap()
                .iter()
                .filter(|seen| seen.path == QUEUE_PATH)
                .count()
                - before;
            assert_eq!(reads as u32, MAX_CONSECUTIVE_SELECTION_READ_SKIPS + 1, "process {process}");
        }
    }

    #[test]
    fn the_scheduler_has_one_way_out_and_it_is_the_startup_state_read() {
        // Section 3: "3의 목록 밖에서는 0이 아닌 종료가 없다". Outside tests,
        // this file returns an error from exactly one place.
        let source = include_str!("scheduler.rs");
        let code = &source[..source.find("#[cfg(test)]\nmod tests").unwrap()];
        assert_eq!(code.matches("bail!(").count(), 1);
        assert!(code.contains(r#"anyhow::bail!("AMUX_HALT_STATE_UNAUTHORIZED");"#));
        assert!(!code.contains("return Err("));
        assert!(!code.contains(".await?"));
        assert!(!code.contains("std::process::exit"));
        assert!(code.contains("pub async fn run(mut self) -> Result<Infallible>"));
        // The exits the old loop had are gone.
        for code_name in [
            "AMUX_CLAIM_OUTCOME_UNKNOWN",
            "AMUX_RECOVERY_OUTCOME_UNKNOWN",
            "AMUX_INTERNAL_API_UNVERIFIED",
        ] {
            assert!(!code.contains(&format!("anyhow!(\"{code_name}\")")), "{code_name}");
        }
    }
}
