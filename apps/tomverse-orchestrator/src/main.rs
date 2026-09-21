mod board_driver;
mod executor;
mod runtime_service;
mod scheduler;
mod tomverse_api;
mod worker;
mod worker_protocol;

use anyhow::Result;
use tracing::info;

fn scheduler_enabled() -> bool {
    std::env::var(
        "TOMVERSE_AMUX_ENABLED",
    )
    .ok()
    .is_some_and(
        |value| {
            value.trim() == "1"
        },
    )
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(
                    |_| {
                        "tomverse_orchestrator=info"
                            .into()
                    },
                ),
        )
        .init();

    if !scheduler_enabled() {
        info!(
            service =
                "tomverse-orchestrator",
            enabled = false,
            "Tomverse AMUX orchestrator disabled; set TOMVERSE_AMUX_ENABLED=1 to enable"
        );

        return Ok(());
    }

    let execution_enabled =
        scheduler::execution_enabled();

    info!(
        service =
            "tomverse-orchestrator",
        enabled = true,
        execution_enabled,
        "Tomverse AMUX orchestrator starting"
    );

    let api =
        tomverse_api::TomverseApi::from_env()?;

    let scheduler =
        scheduler::Scheduler::new(
            api.clone(),
        );

    /*
     * Selection-only mode deliberately does not require executor configuration
     * and creates no worker runtime registrations.
     */
    if !execution_enabled {
        return scheduler.run().await;
    }

    /*
     * Execution mode is fail-closed: an explicit executor configuration is
     * required before any worker services are registered.
     */
    let executor =
        executor::CommandAgentExecutor::from_env()?;

    let runtime =
        runtime_service::RuntimeService::new(
            api,
            executor,
        );

    tokio::try_join!(
        scheduler.run(),
        runtime.run(),
    )?;

    Ok(())
}
