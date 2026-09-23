use anyhow::{bail, Result};

#[cfg(test)]
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    fs,
    path::Path,
    sync::Arc,
};

#[cfg(test)]
use anyhow::Context;

#[cfg(test)]
use serde::Deserialize;

#[cfg(test)]
use tempfile::{Builder as TempDirBuilder, TempDir};

#[cfg(test)]
use tokio::process::Command;

use crate::{
    tomverse_api::PulledDelivery,
    worker_protocol::{AgentExecutor, AgentTurnResult},
};

pub const LOCAL_PROCESS_EXECUTION_FORBIDDEN: &str =
    "LOCAL_PROCESS_EXECUTION_FORBIDDEN: isolated worker sandbox unavailable";

#[cfg(test)]
const EXECUTOR_OUTPUT_VERSION: &str = "tomverse-amux-agent-result-v1";

#[cfg(test)]
const MAX_EXECUTOR_OUTPUT_BYTES: usize = 64 * 1024;

#[cfg(test)]
const MAX_REASON_BYTES: usize = 4 * 1024;

#[cfg(test)]
const MAX_ENV_PASSTHROUGH_NAMES: usize = 32;

#[cfg(test)]
const RESERVED_EXECUTOR_ENV_NAMES: &[&str] = &[
    "TOMVERSE_AMUX_ENABLED",
    "TOMVERSE_AMUX_EXECUTE",
    "TOMVERSE_AMUX_EXECUTOR_COMMANDS_JSON",
    "TOMVERSE_AMUX_SYNC_SECRET",
    "TOMVERSE_INTERNAL_URL",
];

#[cfg(test)]
const PARENT_ENVIRONMENT_ALLOWLIST: &[&str] = &[
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "COLORTERM",
    "NO_COLOR",
];

#[cfg(test)]
const ISOLATED_ENVIRONMENT_PATHS: &[(&str, &str)] = &[
    ("HOME", "home"),
    ("USERPROFILE", "home"),
    ("APPDATA", "config/appdata"),
    ("LOCALAPPDATA", "config/localappdata"),
    ("XDG_CONFIG_HOME", "config/xdg"),
    ("XDG_CACHE_HOME", "cache/xdg"),
    ("CODEX_HOME", "config/codex"),
    ("CLAUDE_CONFIG_DIR", "config/claude"),
    ("TEMP", "tmp"),
    ("TMP", "tmp"),
    ("TMPDIR", "tmp"),
];

#[cfg(all(test, windows))]
fn is_worker_environment_key_allowed(key: &OsStr) -> bool {
    let Some(key) = key.to_str() else {
        return false;
    };

    PARENT_ENVIRONMENT_ALLOWLIST
        .iter()
        .any(|allowed| key.eq_ignore_ascii_case(allowed))
}

#[cfg(all(test, not(windows)))]
fn is_worker_environment_key_allowed(key: &OsStr) -> bool {
    PARENT_ENVIRONMENT_ALLOWLIST
        .iter()
        .any(|allowed| key == OsStr::new(allowed))
}

#[cfg(test)]
struct WorkerEnvironmentSandbox {
    root: TempDir,
}

#[cfg(test)]
impl WorkerEnvironmentSandbox {
    fn new() -> Result<Self> {
        let root = TempDirBuilder::new()
            .prefix("tomverse-amux-worker-")
            .tempdir()
            .context("failed to create isolated AMUX worker environment")?;

        for (_, relative) in ISOLATED_ENVIRONMENT_PATHS {
            fs::create_dir_all(root.path().join(relative))
                .context("failed to prepare isolated AMUX worker environment")?;
        }

        Ok(Self { root })
    }

    fn root(&self) -> &Path {
        self.root.path()
    }
}

#[cfg(test)]
fn configure_worker_environment<I>(
    command: &mut Command,
    parent_environment: I,
    sandbox_root: &Path,
    env_passthrough: &[String],
) where
    I: IntoIterator<Item = (OsString, OsString)>,
{
    /*
     * Fail closed. Worker children inherit only reviewed process-bootstrap,
     * locale and terminal variables. Home, tool configuration, caches and
     * temporary files point to a fresh per-turn directory; no parent auth
     * store is reachable through ambient configuration. Provider credentials
     * belong behind an approved adapter boundary, never this environment.
     */
    command.env_clear();

    for (key, value) in parent_environment {
        let declared = env_passthrough
            .iter()
            .any(|name| key.to_string_lossy().eq_ignore_ascii_case(name));

        if declared && is_worker_environment_key_allowed(&key) {
            command.env(key, value);
        }
    }

    for (key, relative) in ISOLATED_ENVIRONMENT_PATHS {
        command.env(key, sandbox_root.join(relative));
    }
}

