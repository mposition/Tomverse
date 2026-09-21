use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        RwLock,
    },
    time::Duration,
};

use anyhow::{
    anyhow,
    bail,
    Context,
    Result,
};
use tokio::task::JoinSet;
use tracing::{
    info,
    warn,
};
use uuid::Uuid;

use crate::{
    board_driver::{
        BoardDriver,
        DriveOutcome,
        RuntimeIdentity,
        WorkerAdapter,
    },
    executor::CommandAgentExecutor,
    tomverse_api::TomverseApi,
    worker_protocol::{
        WorkerPollOutcome,
        WorkerProtocol,
        DEFAULT_WORKER_HEARTBEAT_INTERVAL,
    },
};

const BOARD_TICK_INTERVAL:
    Duration = Duration::from_secs(1);

const WORKER_POLL_INTERVAL:
    Duration = Duration::from_secs(2);

#[derive(Debug, Clone)]
enum RuntimeState {
    Live {
        identity: RuntimeIdentity,
        boundary: bool,
    },
    Quarantined,
}

#[derive(Debug, Clone, Default)]
pub struct RuntimeRegistry {
    entries:
        Arc<RwLock<BTreeMap<String, RuntimeState>>>,
}

impl RuntimeRegistry {
    fn insert_live(
        &self,
        worker: String,
        identity: RuntimeIdentity,
    ) -> Result<()> {
        let mut entries =
            self.entries
                .write()
                .map_err(
                    |_| {
                        anyhow!(
                            "AMUX runtime registry write lock poisoned"
                        )
                    },
                )?;

        if entries.contains_key(&worker) {
            bail!(
                "AMUX worker already exists in this runtime process"
            );
        }

        entries.insert(
            worker,
            RuntimeState::Live {
                identity,
                boundary: true,
            },
        );

        Ok(())
    }

    fn set_boundary(
        &self,
        worker: &str,
        boundary: bool,
    ) -> Result<()> {
        let mut entries =
            self.entries
                .write()
                .map_err(
                    |_| {
                        anyhow!(
                            "AMUX runtime registry write lock poisoned"
                        )
                    },
                )?;

        let Some(state) =
            entries.get_mut(worker)
        else {
            bail!(
                "AMUX worker is absent from runtime registry"
            );
        };

        match state {
            RuntimeState::Live {
                boundary:
                    stored_boundary,
                ..
            } => {
                *stored_boundary =
                    boundary;
                Ok(())
            }

            RuntimeState::Quarantined => {
                bail!(
                    "AMUX worker is quarantined"
                )
            }
        }
    }

    fn quarantine(
        &self,
        worker: &str,
    ) -> Result<()> {
        let mut entries =
            self.entries
                .write()
                .map_err(
                    |_| {
                        anyhow!(
                            "AMUX runtime registry write lock poisoned"
                        )
                    },
                )?;

        entries.insert(
            worker.to_owned(),
            RuntimeState::Quarantined,
        );

        Ok(())
    }
}

impl WorkerAdapter for RuntimeRegistry {
    async fn is_running(
        &self,
        worker: &str,
    ) -> Result<bool> {
        let entries =
            self.entries
                .read()
                .map_err(
                    |_| {
                        anyhow!(
                            "AMUX runtime registry read lock poisoned"
                        )
                    },
                )?;

        Ok(matches!(
            entries.get(worker),
            Some(RuntimeState::Live {
                ..
            })
        ))
    }

    async fn start_for_dispatch(
        &self,
        worker: &str,
    ) -> Result<()> {
        /*
         * Worker processes are registered exactly once by RuntimeService
         * startup. BoardDriver never creates or re-registers a worker.
         *
         * A worker may have appeared between is_running() and this call; that
         * race is harmless, so accept only that already-live case.
         */
        if self
            .is_running(worker)
            .await?
        {
            return Ok(());
        }

        bail!(
            "AMUX worker service is not live; automatic start/re-registration is disabled"
        )
    }

    async fn at_boundary(
        &self,
        worker: &str,
    ) -> Result<bool> {
        let entries =
            self.entries
                .read()
                .map_err(
                    |_| {
                        anyhow!(
                            "AMUX runtime registry read lock poisoned"
                        )
                    },
                )?;

        Ok(matches!(
            entries.get(worker),
            Some(RuntimeState::Live {
                boundary: true,
                ..
            })
        ))
    }

    async fn runtime_identity(
        &self,
        worker: &str,
    ) -> Result<Option<RuntimeIdentity>> {
        let entries =
            self.entries
                .read()
                .map_err(
                    |_| {
                        anyhow!(
                            "AMUX runtime registry read lock poisoned"
                        )
                    },
                )?;

        Ok(match entries.get(worker) {
            Some(RuntimeState::Live {
                identity,
                boundary: true,
            }) => {
                Some(identity.clone())
            }

            _ => None,
        })
    }
}

#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
)]
enum PollDisposition {
    Boundary,
    Busy,
    Quarantine,
}

