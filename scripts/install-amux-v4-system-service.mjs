/** Owner-approved system-manager migration. Probe only unless --install is
 * explicit. Never start analysis, enable a timer, clear a halt or relax AppArmor.
 * Existing user units and private credentials are not overwritten. */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync,
  realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const ANALYSIS_BUNDLE_SHA256 =
  "4f77a7dea96e100304f6c4e87d86154e91687b5f974424f16811754e5acd43fc";
// This is the read-back hash of the installed, already-reviewed release bundle,
// not the hash of its source entrypoint. A new bundle needs a reviewed pin.
export const SYSTEM_UNIT = "amux-v4-analysis-agent-system.service";
export const SYSTEM_UNIT_SHA256 =
  "d319510cdf0df44e0e447a85c105d0689aa3739924d63bdea900c23e8695a7d8";
export const SYSTEM_PROBE_PROPERTIES = Object.freeze([
  "User=tommy", "Group=tommy", "WorkingDirectory=/home/tommy",
  "NoNewPrivileges=yes", "PrivateTmp=yes", "ProtectSystem=strict",
  "ProtectHome=read-only", "UMask=0077", "TimeoutStartSec=20s",
  "KillMode=control-group",
]);
export const BWRAP_PROBE_ARGS = Object.freeze([
  "--unshare-all", "--die-with-parent", "--clearenv", "--ro-bind", "/", "/",
  "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "/usr/bin/true",
]);

export function disabledSystemEnvironment(source) {
  const expected = new Set(["TOMVERSE_AMUX_V4_LIVE_ANALYSIS_CLI",
    "TOMVERSE_AMUX_V4_ANALYSIS_APP_ORIGIN", "TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET"]);
  const values = new Map();
  for (const line of source.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z0-9_]+)=([^\r\n]*)$/.exec(line);
    if (!match || !expected.has(match[1]) || values.has(match[1])) {
      throw new Error("invalid_environment");
    }
    values.set(match[1], match[2]);
  }
  if (values.size !== 3 ||
      !["enabled", "disabled"].includes(values.get("TOMVERSE_AMUX_V4_LIVE_ANALYSIS_CLI")) ||
      values.get("TOMVERSE_AMUX_V4_ANALYSIS_APP_ORIGIN") !== "https://tomverse.app" ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(values.get("TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET"))) {
    throw new Error("invalid_environment");
  }
  values.set("TOMVERSE_AMUX_V4_LIVE_ANALYSIS_CLI", "disabled");
  return [...values].map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
}

function command(path, args) {
  return execFileSync(path, args, { encoding: "utf8", timeout: 30_000,
    maxBuffer: 64 * 1024, env: { PATH: "/usr/bin:/bin", LANG: "C" },
    stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function regularFile(path, uid, mode) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
      stat.uid !== uid || (stat.mode & 0o777) !== mode || realpathSync(path) !== path) {
    throw new Error("invalid_file");
  }
  return readFileSync(path);
}

function rootDirectory(path) {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o755 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 ||
      (stat.mode & 0o022) !== 0 || realpathSync(path) !== path) {
    throw new Error("invalid_root_directory");
  }
}

export function runSystemServiceInstall(mode) {
  if (process.platform !== "linux" || process.getuid() !== 0 ||
      !["--probe-only", "--install"].includes(mode)) throw new Error("root_required");
  const uid = Number(command("/usr/bin/id", ["-u", "tommy"]));
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error("invalid_runner");
  // Refuse a parallel live user runner. Failed/inactive services are preserved.
  const userCtl = (args) => {
    try {
      return command("/usr/sbin/runuser", ["-u", "tommy", "--", "/usr/bin/env", "-i",
        "HOME=/home/tommy", `XDG_RUNTIME_DIR=/run/user/${uid}`,
        `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`,
        "/usr/bin/systemctl", "--user", ...args]);
    } catch (error) {
      return String(error.stdout ?? "").trim();
    }
  };
  if (userCtl(["is-enabled", "amux-v4-analysis-agent.timer"]) !== "disabled" ||
      userCtl(["is-active", "amux-v4-analysis-agent.timer"]) !== "inactive" ||
      !["inactive", "failed"].includes(userCtl(["is-active", "amux-v4-analysis-agent.service"]))) {
    throw new Error("user_runner_not_stopped");
  }
  const bundle = regularFile("/home/tommy/.local/lib/tomverse-amux-v4/analysis-agent-once.mjs", uid, 0o600);
  if (createHash("sha256").update(bundle).digest("hex") !== ANALYSIS_BUNDLE_SHA256) {
    throw new Error("bundle_mismatch");
  }
  const env = disabledSystemEnvironment(regularFile(
    "/home/tommy/.config/tomverse-amux-v4/analysis-agent.env", uid, 0o600).toString("utf8"));
  const unit = readFileSync(new URL("./systemd/amux-v4-analysis-agent-system.service", import.meta.url));
  if (createHash("sha256").update(unit).digest("hex") !== SYSTEM_UNIT_SHA256) {
    throw new Error("unit_mismatch");
  }
  // No EnvironmentFile or credentials in the offline transient probe.
  command("/usr/bin/systemd-run", ["--quiet", "--wait", "--pipe", "--collect",
    "--service-type=oneshot", `--unit=amux-v4-offline-${randomUUID()}`,
    ...SYSTEM_PROBE_PROPERTIES.flatMap(property => ["--property", property]),
    "/usr/bin/bwrap", ...BWRAP_PROBE_ARGS]);
  if (mode === "--probe-only") return { offlineProbe: "passed", modelCalled: false, installed: false };
  const targets = ["/opt/tomverse-amux-v4/analysis-agent-once.mjs",
    "/etc/tomverse-amux-v4/analysis-agent.env", `/etc/systemd/system/${SYSTEM_UNIT}`];
  if (targets.some(path => existsSync(path))) throw new Error("target_exists");
  for (const parent of ["/opt", "/etc", "/etc/systemd", "/etc/systemd/system",
    "/opt/tomverse-amux-v4", "/etc/tomverse-amux-v4"]) rootDirectory(parent);
  chmodSync("/etc/tomverse-amux-v4", 0o700);
  writeFileSync(targets[0], bundle, { flag: "wx", mode: 0o555 });
  writeFileSync(targets[1], env, { flag: "wx", mode: 0o600 });
  writeFileSync(targets[2], unit, { flag: "wx", mode: 0o644 });
  command("/usr/bin/systemd-analyze", ["verify", targets[2]]);
  command("/usr/bin/systemctl", ["daemon-reload"]);
  regularFile(targets[0], 0, 0o555);
  regularFile(targets[1], 0, 0o600);
  regularFile(targets[2], 0, 0o644);
  return { offlineProbe: "passed", modelCalled: false, installed: true,
    liveFlag: "disabled", timerCreated: false, oldUnitsPreserved: true };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const mode = process.argv.length === 3 ? process.argv[2] : null;
    console.log(JSON.stringify(runSystemServiceInstall(mode)));
  } catch {
    // Never emit environment values, raw subprocess output or provider content.
    console.error("AMUX_V4_SYSTEM_INSTALL_REFUSED");
    process.exitCode = 1;
  }
}
