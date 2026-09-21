use std::{
    collections::BTreeMap,
    process::Stdio,
    sync::Arc,
};

use anyhow::{
    bail,
    Context,
    Result,
};
use serde::{
    Deserialize,
    Serialize,
};
use tokio::{
    io::AsyncWriteExt,
    process::Command,
};

use crate::{
    tomverse_api::PulledDelivery,
    worker_protocol::{
        AgentExecutor,
        AgentTurnResult,
    },
};

const EXECUTOR_CONFIG_ENV: &str =
    "TOMVERSE_AMUX_EXECUTOR_COMMANDS_JSON";

const EXECUTOR_INPUT_VERSION: &str =
    "tomverse-amux-agent-exec-v1";

const EXECUTOR_OUTPUT_VERSION: &str =
    "tomverse-amux-agent-result-v1";

const MAX_EXECUTOR_OUTPUT_BYTES: usize =
    64 * 1024;

const MAX_REASON_BYTES: usize =
    4 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecutorConfigDocument {
    workers: Vec<WorkerCommandSpec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerCommandSpec {
    worker: String,
    program: String,

    #[serde(default)]
    args: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct CommandAgentExecutor {
    workers:
        Arc<BTreeMap<String, WorkerCommandSpec>>,
}

impl CommandAgentExecutor {
    pub fn from_env() -> Result<Self> {
        let raw =
            std::env::var(EXECUTOR_CONFIG_ENV)
                .with_context(|| {
                    format!(
                        "{EXECUTOR_CONFIG_ENV} is required"
                    )
                })?;

        Self::from_json(&raw)
    }

    fn from_json(raw: &str) -> Result<Self> {
        let document:
            ExecutorConfigDocument =
            serde_json::from_str(raw)
                .context(
                    "invalid AMUX executor command configuration",
                )?;

        if document.workers.is_empty() {
            bail!(
                "AMUX executor configuration has no workers"
            );
        }

        if document.workers.len() > 128 {
            bail!(
                "AMUX executor configuration exceeds 128 workers"
            );
        }

        let mut workers =
            BTreeMap::new();

        for raw_spec in document.workers {
            let worker =
                raw_spec.worker.trim().to_owned();

            if !valid_worker_name(&worker) {
                bail!(
                    "invalid AMUX executor worker name"
                );
            }

            let program =
                raw_spec.program.trim().to_owned();

            if program.is_empty()
                || program.len() > 4096
                || program.contains('\0')
            {
                bail!(
                    "invalid AMUX executor program"
                );
            }

            if raw_spec.args.len() > 64 {
                bail!(
                    "AMUX executor command has too many arguments"
                );
            }

            for arg in &raw_spec.args {
                if arg.len() > 4096
                    || arg.contains('\0')
                {
                    bail!(
                        "invalid AMUX executor argument"
                    );
                }
            }

            let spec =
                WorkerCommandSpec {
                    worker: worker.clone(),
                    program,
                    args: raw_spec.args,
                };

            if workers
                .insert(
                    worker,
                    spec,
                )
                .is_some()
            {
                bail!(
                    "duplicate AMUX executor worker"
                );
            }
        }

        Ok(Self {
            workers:
                Arc::new(workers),
        })
    }

    pub fn worker_names(
        &self,
    ) -> Vec<String> {
        self.workers
            .keys()
            .cloned()
            .collect()
    }

    fn command_for(
        &self,
        worker: &str,
    ) -> Result<&WorkerCommandSpec> {
        self.workers
            .get(worker)
            .with_context(|| {
                format!(
                    "no configured AMUX executor for worker {worker}"
                )
            })
    }
}

fn valid_worker_name(
    value: &str,
) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value.chars().all(
            |ch| {
                ch.is_ascii_alphanumeric()
                    || matches!(
                        ch,
                        '.'
                            | '_'
                            | ':'
                            | '-'
                    )
            },
        )
}

#[derive(Debug, Serialize)]
struct ExecutorInput<'a> {
    protocol_version: &'static str,
    attempt_id: &'a str,
    task_id: &'a str,
    worker: &'a str,
    task_revision: i64,
    prompt: &'a str,
    receipt_id: &'a str,
    lease_expires_at: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecutorOutput {
    protocol_version: String,
    outcome: String,

    #[serde(default)]
    reason: Option<String>,
}

fn normalized_reason(
    reason: Option<String>,
) -> Result<Option<String>> {
    let reason =
        reason
            .map(
                |value| {
                    value.trim().to_owned()
                },
            )
            .filter(
                |value| !value.is_empty(),
            );

    if reason
        .as_ref()
        .is_some_and(
            |value| {
                value.len()
                    > MAX_REASON_BYTES
            },
        )
    {
        bail!(
            "AMUX executor reason exceeds limit"
        );
    }

    Ok(reason)
}

fn parse_executor_output(
    bytes: &[u8],
) -> Result<AgentTurnResult> {
    if bytes.len()
        > MAX_EXECUTOR_OUTPUT_BYTES
    {
        bail!(
            "AMUX executor output exceeds limit"
        );
    }

    let output:
        ExecutorOutput =
        serde_json::from_slice(bytes)
            .context(
                "invalid AMUX executor result JSON",
            )?;

    if output.protocol_version
        != EXECUTOR_OUTPUT_VERSION
    {
        bail!(
            "unsupported AMUX executor result protocol"
        );
    }

    let reason =
        normalized_reason(output.reason)?;

    match output.outcome.as_str() {
        "done" => {
            if reason.is_some() {
                bail!(
                    "done result must not include reason"
                );
            }

            Ok(
                AgentTurnResult::SucceededDone,
            )
        }

        "review" => {
            if reason.is_some() {
                bail!(
                    "review result must not include reason"
                );
            }

            Ok(
                AgentTurnResult::SucceededReview,
            )
        }

        "retry" => {
            let Some(reason) = reason
            else {
                bail!(
                    "retry result requires reason"
                );
            };

            Ok(
                AgentTurnResult::RetryableFailure {
                    reason,
                },
            )
        }

        "blocked" => {
            let Some(reason) = reason
            else {
                bail!(
                    "blocked result requires reason"
                );
            };

            Ok(
                AgentTurnResult::Blocked {
                    reason,
                },
            )
        }

        _ => {
            bail!(
                "unsupported AMUX executor outcome"
            )
        }
    }
}

impl AgentExecutor for CommandAgentExecutor {
    async fn execute(
        &self,
        delivery: &PulledDelivery,
    ) -> Result<AgentTurnResult> {
        let spec =
            self.command_for(
                &delivery.worker,
            )?;

        let input =
            ExecutorInput {
                protocol_version:
                    EXECUTOR_INPUT_VERSION,
                attempt_id:
                    &delivery.attempt_id,
                task_id:
                    &delivery.task_id,
                worker:
                    &delivery.worker,
                task_revision:
                    delivery.task_revision,
                prompt:
                    &delivery.prompt,
                receipt_id:
                    &delivery.receipt_id,
                lease_expires_at:
                    &delivery.lease_expires_at,
            };

        let mut payload =
            serde_json::to_vec(&input)
                .context(
                    "failed to serialize AMUX executor input",
                )?;

        payload.push(b'\n');

        let mut command =
            Command::new(
                &spec.program,
            );

        command
            .args(&spec.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            /*
             * Provider/wrapper stderr may contain task or provider output.
             * Do not copy it into orchestrator logs by default.
             */
            .stderr(Stdio::null())
            /*
             * WorkerProtocol cancels execute() when runtime/execution fencing
             * is lost. Dropping this future must terminate its child process.
             */
            .kill_on_drop(true);

        let mut child =
            command
                .spawn()
                .context(
                    "failed to spawn configured AMUX executor",
                )?;

        let mut stdin =
            child
                .stdin
                .take()
                .context(
                    "configured AMUX executor has no stdin",
                )?;

        stdin
            .write_all(&payload)
            .await
            .context(
                "failed to write AMUX executor input",
            )?;

        stdin
            .shutdown()
            .await
            .context(
                "failed to close AMUX executor stdin",
            )?;

        drop(stdin);

        let output =
            child
                .wait_with_output()
                .await
                .context(
                    "failed while waiting for AMUX executor",
                )?;

        if !output.status.success() {
            bail!(
                "configured AMUX executor exited unsuccessfully"
            );
        }

        parse_executor_output(
            &output.stdout,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_is_strict_and_worker_names_are_deterministic() {
        let executor =
            CommandAgentExecutor::from_json(
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
            vec![
                "worker-a".to_string(),
                "worker-b".to_string(),
            ]
        );
    }

    #[test]
    fn duplicate_worker_configuration_is_rejected() {
        let result =
            CommandAgentExecutor::from_json(
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
        let done =
            parse_executor_output(
                br#"{
                  "protocol_version":
                    "tomverse-amux-agent-result-v1",
                  "outcome": "done"
                }"#,
            )
            .unwrap();

        assert_eq!(
            done,
            AgentTurnResult::SucceededDone
        );

        let retry =
            parse_executor_output(
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
                reason:
                    "provider unavailable"
                        .into(),
            }
        );

        let blocked =
            parse_executor_output(
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
                reason:
                    "needs approval".into(),
            }
        );
    }

    #[test]
    fn result_protocol_fails_closed_on_ambiguous_output() {
        assert!(
            parse_executor_output(
                br#"{
                  "protocol_version":
                    "tomverse-amux-agent-result-v1",
                  "outcome": "retry"
                }"#,
            )
            .is_err()
        );

        assert!(
            parse_executor_output(
                br#"{
                  "protocol_version":
                    "tomverse-amux-agent-result-v1",
                  "outcome": "done",
                  "reason": "unexpected"
                }"#,
            )
            .is_err()
        );

        assert!(
            parse_executor_output(
                br#"{
                  "protocol_version":
                    "wrong-version",
                  "outcome": "done"
                }"#,
            )
            .is_err()
        );
    }
}
