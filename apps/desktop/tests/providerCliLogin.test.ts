import assert from "node:assert/strict";
import test from "node:test";
import { cliLoginCommandLine, cliLoginEnvironment, cliLoginFromOutput, loginShellKind, readCliLogin, runCli, type CliOutput } from "../src/host/provider-cli-login";

const signedIn = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max", email: "someone@example.com" });
const signedOut = JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" });
const output = (code: number | null, text: string, timedOut = false): CliOutput => ({ code, output: text, timedOut });

test("The sign-in state comes from the status command's exit code and output", () => {
  assert.equal(cliLoginFromOutput("anthropic", output(0, signedIn)), "loggedIn");
  assert.equal(cliLoginFromOutput("anthropic", output(1, signedOut)), "loginRequired");
  assert.equal(cliLoginFromOutput("anthropic", output(0, JSON.stringify({ loggedIn: true, authMethod: "claude.ai", loginExpiresAt: "2020-01-01T00:00:00Z" }))), "loginRequired");
  // An exit code that contradicts the output, garbage, an empty output and a missing exit code are all unknown.
  assert.equal(cliLoginFromOutput("anthropic", output(1, signedIn)), "unknown");
  assert.equal(cliLoginFromOutput("anthropic", output(0, "not json")), "unknown");
  assert.equal(cliLoginFromOutput("anthropic", output(0, "")), "unknown");
  assert.equal(cliLoginFromOutput("anthropic", output(null, signedIn)), "unknown");

  assert.equal(cliLoginFromOutput("openai", output(0, "Logged in using ChatGPT\n")), "loggedIn");
  assert.equal(cliLoginFromOutput("openai", output(0, "Logged in using an API key - sk-***abcde\n")), "loggedIn");
  assert.equal(cliLoginFromOutput("openai", output(1, "Not logged in\n")), "loginRequired");
  assert.equal(cliLoginFromOutput("openai", output(0, "Not logged in\n")), "unknown");
  assert.equal(cliLoginFromOutput("openai", output(1, "Error checking login status: boom\n")), "unknown");
  assert.equal(cliLoginFromOutput("openai", output(0, "")), "unknown");

  // A command that timed out says nothing, whatever it printed first.
  assert.equal(cliLoginFromOutput("openai", output(null, "Logged in using ChatGPT", true)), "unknown");
  assert.equal(cliLoginFromOutput("anthropic", output(null, signedIn, true)), "unknown");
  // Providers without a documented status command are always unknown.
  for (const provider of ["google", "xai", "moonshot", "qwen"] as const) assert.equal(cliLoginFromOutput(provider, output(0, "Logged in")), "unknown");
});

test("The status command runs with fixed arguments, a small environment and no secrets", async () => {
  const calls: Array<{ file: string; args: readonly string[]; env: Record<string, string> }> = [];
  const run = async (file: string, args: readonly string[], env: Record<string, string>) => { calls.push({ file, args, env }); return output(0, "Logged in using ChatGPT"); };
  const env = {
    HOME: "/home/ada", USERPROFILE: "C:\\Users\\Ada", PATH: "/evil", CODEX_HOME: "/home/ada/.codex", OPENAI_API_KEY: "sk-secret", ANTHROPIC_API_KEY: "secret",
    GITHUB_TOKEN: "secret", TOMVERSE_DESKTOP_AUTH: "secret", NODE_OPTIONS: "--require evil.js", LD_PRELOAD: "/evil.so", SystemRoot: "C:\\Windows",
  };
  assert.equal(await readCliLogin("openai", "/opt/codex", new AbortController().signal, run, env), "loggedIn");
  assert.equal(await readCliLogin("anthropic", "/opt/claude", new AbortController().signal, async (file, args, passed) => { calls.push({ file, args, env: passed }); return output(0, signedIn); }, env), "loggedIn");
  assert.deepEqual(calls.map(({ file, args }) => [file, args]), [["/opt/codex", ["login", "status"]], ["/opt/claude", ["auth", "status"]]]);
  for (const { env: passed } of calls) {
    for (const secret of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "TOMVERSE_DESKTOP_AUTH", "NODE_OPTIONS", "LD_PRELOAD"]) assert.equal(passed[secret], undefined, secret);
    assert.equal(passed.HOME, "/home/ada");
    assert.ok(!Object.values(passed).includes("/evil") || process.platform === "win32");
  }
  assert.equal(calls[0].env.CODEX_HOME, "/home/ada/.codex");
  assert.equal(cliLoginEnvironment({ systemroot: "C:\\Windows", Path: "C:\\evil" }, "win32").PATH, "C:\\Windows\\System32");
  assert.equal(cliLoginEnvironment({ HOME: "/h" }, "linux").PATH, "/usr/bin:/bin");

  // No command is run for a provider without one, or when the scan was already cancelled; a runner that throws gives unknown.
  let started = 0;
  const count = async () => { started += 1; return output(0, "Logged in"); };
  assert.equal(await readCliLogin("xai", "/opt/grok", new AbortController().signal, count, env), "unknown");
  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal(await readCliLogin("openai", "/opt/codex", cancelled.signal, count, env), "unknown");
  assert.equal(started, 0);
  assert.equal(await readCliLogin("openai", "/opt/codex", new AbortController().signal, async () => { throw new Error("spawn failed"); }, env), "unknown");
});