#[cfg(test)]
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecutorConfigDocument {
    workers: Vec<WorkerCommandSpec>,
}

#[cfg(test)]
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerCommandSpec {
    worker: String,
    program: String,

    #[serde(default)]
    args: Vec<String>,

    #[serde(default)]
    env_passthrough: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct CommandAgentExecutor {
    #[cfg(test)]
    workers: Arc<BTreeMap<String, WorkerCommandSpec>>,
}

impl CommandAgentExecutor {
    pub fn from_env() -> Result<Self> {
        bail!(LOCAL_PROCESS_EXECUTION_FORBIDDEN)
    }

    #[cfg(test)]
    fn from_json(raw: &str) -> Result<Self> {
        let document: ExecutorConfigDocument =
            serde_json::from_str(raw).context("invalid AMUX executor command configuration")?;

        if document.workers.is_empty() {
            bail!("AMUX executor configuration has no workers");
        }

        if document.workers.len() > 128 {
            bail!("AMUX executor configuration exceeds 128 workers");
        }

        let mut workers = BTreeMap::new();

        for raw_spec in document.workers {
            let worker = raw_spec.worker.trim().to_owned();

            if !valid_worker_name(&worker) {
                bail!("invalid AMUX executor worker name");
            }

            let program = raw_spec.program.trim().to_owned();

            if program.is_empty() || program.len() > 4096 || program.contains('\0') {
                bail!("invalid AMUX executor program");
            }

            if raw_spec.args.len() > 64 {
                bail!("AMUX executor command has too many arguments");
            }

            for arg in &raw_spec.args {
                if arg.len() > 4096 || arg.contains('\0') {
                    bail!("invalid AMUX executor argument");
                }
            }

            if raw_spec.env_passthrough.len() > MAX_ENV_PASSTHROUGH_NAMES {
                bail!("AMUX executor command passes through too many environment names");
            }

            let mut env_passthrough = Vec::new();

            for raw_name in &raw_spec.env_passthrough {
                let name = raw_name.trim().to_owned();

                if !valid_env_name(&name) {
                    bail!("invalid AMUX executor environment name");
                }

                if RESERVED_EXECUTOR_ENV_NAMES
                    .iter()
                    .any(|reserved| name.eq_ignore_ascii_case(reserved))
                {
                    bail!("AMUX executor may not pass the orchestrator control plane to a worker");
                }

                if !is_worker_environment_key_allowed(OsStr::new(&name)) {
                    bail!("AMUX test executor environment name is outside the bootstrap allowlist");
                }

                if env_passthrough.contains(&name) {
                    bail!("duplicate AMUX executor environment name");
                }

                env_passthrough.push(name);
            }

            let spec = WorkerCommandSpec {
                worker: worker.clone(),
                program,
                args: raw_spec.args,
                env_passthrough,
            };

            if workers.insert(worker, spec).is_some() {
                bail!("duplicate AMUX executor worker");
            }
        }

        Ok(Self {
            workers: Arc::new(workers),
        })
    }

    pub fn worker_names(&self) -> Vec<String> {
        #[cfg(test)]
        {
            return self.workers.keys().cloned().collect();
        }

        #[cfg(not(test))]
        {
            Vec::new()
        }
    }
}

#[cfg(test)]
fn valid_worker_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-'))
}

#[cfg(test)]
fn valid_env_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_alphabetic() || ch == '_')
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

#[cfg(test)]
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecutorOutput {
    protocol_version: String,
    outcome: String,

    #[serde(default)]
    reason: Option<String>,
}

#[cfg(test)]
fn normalized_reason(reason: Option<String>) -> Result<Option<String>> {
    let reason = reason
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());

    if reason
        .as_ref()
        .is_some_and(|value| value.len() > MAX_REASON_BYTES)
    {
        bail!("AMUX executor reason exceeds limit");
    }

    Ok(reason)
}

