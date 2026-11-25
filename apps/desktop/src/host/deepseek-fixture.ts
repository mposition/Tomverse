import { lstat, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, parse } from "node:path";
import { same } from "../../../tomverse-cli/src/workspace.js";
import type { CliFixtureInput } from "./cli-fixture-input";
import { stageDeepSeekRelease } from "./cli-protocol";

const disabledPlugins = [
  "tool-plugin-manager", "plugin-manager", "tool-working-directory", "tool-bash", "tool-pwsh", "tool-jobs",
  "tool-fs", "tool-fs-search", "tool-skill", "tool-agent-team", "tool-subagent-control", "tool-subagent",
  "tool-subagent-fork", "tool-workflow", "tool-goal", "tool-web", "tool-executor-ptc", "deepseek-account", "llm-pi-ai",
  "mcp-resources",
];

export async function deepSeekStartupDirectory(project: string, parent?: string) {
  if (process.platform !== "win32") return;
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) throw new Error("The Windows system drive is unavailable.");
  const systemDrive = parse(systemRoot).root;
  if (same(parse(project).root, systemDrive)) return;
  // The pinned Windows CLI locates a bundled native module using its startup drive.
  const base = parent && isAbsolute(parent) ? await realpath(parent) : undefined;
  if (!base || !same(parse(base).root, systemDrive) || !(await lstat(base)).isDirectory()) {
    throw new Error("DeepSeek Harness requires a startup directory on the Windows system drive.");
  }
  return mkdtemp(join(base, "tomverse-deepseek-start-"));
}

export async function deepSeekLaunch(fixture: CliFixtureInput, staging: string, profile: string, resume: boolean, signal: AbortSignal) {
  const path = join(profile, "cordis.patch.yml");
  const config = JSON.stringify([
    ...disabledPlugins.map((id) => ({ id, disabled: true })),
    { id: "acp", config: { provider: "deepseek-official", model: fixture.model } },
    { id: "llm-deepseek", config: { baseURL: fixture.origin, apiKeyEnv: "DEEPSEEK_API_KEY",
      thinking: "disabled", models: [{ id: fixture.model, contextWindow: 128_000, maxTokens: 8_192 }] } },
    { id: "approval", config: { policy: "never" } },
    { id: "permission", config: { presets: { "read-only": { sandbox: "read-only", approval: "never" } } } },
    { id: "tool-todo", config: { allowParallelInProgress: false } },
  ]);
  if (resume) {
    const file = await lstat(path);
    if (!file.isFile() || file.size !== Buffer.byteLength(config) || !same(await realpath(path), path) ||
        await readFile(path, "utf8") !== config) throw new Error("The saved DeepSeek Desktop configuration changed.");
  } else await writeFile(path, config, { mode: 0o600, flag: "wx" });
  // Apply the transfer policy on every launch, including sessions with an existing profile.
  const privacyPatch = join(staging, "desktop-privacy.yml");
  await writeFile(privacyPatch, JSON.stringify([{ id: "session-log-deepseek", config: { enabled: false } }]),
    { mode: 0o600, flag: "wx" });
  const executable = await stageDeepSeekRelease(fixture.executable, staging, fixture.version, signal);
  return { executable, args: ["--profile", "acp", "--patch", privacyPatch], env: {
    DSH_HOME: profile, DSH_TELEMETRY_DISABLED: "1", DSH_PERMISSION_MODE: "read-only",
    DEEPSEEK_BASE_URL: fixture.origin, DEEPSEEK_API_KEY: "tomverse-loopback-only",
  } };
}
