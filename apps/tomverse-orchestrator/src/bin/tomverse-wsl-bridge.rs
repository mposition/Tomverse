fn main() -> std::process::ExitCode {
    match tomverse_orchestrator::wsl_bridge::process_main(
        tomverse_orchestrator::wsl_bridge::WSL_BRIDGE_CODE_LATCH,
    ) {
        0 => {
            println!("amux wsl bridge latch is off");
            std::process::ExitCode::SUCCESS
        }
        _ => {
            eprintln!("amux wsl bridge latch is on without an activation runner");
            std::process::ExitCode::from(1)
        }
    }
}