#[cfg(test)]
fn parse_executor_output(bytes: &[u8]) -> Result<AgentTurnResult> {
    if bytes.len() > MAX_EXECUTOR_OUTPUT_BYTES {
        bail!("AMUX executor output exceeds limit");
    }

    let output: ExecutorOutput =
        serde_json::from_slice(bytes).context("invalid AMUX executor result JSON")?;

    if output.protocol_version != EXECUTOR_OUTPUT_VERSION {
        bail!("unsupported AMUX executor result protocol");
    }

    let reason = normalized_reason(output.reason)?;

    match output.outcome.as_str() {
        "done" => {
            if reason.is_some() {
                bail!("done result must not include reason");
            }

            Ok(AgentTurnResult::SucceededDone)
        }

        "review" => {
            if reason.is_some() {
                bail!("review result must not include reason");
            }

            Ok(AgentTurnResult::SucceededReview)
        }

        "retry" => {
            let Some(reason) = reason else {
                bail!("retry result requires reason");
            };

            Ok(AgentTurnResult::RetryableFailure { reason })
        }

        "blocked" => {
            let Some(reason) = reason else {
                bail!("blocked result requires reason");
            };

            Ok(AgentTurnResult::Blocked { reason })
        }

        _ => {
            bail!("unsupported AMUX executor outcome")
        }
    }
}

impl AgentExecutor for CommandAgentExecutor {
    async fn execute(&self, delivery: &PulledDelivery) -> Result<AgentTurnResult> {
        let _ = (self, delivery);
        bail!(LOCAL_PROCESS_EXECUTION_FORBIDDEN)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn delivery(worker: &str) -> PulledDelivery {
        PulledDelivery {
            attempt_id: "attempt-1".into(),
            task_id: "task-1".into(),
            worker: worker.into(),
            task_revision: 1,
            prompt: "test prompt".into(),
            receipt_id: "receipt-1".into(),
            lease_expires_at: "2026-09-21T00:00:00Z".into(),
        }
    }

    #[tokio::test]
    async fn production_executor_path_never_spawns_a_configured_wrapper() {
        let marker_dir = TempDirBuilder::new()
            .prefix("tomverse amux marker ")
            .tempdir()
            .unwrap();
        let marker = marker_dir.path().join("wrapper-executed");
        assert!(
            marker.to_string_lossy().contains(' '),
            "the marker regression path must contain spaces",
        );

        #[cfg(windows)]
        let (program, args) = (
            "cmd.exe",
            vec![
                "/C".to_string(),
                format!("echo executed > \"{}\"", marker.display()),
            ],
        );

        #[cfg(not(windows))]
        let (program, args) = (
            "/bin/sh",
            vec![
                "-c".to_string(),
                format!("printf executed > '{}'", marker.display()),
            ],
        );

        // Prove the platform-specific quoting itself is sound. Otherwise a
        // missing marker could make the production containment assertion pass
        // even if the wrapper path had actually been invoked.
        let control = Command::new(program).args(&args).status().await.unwrap();
        assert!(control.success());
        assert!(marker.exists(), "control wrapper did not create its marker");
        fs::remove_file(&marker).unwrap();

        let executor = CommandAgentExecutor::from_json(
            &serde_json::json!({
                "workers": [{
                    "worker": "worker-a",
                    "program": program,
                    "args": args,
                }],
            })
            .to_string(),
        )
        .unwrap();

        let error = executor.execute(&delivery("worker-a")).await.unwrap_err();

        assert_eq!(error.to_string(), LOCAL_PROCESS_EXECUTION_FORBIDDEN);
        assert!(!marker.exists(), "configured wrapper must not run locally");
    }

    #[test]
    fn production_executor_construction_is_fail_closed() {
        let error = CommandAgentExecutor::from_env().unwrap_err();

        assert_eq!(error.to_string(), LOCAL_PROCESS_EXECUTION_FORBIDDEN);
    }

    #[test]
    fn lane_environment_is_empty_unless_bootstrap_names_are_declared() {
        let executor = CommandAgentExecutor::from_json(
            r#"{
              "workers": [
                {
                  "worker": "worker-a",
                  "program": "/opt/tomverse/agent-a"
                },
                {
                  "worker": "worker-b",
                  "program": "/opt/tomverse/agent-b",
                  "env_passthrough": ["PATH", " LANG "]
                }
              ]
            }"#,
        )
        .unwrap();

        assert!(executor.workers["worker-a"].env_passthrough.is_empty());
        assert_eq!(
            executor.workers["worker-b"].env_passthrough,
            vec!["PATH".to_string(), "LANG".to_string()],
        );
    }

