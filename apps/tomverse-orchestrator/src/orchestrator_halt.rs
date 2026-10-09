//! Orchestration policy version 20 ("orchestrator 정지(halt)와 재시작").
//!
//! docs/policy/development-agent-orchestration.md, version 20. The
//! orchestrator no longer ends its process on an answer it does not know.
//! Every write call (claim, recover, automatic promotion tick) carries a new
//! request id; a known answer is acknowledged to the server before the next
//! write; anything else is a halt, recorded in the app database and cleared
//! only by a person. This module holds the closed lists and every decision
//! that does not need the network, so each one is tested on its own:
//!
//! - which answers are known (section 1) and what they are acknowledged as;
//! - how the acknowledgement, the halt record and the halt state read are
//!   answered, and what each answer means for the process (sections 2, 4, 5);
//! - the in-memory halts of this process and the one condition under which
//!   the schedule starts or resumes (section 6).

use std::time::Duration;

use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use tokio::time::Instant;
use uuid::Uuid;

use crate::tomverse_api::{
    parse_claim_response_body, recovery_answer_is_valid, tick_answer_is_valid,
    AutoPromotionTickResponse, ClaimResponse, ExecutionRecoveryResponse, RawAnswer,
};

/// Section 2: the closed list of halt reasons, the same six the server's CHECK
/// constraint and lib/amux/orchestratorHaltCore.ts hold
/// (tests/amuxOrchestratorHaltCore.test.mjs reads this file).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HaltReason {
    ClaimOutcomeUnknown,
    RecoveryOutcomeUnknown,
    PromotionOutcomeUnknown,
    UnackedWriteReceipt,
    ContractViolation,
    SelectionReadFailures,
}

impl HaltReason {
    pub const ALL: [Self; 6] = [
        Self::ClaimOutcomeUnknown,
        Self::RecoveryOutcomeUnknown,
        Self::PromotionOutcomeUnknown,
        Self::UnackedWriteReceipt,
        Self::ContractViolation,
        Self::SelectionReadFailures,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ClaimOutcomeUnknown => "claim_outcome_unknown",
            Self::RecoveryOutcomeUnknown => "recovery_outcome_unknown",
            Self::PromotionOutcomeUnknown => "promotion_outcome_unknown",
            Self::UnackedWriteReceipt => "unacked_write_receipt",
            Self::ContractViolation => "contract_violation",
            Self::SelectionReadFailures => "selection_read_failures",
        }
    }

    /// The first four are about one write call: their halt key is that call's
    /// request id, and the server may hold its admission (section 5).
    pub const fn has_request(self) -> bool {
        matches!(
            self,
            Self::ClaimOutcomeUnknown
                | Self::RecoveryOutcomeUnknown
                | Self::PromotionOutcomeUnknown
                | Self::UnackedWriteReceipt
        )
    }
}

/// Section 2: the three waiting states that are not stored halts. None of them
/// is recorded, and during each of them no write call and no selection read
/// is made.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitState {
    AckPending,
    HaltUnreadable,
    AwaitingDeadline,
}

impl WaitState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AckPending => "ack_pending",
            Self::HaltUnreadable => "halt_unreadable",
            Self::AwaitingDeadline => "awaiting_deadline",
        }
    }
}

/// The three write calls (section 4, "쓰기 호출").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallKind {
    Claim,
    Recover,
    AutoPromotionTick,
}

impl CallKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Claim => "claim",
            Self::Recover => "recover",
            Self::AutoPromotionTick => "auto_promotion_tick",
        }
    }

    /// The halt for an answer to this call that is not a known one.
    pub const fn unknown_outcome(self) -> HaltReason {
        match self {
            Self::Claim => HaltReason::ClaimOutcomeUnknown,
            Self::Recover => HaltReason::RecoveryOutcomeUnknown,
            Self::AutoPromotionTick => HaltReason::PromotionOutcomeUnknown,
        }
    }
}

/// Section 4: `definite` for a 2xx or a 409 refusal, `no_commit` for the three
/// 503 reasons only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AckKind {
    Definite,
    NoCommit,
}

impl AckKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Definite => "definite",
            Self::NoCommit => "no_commit",
        }
    }
}

/// Section 1: the 503 reasons that mean "this request committed nothing". The
/// server stops sending them once a receipt of the request has committed.
pub const NOTHING_COMMITTED_REASONS: [&str; 3] = [
    "amux_database_busy",
    "amux_database_deadline_exceeded",
    "amux_database_call_ceiling_exceeded",
];

/// The `{error, reason}` body every AMUX internal route answers a failure
/// with (lib/amux/internalRoute.ts). Anything more or less is not it.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReasonBody {
    #[allow(dead_code)]
    error: String,
    reason: String,
}