test("A status command that does not finish is stopped, and its output is capped", async () => {
  const hang = await runCli(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], cliLoginEnvironment(process.env), new AbortController().signal, 500);
  assert.equal(hang.timedOut, true);
  assert.equal(hang.code, null);
  const flood = await runCli(process.execPath, ["-e", "process.stdout.write('x'.repeat(2_000_000)); process.stdout.write('end')"], cliLoginEnvironment(process.env), new AbortController().signal, 20_000);
  assert.equal(flood.code, 0);
  assert.ok(flood.output.length < 200_000);
  const missing = await runCli(process.execPath + ".does-not-exist", [], cliLoginEnvironment(process.env), new AbortController().signal);
  assert.equal(missing.code, null);
  const aborted = new AbortController();
  const pending = runCli(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], cliLoginEnvironment(process.env), aborted.signal, 20_000);
  aborted.abort();
  assert.equal((await pending).timedOut, true);
});

test("The sign-in command line quotes the file for the shell the terminal opens and refuses names it cannot quote", () => {
  assert.equal(cliLoginCommandLine("openai", "C:\\Users\\Ada\\codex.exe", "powershell"), "& 'C:\\Users\\Ada\\codex.exe' login\r");
  assert.equal(cliLoginCommandLine("anthropic", "C:\\Users\\O'Brien\\claude.exe", "powershell"), "& 'C:\\Users\\O''Brien\\claude.exe' auth login\r");
  assert.equal(cliLoginCommandLine("openai", "/opt/it's here/codex", "posix"), "'/opt/it'\\''s here/codex' login\r");
  assert.equal(cliLoginCommandLine("anthropic", "/opt/$HOME/`id`/claude", "posix"), "'/opt/$HOME/`id`/claude' auth login\r");
  // Without PowerShell the terminal is cmd.exe, which reads a different syntax: the line follows the shell, and a name cmd.exe would expand is not typed.
  assert.equal(loginShellKind("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "win32"), "powershell");
  assert.equal(loginShellKind("C:\\Windows\\System32\\cmd.exe", "win32"), "cmd");
  assert.equal(loginShellKind("/bin/bash", "linux"), "posix");
  assert.equal(cliLoginCommandLine("openai", "C:\\Users\\Ada\\codex.exe", "cmd"), '"C:\\Users\\Ada\\codex.exe" login\r');
  for (const name of ["C:\\Users\\%USERNAME%\\codex.exe", "C:\\a&b\\codex.exe", "C:\\a^b\\codex.exe", "C:\\a!b\\codex.exe", 'C:\\a"b\\codex.exe']) {
    assert.equal(cliLoginCommandLine("openai", name, "cmd"), null, name);
  }
  for (const name of ["/opt/a\nb/codex", "/opt/a\rb/codex", "/opt/a\u0000b", "/opt/" + String.fromCharCode(0x2018) + "x/codex", "/opt/" + String.fromCharCode(0x201b) + "x"]) {
    for (const shell of ["powershell", "cmd", "posix"] as const) assert.equal(cliLoginCommandLine("openai", name, shell), null);
  }
  // Providers without a documented sign-in command get none.
  for (const provider of ["google", "xai", "moonshot", "qwen", "mistral"] as const) assert.equal(cliLoginCommandLine(provider, "/opt/cli", "posix"), null);
});
