fn main() -> std::process::ExitCode {
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
                Ok(runtime) => runtime.block_on(tomverse_orchestrator::wsl_bridge::run_from_env()),
                Err(_) => 1,
            };
            std::process::ExitCode::from(u8::try_from(code).unwrap_or(1))
        }
    }
}