/// Which of the three "nothing committed" answers this is, if it is exactly
/// one: 503 and the exact `{error, reason}` body.
pub fn nothing_committed_reason(status: StatusCode, body: &[u8]) -> Option<&'static str> {
    if status != StatusCode::SERVICE_UNAVAILABLE {
        return None;
    }
    let body: ReasonBody = serde_json::from_slice(body).ok()?;
    NOTHING_COMMITTED_REASONS
        .iter()
        .copied()
        .find(|reason| *reason == body.reason)
}

/// A short, secret-free label for a status that was not a known answer. Never
/// the body or the URL.
pub fn status_class(status: StatusCode) -> &'static str {
    if status.is_server_error() {
        "http_5xx"
    } else if status == StatusCode::TOO_MANY_REQUESTS {
        "http_429"
    } else if status == StatusCode::NOT_FOUND {
        "http_404"
    } else if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        "http_401_403"
    } else if status.is_client_error() {
        "http_4xx"
    } else if status.is_success() {
        "http_2xx_body"
    } else {
        "http_other"
    }
}

/// What one write call's answer is (section 1).
#[derive(Debug, PartialEq)]
pub enum WriteAnswer<T> {
    /// A 2xx or 409 whose body is the contract's: acknowledged `definite`.
    Definite(T),
    /// One of the three 503 reasons: acknowledged `no_commit`.
    NothingCommitted(&'static str),
    /// Anything else, including no answer at all: a halt, never acknowledged.
    Unknown(&'static str),
}

/// Claim: a 2xx the current parser reads (the 200 `{claimed:false}` of a lost
/// CAS included) or a 409 with a closed refusal reason.
pub fn classify_claim(answer: &RawAnswer) -> WriteAnswer<ClaimResponse> {
    if let Some(reason) = nothing_committed_reason(answer.status, &answer.body) {
        return WriteAnswer::NothingCommitted(reason);
    }
    if answer.status == StatusCode::OK || answer.status == StatusCode::CONFLICT {
        return match parse_claim_response_body(answer.status, &answer.body) {
            Ok(outcome) => WriteAnswer::Definite(outcome),
            Err(_) => WriteAnswer::Unknown("claim_body"),
        };
    }
    WriteAnswer::Unknown(status_class(answer.status))
}

/// Recover: a 2xx the current parser reads, or its 409 `execution_api_disabled`.
pub fn classify_recover(answer: &RawAnswer) -> WriteAnswer<ExecutionRecoveryResponse> {
    if let Some(reason) = nothing_committed_reason(answer.status, &answer.body) {
        return WriteAnswer::NothingCommitted(reason);
    }
    if answer.status == StatusCode::OK || answer.status == StatusCode::CONFLICT {
        return match serde_json::from_slice::<ExecutionRecoveryResponse>(&answer.body) {
            Ok(body) if recovery_answer_is_valid(answer.status, &body) => WriteAnswer::Definite(body),
            _ => WriteAnswer::Unknown("recover_body"),
        };
    }
    WriteAnswer::Unknown(status_class(answer.status))
}

/// Automatic promotion tick: a 200 the parser reads, whatever its reason, and
/// the 409 `apply_disabled`. Its 409 `outcome_unknown` and
/// `expiry_outcome_unknown` are not known answers.
pub fn classify_tick(answer: &RawAnswer) -> WriteAnswer<AutoPromotionTickResponse> {
    if let Some(reason) = nothing_committed_reason(answer.status, &answer.body) {
        return WriteAnswer::NothingCommitted(reason);
    }
    if answer.status == StatusCode::OK || answer.status == StatusCode::CONFLICT {
        return match serde_json::from_slice::<AutoPromotionTickResponse>(&answer.body) {
            Ok(body) if tick_answer_is_valid(answer.status, &body) => WriteAnswer::Definite(body),
            _ => WriteAnswer::Unknown("tick_body"),
        };
    }
    WriteAnswer::Unknown(status_class(answer.status))
}

#[derive(Debug, Serialize)]
pub struct AckRequest {
    pub request_id: String,
    pub kind: &'static str,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AckBody {
    acked: bool,
    #[serde(default)]
    reason: Option<String>,
}

/// How an acknowledgement was answered (section 4).
#[derive(Debug, PartialEq, Eq)]
pub enum AckAnswer {
    Acked,
    /// The closed refusal: the orchestrator halts `unacked_write_receipt`.
    Refused,
    /// No answer, a transport failure, a 5xx, a 404 or a 429: the ack alone is
    /// sent again, every 30 seconds, and no other call is made meanwhile.
    Retry(&'static str),
    /// A 2xx, 400 or 409 outside the contract, or 401 or 403 (section 2).
    ContractViolation(&'static str),
}

pub fn classify_ack(answer: &RawAnswer) -> AckAnswer {
    match answer.status {
        StatusCode::OK => match serde_json::from_slice::<AckBody>(&answer.body) {
            Ok(AckBody {
                acked: true,
                reason: None,
            }) => AckAnswer::Acked,
            _ => AckAnswer::ContractViolation("ack_body"),
        },
        StatusCode::CONFLICT => match serde_json::from_slice::<AckBody>(&answer.body) {
            Ok(AckBody {
                acked: false,
                reason: Some(reason),
            }) if reason == "receipts_present" || reason == "not_admitted" => AckAnswer::Refused,
            _ => AckAnswer::ContractViolation("ack_body"),
        },
        status if retry_status(status) => AckAnswer::Retry(status_class(status)),
        status => AckAnswer::ContractViolation(status_class(status)),
    }
}

/// Statuses that say the call did not get through, not that it was refused:
/// sent again (the ack, the halt record) or waited on (the halt state read).
fn retry_status(status: StatusCode) -> bool {
    status.is_server_error()
        || status == StatusCode::NOT_FOUND
        || status == StatusCode::TOO_MANY_REQUESTS
}

#[derive(Debug, Serialize)]
pub struct HaltRecordRequest {
    pub halt_key: String,
    pub reason_code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HaltRecordBody {
    halt_id: String,
    halt_key: String,
    reason_code: String,
    request_id: Option<String>,
    #[allow(dead_code)]
    opened_at: String,
    #[allow(dead_code)]
    cleared: bool,
    #[allow(dead_code)]
    created: bool,
}

/// How a halt record was answered (section 5).
#[derive(Debug, PartialEq, Eq)]
pub enum RecordAnswer {
    Recorded { halt_id: String },
    /// Kept in memory and sent again, with the same halt key, every 30 seconds.
    Retry(&'static str),
    ContractViolation(&'static str),
}

pub fn classify_record(answer: &RawAnswer, halt_key: Uuid) -> RecordAnswer {
    match answer.status {
        StatusCode::OK => match serde_json::from_slice::<HaltRecordBody>(&answer.body) {
            Ok(body)
                if body.halt_key == halt_key.to_string()
                    && Uuid::parse_str(&body.halt_id).is_ok()
                    && HaltReason::ALL
                        .iter()
                        .any(|reason| reason.as_str() == body.reason_code)
                    && body
                        .request_id
                        .as_deref()
                        .is_none_or(|value| value == body.halt_key) =>
            {
                RecordAnswer::Recorded {
                    halt_id: body.halt_id,
                }
            }
            _ => RecordAnswer::ContractViolation("record_body"),
        },
        status if retry_status(status) => RecordAnswer::Retry(status_class(status)),
        status => RecordAnswer::ContractViolation(status_class(status)),
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenHalt {
    pub halt_id: String,
    pub halt_key: String,
    pub reason_code: String,
    pub request_id: Option<String>,
    pub opened_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HumanRequired {
    pub request_id: String,
    pub call_kind: String,
    pub receipt_count: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KeyedHalt {
    pub halt_key: String,
    pub halt_id: String,
    pub cleared: bool,
}

/// `GET /api/internal/amux/orchestrator/halt`, after the server has applied
/// its resolver (section 5).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HaltState {
    pub open_halt_count: u64,
    pub open_halts: Vec<OpenHalt>,
    pub pending_count: u64,
    pub latest_deadline_at: Option<String>,
    pub retry_after_ms: Option<u64>,
    pub human_required_count: u64,
    pub human_required: Vec<HumanRequired>,
    pub halts: Vec<KeyedHalt>,
}

/// The invariants the gate relies on. A body that breaks one is a contract
/// violation, never a reason to resume.
pub fn halt_state_is_valid(state: &HaltState) -> bool {
    let uuid = |value: &str| Uuid::parse_str(value).is_ok();
    (state.open_halts.len() as u64) <= state.open_halt_count
        && (state.human_required.len() as u64) <= state.human_required_count
        && (state.open_halts.is_empty() == (state.open_halt_count == 0))
        && (state.human_required.is_empty() == (state.human_required_count == 0))
        && ((state.pending_count > 0) == state.retry_after_ms.is_some())
        && ((state.pending_count > 0) == state.latest_deadline_at.is_some())
        && state.open_halts.iter().all(|halt| {
            uuid(&halt.halt_id)
                && uuid(&halt.halt_key)
                && HaltReason::ALL
                    .iter()
                    .any(|reason| reason.as_str() == halt.reason_code)
        })
        && state.human_required.iter().all(|row| {
            uuid(&row.request_id)
                && row.receipt_count >= 1
                && ["claim", "recover", "auto_promotion_tick"].contains(&row.call_kind.as_str())
        })
        && state
            .halts
            .iter()
            .all(|halt| uuid(&halt.halt_key) && uuid(&halt.halt_id))
}

/// How a halt state read was answered (sections 5 and 6).
#[derive(Debug)]
pub enum StateAnswer {
    State(HaltState),
    /// A transport failure, any 5xx (the busy 503 included), 404 (the web has
    /// not deployed this version yet) or 429: `halt_unreadable`, read again in
    /// 30 seconds.
    Unreadable(&'static str),
    /// 401 or 403: at startup a configuration error and the one exit this
    /// version keeps (section 3); later a contract violation.
    Unauthorized,
    ContractViolation(&'static str),
}

pub fn classify_state(answer: &RawAnswer) -> StateAnswer {
    match answer.status {
        StatusCode::OK => match serde_json::from_slice::<HaltState>(&answer.body) {
            Ok(state) if halt_state_is_valid(&state) => StateAnswer::State(state),
            _ => StateAnswer::ContractViolation("state_body"),
        },
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => StateAnswer::Unauthorized,
        status if retry_status(status) => StateAnswer::Unreadable(status_class(status)),
        status => StateAnswer::ContractViolation(status_class(status)),
    }
}

/// One halt this process opened. It stays until a state read shows it
/// recorded and cleared by a person (section 6: "빈 목록을 읽었다는 사실만으로는
/// 사라지지 않는다").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryHalt {
    pub reason: HaltReason,
    pub halt_key: Uuid,
    pub request_id: Option<Uuid>,
    /// The server's halt id once the record has been answered.
    pub halt_id: Option<String>,
}

/// The halts this process holds in memory.
#[derive(Debug, Default)]
pub struct HaltBook {
    halts: Vec<MemoryHalt>,
}

/// How many halt keys one state read asks about (the route's own limit).
pub const MAX_HALT_KEYS_PER_READ: usize = 16;

impl HaltBook {
    pub fn is_empty(&self) -> bool {
        self.halts.is_empty()
    }

    pub fn halts(&self) -> &[MemoryHalt] {
        &self.halts
    }

    /// Opens a halt under `halt_key`. A second halt under a key already held
    /// is the same halt, so nothing is added.
    pub fn open(&mut self, reason: HaltReason, halt_key: Uuid, request_id: Option<Uuid>) {
        if self.halts.iter().any(|halt| halt.halt_key == halt_key) {
            return;
        }
        self.halts.push(MemoryHalt {
            reason,
            halt_key,
            request_id,
            halt_id: None,
        });
    }

    /// Opens a `contract_violation` halt unless one is already held: a
    /// repeated violation (a server that keeps answering outside the
    /// contract) is one halt for a person, not one every 30 seconds.
    pub fn open_contract_violation(&mut self) {
        if self
            .halts
            .iter()
            .any(|halt| halt.reason == HaltReason::ContractViolation)
        {
            return;
        }
        self.open(HaltReason::ContractViolation, Uuid::new_v4(), None);
    }

    pub fn unrecorded(&self) -> Vec<MemoryHalt> {
        self.halts
            .iter()
            .filter(|halt| halt.halt_id.is_none())
            .cloned()
            .collect()
    }

    pub fn mark_recorded(&mut self, halt_key: Uuid, halt_id: String) {
        if let Some(halt) = self.halts.iter_mut().find(|halt| halt.halt_key == halt_key) {
            halt.halt_id = Some(halt_id);
        }
    }

    /// The keys a state read asks about, oldest first.
    pub fn keys_to_read(&self) -> Vec<Uuid> {
        self.halts
            .iter()
            .take(MAX_HALT_KEYS_PER_READ)
            .map(|halt| halt.halt_key)
            .collect()
    }

    /// Releases every halt this process recorded that the read shows cleared
    /// by a person. An unrecorded halt, and a key the read does not report,
    /// stay. Returns how many were released.
    pub fn release_cleared(&mut self, state: &HaltState) -> usize {
        let before = self.halts.len();
        self.halts.retain(|halt| {
            let Some(halt_id) = halt.halt_id.as_deref() else {
                return true;
            };
            !state.halts.iter().any(|read| {
                read.cleared && read.halt_key == halt.halt_key.to_string() && read.halt_id == halt_id
            })
        });
        before - self.halts.len()
    }
}

/// Section 6, the one sentence: the schedule starts or resumes only when this
/// process holds no halt in memory, and a successful state read shows no open
/// halt, no undecided admission and no request needing a person. Every halt
/// this process recorded is released only on reading it cleared, so an empty
/// book means each of them has its human clear.
pub fn resume_permitted(book: &HaltBook, state: &HaltState) -> bool {
    book.is_empty()
        && state.open_halt_count == 0
        && state.pending_count == 0
        && state.human_required_count == 0
}

/// What the process does after a successful state read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    Resume,
    /// Only undecided admissions stand in the way: read again once the latest
    /// deadline plus five seconds has passed.
    AwaitDeadline(Duration),
    Halted,
}

/// The shortest and longest wait for undecided admissions. The server's own
/// answer decides the wait; these only keep a bad value from spinning or from
/// sleeping for good.
pub const AWAITING_DEADLINE_FLOOR: Duration = Duration::from_secs(5);
pub const AWAITING_DEADLINE_CEILING: Duration = Duration::from_secs(60);

pub fn gate(book: &HaltBook, state: &HaltState) -> Gate {
    if resume_permitted(book, state) {
        return Gate::Resume;
    }
    if book.is_empty() && state.open_halt_count == 0 && state.human_required_count == 0 {
        // The server's own figure: its clock, its latest deadline plus the
        // grace. The scheduler bounds it (`AWAITING_DEADLINE_FLOOR`,
        // `AWAITING_DEADLINE_CEILING`) before it sleeps.
        return Gate::AwaitDeadline(Duration::from_millis(state.retry_after_ms.unwrap_or(0)));
    }
    Gate::Halted
}

/// One ERROR line every five minutes while halted or waiting (section 2).
#[derive(Debug, Default)]
pub struct ErrorLogClock {
    last: Option<Instant>,
}

impl ErrorLogClock {
    pub fn due(&mut self, now: Instant, every: Duration) -> bool {
        let due = self
            .last
            .is_none_or(|last| now.saturating_duration_since(last) >= every);
        if due {
            self.last = Some(now);
        }
        due
    }

    pub fn reset(&mut self) {
        self.last = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(status: u16, body: &str) -> RawAnswer {
        RawAnswer {
            status: StatusCode::from_u16(status).unwrap(),
            body: body.as_bytes().to_vec(),
        }
    }

    const BUSY: &str = r#"{"error":"AMUX database is busy.","reason":"amux_database_busy"}"#;
    const DEADLINE: &str =
        r#"{"error":"AMUX database deadline exceeded.","reason":"amux_database_deadline_exceeded"}"#;
    const CEILING: &str =
        r#"{"error":"AMUX database call ceiling exceeded.","reason":"amux_database_call_ceiling_exceeded"}"#;
    const UNKNOWN: &str = r#"{"error":"AMUX database outcome is unknown.","reason":"amux_outcome_unknown","incident_id":"0b8e9a52-6d8c-4f0e-9b1a-2c3d4e5f6a7b"}"#;

    #[test]
    fn the_halt_reasons_are_the_closed_list_of_section_2() {
        let names: Vec<_> = HaltReason::ALL.iter().map(|reason| reason.as_str()).collect();
        assert_eq!(
            names,
            [
                "claim_outcome_unknown",
                "recovery_outcome_unknown",
                "promotion_outcome_unknown",
                "unacked_write_receipt",
                "contract_violation",
                "selection_read_failures",
            ]
        );
        let with_request: Vec<_> = HaltReason::ALL
            .iter()
            .filter(|reason| reason.has_request())
            .map(|reason| reason.as_str())
            .collect();
        assert_eq!(with_request, &names[..4]);
        assert_eq!(WaitState::AckPending.as_str(), "ack_pending");
        assert_eq!(WaitState::HaltUnreadable.as_str(), "halt_unreadable");
        assert_eq!(WaitState::AwaitingDeadline.as_str(), "awaiting_deadline");
    }

    #[test]
    fn exactly_the_three_503_reasons_say_nothing_was_committed() {
        for (body, reason) in [
            (BUSY, "amux_database_busy"),
            (DEADLINE, "amux_database_deadline_exceeded"),
            (CEILING, "amux_database_call_ceiling_exceeded"),
        ] {
            assert_eq!(
                nothing_committed_reason(StatusCode::SERVICE_UNAVAILABLE, body.as_bytes()),
                Some(reason)
            );
            // Any other status with the same body is not the answer.
            for status in [StatusCode::INTERNAL_SERVER_ERROR, StatusCode::CONFLICT, StatusCode::OK] {
                assert_eq!(nothing_committed_reason(status, body.as_bytes()), None);
            }
        }
        for body in [
            UNKNOWN,
            r#"{"reason":"amux_database_busy"}"#,
            r#"{"error":"x","reason":"amux_database_busy","extra":1}"#,
            r#"{"error":"x","reason":"amux_commit_check_missing"}"#,
            "not json",
        ] {
            assert_eq!(
                nothing_committed_reason(StatusCode::SERVICE_UNAVAILABLE, body.as_bytes()),
                None,
                "{body}"
            );
        }
    }

    #[test]
    fn every_known_claim_answer_is_definite_or_nothing_committed() {
        assert_eq!(
            classify_claim(&raw(200, r#"{"claimed":true,"revision":4,"decision_id":"c123456789012345678901234"}"#)),
            WriteAnswer::Definite(ClaimResponse::Claimed {
                revision: 4,
                decision_id: "c123456789012345678901234".into()
            })
        );
        assert_eq!(
            classify_claim(&raw(200, r#"{"claimed":false}"#)),
            WriteAnswer::Definite(ClaimResponse::CasLost)
        );
        for reason in crate::tomverse_api::ClaimRefusalReason::CLOSED {
            let body = format!(r#"{{"claimed":false,"reason":"{}"}}"#, reason.as_str());
            assert!(matches!(
                classify_claim(&raw(409, &body)),
                WriteAnswer::Definite(ClaimResponse::Refused { .. })
            ));
        }
        for (body, reason) in [
            (BUSY, "amux_database_busy"),
            (DEADLINE, "amux_database_deadline_exceeded"),
            (CEILING, "amux_database_call_ceiling_exceeded"),
        ] {
            assert_eq!(classify_claim(&raw(503, body)), WriteAnswer::NothingCommitted(reason));
        }
    }

    #[test]
    fn a_claim_answer_outside_section_1_is_unknown() {
        // The completion list's examples: a 500 with an incident id, the
        // missing-commit-check 503, a 429, a duplicate request, and a refusal
        // reason nobody reviewed.
        for (status, body) in [
            (500, r#"{"error":"Internal server error.","incident_id":"0b8e9a52-6d8c-4f0e-9b1a-2c3d4e5f6a7b"}"#),
            (503, r#"{"error":"AMUX database commit check is missing.","reason":"amux_commit_check_missing","incident_id":"x"}"#),
            (503, UNKNOWN),
            (429, r#"{"error":"Too Many Requests"}"#),
            (409, r#"{"error":"Duplicate request.","reason":"duplicate_request"}"#),
            (409, r#"{"claimed":false,"reason":"future_unreviewed_reason"}"#),
            (400, r#"{"error":"Invalid request."}"#),
            (401, r#"{"error":"Unauthorized"}"#),
            (200, "not json"),
        ] {
            assert!(
                matches!(classify_claim(&raw(status, body)), WriteAnswer::Unknown(_)),
                "{status} {body}"
            );
        }
    }

    #[test]
    fn recover_knows_its_2xx_and_only_the_execution_api_disabled_409() {
        assert!(matches!(
            classify_recover(&raw(
                200,
                r#"{"recovered":true,"reclaimed":1,"reclaimed_claims":0,"quota_observations_deleted":3,"more":false}"#
            )),
            WriteAnswer::Definite(_)
        ));
        // Even after the quota sweep deleted rows: the answer confirms it.
        assert!(matches!(
            classify_recover(&raw(
                409,
                r#"{"recovered":false,"reason":"execution_api_disabled","quota_observations_deleted":5}"#
            )),
            WriteAnswer::Definite(_)
        ));
        assert!(matches!(
            classify_recover(&raw(503, DEADLINE)),
            WriteAnswer::NothingCommitted("amux_database_deadline_exceeded")
        ));
        for (status, body) in [
            (409, r#"{"recovered":false,"reason":"other","quota_observations_deleted":5}"#),
            (500, r#"{"error":"Internal server error."}"#),
            (503, UNKNOWN),
            (200, r#"{"recovered":true,"reason":"x"}"#),
        ] {
            assert!(
                matches!(classify_recover(&raw(status, body)), WriteAnswer::Unknown(_)),
                "{status} {body}"
            );
        }
    }

    #[test]
    fn the_tick_knows_every_200_reason_and_only_the_apply_disabled_409() {
        for body in [
            r#"{"promoted":false,"reason":"no_grant","expired":0}"#,
            r#"{"promoted":false,"reason":"graduation_unmet","expired":2}"#,
            r#"{"promoted":false,"reason":"route_budget_exhausted","expired":1}"#,
            r#"{"promoted":false,"reason":"auto_halted","expired":0}"#,
            r#"{"promoted":true,"consumption_id":"7b1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d","expired":0}"#,
            r#"{"promoted":true,"policy_version":22,"receipt_id":"7b1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d","task_id":"TASK-1"}"#,
            r#"{"promoted":false,"policy_version":22,"reason":"no_candidate"}"#,
            r#"{"promoted":false,"claimed":true,"policy_version":22,"assignment_id":"7b1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d","task_id":"TASK-1","worker_name":"worker-one"}"#,
        ] {
            assert!(matches!(classify_tick(&raw(200, body)), WriteAnswer::Definite(_)), "{body}");
        }
        assert!(matches!(
            classify_tick(&raw(409, r#"{"promoted":false,"reason":"apply_disabled","expired":0}"#)),
            WriteAnswer::Definite(_)
        ));
        for (status, body) in [
            (409, r#"{"promoted":false,"reason":"outcome_unknown","expired":0}"#),
            (409, r#"{"promoted":false,"reason":"expiry_outcome_unknown","expired":1}"#),
            (500, r#"{"promoted":false,"reason":"audit_unbound","expired":0}"#),
            (503, r#"{"promoted":false,"reason":"audit_key_missing","expired":0}"#),
            (200, r#"{"promoted":true,"expired":0}"#),
            (200, r#"{"promoted":false,"reason":"no_grant","expired":-1}"#),
            (200, r#"{"promoted":true,"policy_version":22,"consumption_id":"legacy"}"#),
            (200, r#"{"promoted":false,"claimed":true,"policy_version":22,"task_id":"TASK-1"}"#),
            (409, r#"{"promoted":false,"policy_version":22,"reason":"outcome_unknown"}"#),
        ] {
            assert!(
                matches!(classify_tick(&raw(status, body)), WriteAnswer::Unknown(_)),
                "{status} {body}"
            );
        }
    }

    #[test]
    fn an_acknowledgement_is_acked_refused_retried_or_a_contract_violation() {
        assert_eq!(classify_ack(&raw(200, r#"{"acked":true}"#)), AckAnswer::Acked);
        assert_eq!(
            classify_ack(&raw(409, r#"{"acked":false,"reason":"receipts_present"}"#)),
            AckAnswer::Refused
        );
        assert_eq!(
            classify_ack(&raw(409, r#"{"acked":false,"reason":"not_admitted"}"#)),
            AckAnswer::Refused
        );
        for status in [500, 502, 503, 404, 429] {
            assert!(matches!(classify_ack(&raw(status, BUSY)), AckAnswer::Retry(_)), "{status}");
        }
        for (status, body) in [
            (200, r#"{"acked":false}"#),
            (200, r#"{"acked":true,"extra":1}"#),
            (409, r#"{"acked":false,"reason":"other"}"#),
            (400, r#"{"error":"Invalid request."}"#),
            (401, "{}"),
            (403, "{}"),
        ] {
            assert!(
                matches!(classify_ack(&raw(status, body)), AckAnswer::ContractViolation(_)),
                "{status} {body}"
            );
        }
    }

    const KEY: &str = "0b8e9a52-6d8c-4f0e-9b1a-2c3d4e5f6a7b";
    const HALT_ID: &str = "1c9f0b63-7e9d-4a1f-8c2b-3d4e5f6a7b8c";

    #[test]
    fn a_halt_record_is_recorded_only_for_its_own_key() {
        let key = Uuid::parse_str(KEY).unwrap();
        let body = format!(
            r#"{{"halt_id":"{HALT_ID}","halt_key":"{KEY}","reason_code":"claim_outcome_unknown","request_id":"{KEY}","opened_at":"2026-09-30T00:00:00.000Z","cleared":false,"created":true}}"#
        );
        assert_eq!(
            classify_record(&raw(200, &body), key),
            RecordAnswer::Recorded {
                halt_id: HALT_ID.into()
            }
        );
        assert!(matches!(
            classify_record(&raw(200, &body), Uuid::new_v4()),
            RecordAnswer::ContractViolation(_)
        ));
        for status in [404, 500, 503, 429] {
            assert!(matches!(classify_record(&raw(status, "{}"), key), RecordAnswer::Retry(_)));
        }
        for status in [400, 401, 403, 409] {
            assert!(matches!(
                classify_record(&raw(status, "{}"), key),
                RecordAnswer::ContractViolation(_)
            ));
        }
    }

    fn state_json(open: usize, pending: u64, human: usize, halts: &str) -> String {
        let open_halts: Vec<String> = (0..open)
            .map(|_| {
                format!(
                    r#"{{"halt_id":"{}","halt_key":"{}","reason_code":"contract_violation","request_id":null,"opened_at":"2026-09-30T00:00:00.000Z"}}"#,
                    Uuid::new_v4(),
                    Uuid::new_v4()
                )
            })
            .collect();
        let human_rows: Vec<String> = (0..human)
            .map(|_| {
                format!(
                    r#"{{"request_id":"{}","call_kind":"claim","receipt_count":2}}"#,
                    Uuid::new_v4()
                )
            })
            .collect();
        let (latest, retry) = if pending > 0 {
            (r#""2026-09-30T00:00:12.000Z""#, "7000")
        } else {
            ("null", "null")
        };
        format!(
            r#"{{"open_halt_count":{open},"open_halts":[{}],"pending_count":{pending},"latest_deadline_at":{latest},"retry_after_ms":{retry},"human_required_count":{human},"human_required":[{}],"halts":[{halts}]}}"#,
            open_halts.join(","),
            human_rows.join(",")
        )
    }

    pub(crate) fn state(open: usize, pending: u64, human: usize, halts: &str) -> HaltState {
        match classify_state(&raw(200, &state_json(open, pending, human, halts))) {
            StateAnswer::State(state) => state,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_state_read_is_a_state_unreadable_unauthorized_or_a_contract_violation() {
        assert!(matches!(
            classify_state(&raw(200, &state_json(0, 0, 0, ""))),
            StateAnswer::State(_)
        ));
        for status in [404, 500, 502, 503, 429] {
            assert!(matches!(classify_state(&raw(status, BUSY)), StateAnswer::Unreadable(_)), "{status}");
        }
        for status in [401, 403] {
            assert!(matches!(classify_state(&raw(status, "{}")), StateAnswer::Unauthorized));
        }
        for (status, body) in [
            (200, "not json".to_owned()),
            (200, state_json(0, 0, 0, "").replace(r#""pending_count":0"#, r#""pending_count":1"#)),
            (200, state_json(1, 0, 0, "").replace(r#""open_halt_count":1"#, r#""open_halt_count":0"#)),
            (400, "{}".to_owned()),
            (409, "{}".to_owned()),
        ] {
            assert!(
                matches!(classify_state(&raw(status, &body)), StateAnswer::ContractViolation(_)),
                "{status} {body}"
            );
        }
    }

    #[test]
    fn each_clause_of_the_resume_sentence_blocks_the_schedule_on_its_own() {
        let empty = HaltBook::default();
        assert_eq!(gate(&empty, &state(0, 0, 0, "")), Gate::Resume);
        // An open halt, of this process or another.
        assert_eq!(gate(&empty, &state(1, 0, 0, "")), Gate::Halted);
        // A request a person has to confirm.
        assert_eq!(gate(&empty, &state(0, 0, 1, "")), Gate::Halted);
        // An undecided admission: wait for its deadline, then read again.
        assert_eq!(gate(&empty, &state(0, 1, 0, "")), Gate::AwaitDeadline(Duration::from_secs(7)));
        // A halt in memory, even one the server has never heard of.
        let mut book = HaltBook::default();
        book.open(HaltReason::SelectionReadFailures, Uuid::new_v4(), None);
        assert_eq!(gate(&book, &state(0, 0, 0, "")), Gate::Halted);
        assert!(!resume_permitted(&book, &state(0, 0, 0, "")));
    }

    #[test]
    fn a_memory_halt_is_released_only_by_reading_it_recorded_and_cleared() {
        let key = Uuid::parse_str(KEY).unwrap();
        let mut book = HaltBook::default();
        book.open(HaltReason::ClaimOutcomeUnknown, key, Some(key));
        // Opening the same key again is the same halt.
        book.open(HaltReason::UnackedWriteReceipt, key, Some(key));
        assert_eq!(book.halts().len(), 1);

        // Not yet recorded: a read that says it is cleared still does not
        // release it, and neither does an empty read.
        let cleared = format!(r#"{{"halt_key":"{KEY}","halt_id":"{HALT_ID}","cleared":true}}"#);
        assert_eq!(book.release_cleared(&state(0, 0, 0, &cleared)), 0);
        assert_eq!(book.release_cleared(&state(0, 0, 0, "")), 0);

        book.mark_recorded(key, HALT_ID.into());
        assert_eq!(book.release_cleared(&state(0, 0, 0, "")), 0, "an empty read releases nothing");
        let open = format!(r#"{{"halt_key":"{KEY}","halt_id":"{HALT_ID}","cleared":false}}"#);
        assert_eq!(book.release_cleared(&state(0, 0, 0, &open)), 0);
        assert!(!book.is_empty());
        assert_eq!(book.release_cleared(&state(0, 0, 0, &cleared)), 1);
        assert!(book.is_empty());
    }

    #[test]
    fn repeated_contract_violations_are_one_halt() {
        let mut book = HaltBook::default();
        book.open_contract_violation();
        book.open_contract_violation();
        assert_eq!(book.halts().len(), 1);
        assert_eq!(book.halts()[0].reason, HaltReason::ContractViolation);
        assert_eq!(book.halts()[0].request_id, None);
    }

    #[test]
    fn the_error_line_is_due_once_every_period() {
        let mut clock = ErrorLogClock::default();
        let start = Instant::now();
        let every = Duration::from_secs(300);
        assert!(clock.due(start, every));
        assert!(!clock.due(start + Duration::from_secs(299), every));
        assert!(clock.due(start + Duration::from_secs(300), every));
        assert!(!clock.due(start + Duration::from_secs(301), every));
    }
}