fn poll_disposition(
    outcome: &WorkerPollOutcome,
) -> PollDisposition {
    match outcome {
        WorkerPollOutcome::Idle => {
            PollDisposition::Boundary
        }

        WorkerPollOutcome::WaitingForDelivery => {
            PollDisposition::Busy
        }

        WorkerPollOutcome::Settled {
            idle_accepted: true,
            ..
        } => {
            PollDisposition::Boundary
        }

        WorkerPollOutcome::Settled {
            idle_accepted: false,
            ..
        }
        | WorkerPollOutcome::AckRefused {
            ..
        }
        | WorkerPollOutcome::LeaseLost {
            ..
        }
        | WorkerPollOutcome::SettleRefused {
            ..
        } => {
            PollDisposition::Quarantine
        }
    }
}

pub struct RuntimeService {
    api: TomverseApi,
    executor: CommandAgentExecutor,
    registry: RuntimeRegistry,
}

impl RuntimeService {
    pub fn new(
        api: TomverseApi,
        executor: CommandAgentExecutor,
    ) -> Self {
        Self {
            api,
            executor,
            registry:
                RuntimeRegistry::default(),
        }
    }

    pub async fn run(
        self,
    ) -> Result<()> {
        let workers =
            self.executor.worker_names();

        let mut protocols =
            Vec::with_capacity(
                workers.len(),
            );

        /*
         * Initial registration is deliberate and one-shot.
         *
         * If startup registration fails, fail this service. Once registration
         * succeeds, later fence loss quarantines that worker and never
         * re-registers it inside this process.
         */
        for worker in workers {
            let instance_id =
                Uuid::new_v4()
                    .to_string();

            let protocol =
                WorkerProtocol::register(
                    self.api.clone(),
                    self.executor.clone(),
                    worker.clone(),
                    instance_id,
                    DEFAULT_WORKER_HEARTBEAT_INTERVAL,
                )
                .await
                .with_context(
                    || {
                        format!(
                            "failed to register AMUX worker {worker}"
                        )
                    },
                )?;

            self.registry
                .insert_live(
                    worker.clone(),
                    RuntimeIdentity {
                        instance_id:
                            protocol
                                .instance_id()
                                .to_owned(),
                        generation:
                            protocol.generation(),
                    },
                )?;

            info!(
                worker = %worker,
                instance_id =
                    %protocol.instance_id(),
                generation =
                    protocol.generation(),
                "AMUX worker service registered"
            );

            protocols.push(protocol);
        }

        let mut tasks =
            JoinSet::new();

        for protocol in protocols {
            let registry =
                self.registry.clone();

            tasks.spawn(
                async move {
                    run_worker_loop(
                        protocol,
                        registry,
                    )
                    .await
                },
            );
        }

        {
            let api =
                self.api.clone();

            let registry =
                self.registry.clone();

            tasks.spawn(
                async move {
                    run_board_loop(
                        api,
                        registry,
                    )
                    .await
                },
            );
        }

        loop {
            let Some(joined) =
                tasks.join_next().await
            else {
                bail!(
                    "all AMUX runtime service tasks exited"
                );
            };

            match joined {
                Ok(Ok(())) => {
                    /*
                     * A quarantined worker task may end normally. Other worker
                     * tasks and the BoardDriver remain live.
                     */
                    warn!(
                        "an AMUX runtime task exited"
                    );
                }

                Ok(Err(error)) => {
                    return Err(error)
                        .context(
                            "AMUX runtime task failed",
                        );
                }

                Err(error) => {
                    return Err(anyhow!(
                        "AMUX runtime task join failure: {error}"
                    ));
                }
            }
        }
    }
}

async fn run_worker_loop(
    protocol:
        WorkerProtocol<
            TomverseApi,
            CommandAgentExecutor,
        >,
    registry: RuntimeRegistry,
) -> Result<()> {
    let worker =
        protocol
            .worker_name()
            .to_owned();

    loop {
        /*
         * Stay dispatch-ready during the sleep window. This gives BoardDriver
         * a stable positive boundary from which it may start exactly one
         * execution. The server runtime/attempt CAS remains authoritative.
         */
        tokio::time::sleep(
            WORKER_POLL_INTERVAL,
        )
        .await;

        registry
            .set_boundary(
                &worker,
                false,
            )?;

        let outcome =
            match protocol
                .poll_once()
                .await
            {
                Ok(outcome) => outcome,

                Err(error) => {
                    registry
                        .quarantine(
                            &worker,
                        )?;

                    warn!(
                        worker = %worker,
                        %error,
                        "AMUX worker poll failed; worker quarantined without re-registration"
                    );

                    return Ok(());
                }
            };

        match poll_disposition(
            &outcome,
        ) {
            PollDisposition::Boundary => {
                registry
                    .set_boundary(
                        &worker,
                        true,
                    )?;
            }

            PollDisposition::Busy => {
                /*
                 * Keep the registry non-dispatchable while an execution is
                 * known or suspected to be waiting for durable delivery.
                 */
            }

            PollDisposition::Quarantine => {
                registry
                    .quarantine(
                        &worker,
                    )?;

                warn!(
                    worker = %worker,
                    outcome = ?outcome,
                    "AMUX worker authority became ambiguous or fenced; worker quarantined"
                );

                return Ok(());
            }
        }
    }
}

