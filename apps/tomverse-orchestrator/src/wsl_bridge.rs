/**
 * Development runner that pulls Tomverse work on the operator workstation.
 *
 * Policy version 14 turns the code latch on. The runner still does not open a
 * socket unless `TOMVERSE_AMUX_WSL_BRIDGE` is exactly `1`. This process hosts
 * BoardDriver and the local-session adapter together. It never starts a Codex
 * or Claude process, and it never posts to `/api/board`.
 */

use std::collections::{BTreeMap, HashSet};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use uuid::Uuid;

use crate::board_driver::{
    BoardControlPlane, BoardDriver, DriveOutcome, RuntimeIdentity, WorkerAdapter,
};
use crate::tomverse_api::{ExecutionStartResponse, OwnedTodoTask};

pub const WSL_BRIDGE_CODE_LATCH: bool = true;

pub const WSL_BRIDGE_ENV_NAME: &str = "TOMVERSE_AMUX_WSL_BRIDGE";

pub const WSL_BRIDGE_LOCAL_URL_ENV: &str = "TOMVERSE_AMUX_WSL_LOCAL_URL";

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

#[allow(async_fn_in_trait)]
pub trait AttemptPrompts {
    async fn prompt_for(&mut self, worker: &str, attempt_id: &str) -> Result<Option<String>>;
}

#[allow(async_fn_in_trait)]
pub trait LocalAmux {
    async fn send(&mut self, path: &str, body: &LocalDispatchBody) -> Result<SendReply>;
    async fn read_back(&mut self, session_name: &str, attempt_id: &str) -> Result<ReadBack>;
}

impl AttemptPrompts for BTreeMap<String, String> {
    async fn prompt_for(&mut self, _worker: &str, attempt_id: &str) -> Result<Option<String>> {
        Ok(self.get(attempt_id).cloned())
    }
}

impl LocalAmux for LocalExchange {
    async fn send(&mut self, path: &str, body: &LocalDispatchBody) -> Result<SendReply> {
        self.paths.push(path.to_owned());
        self.sends.push(body.clone());
        Ok(self.reply.clone())
    }

