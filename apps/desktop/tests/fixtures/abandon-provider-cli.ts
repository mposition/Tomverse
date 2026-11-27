import fs from "node:fs";
import { runProviderCli } from "../../src/host/provider-cli-exec";

// Stands in for the Code worker: it starts a run, and when the CLI's background command has lost its parent it is killed at once with
// no exit handler running, as a worker is when the app crashes. The test then checks that nothing of the run is left.
const [fake, pidFile] = process.argv.slice(2) as [string, string];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
void runProviderCli({ provider: "openai", file: process.execPath, argsPrefix: [fake, JSON.stringify({ scenario: "codex-middle", pidFile })], cwd: process.cwd(),
  prompt: "x", mode: "read_only", env: process.env, signal: new AbortController().signal, onEvent: () => undefined });
setInterval(() => {
  try {
    const { middle } = JSON.parse(fs.readFileSync(pidFile, "utf8")) as { middle: number };
    if (fs.existsSync(pidFile + ".grandchild") && !alive(middle)) process.kill(process.pid, "SIGKILL");
  } catch { /* not written yet */ }
}, 100);
