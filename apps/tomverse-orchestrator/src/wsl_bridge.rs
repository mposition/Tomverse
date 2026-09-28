/**
 * Development runner that pulls Tomverse work on the operator workstation.
 *
 * The code latch ships false. A true latch is a later policy version. This
 * process hosts BoardDriver and the local-session adapter together. It never
 * starts a Codex or Claude process, and it never posts to `/api/board`.
 * `process_main` does not construct a client or open a socket.
 */

use std::collections::{BTreeMap, HashSet};

use anyhow::{bail, Result};
use uuid::Uuid;

use crate::board_driver::{
    BoardControlPlane, BoardDriver, DriveOutcome, RuntimeIdentity, WorkerAdapter,
};
use crate::tomverse_api::{ExecutionStartResponse, OwnedTodoTask};

pub const WSL_BRIDGE_CODE_LATCH: bool = false;

const CONTROL_PLANE_MARKERS: &[&str] = &[
    "TOMVERSE_AMUX_SYNC_SECRET",
    "TOMVERSE_AMUX_ENABLED",
    "TOMVERSE_AMUX_EXECUTE",
    "TOMVERSE_AMUX_EXECUTOR_COMMANDS_JSON",
    "TOMVERSE_INTERNAL_URL",
    "DATABASE_URL",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeHalt {
    Running,
    Halted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionPresence {
    pub running: bool,
    pub at_boundary: bool,
    pub instance_id: String,
    pub generation: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalDispatchBody {
    pub text: String,
    pub no_board: bool,
    pub msg_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DispatchPlan {
    Send {
        method: &'static str,
        path: String,
        body: LocalDispatchBody,
    },
    Refuse {
        reason: &'static str,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendReply {
    pub transport_unknown: bool,
    pub status: u16,
    pub ok: bool,
    pub id: Option<String>,
    pub no_board_refused: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadBack {
    Found,
    Missing,
    LookupFailed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendInterpretation {
    Pending,
    DualBoard,
    Unknown,
    Refused,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BridgeTickResult {
    Idle {
        reason: &'static str,
    },
    Pending {
        attempt_id: String,
    },
    DualBoard {
        attempt_id: String,
    },
    Halted {
        attempt_id: String,
    },
    Refused {
        attempt_id: String,
    },
    Settled {
        attempt_id: String,
        to_status: &'static str,
    },
    ResultRejected {
        attempt_id: String,
    },
}

pub struct BridgeTickInput<'a> {
    pub latch: bool,
    pub env_value: Option<&'a str>,
    pub halt: BridgeHalt,
    pub local_reachable: bool,
    pub prompts: &'a BTreeMap<String, String>,
    pub reserved_attempt_ids: &'a [String],
    pub generation: i64,
    pub live_generation: Option<i64>,
    pub lease_expires_at: i64,
    pub now: i64,
    pub worker_outcome: Option<&'a str>,
}

pub struct LocalExchange {
    pub reply: SendReply,
    pub read_back: ReadBack,
    pub sends: Vec<LocalDispatchBody>,
    pub paths: Vec<String>,
}

impl LocalExchange {
    pub fn accepting() -> Self {
        Self {
            reply: SendReply {
                transport_unknown: false,
                status: 200,
                ok: true,
                id: Some("1".into()),
                no_board_refused: None,
            },
            read_back: ReadBack::Missing,
            sends: Vec::new(),
            paths: Vec::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ExistingSessionAdapter {
    sessions: BTreeMap<String, SessionPresence>,
}

impl ExistingSessionAdapter {
    pub fn new(sessions: BTreeMap<String, SessionPresence>) -> Self {
        Self { sessions }
    }

    pub fn presence(&self, worker: &str) -> Option<&SessionPresence> {
        self.sessions.get(worker)
    }
}

impl WorkerAdapter for ExistingSessionAdapter {
    async fn is_running(&self, worker: &str) -> Result<bool> {
        Ok(self
            .sessions
            .get(worker)
            .is_some_and(|session| session.running))
    }

    async fn start_for_dispatch(&self, worker: &str) -> Result<()> {
        let _ = worker;
        bail!("wsl bridge does not start workers");
    }

    async fn at_boundary(&self, worker: &str) -> Result<bool> {
        Ok(self
            .sessions
            .get(worker)
            .is_some_and(|session| session.running && session.at_boundary))
    }

    async fn runtime_identity(&self, worker: &str) -> Result<Option<RuntimeIdentity>> {
        let Some(session) = self.sessions.get(worker) else {
            return Ok(None);
        };
        if !session.running {
            return Ok(None);
        }
        Ok(Some(RuntimeIdentity {
            instance_id: session.instance_id.clone(),
            generation: session.generation,
        }))
    }
}

pub fn payload_leaks_control_plane(text: &str) -> bool {
    CONTROL_PLANE_MARKERS
        .iter()
        .any(|marker| text.contains(marker))
        || contains_database_url_scheme(text)
}

pub fn plan_local_dispatch(
    latch: bool,
    env_value: Option<&str>,
    halt: BridgeHalt,
    local_reachable: bool,
    session_name: Option<&str>,
    session_running: bool,
    attempt_id: &str,
    prompt: &str,
    reserved_attempt_ids: &[String],
) -> DispatchPlan {
    if !latch {
        return DispatchPlan::Refuse {
            reason: "bridge_latch_off",
        };
    }
    if env_value != Some("1") {
        return DispatchPlan::Refuse {
            reason: "bridge_disabled",
        };
    }
    if halt != BridgeHalt::Running {
        return DispatchPlan::Refuse {
            reason: "assignments_halted",
        };
    }
    if !local_reachable {
        return DispatchPlan::Refuse {
            reason: "local_unreachable",
        };
    }
    if !valid_attempt_id(attempt_id) {
        return DispatchPlan::Refuse {
            reason: "attempt_id_invalid",
        };
    }
    if reserved_attempt_ids.iter().any(|id| id == attempt_id) {
        return DispatchPlan::Refuse {
            reason: "duplicate_assignment",
        };
    }
    if !session_running {
        return DispatchPlan::Refuse {
            reason: "worker_not_running",
        };
    }
    let Some(name) = session_name else {
        return DispatchPlan::Refuse {
            reason: "worker_not_running",
        };
    };
    if !valid_session_name(name) {
        return DispatchPlan::Refuse {
            reason: "session_name_invalid",
        };
    }
    if !prompt.contains("Approved execution brief:\n")
        || prompt.contains("Approved execution brief:\n(none)")
    {
        return DispatchPlan::Refuse {
            reason: "brief_absent",
        };
    }
    if payload_leaks_control_plane(prompt) {
        return DispatchPlan::Refuse {
            reason: "control_plane_leak",
        };
    }

    DispatchPlan::Send {
        method: "POST",
        path: format!("/api/sessions/{}/send", encode_session_name(name)),
        body: LocalDispatchBody {
            text: prompt.to_owned(),
            no_board: true,
            msg_id: attempt_id.to_owned(),
        },
    }
}

pub fn interpret_send_response(reply: &SendReply) -> SendInterpretation {
    if reply.transport_unknown {
        return SendInterpretation::Unknown;
    }
    if !(200..300).contains(&reply.status) {
        return SendInterpretation::Refused;
    }
    if reply
        .no_board_refused
        .as_ref()
        .is_some_and(|reason| !reason.is_empty())
    {
        return SendInterpretation::DualBoard;
    }
    if reply.ok || reply.id.as_ref().is_some_and(|id| !id.is_empty()) {
        return SendInterpretation::Pending;
    }
    SendInterpretation::Unknown
}

pub fn decide_after_read_back(found: ReadBack) -> (bool, bool) {
    match found {
        ReadBack::LookupFailed => (false, true),
        ReadBack::Found => (false, false),
        ReadBack::Missing => (true, false),
    }
}

pub fn classify_bridge_result(outcome: &str) -> Option<&'static str> {
    match outcome {
        "succeeded" => Some("review"),
        "failed" => Some("todo"),
        "blocked" => Some("blocked"),
        _ => None,
    }
}

pub fn accept_late_result(
    generation: i64,
    live_generation: Option<i64>,
    lease_expires_at: i64,
    now: i64,
) -> bool {
    live_generation == Some(generation) && lease_expires_at > now
}

/**
 * The binary entry. A false latch returns before any client exists. A true
 * latch still refuses: wiring this function to `bridge_tick` is the next
 * policy version, and this build has no activation runner.
 */
pub fn process_main(latch: bool) -> i32 {
    if latch { 1 } else { 0 }
}

struct SingleOwnedTask<'a, C> {
    inner: &'a C,
    task: OwnedTodoTask,
}

impl<C> BoardControlPlane for SingleOwnedTask<'_, C>
where
    C: BoardControlPlane,
{
    async fn owned_queue(&self) -> Result<Vec<OwnedTodoTask>> {
        Ok(vec![self.task.clone()])
    }

    async fn execution_start(
        &self,
        task: &OwnedTodoTask,
        runtime: &RuntimeIdentity,
    ) -> Result<ExecutionStartResponse> {
        self.inner.execution_start(task, runtime).await
    }
}

pub async fn bridge_tick<C>(
    input: &BridgeTickInput<'_>,
    control: C,
    sessions: ExistingSessionAdapter,
    local: &mut LocalExchange,
) -> Result<Vec<BridgeTickResult>>
where
    C: BoardControlPlane,
{
    /*
     * Assignment gates run before any execution start. A lookup failure from
     * an earlier tick arrives as `BridgeHalt::Halted` and must not open a new
     * Tomverse attempt.
     */
    if !input.latch {
        return Ok(vec![BridgeTickResult::Idle {
            reason: "bridge_latch_off",
        }]);
    }
    if input.env_value != Some("1") {
        return Ok(vec![BridgeTickResult::Idle {
            reason: "bridge_disabled",
        }]);
    }
    if input.halt != BridgeHalt::Running {
        return Ok(vec![BridgeTickResult::Idle {
            reason: "assignments_halted",
        }]);
    }
    if !input.local_reachable {
        return Ok(vec![BridgeTickResult::Idle {
            reason: "local_unreachable",
        }]);
    }

    let tasks = control.owned_queue().await?;
    let snapshot = sessions.clone();
    let mut seen = HashSet::new();
    let mut results = Vec::new();
    let mut halted = false;

    for task in tasks {
        if !seen.insert(task.owner.clone()) {
            continue;
        }
        if halted {
            break;
        }

        let outcomes = BoardDriver::new(
            SingleOwnedTask {
                inner: &control,
                task: task.clone(),
            },
            sessions.clone(),
        )
        .tick()
        .await?;

        for outcome in outcomes {
            let result = match outcome {
                DriveOutcome::ExecutionStarted {
                    worker,
                    attempt_id,
                    ..
                } => {
                    let prompt = input
                        .prompts
                        .get(&attempt_id)
                        .map(String::as_str)
                        .unwrap_or("");
                    let presence = snapshot.presence(&worker);
                    dispatch_started(
                        input,
                        presence.map(|_| worker.as_str()),
                        presence.is_some_and(|session| session.running),
                        &attempt_id,
                        prompt,
                        local,
                    )
                }
                DriveOutcome::StartFailed { .. }
                | DriveOutcome::StartReportedNotRunning { .. }
                | DriveOutcome::MidTurn { .. }
                | DriveOutcome::RuntimeUnavailable { .. } => BridgeTickResult::Idle {
                    reason: "worker_not_running",
                },
                DriveOutcome::ExecutionStartRefused { .. } => BridgeTickResult::Idle {
                    reason: "assignments_halted",
                },
            };
            if matches!(result, BridgeTickResult::Halted { .. }) {
                halted = true;
            }
            results.push(result);
        }
    }

    Ok(results)
}

fn dispatch_started(
    input: &BridgeTickInput<'_>,
    session_name: Option<&str>,
    session_running: bool,
    attempt_id: &str,
    prompt: &str,
    local: &mut LocalExchange,
) -> BridgeTickResult {
    let plan = plan_local_dispatch(
        input.latch,
        input.env_value,
        input.halt,
        input.local_reachable,
        session_name,
        session_running,
        attempt_id,
        prompt,
        input.reserved_attempt_ids,
    );
    let DispatchPlan::Send { path, body, .. } = plan else {
        let DispatchPlan::Refuse { reason } = plan else {
            unreachable!("plan is send or refuse");
        };
        return BridgeTickResult::Idle { reason };
    };
    if path.contains("/api/board") {
        return BridgeTickResult::Idle {
            reason: "control_plane_leak",
        };
    }

    local.paths.push(path);
    local.sends.push(body.clone());
    let mut interpretation = interpret_send_response(&local.reply);
    if interpretation == SendInterpretation::Unknown {
        let found = local.read_back;
        let (send_again, halt) = decide_after_read_back(found);
        if halt {
            return BridgeTickResult::Halted {
                attempt_id: attempt_id.to_owned(),
            };
        }
        if !send_again {
            return BridgeTickResult::Pending {
                attempt_id: attempt_id.to_owned(),
            };
        }
        local.sends.push(body);
        interpretation = interpret_send_response(&local.reply);
        if interpretation == SendInterpretation::Unknown {
            return BridgeTickResult::Halted {
                attempt_id: attempt_id.to_owned(),
            };
        }
    }
    if interpretation == SendInterpretation::DualBoard {
        return BridgeTickResult::DualBoard {
            attempt_id: attempt_id.to_owned(),
        };
    }
    if interpretation != SendInterpretation::Pending {
        return BridgeTickResult::Refused {
            attempt_id: attempt_id.to_owned(),
        };
    }
    if input.worker_outcome.is_none() {
        return BridgeTickResult::Pending {
            attempt_id: attempt_id.to_owned(),
        };
    }
    if !accept_late_result(
        input.generation,
        input.live_generation,
        input.lease_expires_at,
        input.now,
    ) {
        return BridgeTickResult::ResultRejected {
            attempt_id: attempt_id.to_owned(),
        };
    }
    let Some(to_status) = classify_bridge_result(input.worker_outcome.unwrap_or("")) else {
        return BridgeTickResult::ResultRejected {
            attempt_id: attempt_id.to_owned(),
        };
    };
    BridgeTickResult::Settled {
        attempt_id: attempt_id.to_owned(),
        to_status,
    }
}

fn valid_attempt_id(value: &str) -> bool {
    let Ok(id) = Uuid::parse_str(value) else {
        return false;
    };
    let version = id.as_bytes()[6] >> 4;
    (1..=8).contains(&version)
}

fn valid_session_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

fn encode_session_name(name: &str) -> String {
    let mut encoded = String::new();
    for character in name.chars() {
        if character == ':' {
            encoded.push_str("%3A");
        } else {
            encoded.push(character);
        }
    }
    encoded
}

fn contains_database_url_scheme(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("postgres://") || lower.contains("postgresql://")
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use super::*;
    use crate::tomverse_api::{ExecutionStartResponse, OwnedTodoTask};

    const ATTEMPT_ID: &str = "4f3b1c0a-6d2e-4a18-9c0b-1a2b3c4d5e6f";

    fn task() -> OwnedTodoTask {
        OwnedTodoTask {
            id: "TASK-1".into(),
            title: "Fix the window".into(),
            description: Some("description".into()),
            kind: "bug".into(),
            priority: "p2".into(),
            owner: "claude-impl".into(),
            revision: 2,
            claimed_at: None,
            created_at: "2026-09-28T00:00:00Z".into(),
        }
    }

    fn started() -> ExecutionStartResponse {
        ExecutionStartResponse {
            started: true,
            attempt_id: Some(ATTEMPT_ID.into()),
            task_revision: Some(3),
            lease_expires_at: None,
            reason: None,
        }
    }

    fn brief_prompt() -> String {
        "Approved execution brief digest: abc\nApproved execution brief:\nDo the work.\nCard description:\ndescription\n".into()
    }

    struct FlagControl {
        calls: Arc<AtomicUsize>,
        tasks: Vec<OwnedTodoTask>,
        start: ExecutionStartResponse,
    }

    impl BoardControlPlane for FlagControl {
        async fn owned_queue(&self) -> Result<Vec<OwnedTodoTask>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.tasks.clone())
        }

        async fn execution_start(
            &self,
            _task: &OwnedTodoTask,
            _runtime: &RuntimeIdentity,
        ) -> Result<ExecutionStartResponse> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.start.clone())
        }
    }

    fn input<'a>(
        latch: bool,
        prompts: &'a BTreeMap<String, String>,
        outcome: Option<&'a str>,
    ) -> BridgeTickInput<'a> {
        BridgeTickInput {
            latch,
            env_value: Some("1"),
            halt: BridgeHalt::Running,
            local_reachable: true,
            prompts,
            reserved_attempt_ids: &[],
            generation: 4,
            live_generation: Some(4),
            lease_expires_at: 200,
            now: 100,
            worker_outcome: outcome,
        }
    }

    fn running_session() -> ExistingSessionAdapter {
        let mut sessions = BTreeMap::new();
        sessions.insert(
            "claude-impl".into(),
            SessionPresence {
                running: true,
                at_boundary: true,
                instance_id: "00000000-0000-4000-8000-000000000001".into(),
                generation: 4,
            },
        );
        ExistingSessionAdapter::new(sessions)
    }

    #[test]
    fn process_main_stays_off_without_a_client() {
        assert!(!WSL_BRIDGE_CODE_LATCH);
        assert_eq!(process_main(false), 0);
        assert_eq!(process_main(true), 1);
    }

    #[tokio::test]
    async fn latch_off_does_not_read_the_board_or_send() {
        let calls = Arc::new(AtomicUsize::new(0));
        let prompts = BTreeMap::new();
        let mut local = LocalExchange::accepting();
        let results = bridge_tick(
            &input(false, &prompts, None),
            FlagControl {
                calls: calls.clone(),
                tasks: vec![task()],
                start: started(),
            },
            running_session(),
            &mut local,
        )
        .await
        .unwrap();

        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(local.sends.is_empty());
        assert_eq!(
            results,
            vec![BridgeTickResult::Idle {
                reason: "bridge_latch_off",
            }]
        );
    }

    #[tokio::test]
    async fn stopped_session_is_not_started() {
        let calls = Arc::new(AtomicUsize::new(0));
        let mut prompts = BTreeMap::new();
        prompts.insert(ATTEMPT_ID.into(), brief_prompt());
        let mut local = LocalExchange::accepting();
        let results = bridge_tick(
            &input(true, &prompts, None),
            FlagControl {
                calls: calls.clone(),
                tasks: vec![task()],
                start: started(),
            },
            ExistingSessionAdapter::new(BTreeMap::new()),
            &mut local,
        )
        .await
        .unwrap();

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(local.sends.is_empty());
        assert!(local.paths.iter().all(|path| !path.contains("/api/board")));
        assert_eq!(
            results,
            vec![BridgeTickResult::Idle {
                reason: "worker_not_running",
            }]
        );
    }

    #[tokio::test]
    async fn running_session_send_stays_pending_and_does_not_open_a_board() {
        let calls = Arc::new(AtomicUsize::new(0));
        let mut prompts = BTreeMap::new();
        prompts.insert(ATTEMPT_ID.into(), brief_prompt());
        let mut local = LocalExchange::accepting();
        let results = bridge_tick(
            &input(true, &prompts, None),
            FlagControl {
                calls: calls.clone(),
                tasks: vec![task()],
                start: started(),
            },
            running_session(),
            &mut local,
        )
        .await
        .unwrap();

        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(local.sends.len(), 1);
        assert!(local.sends[0].no_board);
        assert_eq!(local.sends[0].msg_id, ATTEMPT_ID);
        assert_eq!(local.paths, vec!["/api/sessions/claude-impl/send".to_owned()]);
        assert_eq!(
            results,
            vec![BridgeTickResult::Pending {
                attempt_id: ATTEMPT_ID.into(),
            }]
        );
    }

    #[tokio::test]
    async fn database_url_in_the_prompt_is_not_sent() {
        let mut prompts = BTreeMap::new();
        prompts.insert(
            ATTEMPT_ID.into(),
            "Approved execution brief:\nsee postgres://db.internal/app\n".into(),
        );
        let mut local = LocalExchange::accepting();
        let results = bridge_tick(
            &input(true, &prompts, None),
            FlagControl {
                calls: Arc::new(AtomicUsize::new(0)),
                tasks: vec![task()],
                start: started(),
            },
            running_session(),
            &mut local,
        )
        .await
        .unwrap();

        assert!(local.sends.is_empty());
        assert_eq!(
            results,
            vec![BridgeTickResult::Idle {
                reason: "control_plane_leak",
            }]
        );
    }

    #[tokio::test]
    async fn no_board_refusal_is_not_a_dispatch() {
        let mut prompts = BTreeMap::new();
        prompts.insert(ATTEMPT_ID.into(), brief_prompt());
        let mut local = LocalExchange::accepting();
        local.reply.no_board_refused = Some("substantive".into());
        let results = bridge_tick(
            &input(true, &prompts, Some("succeeded")),
            FlagControl {
                calls: Arc::new(AtomicUsize::new(0)),
                tasks: vec![task()],
                start: started(),
            },
            running_session(),
            &mut local,
        )
        .await
        .unwrap();

        assert_eq!(local.sends.len(), 1);
        assert_eq!(
            results,
            vec![BridgeTickResult::DualBoard {
                attempt_id: ATTEMPT_ID.into(),
            }]
        );
    }

    #[tokio::test]
    async fn fenced_success_settles_review_and_a_stale_generation_does_not() {
        let mut prompts = BTreeMap::new();
        prompts.insert(ATTEMPT_ID.into(), brief_prompt());
        let mut local = LocalExchange::accepting();
        let settled = bridge_tick(
            &input(true, &prompts, Some("succeeded")),
            FlagControl {
                calls: Arc::new(AtomicUsize::new(0)),
                tasks: vec![task()],
                start: started(),
            },
            running_session(),
            &mut local,
        )
        .await
        .unwrap();
        assert_eq!(
            settled,
            vec![BridgeTickResult::Settled {
                attempt_id: ATTEMPT_ID.into(),
                to_status: "review",
            }]
        );

        let mut late_input = input(true, &prompts, Some("succeeded"));
        late_input.live_generation = Some(9);
        let late = bridge_tick(
            &late_input,
            FlagControl {
                calls: Arc::new(AtomicUsize::new(0)),
                tasks: vec![task()],
                start: started(),
            },
            running_session(),
            &mut LocalExchange::accepting(),
        )
        .await
        .unwrap();
        assert_eq!(
            late,
            vec![BridgeTickResult::ResultRejected {
                attempt_id: ATTEMPT_ID.into(),
            }]
        );
    }

    #[tokio::test]
    async fn halted_bridge_does_not_start_execution() {
        let calls = Arc::new(AtomicUsize::new(0));
        let prompts = BTreeMap::new();
        let mut tick = input(true, &prompts, None);
        tick.halt = BridgeHalt::Halted;
        let results = bridge_tick(
            &tick,
            FlagControl {
                calls: calls.clone(),
                tasks: vec![task()],
                start: started(),
            },
            running_session(),
            &mut LocalExchange::accepting(),
        )
        .await
        .unwrap();

        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            results,
            vec![BridgeTickResult::Idle {
                reason: "assignments_halted",
            }]
        );
    }

    #[tokio::test]
    async fn lookup_failure_does_not_start_the_next_worker() {
        let calls = Arc::new(AtomicUsize::new(0));
        let mut second = task();
        second.id = "TASK-2".into();
        second.owner = "claude-review".into();
        let mut sessions = BTreeMap::new();
        for name in ["claude-impl", "claude-review"] {
            sessions.insert(
                name.into(),
                SessionPresence {
                    running: true,
                    at_boundary: true,
                    instance_id: "00000000-0000-4000-8000-000000000001".into(),
                    generation: 4,
                },
            );
        }
        let mut prompts = BTreeMap::new();
        prompts.insert(ATTEMPT_ID.into(), brief_prompt());
        let mut local = LocalExchange::accepting();
        local.reply.transport_unknown = true;
        local.reply.ok = false;
        local.reply.id = None;
        local.read_back = ReadBack::LookupFailed;

        let results = bridge_tick(
            &input(true, &prompts, None),
            FlagControl {
                calls: calls.clone(),
                tasks: vec![task(), second],
                start: started(),
            },
            ExistingSessionAdapter::new(sessions),
            &mut local,
        )
        .await
        .unwrap();

        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(local.sends.len(), 1);
        assert_eq!(
            results,
            vec![BridgeTickResult::Halted {
                attempt_id: ATTEMPT_ID.into(),
            }]
        );
    }

    #[test]
    fn merged_and_deploy_are_not_results() {
        assert_eq!(classify_bridge_result("done"), None);
        assert_eq!(classify_bridge_result("merged"), None);
        assert_eq!(classify_bridge_result("deploy"), None);
        assert!(payload_leaks_control_plane("PostgreSQL://secret"));
    }
}
