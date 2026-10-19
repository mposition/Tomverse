fn main() -> std::process::ExitCode {
    use tomverse_orchestrator::wsl_bridge::BridgeArgs;

    // Orchestration policy version 55, section 2: no arguments is the bridge
    // exactly as before; `--worker <name>` is one bridge for one worker.
    // `--dm-relay` is the Decision Maker relay alone (its own unit). Anything
    // else does not start.
    let Some(args) = tomverse_orchestrator::wsl_bridge::parse_bridge_args(std::env::args_os().skip(1))
    else {
        eprintln!("amux wsl bridge arguments are invalid; expected none, --worker <name> or --dm-relay");
        return std::process::ExitCode::from(1);
    };
    let env_value = std::env::var(tomverse_orchestrator::wsl_bridge::WSL_BRIDGE_ENV_NAME).ok();
    match tomverse_orchestrator::wsl_bridge::activation_gate(
        tomverse_orchestrator::wsl_bridge::WSL_BRIDGE_CODE_LATCH,
        env_value.as_deref(),
    ) {
        tomverse_orchestrator::wsl_bridge::ActivationGate::LatchOff => {
            println!("amux wsl bridge latch is off");
            std::process::ExitCode::SUCCESS
        }
        tomverse_orchestrator::wsl_bridge::ActivationGate::EnvOff => {
            println!("amux wsl bridge env is off");
            std::process::ExitCode::SUCCESS
        }
        tomverse_orchestrator::wsl_bridge::ActivationGate::Runner => {
            let code = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime.block_on(async {
                    match &args {
                        BridgeArgs::Sessions => tomverse_orchestrator::wsl_bridge::run_from_env().await,
                        BridgeArgs::Worker(worker) => {
                            tomverse_orchestrator::wsl_bridge::run_worker_from_env(worker).await
                        }
                        BridgeArgs::DmRelay => tomverse_orchestrator::wsl_bridge::run_dm_relay_from_env().await,
                    }
                }),
                Err(_) => 1,
            };
            std::process::ExitCode::from(u8::try_from(code).unwrap_or(1))
        }
    }
}
