use std::collections::HashSet;

use anyhow::Result;

use crate::tomverse_api::{ExecutionStartResponse, OwnedTodoTask, TomverseApi};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeIdentity {
    pub instance_id: String,
    pub generation: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DriveOutcome {
    StartFailed {
        task_id: String,
        worker: String,
    },
    StartReportedNotRunning {
        task_id: String,
        worker: String,
    },
    MidTurn {
        task_id: String,
        worker: String,
    },
    RuntimeUnavailable {
        task_id: String,
        worker: String,
    },
    ExecutionStartRefused {
        task_id: String,
        worker: String,
        reason: Option<String>,
    },
    ExecutionStarted {
        task_id: String,
        worker: String,
        attempt_id: String,
        task_revision: i64,
    },
}

#[allow(async_fn_in_trait)]
pub trait BoardControlPlane: Send + Sync {
    async fn owned_queue(&self) -> Result<Vec<OwnedTodoTask>>;

    async fn execution_start(
        &self,
        task: &OwnedTodoTask,
        runtime: &RuntimeIdentity,
    ) -> Result<ExecutionStartResponse>;
}

#[allow(async_fn_in_trait)]
pub trait WorkerAdapter: Send + Sync {
    async fn is_running(&self, worker: &str) -> Result<bool>;

    async fn start_for_dispatch(&self, worker: &str) -> Result<()>;

    async fn at_boundary(&self, worker: &str) -> Result<bool>;

    /**
     * Returns the exact runtime identity only when the logical worker is
     * positively known to be dispatch-ready.
     */
    async fn runtime_identity(&self, worker: &str) -> Result<Option<RuntimeIdentity>>;
}

impl BoardControlPlane for TomverseApi {
    async fn owned_queue(&self) -> Result<Vec<OwnedTodoTask>> {
        TomverseApi::owned_queue(self).await
    }

    async fn execution_start(
        &self,
        task: &OwnedTodoTask,
        runtime: &RuntimeIdentity,
    ) -> Result<ExecutionStartResponse> {
        TomverseApi::execution_start(
            self,
            &task.id,
            &task.owner,
            &runtime.instance_id,
            runtime.generation,
            task.revision,
        )
        .await
    }
}

pub struct BoardDriver<C, A> {
    control: C,
    adapter: A,
}

impl<C, A> BoardDriver<C, A>
where
    C: BoardControlPlane,
    A: WorkerAdapter,
{
    pub fn new(control: C, adapter: A) -> Self {
        Self { control, adapter }
    }

    /**
     * Drives at most one owned Todo per logical worker in one pass.
     *
     * Queue ordering is preserved; multiple owned Todos for the same worker do
     * not become concurrent execution attempts.
     */
    pub async fn tick(&self) -> Result<Vec<DriveOutcome>> {
        let tasks = self.control.owned_queue().await?;

        let mut workers = HashSet::new();
        let mut outcomes = Vec::new();

        for task in tasks {
            if !workers.insert(task.owner.clone()) {
                continue;
            }

            outcomes.push(self.drive_task(&task).await?);
        }

        Ok(outcomes)
    }

    async fn drive_task(&self, task: &OwnedTodoTask) -> Result<DriveOutcome> {
        let worker = task.owner.as_str();

        /*
         * Real work preflight already happened when this durable owned Todo was
         * read. A stopped worker may now be started, but start success is not
         * trusted until the adapter proves it is actually running.
         */
        let mut woke_for_dispatch = false;

        if !self.adapter.is_running(worker).await? {
            if self.adapter.start_for_dispatch(worker).await.is_err() {
                return Ok(DriveOutcome::StartFailed {
                    task_id: task.id.clone(),
                    worker: task.owner.clone(),
                });
            }

            if !self.adapter.is_running(worker).await? {
                return Ok(DriveOutcome::StartReportedNotRunning {
                    task_id: task.id.clone(),
                    worker: task.owner.clone(),
                });
            }

            woke_for_dispatch = true;
        }

        /*
         * A newly-started worker is already at its dispatch bootstrap seam.
         * A previously-running worker must positively report a turn boundary.
         */
        if !woke_for_dispatch && !self.adapter.at_boundary(worker).await? {
            return Ok(DriveOutcome::MidTurn {
                task_id: task.id.clone(),
                worker: task.owner.clone(),
            });
        }

        let Some(runtime) = self.adapter.runtime_identity(worker).await? else {
            return Ok(DriveOutcome::RuntimeUnavailable {
                task_id: task.id.clone(),
                worker: task.owner.clone(),
            });
        };

        /*
         * execution_start is the authoritative Todo -> Doing + execution
         * attempt CAS. A stale owned-queue read simply loses here.
         */
        let start = match self.control.execution_start(task, &runtime).await {
            Ok(start) => start,
            Err(_) => {
                tracing::warn!(
                    task_id = %task.id,
                    task_revision = task.revision,
                    worker = %task.owner,
                    incident_id = %uuid::Uuid::new_v4(),
                    endpoint = "execution_start",
                    error_code = "AMUX_EXECUTION_START_OUTCOME_UNKNOWN",
                    "AMUX execution-start outcome unknown; read-back and human handoff required"
                );
                return Err(anyhow::anyhow!("AMUX execution-start outcome unknown"));
            }
        };

        if !start.started {
            return Ok(DriveOutcome::ExecutionStartRefused {
                task_id: task.id.clone(),
                worker: task.owner.clone(),
                reason: start.reason,
            });
        }

        let Some(attempt_id) = start.attempt_id else {
            anyhow::bail!("execution start reported success without attempt_id");
        };

        let Some(task_revision) = start.task_revision else {
            anyhow::bail!("execution start reported success without task_revision");
        };

        /*
         * started=true means the server atomically committed:
         * Todo -> Doing, runtime -> Busy, execution attempt, durable delivery
         * and their audit records. There is no second delivery mutation here.
         */
        Ok(DriveOutcome::ExecutionStarted {
            task_id: task.id.clone(),
            worker: task.owner.clone(),
            attempt_id,
            task_revision,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    };

    use super::*;

    fn task() -> OwnedTodoTask {
        OwnedTodoTask {
            id: "TASK-1".into(),
            owner: "worker-a".into(),
            revision: 7,
        }
    }

    struct FakeControl {
        tasks: Vec<OwnedTodoTask>,
        start: ExecutionStartResponse,
        start_error: bool,
        start_calls: Arc<AtomicUsize>,
    }

    impl FakeControl {
        fn successful() -> Self {
            Self {
                tasks: vec![task()],
                start: ExecutionStartResponse {
                    started: true,
                    attempt_id: Some("attempt-1".into()),
                    task_revision: Some(8),
                    lease_expires_at: None,
                    reason: None,
                },
                start_error: false,
                start_calls: Arc::new(AtomicUsize::new(0)),
            }
        }
    }

    impl BoardControlPlane for FakeControl {
        async fn owned_queue(&self) -> Result<Vec<OwnedTodoTask>> {
            Ok(self.tasks.clone())
        }

        async fn execution_start(
            &self,
            _task: &OwnedTodoTask,
            _runtime: &RuntimeIdentity,
        ) -> Result<ExecutionStartResponse> {
            self.start_calls.fetch_add(1, Ordering::SeqCst);
            if self.start_error {
                return Err(anyhow::anyhow!("unverified execution-start response"));
            }
            Ok(self.start.clone())
        }
    }

    struct FakeAdapter {
        running: Mutex<bool>,
        boundary: bool,
        start_keeps_stopped: bool,
    }

    impl FakeAdapter {
        fn idle_running() -> Self {
            Self {
                running: Mutex::new(true),
                boundary: true,
                start_keeps_stopped: false,
            }
        }

        fn stopped() -> Self {
            Self {
                running: Mutex::new(false),
                boundary: false,
                start_keeps_stopped: false,
            }
        }
    }

    impl WorkerAdapter for FakeAdapter {
        async fn is_running(&self, _worker: &str) -> Result<bool> {
            Ok(*self.running.lock().unwrap())
        }

        async fn start_for_dispatch(&self, _worker: &str) -> Result<()> {
            if !self.start_keeps_stopped {
                *self.running.lock().unwrap() = true;
            }

            Ok(())
        }

        async fn at_boundary(&self, _worker: &str) -> Result<bool> {
            Ok(self.boundary)
        }

        async fn runtime_identity(&self, _worker: &str) -> Result<Option<RuntimeIdentity>> {
            if !*self.running.lock().unwrap() {
                return Ok(None);
            }

            Ok(Some(RuntimeIdentity {
                instance_id: "00000000-0000-4000-8000-000000000001".into(),
                generation: 4,
            }))
        }
    }

    #[tokio::test]
    async fn stopped_worker_is_started_and_rechecked_before_execution() {
        let control = FakeControl::successful();
        let adapter = FakeAdapter::stopped();

        let driver = BoardDriver::new(control, adapter);

        let outcomes = driver.tick().await.unwrap();

        assert!(matches!(
            outcomes.as_slice(),
            [DriveOutcome::ExecutionStarted {
                task_id,
                worker,
                attempt_id,
                task_revision: 8,
            }] if task_id == "TASK-1"
                && worker == "worker-a"
                && attempt_id == "attempt-1"
        ));
    }

    #[tokio::test]
    async fn running_worker_without_idle_boundary_is_not_started() {
        let control = FakeControl::successful();

        let adapter = FakeAdapter {
            boundary: false,
            ..FakeAdapter::idle_running()
        };

        let driver = BoardDriver::new(control, adapter);

        let outcomes = driver.tick().await.unwrap();

        assert!(matches!(
            outcomes.as_slice(),
            [DriveOutcome::MidTurn {
                task_id,
                worker,
            }] if task_id == "TASK-1"
                && worker == "worker-a"
        ));
    }

    #[tokio::test]
    async fn start_success_without_running_worker_never_starts_execution() {
        let control = FakeControl::successful();

        let adapter = FakeAdapter {
            start_keeps_stopped: true,
            ..FakeAdapter::stopped()
        };

        let driver = BoardDriver::new(control, adapter);

        let outcomes = driver.tick().await.unwrap();

        assert!(matches!(
            outcomes.as_slice(),
            [DriveOutcome::StartReportedNotRunning {
                task_id,
                worker,
            }] if task_id == "TASK-1"
                && worker == "worker-a"
        ));
    }

    #[tokio::test]
    async fn execution_start_success_without_attempt_id_is_rejected() {
        let mut control = FakeControl::successful();

        control.start.attempt_id = None;

        let driver = BoardDriver::new(control, FakeAdapter::idle_running());

        let error = driver
            .tick()
            .await
            .expect_err("started execution must include attempt_id");

        assert!(error
            .to_string()
            .contains("execution start reported success without attempt_id"));
    }

    #[tokio::test]
    async fn lost_start_response_stops_before_another_task() {
        let mut control = FakeControl::successful();
        control.start_error = true;
        control.tasks.push(OwnedTodoTask {
            id: "TASK-2".into(),
            owner: "worker-b".into(),
            revision: 2,
        });
        let calls = control.start_calls.clone();
        let driver = BoardDriver::new(control, FakeAdapter::idle_running());
        let result = tokio::time::timeout(std::time::Duration::from_secs(1), driver.tick())
            .await
            .expect("unverified start must stop within bounded time");
        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn execution_start_success_without_task_revision_is_rejected() {
        let mut control = FakeControl::successful();

        control.start.task_revision = None;

        let driver = BoardDriver::new(control, FakeAdapter::idle_running());

        let error = driver
            .tick()
            .await
            .expect_err("started execution must include task_revision");

        assert!(error
            .to_string()
            .contains("execution start reported success without task_revision"));
    }
}