async fn run_board_loop(
    api: TomverseApi,
    registry: RuntimeRegistry,
) -> Result<()> {
    let driver =
        BoardDriver::new(
            api,
            registry,
        );

    loop {
        match driver.tick().await {
            Ok(outcomes) => {
                for outcome in outcomes {
                    if let
                        DriveOutcome::ExecutionStarted {
                            task_id,
                            worker,
                            attempt_id,
                            task_revision,
                        } = outcome
                    {
                        info!(
                            task_id = %task_id,
                            worker = %worker,
                            attempt_id = %attempt_id,
                            task_revision,
                            "AMUX execution started with atomic durable delivery"
                        );
                    }
                }
            }

            Err(error) => {
                /*
                 * A lost execution_start HTTP response may still represent a
                 * committed server transaction. Never compensate locally.
                 * WorkerProtocol may consume the atomic durable delivery.
                 */
                warn!(
                    %error,
                    "AMUX BoardDriver tick failed"
                );
            }
        }

        tokio::time::sleep(
            BOARD_TICK_INTERVAL,
        )
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> RuntimeIdentity {
        RuntimeIdentity {
            instance_id:
                "00000000-0000-4000-8000-000000000099"
                    .into(),
            generation: 9,
        }
    }

    #[tokio::test]
    async fn registry_exposes_identity_only_at_dispatch_boundary() {
        let registry =
            RuntimeRegistry::default();

        registry
            .insert_live(
                "worker-a".into(),
                identity(),
            )
            .unwrap();

        assert_eq!(
            registry
                .is_running(
                    "worker-a",
                )
                .await
                .unwrap(),
            true,
        );

        assert_eq!(
            registry
                .at_boundary(
                    "worker-a",
                )
                .await
                .unwrap(),
            true,
        );

        assert_eq!(
            registry
                .runtime_identity(
                    "worker-a",
                )
                .await
                .unwrap(),
            Some(identity()),
        );

        registry
            .set_boundary(
                "worker-a",
                false,
            )
            .unwrap();

        assert_eq!(
            registry
                .runtime_identity(
                    "worker-a",
                )
                .await
                .unwrap(),
            None,
        );
    }

    #[tokio::test]
    async fn quarantined_worker_cannot_reenter_dispatch_in_same_process() {
        let registry =
            RuntimeRegistry::default();

        registry
            .insert_live(
                "worker-a".into(),
                identity(),
            )
            .unwrap();

        registry
            .quarantine(
                "worker-a",
            )
            .unwrap();

        assert_eq!(
            registry
                .is_running(
                    "worker-a",
                )
                .await
                .unwrap(),
            false,
        );

        assert_eq!(
            registry
                .at_boundary(
                    "worker-a",
                )
                .await
                .unwrap(),
            false,
        );

        assert_eq!(
            registry
                .runtime_identity(
                    "worker-a",
                )
                .await
                .unwrap(),
            None,
        );

        assert!(
            registry
                .insert_live(
                    "worker-a".into(),
                    identity(),
                )
                .is_err()
        );
    }

    #[tokio::test]
    async fn board_adapter_never_autostarts_an_absent_worker() {
        let registry =
            RuntimeRegistry::default();

        assert!(
            registry
                .start_for_dispatch(
                    "worker-a",
                )
                .await
                .is_err()
        );

        assert_eq!(
            registry
                .is_running(
                    "worker-a",
                )
                .await
                .unwrap(),
            false,
        );
    }

    #[test]
    fn fenced_or_ambiguous_poll_outcomes_quarantine_worker() {
        assert_eq!(
            poll_disposition(
                &WorkerPollOutcome::Idle,
            ),
            PollDisposition::Boundary,
        );

        assert_eq!(
            poll_disposition(
                &WorkerPollOutcome::WaitingForDelivery,
            ),
            PollDisposition::Busy,
        );

        assert_eq!(
            poll_disposition(
                &WorkerPollOutcome::LeaseLost {
                    attempt_id: None,
                    reason:
                        Some(
                            "fenced_out"
                                .into(),
                        ),
                },
            ),
            PollDisposition::Quarantine,
        );

        assert_eq!(
            poll_disposition(
                &WorkerPollOutcome::AckRefused {
                    attempt_id:
                        "attempt-a".into(),
                    reason:
                        Some(
                            "fenced_out"
                                .into(),
                        ),
                },
            ),
            PollDisposition::Quarantine,
        );

        assert_eq!(
            poll_disposition(
                &WorkerPollOutcome::SettleRefused {
                    attempt_id:
                        "attempt-a".into(),
                    reason:
                        Some(
                            "fenced_out"
                                .into(),
                        ),
                },
            ),
            PollDisposition::Quarantine,
        );

        assert_eq!(
            poll_disposition(
                &WorkerPollOutcome::Settled {
                    attempt_id:
                        "attempt-a".into(),
                    to_status:
                        "done".into(),
                    idle_accepted: false,
                },
            ),
            PollDisposition::Quarantine,
        );
    }
}
