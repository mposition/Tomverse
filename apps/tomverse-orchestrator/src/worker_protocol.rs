use std::time::Duration;

use anyhow::Result;

use crate::tomverse_api::{
    DeliveryAckResponse,
    DeliveryPullResponse,
    ExecutionHeartbeatResponse,
    ExecutionSettleResponse,
    PulledDelivery,
    TomverseApi,
    WorkerHeartbeatResponse,
    WorkerRegisterResponse,
};

pub const DEFAULT_WORKER_HEARTBEAT_INTERVAL:
    Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentTurnResult {
    SucceededDone,
    SucceededReview,
    RetryableFailure {
        reason: String,
    },
    Blocked {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerPollOutcome {
    Idle,
    WaitingForDelivery,
    AckRefused {
        attempt_id: String,
        reason: Option<String>,
    },
    LeaseLost {
        attempt_id: Option<String>,
        reason: Option<String>,
    },
    SettleRefused {
        attempt_id: String,
        reason: Option<String>,
    },
    Settled {
        attempt_id: String,
        to_status: String,
        idle_accepted: bool,
    },
}

#[allow(async_fn_in_trait)]
pub trait WorkerControlPlane: Send + Sync {
    async fn register(
        &self,
        worker: &str,
        instance_id: &str,
    ) -> Result<WorkerRegisterResponse>;

    async fn worker_heartbeat(
        &self,
        worker: &str,
        instance_id: &str,
        generation: i64,
        status: &str,
        dispatch_ready: bool,
    ) -> Result<WorkerHeartbeatResponse>;

    async fn delivery_pull(
        &self,
        worker: &str,
        instance_id: &str,
        generation: i64,
    ) -> Result<DeliveryPullResponse>;

    async fn delivery_ack(
        &self,
        delivery: &PulledDelivery,
        instance_id: &str,
        generation: i64,
    ) -> Result<DeliveryAckResponse>;

    async fn execution_heartbeat(
        &self,
        delivery: &PulledDelivery,
        instance_id: &str,
        generation: i64,
    ) -> Result<ExecutionHeartbeatResponse>;

    async fn execution_settle(
        &self,
        delivery: &PulledDelivery,
        instance_id: &str,
        generation: i64,
        result: &AgentTurnResult,
    ) -> Result<ExecutionSettleResponse>;
}

#[allow(async_fn_in_trait)]
pub trait AgentExecutor: Send + Sync {
    /**
     * Executes exactly one acknowledged durable delivery.
     *
     * The returned future must be cancellation-safe: if either server-side
     * runtime or execution fencing is lost, WorkerProtocol drops this future
     * and does not send a settlement callback.
     */
    async fn execute(
        &self,
        delivery: &PulledDelivery,
    ) -> Result<AgentTurnResult>;
}

impl WorkerControlPlane for TomverseApi {
    async fn register(
        &self,
        worker: &str,
        instance_id: &str,
    ) -> Result<WorkerRegisterResponse> {
        TomverseApi::worker_register(
            self,
            worker,
            instance_id,
        )
        .await
    }

    async fn worker_heartbeat(
        &self,
        worker: &str,
        instance_id: &str,
        generation: i64,
        status: &str,
        dispatch_ready: bool,
    ) -> Result<WorkerHeartbeatResponse> {
        TomverseApi::worker_heartbeat(
            self,
            worker,
            instance_id,
            generation,
            status,
            dispatch_ready,
        )
        .await
    }

    async fn delivery_pull(
        &self,
        worker: &str,
        instance_id: &str,
        generation: i64,
    ) -> Result<DeliveryPullResponse> {
        TomverseApi::delivery_pull(
            self,
            worker,
            instance_id,
            generation,
        )
        .await
    }

    async fn delivery_ack(
        &self,
        delivery: &PulledDelivery,
        instance_id: &str,
        generation: i64,
    ) -> Result<DeliveryAckResponse> {
        TomverseApi::delivery_ack(
            self,
            delivery,
            instance_id,
            generation,
        )
        .await
    }

    async fn execution_heartbeat(
        &self,
        delivery: &PulledDelivery,
        instance_id: &str,
        generation: i64,
    ) -> Result<ExecutionHeartbeatResponse> {
        TomverseApi::execution_heartbeat(
            self,
            delivery,
            instance_id,
            generation,
        )
        .await
    }

    async fn execution_settle(
        &self,
        delivery: &PulledDelivery,
        instance_id: &str,
        generation: i64,
        result: &AgentTurnResult,
    ) -> Result<ExecutionSettleResponse> {
        let (
            outcome,
            to_status,
            reason,
        ) = settlement_fields(result);

        TomverseApi::execution_settle(
            self,
            &delivery.attempt_id,
            &delivery.worker,
            instance_id,
            generation,
            delivery.task_revision,
            outcome,
            to_status,
            reason,
        )
        .await
    }
}

fn settlement_fields(
    result: &AgentTurnResult,
) -> (
    &'static str,
    &'static str,
    Option<&str>,
) {
    match result {
        AgentTurnResult::SucceededDone => (
            "succeeded",
            "done",
            None,
        ),
        AgentTurnResult::SucceededReview => (
            "succeeded",
            "review",
            None,
        ),
        AgentTurnResult::RetryableFailure {
            reason,
        } => (
            "failed",
            "todo",
            Some(reason.as_str()),
        ),
        AgentTurnResult::Blocked {
            reason,
        } => (
            "blocked",
            "blocked",
            Some(reason.as_str()),
        ),
    }
}

pub struct WorkerProtocol<C, E> {
    control: C,
    executor: E,
    worker: String,
    instance_id: String,
    generation: i64,
    heartbeat_interval: Duration,
}

impl<C, E> WorkerProtocol<C, E>
where
    C: WorkerControlPlane,
    E: AgentExecutor,
{
    pub async fn register(
        control: C,
        executor: E,
        worker: String,
        instance_id: String,
        heartbeat_interval: Duration,
    ) -> Result<Self> {
        let registered = control
            .register(
                &worker,
                &instance_id,
            )
            .await?;

        if !registered.registered {
            anyhow::bail!(
                "AMUX worker registration refused: {}",
                registered
                    .reason
                    .as_deref()
                    .unwrap_or("unknown")
            );
        }

        let Some(generation) =
            registered.generation
        else {
            anyhow::bail!(
                "AMUX worker registration succeeded without generation"
            );
        };

        /*
         * Registration creates starting/not-ready. Only a positive idle
         * boundary makes this process available for BoardDriver dispatch.
         */
        let idle = control
            .worker_heartbeat(
                &worker,
                &instance_id,
                generation,
                "idle",
                true,
            )
            .await?;

        if !idle.accepted {
            anyhow::bail!(
                "initial AMUX idle heartbeat refused: {}",
                idle.reason
                    .as_deref()
                    .unwrap_or("unknown")
            );
        }

        Ok(Self {
            control,
            executor,
            worker,
            instance_id,
            generation,
            heartbeat_interval,
        })
    }

    pub fn worker_name(
        &self,
    ) -> &str {
        &self.worker
    }

    pub fn instance_id(
        &self,
    ) -> &str {
        &self.instance_id
    }

    pub fn generation(
        &self,
    ) -> i64 {
        self.generation
    }

    pub async fn poll_once(
        &self,
    ) -> Result<WorkerPollOutcome> {
        /*
         * An idle heartbeat racing BoardDriver may lose with
         * `active_execution`. That is not lease loss; it means execution
         * authority may already be waiting in the durable delivery queue.
         */
        let idle = self
            .control
            .worker_heartbeat(
                &self.worker,
                &self.instance_id,
                self.generation,
                "idle",
                true,
            )
            .await?;

        if !idle.accepted
            && idle.reason.as_deref()
                != Some("active_execution")
        {
            return Ok(
                WorkerPollOutcome::LeaseLost {
                    attempt_id: None,
                    reason: idle.reason,
                },
            );
        }

        let pulled = self
            .control
            .delivery_pull(
                &self.worker,
                &self.instance_id,
                self.generation,
            )
            .await?;

        if !pulled.available {
            return match pulled.reason.as_deref() {
                /*
                 * If idle was just accepted, runtime_not_ready simply means
                 * there is no active execution yet. If idle lost with
                 * active_execution, enqueue may still be between commit steps;
                 * retry rather than inventing a failure.
                 */
                Some("runtime_not_ready")
                    if idle.accepted =>
                {
                    Ok(WorkerPollOutcome::Idle)
                }
                Some("runtime_not_ready") => {
                    Ok(
                        WorkerPollOutcome::WaitingForDelivery,
                    )
                }
                Some("none") | None => {
                    if idle.accepted {
                        Ok(WorkerPollOutcome::Idle)
                    } else {
                        Ok(
                            WorkerPollOutcome::WaitingForDelivery,
                        )
                    }
                }
                other => Ok(
                    WorkerPollOutcome::LeaseLost {
                        attempt_id: None,
                        reason: other.map(str::to_owned),
                    },
                ),
            };
        }

        let Some(delivery) =
            pulled.delivery
        else {
            anyhow::bail!(
                "delivery pull reported available without delivery"
            );
        };

        if delivery.worker != self.worker {
            anyhow::bail!(
                "delivery worker does not match registered worker"
            );
        }

        let ack = self
            .control
            .delivery_ack(
                &delivery,
                &self.instance_id,
                self.generation,
            )
            .await?;

        if !ack.acknowledged {
            return Ok(
                WorkerPollOutcome::AckRefused {
                    attempt_id:
                        delivery.attempt_id,
                    reason: ack.reason,
                },
            );
        }

        /*
         * Keep both leases alive. The runtime lease and execution attempt lease
         * are deliberately independent server authorities.
         */
        if !self
            .heartbeat_busy_execution(
                &delivery,
            )
            .await?
        {
            return Ok(
                WorkerPollOutcome::LeaseLost {
                    attempt_id:
                        Some(
                            delivery.attempt_id,
                        ),
                    reason:
                        Some(
                            "heartbeat_fenced_out"
                                .into(),
                        ),
                },
            );
        }

        let result = self
            .execute_with_heartbeats(
                &delivery,
            )
            .await?;

        let Some(result) = result else {
            return Ok(
                WorkerPollOutcome::LeaseLost {
                    attempt_id:
                        Some(
                            delivery.attempt_id,
                        ),
                    reason:
                        Some(
                            "heartbeat_fenced_out"
                                .into(),
                        ),
                },
            );
        };

        let settle = self
            .control
            .execution_settle(
                &delivery,
                &self.instance_id,
                self.generation,
                &result,
            )
            .await?;

        if !settle.settled {
            return Ok(
                WorkerPollOutcome::SettleRefused {
                    attempt_id:
                        delivery.attempt_id,
                    reason: settle.reason,
                },
            );
        }

        /*
         * Settlement closes server execution state, but it does not invent a
         * turn boundary. This heartbeat is the worker's explicit statement that
         * the executor has actually returned to idle.
         */
        let idle_after = self
            .control
            .worker_heartbeat(
                &self.worker,
                &self.instance_id,
                self.generation,
                "idle",
                true,
            )
            .await?;

        let (_, to_status, _) =
            settlement_fields(&result);

        Ok(WorkerPollOutcome::Settled {
            attempt_id:
                delivery.attempt_id,
            to_status:
                to_status.to_owned(),
            idle_accepted:
                idle_after.accepted,
        })
    }

    async fn heartbeat_busy_execution(
        &self,
        delivery: &PulledDelivery,
    ) -> Result<bool> {
        let runtime = self
            .control
            .worker_heartbeat(
                &self.worker,
                &self.instance_id,
                self.generation,
                "busy",
                false,
            )
            .await?;

        if !runtime.accepted {
            return Ok(false);
        }

        let execution = self
            .control
            .execution_heartbeat(
                delivery,
                &self.instance_id,
                self.generation,
            )
            .await?;

        Ok(execution.accepted)
    }

    async fn execute_with_heartbeats(
        &self,
        delivery: &PulledDelivery,
    ) -> Result<Option<AgentTurnResult>> {
        let execution =
            self.executor.execute(delivery);

        tokio::pin!(execution);

        let mut ticker =
            tokio::time::interval(
                self.heartbeat_interval,
            );

        /*
         * interval() ticks immediately once. The initial heartbeat was already
         * sent above, so consume that tick before waiting for the next renewal.
         */
        ticker.tick().await;

        loop {
            tokio::select! {
                result = &mut execution => {
                    return result.map(Some);
                }

                _ = ticker.tick() => {
                    if !self
                        .heartbeat_busy_execution(
                            delivery,
                        )
                        .await?
                    {
                        /*
                         * Dropping the executor future is the cancellation
                         * boundary. Do not settle after authority is lost.
                         */
                        return Ok(None);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{
            AtomicBool,
            AtomicUsize,
            Ordering,
        },
        Mutex,
    };

    use super::*;

    struct FakeControl {
        events: Mutex<Vec<String>>,
        idle_reason:
            Mutex<Option<String>>,
        pull:
            Mutex<DeliveryPullResponse>,
        ack:
            Mutex<DeliveryAckResponse>,
        execution_heartbeats:
            AtomicUsize,
        fail_execution_heartbeat_after:
            Option<usize>,
        settle:
            Mutex<ExecutionSettleResponse>,
    }

    impl FakeControl {
        fn delivery() -> PulledDelivery {
            PulledDelivery {
                attempt_id:
                    "00000000-0000-4000-8000-000000000011"
                        .into(),
                task_id: "TASK-1".into(),
                worker: "worker-a".into(),
                task_revision: 8,
                prompt: "Do the task".into(),
                receipt_id:
                    "00000000-0000-4000-8000-000000000012"
                        .into(),
                lease_expires_at:
                    "2026-09-20T12:00:30Z"
                        .into(),
            }
        }

        fn with_delivery() -> Self {
            Self {
                events:
                    Mutex::new(Vec::new()),
                idle_reason:
                    Mutex::new(None),
                pull: Mutex::new(
                    DeliveryPullResponse {
                        available: true,
                        delivery:
                            Some(Self::delivery()),
                        reason: None,
                    },
                ),
                ack: Mutex::new(
                    DeliveryAckResponse {
                        acknowledged: true,
                        idempotent:
                            Some(false),
                        reason: None,
                    },
                ),
                execution_heartbeats:
                    AtomicUsize::new(0),
                fail_execution_heartbeat_after:
                    None,
                settle: Mutex::new(
                    ExecutionSettleResponse {
                        settled: true,
                        task_revision:
                            Some(9),
                        reason: None,
                    },
                ),
            }
        }

        fn idle() -> Self {
            let this = Self::with_delivery();

            *this.pull.lock().unwrap() =
                DeliveryPullResponse {
                    available: false,
                    delivery: None,
                    reason:
                        Some(
                            "runtime_not_ready"
                                .into(),
                        ),
                };

            this
        }

        fn record(
            &self,
            event: &str,
        ) {
            self.events
                .lock()
                .unwrap()
                .push(event.to_owned());
        }
    }

    impl WorkerControlPlane for FakeControl {
        async fn register(
            &self,
            _worker: &str,
            _instance_id: &str,
        ) -> Result<WorkerRegisterResponse> {
            self.record("register");

            Ok(WorkerRegisterResponse {
                registered: true,
                generation: Some(4),
                lease_expires_at: None,
                reason: None,
            })
        }

        async fn worker_heartbeat(
            &self,
            _worker: &str,
            _instance_id: &str,
            _generation: i64,
            status: &str,
            _dispatch_ready: bool,
        ) -> Result<WorkerHeartbeatResponse> {
            self.record(
                &format!(
                    "worker_heartbeat:{status}"
                ),
            );

            if status == "idle" {
                if let Some(reason) =
                    self
                        .idle_reason
                        .lock()
                        .unwrap()
                        .take()
                {
                    return Ok(
                        WorkerHeartbeatResponse {
                            accepted: false,
                            lease_expires_at:
                                None,
                            reason:
                                Some(reason),
                        },
                    );
                }
            }

            Ok(WorkerHeartbeatResponse {
                accepted: true,
                lease_expires_at: None,
                reason: None,
            })
        }

        async fn delivery_pull(
            &self,
            _worker: &str,
            _instance_id: &str,
            _generation: i64,
        ) -> Result<DeliveryPullResponse> {
            self.record("pull");
            Ok(
                self.pull
                    .lock()
                    .unwrap()
                    .clone(),
            )
        }

        async fn delivery_ack(
            &self,
            _delivery: &PulledDelivery,
            _instance_id: &str,
            _generation: i64,
        ) -> Result<DeliveryAckResponse> {
            self.record("ack");
            Ok(
                self.ack
                    .lock()
                    .unwrap()
                    .clone(),
            )
        }

        async fn execution_heartbeat(
            &self,
            _delivery: &PulledDelivery,
            _instance_id: &str,
            _generation: i64,
        ) -> Result<ExecutionHeartbeatResponse> {
            self.record(
                "execution_heartbeat",
            );

            let count =
                self.execution_heartbeats
                    .fetch_add(
                        1,
                        Ordering::SeqCst,
                    )
                    + 1;

            let accepted =
                self.fail_execution_heartbeat_after
                    .map(|limit| count < limit)
                    .unwrap_or(true);

            Ok(ExecutionHeartbeatResponse {
                accepted,
                reason:
                    (!accepted)
                        .then(|| {
                            "fenced_out"
                                .into()
                        }),
            })
        }

        async fn execution_settle(
            &self,
            _delivery: &PulledDelivery,
            _instance_id: &str,
            _generation: i64,
            result: &AgentTurnResult,
        ) -> Result<ExecutionSettleResponse> {
            let (_, status, _) =
                settlement_fields(result);

            self.record(
                &format!(
                    "settle:{status}"
                ),
            );

            Ok(
                self.settle
                    .lock()
                    .unwrap()
                    .clone(),
            )
        }
    }

    struct FakeExecutor {
        called: AtomicBool,
        result:
            Mutex<Option<AgentTurnResult>>,
        delay: Duration,
    }

    impl FakeExecutor {
        fn immediate(
            result: AgentTurnResult,
        ) -> Self {
            Self {
                called:
                    AtomicBool::new(false),
                result:
                    Mutex::new(Some(result)),
                delay:
                    Duration::ZERO,
            }
        }
    }

    impl AgentExecutor for FakeExecutor {
        async fn execute(
            &self,
            _delivery: &PulledDelivery,
        ) -> Result<AgentTurnResult> {
            self.called.store(
                true,
                Ordering::SeqCst,
            );

            if !self.delay.is_zero() {
                tokio::time::sleep(
                    self.delay,
                )
                .await;
            }

            Ok(
                self.result
                    .lock()
                    .unwrap()
                    .clone()
                    .expect(
                        "fake result missing",
                    ),
            )
        }
    }

    async fn protocol(
        control: FakeControl,
        executor: FakeExecutor,
        heartbeat_interval: Duration,
    ) -> WorkerProtocol<FakeControl, FakeExecutor> {
        WorkerProtocol::register(
            control,
            executor,
            "worker-a".into(),
            "00000000-0000-4000-8000-000000000001"
                .into(),
            heartbeat_interval,
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn registration_requires_explicit_idle_boundary() {
        let control =
            FakeControl::idle();

        let worker = protocol(
            control,
            FakeExecutor::immediate(
                AgentTurnResult::SucceededDone,
            ),
            Duration::from_secs(30),
        )
        .await;

        assert_eq!(
            worker
                .control
                .events
                .lock()
                .unwrap()
                .as_slice(),
            [
                "register",
                "worker_heartbeat:idle",
            ]
        );
    }

    #[tokio::test]
    async fn idle_poll_does_not_execute_without_delivery() {
        let worker = protocol(
            FakeControl::idle(),
            FakeExecutor::immediate(
                AgentTurnResult::SucceededDone,
            ),
            Duration::from_secs(30),
        )
        .await;

        let outcome =
            worker.poll_once().await.unwrap();

        assert_eq!(
            outcome,
            WorkerPollOutcome::Idle
        );

        assert_eq!(
            worker
                .executor
                .called
                .load(Ordering::SeqCst),
            false
        );
    }

    #[tokio::test]
    async fn active_execution_idle_race_falls_through_to_pull() {
        let control =
            FakeControl::with_delivery();

        let worker = protocol(
            control,
            FakeExecutor::immediate(
                AgentTurnResult::SucceededDone,
            ),
            Duration::from_secs(30),
        )
        .await;

        /*
         * register() consumed one normal idle heartbeat; arrange the race for
         * the poll heartbeat itself.
         */
        *worker
            .control
            .idle_reason
            .lock()
            .unwrap() =
            Some(
                "active_execution".into(),
            );

        let outcome =
            worker.poll_once().await.unwrap();

        assert!(matches!(
            outcome,
            WorkerPollOutcome::Settled {
                to_status,
                ..
            } if to_status == "done"
        ));

        let events =
            worker
                .control
                .events
                .lock()
                .unwrap();

        let pull =
            events
                .iter()
                .position(
                    |event| event == "pull"
                )
                .unwrap();

        let ack =
            events
                .iter()
                .position(
                    |event| event == "ack"
                )
                .unwrap();

        assert!(pull < ack);
    }

    #[tokio::test]
    async fn ack_refusal_never_executes_agent() {
        let control =
            FakeControl::with_delivery();

        *control.ack.lock().unwrap() =
            DeliveryAckResponse {
                acknowledged: false,
                idempotent: None,
                reason:
                    Some(
                        "fenced_out".into(),
                    ),
            };

        let worker = protocol(
            control,
            FakeExecutor::immediate(
                AgentTurnResult::SucceededDone,
            ),
            Duration::from_secs(30),
        )
        .await;

        let outcome =
            worker.poll_once().await.unwrap();

        assert!(matches!(
            outcome,
            WorkerPollOutcome::AckRefused {
                ..
            }
        ));

        assert_eq!(
            worker
                .executor
                .called
                .load(Ordering::SeqCst),
            false
        );
    }

    #[tokio::test]
    async fn successful_turn_settles_then_reports_idle() {
        let worker = protocol(
            FakeControl::with_delivery(),
            FakeExecutor::immediate(
                AgentTurnResult::SucceededReview,
            ),
            Duration::from_secs(30),
        )
        .await;

        let outcome =
            worker.poll_once().await.unwrap();

        assert_eq!(
            outcome,
            WorkerPollOutcome::Settled {
                attempt_id:
                    "00000000-0000-4000-8000-000000000011"
                        .into(),
                to_status:
                    "review".into(),
                idle_accepted: true,
            }
        );

        let events =
            worker
                .control
                .events
                .lock()
                .unwrap();

        let ack =
            events
                .iter()
                .position(
                    |event| event == "ack"
                )
                .unwrap();

        let busy =
            events
                .iter()
                .position(
                    |event| {
                        event
                            == "worker_heartbeat:busy"
                    },
                )
                .unwrap();

        let execute_heartbeat =
            events
                .iter()
                .position(
                    |event| {
                        event
                            == "execution_heartbeat"
                    },
                )
                .unwrap();

        let settle =
            events
                .iter()
                .position(
                    |event| {
                        event
                            == "settle:review"
                    },
                )
                .unwrap();

        let final_idle =
            events
                .iter()
                .rposition(
                    |event| {
                        event
                            == "worker_heartbeat:idle"
                    },
                )
                .unwrap();

        assert!(ack < busy);
        assert!(
            busy < execute_heartbeat
        );
        assert!(
            execute_heartbeat < settle
        );
        assert!(settle < final_idle);
    }

    #[tokio::test]
    async fn heartbeat_fence_loss_cancels_execution_without_settlement() {
        let mut control =
            FakeControl::with_delivery();

        control
            .fail_execution_heartbeat_after =
            Some(2);

        let executor = FakeExecutor {
            called:
                AtomicBool::new(false),
            result:
                Mutex::new(Some(
                    AgentTurnResult::SucceededDone,
                )),
            delay:
                Duration::from_millis(30),
        };

        let worker = protocol(
            control,
            executor,
            Duration::from_millis(5),
        )
        .await;

        let outcome =
            worker.poll_once().await.unwrap();

        assert!(matches!(
            outcome,
            WorkerPollOutcome::LeaseLost {
                attempt_id: Some(_),
                ..
            }
        ));

        let events =
            worker
                .control
                .events
                .lock()
                .unwrap();

        assert!(
            !events
                .iter()
                .any(
                    |event| {
                        event
                            .starts_with(
                                "settle:"
                            )
                    },
                )
        );
    }
}
