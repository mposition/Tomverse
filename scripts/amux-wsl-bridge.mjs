import { WSL_BRIDGE_CODE_LATCH, WSL_BRIDGE_ENV_NAME } from "../lib/amux/wslBridgeCore.ts";

/*
 * Development runner entry. The Rust binary is the process that can open a
 * socket. This script never does. The code latch is on, and the environment
 * value must still be exactly "1" before that binary enters the runner.
 */
if (!WSL_BRIDGE_CODE_LATCH) {
  process.stdout.write("amux wsl bridge latch is off\n");
  process.exit(0);
}

if (process.env[WSL_BRIDGE_ENV_NAME] !== "1") {
  process.stdout.write("amux wsl bridge env is off\n");
  process.exit(0);
}

process.stdout.write("amux wsl bridge runner is tomverse-wsl-bridge\n");
process.exit(0);
