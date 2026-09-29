import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import {
  LOCAL_INTAKE_FRONTIER_EFFORTS,
  LOCAL_INTAKE_PROMPT_VERSION,
  localIntakeFrontierAccepted,
} from "./localIntakeCore.ts";

/**
 * Codex CLI argv for one read-only local intake analysis.
 *
 * docs/policy/amux-intake.md (policy version 3).
 *
 * The parent builds an executable and an args array. It does not concatenate
 * a shell string. The model id comes from adapter config and must be on the
 * frontier allowlist. This module does not spawn unless `spawnCodexIntake`
 * is called, and tests do not call that.
 */

export const LOCAL_INTAKE_CODEX_EXECUTABLE = "codex";

const ENV_ALLOWLIST = ["CODEX_HOME", "COMSPEC", "PATH", "PATHEXT", "SYSTEMROOT", "TEMP", "TMP", "WINDIR"] as const;

export type LocalIntakeCodexConfig = {
  model: string;
  reasoningEffort: (typeof LOCAL_INTAKE_FRONTIER_EFFORTS)[number];
  schemaPath: string;
  outputPath: string;
  cwd: string;
  timeoutMs: number;
};

export const localIntakeChildEnv = (parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    const value = parent[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  return env;
};

export const buildCodexIntakeArgs = (config: LocalIntakeCodexConfig): string[] => {
  if (!localIntakeFrontierAccepted(config.model, config.reasoningEffort)) {
    throw new Error("frontier_model_unavailable");
  }
  return [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--strict-config",
    "--sandbox",
    "read-only",
    "--ask-for-approval",
    "never",
    "--json",
    "--skip-git-repo-check",
    "-m",
    config.model,
    "-c",
    `model_reasoning_effort="${config.reasoningEffort}"`,
    "-c",
    'web_search="disabled"',
    "-c",
    'shell_environment_policy.inherit="none"',
    "-c",
    `shell_environment_policy.include_only=${JSON.stringify([...ENV_ALLOWLIST])}`,
    "--output-schema",
    config.schemaPath,
    "--output-last-message",
    config.outputPath,
    "-C",
    config.cwd,
    "-",
  ];
};

export type CodexSpawn = (
  executable: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; shell: false; signal: AbortSignal },
) => Promise<{ stdout: string; code: number | null }>;

export const spawnCodexIntake = async (
  config: LocalIntakeCodexConfig,
  input: { prompt: string; signal: AbortSignal; spawnImpl?: CodexSpawn },
): Promise<{ ok: true; stdout: string } | { ok: false; code: string }> => {
  if (!localIntakeFrontierAccepted(config.model, config.reasoningEffort)) {
    return { ok: false, code: "frontier_model_unavailable" };
  }
  const args = buildCodexIntakeArgs(config);
  const run =
    input.spawnImpl ??
    (async (executable, command, options) => {
      const child = spawn(executable, command, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin?.end(input.prompt);
      let stdout = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      const code = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => child.kill(), config.timeoutMs);
        const onAbort = () => {
          clearTimeout(timer);
          child.kill();
        };
        options.signal.addEventListener("abort", onAbort);
        child.on("close", (exitCode) => {
          clearTimeout(timer);
          options.signal.removeEventListener("abort", onAbort);
          resolve(exitCode);
        });
      });
      return { stdout, code };
    });
  try {
    const result = await run(LOCAL_INTAKE_CODEX_EXECUTABLE, args, {
      cwd: config.cwd,
      env: localIntakeChildEnv(process.env),
      shell: false,
      signal: input.signal,
    });
    if (input.signal.aborted) return { ok: false, code: "cancelled" };
    if (result.code !== 0) return { ok: false, code: "agent_failed" };
    if (input.spawnImpl) return { ok: true, stdout: result.stdout };
    const text = await readFile(config.outputPath, "utf8");
    return { ok: true, stdout: text };
  } catch {
    return { ok: false, code: input.signal.aborted ? "cancelled" : "agent_failed" };
  }
};

export const localIntakePromptVersion = LOCAL_INTAKE_PROMPT_VERSION;
