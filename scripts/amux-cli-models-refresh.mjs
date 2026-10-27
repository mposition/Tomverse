// Reads which models each worker CLI offers on the AMUX host and records them
// in Tomverse (owner decision 2026-10-27). No model is called: Cursor and
// Copilot print their lists, Codex keeps its own cache. Run as the user that
// owns the CLIs' sign-ins:
//
//   node scripts/amux-cli-models-refresh.mjs --dry-run   # print, send nothing
//   node scripts/amux-cli-models-refresh.mjs             # send each list
//
// Sending needs TOMVERSE_INTERNAL_URL and the CLI monitor's credential
// (TOMVERSE_AMUX_CLI_MONITOR=1, TOMVERSE_AMUX_CLI_MONITOR_SECRET). No list,
// URL or credential enters the logs; a CLI that is missing is skipped.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { readCodexModelsCache, readCopilotHelpConfig, readCursorModelList } from "../lib/amux/cliModelListReader.mjs";

const run = promisify(execFile);
const flags = process.argv.slice(2);
if (flags.some((flag) => flag !== "--dry-run")) throw new Error("invalid arguments");
const dryRun = flags.includes("--dry-run");
const bin = (name) => join(homedir(), ".local", "bin", name);
const output = async (file, args) =>
  (await run(file, args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } })).stdout;

const sources = {
  cursor: async () => readCursorModelList(await output(bin("agent"), ["--list-models"])),
  codex: async () => readCodexModelsCache(await readFile(join(homedir(), ".codex", "models_cache.json"), "utf8")),
  copilot: async () => readCopilotHelpConfig(await output(bin("copilot"), ["help", "config"])),
};

function destination() {
  if (process.env.TOMVERSE_AMUX_CLI_MONITOR !== "1" || (process.env.TOMVERSE_AMUX_CLI_MONITOR_SECRET ?? "").length < 32) {
    throw new Error("credential_missing");
  }
  const url = new URL(process.env.TOMVERSE_INTERNAL_URL ?? "");
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw new Error("invalid_destination");
  return new URL("/api/internal/amux/cli-models", url);
}

const target = dryRun ? null : destination();
for (const [cli, read] of Object.entries(sources)) {
  let models;
  try {
    models = await read();
  } catch {
    process.stderr.write(`amux_cli_models_unreadable cli=${cli}\n`);
    process.exitCode = 1;
    continue;
  }
  if (models.length === 0) {
    process.stderr.write(`amux_cli_models_empty cli=${cli}\n`);
    process.exitCode = 1;
    continue;
  }
  if (dryRun) {
    process.stdout.write(`${JSON.stringify({ cli, models })}\n`);
    continue;
  }
  const response = await fetch(target, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.TOMVERSE_AMUX_CLI_MONITOR_SECRET}` },
    body: JSON.stringify({ cli, models }),
  }).catch(() => null);
  const result = response?.ok ? await response.json().catch(() => null) : null;
  await response?.body?.cancel().catch(() => {});
  if (!result) {
    process.stderr.write(`amux_cli_models_refused cli=${cli} status=${response?.status ?? "none"}\n`);
    process.exitCode = 1;
    continue;
  }
  process.stdout.write(`amux_cli_models_recorded cli=${cli} listed=${result.listed} unlisted=${result.unlisted}\n`);
}
