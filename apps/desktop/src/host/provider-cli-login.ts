import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliLoginArguments, type CliLogin, type CliProvider } from "../code-execution";
import { claudeAccountFromStatus } from "./claude-account";

// The sign-in state is read with the provider's own documented status command, with fixed arguments, no shell, a short
// timeout and a small environment. The output only decides the state: it can contain account names or a masked key, so it
// is never stored, logged or returned.

/** Providers whose documented status command is known. Any other provider's state stays unknown. */
const statusArguments: Partial<Record<CliProvider, readonly string[]>> = {
  openai: ["login", "status"],
  anthropic: ["auth", "status"],
};

export type CliOutput = { code: number | null; output: string; timedOut: boolean };
export type CliRunner = (file: string, args: readonly string[], env: Record<string, string>, signal: AbortSignal) => Promise<CliOutput>;

const inherited = ["SystemRoot", "WINDIR", "ComSpec", "OS", "PROCESSOR_ARCHITECTURE", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "TEMP", "TMP", "TMPDIR", "USER", "USERNAME", "LOGNAME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"];

/** Only what the CLI needs to find the person's own sign-in; no secrets of this app or the shell are passed on. */
export function cliLoginEnvironment(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of inherited) {
    const key = platform === "win32" ? Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase()) : name;
    const value = key === undefined ? undefined : env[key];
    if (value) result[name] = value;
  }
  const root = result.SystemRoot ?? result.WINDIR;
  result.PATH = platform === "win32" ? (root ? join(root, "System32") : "") : "/usr/bin:/bin";
  result.NO_COLOR = "1";
  result.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  result.DISABLE_AUTOUPDATER = "1";
  return result;
}

export function cliLoginFromOutput(provider: CliProvider, { code, output, timedOut }: CliOutput): CliLogin {
  if (timedOut) return "unknown";
  if (provider === "anthropic") {
    if (code === null) return "unknown";
    const account = claudeAccountFromStatus(output, code);
    return account.status === "signedIn" ? "loggedIn" : account.status === "signInRequired" || account.status === "signInExpired" ? "loginRequired" : "unknown";
  }
  if (provider === "openai") {
    const text = output.slice(0, 2048);
    if (/\bnot logged in\b/i.test(text) && code === 1) return "loginRequired";
    if (code === 0 && /^\s*logged in\b/i.test(text)) return "loggedIn";
  }
  return "unknown";
}

/** Runs a program with fixed arguments and returns what it printed. A program that outlives the timeout is killed. */
export const runCli = (file: string, args: readonly string[], env: Record<string, string>, parent: AbortSignal, timeoutMs = 8_000): Promise<CliOutput> => new Promise((resolve) => {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]);
  const finish = (value: CliOutput) => resolve(value);
  if (signal.aborted) return finish({ code: null, output: "", timedOut: true });
  let output = "";
  let timedOut = false;
  let settled = false;
  const child = spawn(file, [...args], { cwd: tmpdir(), env, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
  const end = (code: number | null) => {
    if (settled) return;
    settled = true;
    signal.removeEventListener("abort", stop);
    finish({ code, output, timedOut });
  };
  const stop = () => { timedOut = true; child.kill("SIGKILL"); end(null); };
  signal.addEventListener("abort", stop, { once: true });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      if (output.length < 64 * 1024) output += chunk;
    });
  }
  child.on("error", () => end(null));
  child.on("close", (code) => end(code));
});

/** Runs the provider's read-only sign-in status command on a file that already matched its pinned release. */
export async function readCliLogin(provider: CliProvider, file: string, signal: AbortSignal,
    run: CliRunner = runCli, env: NodeJS.ProcessEnv = process.env): Promise<CliLogin> {
  const args = statusArguments[provider];
  if (!args || signal.aborted) return "unknown";
  try {
    return cliLoginFromOutput(provider, await run(file, args, cliLoginEnvironment(env), signal));
  } catch {
    return "unknown";
  }
}

const unsafeInTypedPath = new RegExp("[\x00-\x1f\x7f" + String.fromCharCode(0x2018) + "-" + String.fromCharCode(0x201b) + String.fromCharCode(0x2028, 0x2029) + "]");

/** The text typed into the person's own terminal to start the official sign-in. Null when the file name could not be quoted safely. */
export function cliLoginCommandLine(provider: CliProvider, file: string, platform: NodeJS.Platform = process.platform): string | null {
  const args = cliLoginArguments[provider];
  // Control characters, and the curly quotes PowerShell treats as quotes, are never part of a path this app types.
  if (!args || unsafeInTypedPath.test(file)) return null;
  return platform === "win32"
    ? `& '${file.replaceAll("'", "''")}' ${args.join(" ")}\r`
    : `'${file.replaceAll("'", "'\\''")}' ${args.join(" ")}\r`;
}
