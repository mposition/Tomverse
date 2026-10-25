import { collectAgentOfficeCliSnapshot, sendAgentOfficeCliSnapshot } from "../lib/agentOfficeCliMonitorCollector.mjs";
import { AGENT_OFFICE_CLI_POLL_MS } from "../lib/agentOfficeCliMonitorCore.ts";

const flags = process.argv.slice(2);
if (flags.some(flag => !["--once", "--check-source"].includes(flag))) throw new Error("invalid arguments");
const check = flags.includes("--check-source");
if (!check && (process.env.TOMVERSE_AMUX_CLI_MONITOR !== "1" ||
    (process.env.TOMVERSE_AMUX_CLI_MONITOR_SECRET ?? "").length < 32)) {
  process.stdout.write("CLI monitor disabled\n");
  process.exit(0);
}

let stopped = false;
process.on("SIGINT", () => { stopped = true; });
process.on("SIGTERM", () => { stopped = true; });
do {
  try {
    const snapshot = await collectAgentOfficeCliSnapshot();
    if (check) {
      process.stdout.write(JSON.stringify({ worker: snapshot.worker, source: snapshot.source,
        events: snapshot.events.length, kinds: [...new Set(snapshot.events.map(e => e.kind))],
        rawOutputCharacters: snapshot.rawOutput.length, truncated: snapshot.truncated }) + "\n");
    } else await sendAgentOfficeCliSnapshot(snapshot);
  } catch {
    // No transcript, URL, credential or free-form error enters service logs.
    process.stderr.write("amux_cli_monitor_capture_unavailable\n");
    if (check || flags.includes("--once")) process.exitCode = 1;
  }
  if (check || flags.includes("--once") || stopped) break;
  await new Promise(resolve => setTimeout(resolve, AGENT_OFFICE_CLI_POLL_MS));
} while (!stopped);