    async fn read_back(&mut self, _session_name: &str, _attempt_id: &str) -> Result<ReadBack> {
        Ok(self.read_back)
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

    pub fn names(&self) -> Vec<String> {
        self.sessions.keys().cloned().collect()
    }

    pub fn observe(&mut self, name: &str, running: bool, at_boundary: bool) {
        if let Some(session) = self.sessions.get_mut(name) {
            session.running = running;
            session.at_boundary = running && at_boundary;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkerHeartbeatPlan {
    pub status: &'static str,
    pub dispatch_ready: bool,
}

/**
 * The server starts work only for an idle, dispatch-ready runtime. A session
 * that is waiting or idle and has no live attempt is that state. A pending
 * attempt, a mid-turn session, or a stopped session must not advertise it.
 */
pub fn plan_worker_heartbeat(
    running: bool,
    at_boundary: bool,
    has_pending_attempt: bool,
) -> WorkerHeartbeatPlan {
    if !running {
        return WorkerHeartbeatPlan {
            status: "stopped",
            dispatch_ready: false,
        };
    }
    if has_pending_attempt || !at_boundary {
        return WorkerHeartbeatPlan {
            status: "busy",
            dispatch_ready: false,
        };
    }
    WorkerHeartbeatPlan {
        status: "idle",
        dispatch_ready: true,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivationGate {
    LatchOff,
    EnvOff,
    Runner,
}

/**
 * The binary entry. A false latch returns before any client exists. A true
 * latch still returns before any client exists unless the environment value
 * is exactly `1`. This function does not read the process environment.
 */
pub fn activation_gate(latch: bool, env_value: Option<&str>) -> ActivationGate {
    if !latch {
        return ActivationGate::LatchOff;
    }
    if env_value != Some("1") {
        return ActivationGate::EnvOff;
    }
    ActivationGate::Runner
}

pub fn local_amux_url_allowed(raw: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(raw) else {
        return false;
    };
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    if url.query().is_some() || url.fragment().is_some() {
        return false;
    }
    if !(url.path().is_empty() || url.path() == "/") {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let loopback = host == "localhost" || host == "127.0.0.1" || host == "::1";
    loopback && matches!(url.scheme(), "http" | "https")
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
    let mut prompts = input.prompts.clone();
    bridge_tick_sourced(input, control, sessions, &mut prompts, local).await
}

pub async fn bridge_tick_sourced<C, P, L>(
    input: &BridgeTickInput<'_>,
    control: C,
    sessions: ExistingSessionAdapter,
    prompts: &mut P,
    local: &mut L,
) -> Result<Vec<BridgeTickResult>>
where
    C: BoardControlPlane,
    P: AttemptPrompts,
    L: LocalAmux,
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
                    let prompt = prompts
                        .prompt_for(&worker, &attempt_id)
                        .await?
                        .unwrap_or_default();
                    let presence = snapshot.presence(&worker);
                    dispatch_started(
                        input,
                        presence.map(|_| worker.as_str()),
                        presence.is_some_and(|session| session.running),
                        &attempt_id,
                        &prompt,
                        local,
                    )
                    .await
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

async fn dispatch_started<L>(
    input: &BridgeTickInput<'_>,
    session_name: Option<&str>,
    session_running: bool,
    attempt_id: &str,
    prompt: &str,
    local: &mut L,
) -> BridgeTickResult
where
    L: LocalAmux,
{
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

    let session_for_lookup = session_name.unwrap_or("");
    let reply = local
        .send(&path, &body)
        .await
        .unwrap_or(SendReply {
            transport_unknown: true,
            status: 0,
            ok: false,
            id: None,
            no_board_refused: None,
        });
    let mut interpretation = interpret_send_response(&reply);
    if interpretation == SendInterpretation::Unknown {
        let found = local
            .read_back(session_for_lookup, attempt_id)
            .await
            .unwrap_or(ReadBack::LookupFailed);
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
        let reply = local
            .send(&path, &body)
            .await
            .unwrap_or(SendReply {
                transport_unknown: true,
                status: 0,
                ok: false,
                id: None,
                no_board_refused: None,
            });
        interpretation = interpret_send_response(&reply);
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionObservation {
    pub name: String,
    pub running: bool,
    pub at_boundary: bool,
}

pub fn parse_session_roster(body: &str) -> Result<Vec<SessionObservation>> {
    let rows: Vec<serde_json::Value> = serde_json::from_str(body).context("invalid local session list")?;
    let mut sessions = Vec::new();
    for row in rows {
        let Some(name) = row.get("name").and_then(|value| value.as_str()) else {
            continue;
        };
        if !valid_session_name(name) {
            continue;
        }
        let archived = row.get("archived").and_then(|value| value.as_bool()).unwrap_or(false);
        let running = row.get("running").and_then(|value| value.as_bool()).unwrap_or(false);
        let lifecycle = row.get("lifecycle").and_then(|value| value.as_str()).unwrap_or("");
        let status = row.get("status").and_then(|value| value.as_str()).unwrap_or("");
        let agents_working = row
            .get("agents_working")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        sessions.push(SessionObservation {
            name: name.to_owned(),
            running: running && !archived && lifecycle == "active",
            at_boundary: (status == "waiting" || status == "idle") && !agents_working,
        });
    }
    Ok(sessions)
}

pub fn interpret_http_send(status: u16, body: &serde_json::Value) -> SendReply {
    let id = match body.get("id") {
        Some(serde_json::Value::String(value)) if !value.is_empty() => Some(value.clone()),
        Some(serde_json::Value::Number(value)) => Some(value.to_string()),
        _ => None,
    };
    let no_board_refused = body
        .get("no_board_refused")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    SendReply {
        transport_unknown: false,
        status,
        ok: body.get("ok").and_then(|value| value.as_bool()).unwrap_or(false),
        id,
        no_board_refused,
    }
}

pub fn interpret_read_back_body(status: u16, body: &serde_json::Value) -> ReadBack {
    if !(200..300).contains(&status) {
        return ReadBack::LookupFailed;
    }
    if body.get("stranded") == Some(&serde_json::Value::Bool(true))
        || body.get("delivered") == Some(&serde_json::Value::String("unknown".into()))
    {
        return ReadBack::LookupFailed;
    }
    match body.get("accepted").and_then(|value| value.as_bool()) {
        Some(true) => ReadBack::Found,
        Some(false) => ReadBack::Missing,
        None => ReadBack::LookupFailed,
    }
}

struct HttpLocal {
    client: reqwest::Client,
    base: String,
}

impl LocalAmux for HttpLocal {
    async fn send(&mut self, path: &str, body: &LocalDispatchBody) -> Result<SendReply> {
        if !path.starts_with("/api/sessions/") || !path.ends_with("/send") || path.contains("/api/board") {
            bail!("wsl bridge refused a non-session send");
        }
        let response = self
            .client
            .post(format!("{}{path}", self.base))
            .json(&serde_json::json!({
                "text": body.text,
                "no_board": true,
                "msg_id": body.msg_id,
            }))
            .send()
            .await
            .context("local session send failed")?;
        let status = response.status().as_u16();
        let parsed = response.json::<serde_json::Value>().await.unwrap_or(serde_json::Value::Null);
        if parsed.is_null() {
            return Ok(SendReply {
                transport_unknown: true,
                status,
                ok: false,
                id: None,
                no_board_refused: None,
            });
        }
        Ok(interpret_http_send(status, &parsed))
    }

    async fn read_back(&mut self, session_name: &str, attempt_id: &str) -> Result<ReadBack> {
        if !valid_session_name(session_name) || !valid_attempt_id(attempt_id) {
            bail!("wsl bridge refused an invalid read-back");
        }
        let response = self
            .client
            .get(format!(
                "{}/api/sessions/{}/send?msg_id={attempt_id}",
                self.base,
                encode_session_name(session_name)
            ))
            .send()
            .await
            .context("local session read-back failed")?;
        let status = response.status().as_u16();
        let parsed = response.json::<serde_json::Value>().await.unwrap_or(serde_json::Value::Null);
        if parsed.is_null() {
            return Ok(ReadBack::LookupFailed);
        }
        Ok(interpret_read_back_body(status, &parsed))
    }
}

struct DeliveryPrompts<'a> {
    api: &'a crate::tomverse_api::TomverseApi,
    sessions: &'a ExistingSessionAdapter,
    deliveries: Vec<crate::tomverse_api::PulledDelivery>,
}

impl AttemptPrompts for DeliveryPrompts<'_> {
    async fn prompt_for(&mut self, worker: &str, attempt_id: &str) -> Result<Option<String>> {
        let Some(session) = self.sessions.presence(worker) else {
            return Ok(None);
        };
        let pulled = self
            .api
            .delivery_pull(worker, &session.instance_id, session.generation)
            .await
            .context("delivery pull failed")?;
        let Some(delivery) = pulled.delivery else {
            return Ok(None);
        };
        if delivery.attempt_id != attempt_id {
            return Ok(None);
        }
        let ack = self
            .api
            .delivery_ack(&delivery, &session.instance_id, session.generation)
            .await
            .context("delivery ack failed")?;
        if !ack.acknowledged {
            return Ok(None);
        }
        let prompt = delivery.prompt.clone();
        self.deliveries.push(delivery);
        Ok(Some(prompt))
    }
}

pub async fn run_from_env() -> i32 {
    let Ok(local_url) = std::env::var(WSL_BRIDGE_LOCAL_URL_ENV) else {
        eprintln!("amux wsl bridge local url is unset");
        return 1;
    };
    if !local_amux_url_allowed(&local_url) {
        eprintln!("amux wsl bridge local url is not loopback");
        return 1;
    }
    let client = match local_client(&local_url) {
        Ok(client) => client,
        Err(_) => {
            eprintln!("amux wsl bridge local client failed");
            return 1;
        }
    };
    let base = local_url.trim_end_matches('/').to_owned();
    let roster = match fetch_roster(&client, &base).await {
        Ok(roster) => roster,
        Err(_) => {
            eprintln!("amux wsl bridge local amux is unreachable");
            return 1;
        }
    };
    let running: Vec<_> = roster.into_iter().filter(|row| row.running).collect();
    if running.is_empty() {
        println!("amux wsl bridge found no running session");
        return 0;
    }

    let api = match crate::tomverse_api::TomverseApi::from_env() {
        Ok(api) => api,
        Err(_) => {
            eprintln!("amux wsl bridge control plane is unavailable");
            return 1;
        }
    };
    let mut registered = BTreeMap::new();
    for row in &running {
        let instance_id = Uuid::new_v4().to_string();
        let Ok(response) = api.worker_register(&row.name, &instance_id).await else {
            continue;
        };
        if !response.registered {
            continue;
        }
        let Some(generation) = response.generation else {
            continue;
        };
        registered.insert(
            row.name.clone(),
            SessionPresence {
                running: true,
                at_boundary: row.at_boundary,
                instance_id,
                generation,
            },
        );
    }
    if registered.is_empty() {
        eprintln!("amux wsl bridge could not register a running session");
        return 1;
    }

    let mut sessions = ExistingSessionAdapter::new(registered);
    let mut local = HttpLocal {
        client: client.clone(),
        base: base.clone(),
    };
    let mut reserved = Vec::new();
    let mut pending: Vec<crate::tomverse_api::PulledDelivery> = Vec::new();
    let mut halted = false;
    let empty_prompts = BTreeMap::new();

    loop {
        let roster_ok = refresh_registered_sessions(&client, &base, &mut sessions).await;
        let pending_workers: HashSet<String> = pending.iter().map(|delivery| delivery.worker.clone()).collect();
        for name in sessions.names() {
            let Some(session) = sessions.presence(&name).cloned() else {
                continue;
            };
            let has_pending = pending_workers.contains(&name);
            let plan = if roster_ok {
                plan_worker_heartbeat(session.running, session.at_boundary, has_pending)
            } else {
                plan_worker_heartbeat(true, false, true)
            };
            let published = api
                .worker_heartbeat(
                    &name,
                    &session.instance_id,
                    session.generation,
                    plan.status,
                    plan.dispatch_ready,
                )
                .await;
            match published {
                Ok(response) if response.accepted => {}
                Ok(response) if response.reason.as_deref() == Some("active_execution") && plan.status == "idle" => {
                    let _ = api
                        .worker_heartbeat(&name, &session.instance_id, session.generation, "busy", false)
                        .await;
                    sessions.observe(&name, session.running, false);
                }
                Ok(response) if response.reason.as_deref() == Some("runtime_lease_lost") => {
                    sessions.observe(&name, false, false);
                }
                _ => {
                    sessions.observe(&name, session.running, false);
                }
            }
        }

        if !halted {
            let mut prompts = DeliveryPrompts {
                api: &api,
                sessions: &sessions,
                deliveries: Vec::new(),
            };
            let input = BridgeTickInput {
                latch: true,
                env_value: Some("1"),
                halt: BridgeHalt::Running,
                local_reachable: roster_ok,
                prompts: &empty_prompts,
                reserved_attempt_ids: &reserved,
                generation: 0,
                live_generation: None,
                lease_expires_at: 0,
                now: 0,
                worker_outcome: None,
            };
            let mut accepted = Vec::new();
            match bridge_tick_sourced(
                &input,
                api.clone(),
                sessions.clone(),
                &mut prompts,
                &mut local,
            )
            .await
            {
                Ok(results) => {
                    for result in &results {
                        if matches!(result, BridgeTickResult::Halted { .. }) {
                            halted = true;
                        }
                        if let BridgeTickResult::Pending { attempt_id } = result {
                            if let Some(delivery) = prompts
                                .deliveries
                                .iter()
                                .find(|delivery| delivery.attempt_id == *attempt_id)
                            {
                                accepted.push((attempt_id.clone(), delivery.clone()));
                            }
                        }
                    }
                }
                Err(_) => {
                    halted = true;
                }
            }
            drop(input);
            for (attempt_id, delivery) in accepted {
                reserved.push(attempt_id);
                pending.push(delivery);
            }
        }

        let mut still_pending = Vec::new();
        for delivery in &pending {
            let Some(session) = sessions.presence(&delivery.worker) else {
                halted = true;
                continue;
            };
            match api
                .execution_heartbeat(delivery, &session.instance_id, session.generation)
                .await
            {
                Ok(response) if response.accepted => still_pending.push(delivery.clone()),
                _ => halted = true,
            }
        }
        pending = still_pending;
        if halted && pending.is_empty() {
            return 0;
        }

        tokio::select! {
            result = tokio::signal::ctrl_c() => {
                if result.is_ok() {
                    return 0;
                }
            }
            _ = tokio::time::sleep(Duration::from_secs(30)) => {}
        }
    }
}

fn local_client(local_url: &str) -> Result<reqwest::Client> {
    let url = reqwest::Url::parse(local_url).context("invalid local AMUX url")?;
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(Duration::from_secs(15));
    if url.scheme() == "https" {
        builder = builder.danger_accept_invalid_certs(true);
    }
    builder.build().context("local AMUX client failed")
}

async fn refresh_registered_sessions(
    client: &reqwest::Client,
    base: &str,
    sessions: &mut ExistingSessionAdapter,
) -> bool {
    let Ok(roster) = fetch_roster(client, base).await else {
        return false;
    };
    let by_name: BTreeMap<String, SessionObservation> =
        roster.into_iter().map(|row| (row.name.clone(), row)).collect();
    for name in sessions.names() {
        match by_name.get(&name) {
            Some(row) => sessions.observe(&name, row.running, row.at_boundary),
            None => sessions.observe(&name, false, false),
        }
    }
    true
}

async fn fetch_roster(client: &reqwest::Client, base: &str) -> Result<Vec<SessionObservation>> {
    let body = client
        .get(format!("{base}/api/sessions"))
        .send()
        .await
        .context("local session list failed")?
        .error_for_status()
        .context("local session list was refused")?
        .text()
        .await
        .context("local session list was unreadable")?;
    parse_session_roster(&body)
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
    fn heartbeat_is_idle_only_at_a_boundary_without_a_pending_attempt() {
        assert_eq!(
            plan_worker_heartbeat(true, true, false),
            WorkerHeartbeatPlan {
                status: "idle",
                dispatch_ready: true,
            }
        );
        assert_eq!(
            plan_worker_heartbeat(true, true, true),
            WorkerHeartbeatPlan {
                status: "busy",
                dispatch_ready: false,
            }
        );
        assert_eq!(
            plan_worker_heartbeat(true, false, false),
            WorkerHeartbeatPlan {
                status: "busy",
                dispatch_ready: false,
            }
        );
        assert_eq!(
            plan_worker_heartbeat(false, true, false),
            WorkerHeartbeatPlan {
                status: "stopped",
                dispatch_ready: false,
            }
        );
    }

    #[test]
    fn activation_gate_stays_closed_without_the_exact_env() {
        assert!(WSL_BRIDGE_CODE_LATCH);
        assert_eq!(activation_gate(false, Some("1")), ActivationGate::LatchOff);
        assert_eq!(activation_gate(true, None), ActivationGate::EnvOff);
        assert_eq!(activation_gate(true, Some("enabled")), ActivationGate::EnvOff);
        assert_eq!(activation_gate(true, Some("1 ")), ActivationGate::EnvOff);
        assert_eq!(activation_gate(true, Some(" 1")), ActivationGate::EnvOff);
        assert_eq!(activation_gate(true, Some("1")), ActivationGate::Runner);
        assert!(!local_amux_url_allowed("https://example.com"));
        assert!(!local_amux_url_allowed("https://127.0.0.1:8824/api/board"));
        assert!(local_amux_url_allowed("https://127.0.0.1:8824"));
        assert!(local_amux_url_allowed("http://localhost:8824"));
    }

    #[test]
    fn local_client_does_not_follow_a_redirect() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut buffer = [0_u8; 2048];
            let _ = std::io::Read::read(&mut socket, &mut buffer);
            let response = b"HTTP/1.1 302 Found\r\nLocation: http://example.com/api/board\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            let _ = std::io::Write::write_all(&mut socket, response);
        });
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let status = runtime.block_on(async move {
            let client = local_client(&format!("http://127.0.0.1:{port}")).unwrap();
            client
                .get(format!("http://127.0.0.1:{port}/api/sessions"))
                .send()
                .await
                .unwrap()
                .status()
                .as_u16()
        });
        assert_eq!(status, 302);
        server.join().unwrap();
    }

    #[test]
    fn session_roster_uses_running_state_and_ignores_preview_text() {
        let roster = parse_session_roster(
            r#"[{"name":"claude-impl","running":true,"lifecycle":"active","status":"waiting","agents_working":false,"preview":"secret text"},{"name":"stopped","running":false,"lifecycle":"active","status":"idle"}]"#,
        )
        .unwrap();
        assert_eq!(
            roster,
            vec![
                SessionObservation {
                    name: "claude-impl".into(),
                    running: true,
                    at_boundary: true,
                },
                SessionObservation {
                    name: "stopped".into(),
                    running: false,
                    at_boundary: true,
                },
            ]
        );
        assert_eq!(
            interpret_read_back_body(200, &serde_json::json!({"ok": true, "accepted": true, "id": "1"})),
            ReadBack::Found
        );
        assert_eq!(
            interpret_read_back_body(202, &serde_json::json!({"ok": true, "accepted": false})),
            ReadBack::Missing
        );
        assert_eq!(
            interpret_read_back_body(
                200,
                &serde_json::json!({"accepted": false, "stranded": true, "delivered": "unknown"})
            ),
            ReadBack::LookupFailed
        );
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
