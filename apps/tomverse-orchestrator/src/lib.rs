pub mod board_driver;
pub mod executor;
pub mod local_card;
pub mod runtime_service;
pub mod scheduler;
pub mod tomverse_api;
pub mod worker;
pub mod worker_protocol;
pub mod wsl_bridge;

use anyhow::Result;
use tracing::info;

fn scheduler_enabled() -> bool {
    std::env::var("TOMVERSE_AMUX_ENABLED")
        .ok()
        .is_some_and(|value| value.trim() == "1")
}

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

    let scheduler = scheduler::Scheduler::new(api.clone());

    /*
     * Selection-only and claim-only modes deliberately do not require executor
     * configuration and create no worker runtime registrations.
     */
    if !execution_enabled {
        return scheduler.run().await;
    }

    /*
     * Execution mode is fail-closed: an explicit executor configuration is
     * required before any worker services are registered.
     */
    let executor = executor::CommandAgentExecutor::from_env()?;

    let runtime = runtime_service::RuntimeService::new(api, executor);

    tokio::try_join!(scheduler.run(), runtime.run())?;

    Ok(())
}
