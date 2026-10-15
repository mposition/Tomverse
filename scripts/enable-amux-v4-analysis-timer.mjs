/** Intake policy v18 item 2: the local analysis agent reads the app's queue
 * on a fixed timer, so no person starts an analysis. Probe only unless
 * --enable is explicit. It installs one pinned timer for the already
 * installed system service and enables it. It never edits the service, its
 * environment or credentials, never clears the outcome-unknown halt (the
 * service's own condition still skips every run while it exists) and never
 * runs the service itself. Output carries no environment value. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { SYSTEM_UNIT, SYSTEM_UNIT_SHA256 } from "./install-amux-v4-system-service.mjs";

export const SYSTEM_TIMER = "amux-v4-analysis-agent-system.timer";
export const SYSTEM_TIMER_SHA256 =
  "9400acd96a091ddcbce3a0c84f5514d593d773469903c7897340e87bf3a9a9e1";
export const ANALYSIS_HALT_MARKER =
  "/home/tommy/.local/state/tomverse-amux-v4-analysis/analysis-outcome-unknown.halt";
const ENVIRONMENT_FILE = "/etc/tomverse-amux-v4/analysis-agent.env";

function command(path, args) {
  return execFileSync(path, args, { encoding: "utf8", timeout: 30_000,
    maxBuffer: 64 * 1024, env: { PATH: "/usr/bin:/bin", LANG: "C" },
    stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function rootFile(path, mode) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== 0 ||
      (stat.mode & 0o777) !== mode || realpathSync(path) !== path) {
    throw new Error("invalid_file");
  }
  return readFileSync(path);
}

/** A unit runs exactly its pinned file: no drop-in may change it (a drop-in
 * could reset the halt condition or swap ExecStart under the same digest). */
function requireUndropped(unit) {
  const fragment = command("/usr/bin/systemctl", ["show", "--property=FragmentPath", "--value", unit]);
  const dropIns = command("/usr/bin/systemctl", ["show", "--property=DropInPaths", "--value", unit]);
  if (fragment !== `/etc/systemd/system/${unit}` || dropIns !== "") throw new Error("unit_overridden");
}

/** The live switch as installed: "enabled" or "disabled", never the line itself. */
export function liveSwitchOf(source) {
  const values = source.split(/\r?\n/)
    .map((line) => /^TOMVERSE_AMUX_V4_LIVE_ANALYSIS_CLI=(enabled|disabled)$/.exec(line)?.[1])
    .filter(Boolean);
  return values.length === 1 ? values[0] : "invalid";
}

export function runAnalysisTimerEnable(mode = "--probe-only") {
  if (process.platform !== "linux" || process.getuid() !== 0 ||
      !["--probe-only", "--enable"].includes(mode)) throw new Error("root_required");
  // The timer only drives the reviewed, already installed system service.
  const service = rootFile(`/etc/systemd/system/${SYSTEM_UNIT}`, 0o644);
  if (createHash("sha256").update(service).digest("hex") !== SYSTEM_UNIT_SHA256) {
    throw new Error("service_mismatch");
  }
  requireUndropped(SYSTEM_UNIT);
  const liveSwitch = liveSwitchOf(rootFile(ENVIRONMENT_FILE, 0o600).toString("utf8"));
  const timer = readFileSync(new URL(`./systemd/${SYSTEM_TIMER}`, import.meta.url));
  if (createHash("sha256").update(timer).digest("hex") !== SYSTEM_TIMER_SHA256) {
    throw new Error("timer_mismatch");
  }
  const halted = existsSync(ANALYSIS_HALT_MARKER);
  const target = `/etc/systemd/system/${SYSTEM_TIMER}`;
  if (mode === "--probe-only") {
    return { timerInstalled: existsSync(target), liveSwitch, halted, enabled: false };
  }
  if (!existsSync(target)) {
    writeFileSync(target, timer, { flag: "wx", mode: 0o644 });
  } else if (createHash("sha256").update(rootFile(target, 0o644)).digest("hex") !== SYSTEM_TIMER_SHA256) {
    throw new Error("installed_timer_mismatch");
  }
  command("/usr/bin/systemd-analyze", ["verify", target]);
  command("/usr/bin/systemctl", ["daemon-reload"]);
  // Read again after the reload: what the manager now holds is what runs.
  requireUndropped(SYSTEM_UNIT);
  requireUndropped(SYSTEM_TIMER);
  command("/usr/bin/systemctl", ["enable", "--now", SYSTEM_TIMER]);
  return { timerInstalled: true, liveSwitch, halted, enabled: true };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    // No argument is the probe; one known argument selects; anything else is refused.
    const mode = process.argv.length === 2 ? "--probe-only" : process.argv.length === 3 ? process.argv[2] : null;
    console.log(JSON.stringify(runAnalysisTimerEnable(mode)));
  } catch {
    // Never emit environment values or raw subprocess output.
    console.error("AMUX_V4_ANALYSIS_TIMER_REFUSED");
    process.exitCode = 1;
  }
}
