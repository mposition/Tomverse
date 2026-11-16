import { WSL_BRIDGE_ENV_NAME } from "../lib/amux/wslBridgeCore.ts";

/*
 * Development runner entry. The Rust binary is the process that can open a
 * socket. This script never does. The environment value must be exactly
 * "enabled" (or the earlier "1") before that binary enters the runner.
 */
if (!["enabled", "1"].includes(process.env[WSL_BRIDGE_ENV_NAME] ?? "")) {
  process.stdout.write("amux wsl bridge env is off\n");
  process.exit(0);
}

process.stdout.write("amux wsl bridge runner is tomverse-wsl-bridge\n");
process.exit(0);
