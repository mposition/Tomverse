mod board_driver;
mod executor;
mod runtime_service;
mod scheduler;
mod tomverse_api;
mod worker;
mod worker_protocol;

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

#[tokio::main]
async fn main() -> Result<()> {
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

    info!(
        service = "tomverse-orchestrator",
        enabled = true,
        execution_enabled,
        "Tomverse AMUX orchestrator starting"
    );

    let api = tomverse_api::TomverseApi::from_env()?;

    let scheduler = scheduler::Scheduler::new(api.clone());

    /*
     * Selection-only mode deliberately does not require executor configuration
     * and creates no worker runtime registrations.
     */
    if !execution_enabled {
        return scheduler.run().await;
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

    supervise_amux(scheduler.run(), runtime.run()).await
}
