import { WSL_BRIDGE_CODE_LATCH } from "../lib/amux/wslBridgeCore.ts";

/*
 * Development runner entry. The latch is the policy gate. While it is false
 * this process does not read a secret, open a socket, or talk to local AMUX.
 */
if (!WSL_BRIDGE_CODE_LATCH) {
  process.stdout.write("amux wsl bridge latch is off\n");
  process.exit(0);
}

process.stderr.write("amux wsl bridge latch is on without an activation runner\n");
process.exit(1);
