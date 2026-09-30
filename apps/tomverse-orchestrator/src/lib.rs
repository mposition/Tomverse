pub mod board_driver;
pub mod executor;
pub mod local_card;
pub mod orchestrator_halt;
pub mod runtime_service;
pub mod scheduler;
pub mod tomverse_api;
pub mod worker;
pub mod worker_protocol;
pub mod wsl_bridge;

use anyhow::Result;
use std::future::Future;
use tracing::info;

pub(crate) async fn supervise_amux<S, R>(scheduler: S, runtime: R) -> Result<()>
where
    S: Future<Output = Result<()>>,
    R: Future<Output = Result<()>>,
{
    // A terminal scheduler error must drop RuntimeService::run. Its JoinSet
    // then aborts the spawned worker and BoardDriver tasks in this process.
    tokio::try_join!(scheduler, runtime)?;
    Ok(())
}

fn scheduler_enabled() -> bool {
    std::env::var("TOMVERSE_AMUX_ENABLED")
        .ok()
        .is_some_and(|value| value.trim() == "1")
}

/// The process's exits (orchestration policy version 20, section 3): `Ok`
/// when `TOMVERSE_AMUX_ENABLED` is off, as before; an error only for a start
/// configuration error (a missing or malformed required variable, both
/// `TOMVERSE_AMUX_EXECUTE` and `TOMVERSE_AMUX_CLAIM`, a 401 or 403 on the
/// startup halt state read) and, in execute mode, the runtime's own
/// `AMUX_WORKER_POLL_UNVERIFIED` and `AMUX_BOARD_TICK_UNVERIFIED`. Everything
/// else the scheduler meets is a halt, not an exit.
pub async fn run() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "tomverse_orchestrator=info".into()),
        )
        .init();

    if !scheduler_enabled() {
        info!(
            service = "tomverse-orchestrator",
            enabled = false,
            "Tomverse AMUX orchestrator disabled; set TOMVERSE_AMUX_ENABLED=1 to enable"
        );

        return Ok(());
    }

    let execution_enabled = scheduler::execution_enabled();
    let claim_mode = scheduler::current_claim_mode();

    info!(
        service = "tomverse-orchestrator",
        enabled = true,
        execution_enabled,
        claim_mode = ?claim_mode,
        "Tomverse AMUX orchestrator starting"
    );

    // Policy version 15: execute mode starts a Railway runtime, which would
    // compete with the WSL runner that claim-only mode feeds.
    if claim_mode == scheduler::ClaimMode::Conflict {
        anyhow::bail!("TOMVERSE_AMUX_EXECUTE and TOMVERSE_AMUX_CLAIM must not both be set");
    }

    let api = tomverse_api::TomverseApi::from_env()?;

    // Policy version 20, section 4: one instance id per process.
    let scheduler = scheduler::Scheduler::new(api.clone());
    info!(
        service = "tomverse-orchestrator",
        instance_id = %scheduler.instance_id(),
        "Tomverse AMUX orchestrator instance"
    );

    // The scheduler never ends by itself. Its first call is the halt state
    // read, and its only error is a 401 or 403 on that read at startup.
    let scheduler = async move {
        match scheduler.run().await {
            Ok(never) => match never {},
            Err(error) => Err(error),
        }
    };

    /*
     * Selection-only and claim-only modes deliberately do not require executor
     * configuration and create no worker runtime registrations.
     */
    if !execution_enabled {
        return scheduler.await;
    }

    /*
     * Phase A production containment: local process execution is unavailable
     * and this constructor always fails before any worker runtime registration.
     * A future execution path requires the common-foundation-approved,
     * per-agent isolated Railway service boundary; command fixtures remain
     * test-only and cannot be enabled by flags or environment configuration.
     */
    let executor = executor::CommandAgentExecutor::from_env()?;

    let runtime = runtime_service::RuntimeService::new(api, executor);

    supervise_amux(scheduler, runtime.run()).await
}