    #[test]
    fn lane_environment_rejects_control_plane_secrets_and_unreviewed_names() {
        for name in RESERVED_EXECUTOR_ENV_NAMES.iter().copied().chain([
            "tomverse_amux_sync_secret",
            "OPENAI_API_KEY",
            "HAS-DASH",
        ]) {
            let raw = serde_json::json!({
                "workers": [{
                    "worker": "worker-a",
                    "program": "/opt/tomverse/agent-a",
                    "env_passthrough": [name],
                }],
            })
            .to_string();

            assert!(
                CommandAgentExecutor::from_json(&raw).is_err(),
                "{name} must not enter a test worker lane",
            );
        }

        let duplicate = r#"{
          "workers": [{
            "worker": "worker-a",
            "program": "/opt/tomverse/agent-a",
            "env_passthrough": ["PATH", "PATH"]
          }]
        }"#;

        assert!(CommandAgentExecutor::from_json(duplicate).is_err());
    }

    #[test]
    fn undeclared_parent_bootstrap_environment_is_not_inherited() {
        let sandbox = WorkerEnvironmentSandbox::new().unwrap();
        let mut command = Command::new("unused-test-program");

        configure_worker_environment(
            &mut command,
            [(OsString::from("PATH"), OsString::from("/parent/bin"))],
            sandbox.root(),
            &[],
        );

        let configured: BTreeMap<_, _> = command
            .as_std()
            .get_envs()
            .map(|(key, value)| (key.to_os_string(), value.map(OsStr::to_os_string)))
            .collect();

        assert!(!configured.contains_key(OsStr::new("PATH")));
        assert_eq!(configured.len(), ISOLATED_ENVIRONMENT_PATHS.len());
    }

    #[test]
    fn child_environment_is_cleared_then_rebuilt_from_a_closed_allowlist() {
        let sandbox = WorkerEnvironmentSandbox::new().unwrap();
        let mut command = Command::new("unused-test-program");

        configure_worker_environment(
            &mut command,
            [
                (OsString::from("PATH"), OsString::from("/safe/bin")),
                (OsString::from("HOME"), OsString::from("/safe/home")),
                (
                    OsString::from("TOMVERSE_AMUX_SYNC_SECRET"),
                    OsString::from("must-not-cross"),
                ),
                (
                    OsString::from("TOMVERSE_INTERNAL_URL"),
                    OsString::from("https://internal.invalid"),
                ),
                (
                    OsString::from("OPENAI_API_KEY"),
                    OsString::from("must-not-cross"),
                ),
                (
                    OsString::from("DATABASE_URL"),
                    OsString::from("must-not-cross"),
                ),
                (
                    OsString::from("FUTURE_UNREVIEWED_VALUE"),
                    OsString::from("must-not-cross"),
                ),
            ],
            sandbox.root(),
            &["PATH".to_string()],
        );

        let configured: BTreeMap<_, _> = command
            .as_std()
            .get_envs()
            .map(|(key, value)| (key.to_os_string(), value.map(OsStr::to_os_string)))
            .collect();

        assert_eq!(
            configured.get(OsStr::new("PATH")),
            Some(&Some(OsString::from("/safe/bin"))),
        );
        assert_eq!(
            configured.get(OsStr::new("HOME")),
            Some(&Some(sandbox.root().join("home").into_os_string())),
        );

        for key in [
            "TOMVERSE_AMUX_SYNC_SECRET",
            "TOMVERSE_INTERNAL_URL",
            "OPENAI_API_KEY",
            "DATABASE_URL",
            "FUTURE_UNREVIEWED_VALUE",
        ] {
            assert!(
                !configured.contains_key(OsStr::new(key)),
                "{key} must not enter the worker child",
            );
        }

        assert_eq!(configured.len(), 1 + ISOLATED_ENVIRONMENT_PATHS.len());
    }

    #[test]
    fn parent_environment_key_matching_follows_platform_rules() {
        assert!(is_worker_environment_key_allowed(OsStr::new("PATH")));
        assert_eq!(
            is_worker_environment_key_allowed(OsStr::new("path")),
            cfg!(windows),
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn spawned_child_receives_isolated_paths_without_parent_auth_state() {
        let sandbox = WorkerEnvironmentSandbox::new().unwrap();
        let mut command = Command::new("/usr/bin/env");

        configure_worker_environment(
            &mut command,
            [
                (OsString::from("PATH"), OsString::from("/usr/bin:/bin")),
                (OsString::from("HOME"), OsString::from("/parent/home")),
                (
                    OsString::from("CODEX_HOME"),
                    OsString::from("/parent/codex"),
                ),
                (
                    OsString::from("CLAUDE_CONFIG_DIR"),
                    OsString::from("/parent/claude"),
                ),
                (
                    OsString::from("TOMVERSE_AMUX_SYNC_SECRET"),
                    OsString::from("must-not-cross"),
                ),
                (
                    OsString::from("OPENAI_API_KEY"),
                    OsString::from("must-not-cross"),
                ),
            ],
            sandbox.root(),
            &["PATH".to_string()],
        );

        let output = command.as_std_mut().output().unwrap();

        assert!(output.status.success());

        let stdout = String::from_utf8(output.stdout).unwrap();
        let child_environment: BTreeMap<_, _> = stdout
            .lines()
            .filter_map(|line| line.split_once('='))
            .collect();
        let sandbox_prefix = sandbox.root().to_string_lossy();

        for (key, _) in ISOLATED_ENVIRONMENT_PATHS {
            let value = child_environment
                .get(key)
                .unwrap_or_else(|| panic!("{key} missing from spawned child"));

            assert!(
                value.starts_with(sandbox_prefix.as_ref()),
                "{key} must point inside the per-turn sandbox",
            );
        }

        assert_eq!(child_environment.get("PATH"), Some(&"/usr/bin:/bin"));
        assert!(!child_environment.contains_key("TOMVERSE_AMUX_SYNC_SECRET"));
        assert!(!child_environment.contains_key("OPENAI_API_KEY"));
        assert!(!stdout.contains("/parent/home"));
        assert!(!stdout.contains("/parent/codex"));
        assert!(!stdout.contains("/parent/claude"));
    }

    #[test]
    fn config_is_strict_and_worker_names_are_deterministic() {
        let executor = CommandAgentExecutor::from_json(
            r#"{
                  "workers": [
                    {
                      "worker": "worker-b",
                      "program": "/opt/tomverse/agent-b",
                      "args": ["--json"]
                    },
                    {
                      "worker": "worker-a",
                      "program": "/opt/tomverse/agent-a"
                    }
                  ]
                }"#,
        )
        .unwrap();

        assert_eq!(
            executor.worker_names(),
            vec!["worker-a".to_string(), "worker-b".to_string(),]
        );
    }

    #[test]
    fn duplicate_worker_configuration_is_rejected() {
        let result = CommandAgentExecutor::from_json(
            r#"{
                  "workers": [
                    {
                      "worker": "worker-a",
                      "program": "/one"
                    },
                    {
                      "worker": "worker-a",
                      "program": "/two"
                    }
                  ]
                }"#,
        );

        assert!(result.is_err());
    }

    #[test]
    fn result_protocol_maps_all_worker_outcomes() {
        let done = parse_executor_output(
            br#"{
                  "protocol_version":
                    "tomverse-amux-agent-result-v1",
                  "outcome": "done"
                }"#,
        )
        .unwrap();

        assert_eq!(done, AgentTurnResult::SucceededDone);

        let retry = parse_executor_output(
            br#"{
                  "protocol_version":
                    "tomverse-amux-agent-result-v1",
                  "outcome": "retry",
                  "reason": "provider unavailable"
                }"#,
        )
        .unwrap();

        assert_eq!(
            retry,
            AgentTurnResult::RetryableFailure {
                reason: "provider unavailable".into(),
            }
        );

        let blocked = parse_executor_output(
            br#"{
                  "protocol_version":
                    "tomverse-amux-agent-result-v1",
                  "outcome": "blocked",
                  "reason": "needs approval"
                }"#,
        )
        .unwrap();

        assert_eq!(
            blocked,
            AgentTurnResult::Blocked {
                reason: "needs approval".into(),
            }
        );
    }

    #[test]
    fn result_protocol_fails_closed_on_ambiguous_output() {
        assert!(parse_executor_output(
            br#"{
                  "protocol_version":
                    "tomverse-amux-agent-result-v1",
                  "outcome": "retry"
                }"#,
        )
        .is_err());

        assert!(parse_executor_output(
            br#"{
                  "protocol_version":
                    "tomverse-amux-agent-result-v1",
                  "outcome": "done",
                  "reason": "unexpected"
                }"#,
        )
        .is_err());

        assert!(parse_executor_output(
            br#"{
                  "protocol_version":
                    "wrong-version",
                  "outcome": "done"
                }"#,
        )
        .is_err());
    }
}
