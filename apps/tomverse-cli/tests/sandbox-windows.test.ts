import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { planCommand, runCommand, type CommandInput } from "../src/commands.js";
import { createSandboxRuntime, normalizeSandboxSettings, SandboxUnavailableError, type SandboxRuntime } from "../src/sandbox.js";
import { clearWindowsMarks, isMarkedLow, markedWorkspaces, markWorkspace, quoteWindowsArg, windowsCommandLine } from "../src/sandbox-windows.js";
import { tempDir } from "./helpers.js";

// These run real commands in the real low-integrity sandbox, so they run on Windows only. The folders are made under the home
// folder, not the temp folder: the temp folder is under %LOCALAPPDATA%, which a low-integrity process cannot read here, and a
// working folder is never there.
const windows = process.platform === "win32";
const never = new AbortController().signal;
const system = process.env.SystemRoot ?? "C:\\Windows";
const cmd = join(system, "System32", "cmd.exe");

let base = "";
let workspace = "";
let other = "";
let state = "";
const runtimes: SandboxRuntime[] = [];

const settings = (mode: "workspace-write" | "read-only") => ({ ...normalizeSandboxSettings({ mode }), allowedDomains: ["registry.npmjs.org"] });
const runtime = async (mode: "workspace-write" | "read-only", root = workspace) => {
    const made = await createSandboxRuntime({ settings: settings(mode), workspaceRoot: root, stateDir: state });
    assert.ok(made, "a runtime for a mode that is on");
    runtimes.push(made);
    return made;
};
const run = (sandbox: SandboxRuntime | null, input: CommandInput, cwd = workspace) =>
    runCommand(planCommand(input, cwd, 120_000), never, undefined, [], sandbox?.launch);
const shell = (sandbox: SandboxRuntime | null, line: string) => run(sandbox, { argv: [cmd, "/d", "/c", line] });

before(() => {
    if (!windows) return;
    base = join(homedir(), `.tvsbx-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
    workspace = join(base, "ws");
    other = join(base, "other");
    state = tempDir("sbx-state");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(other, { recursive: true });
    mkdirSync(join(workspace, ".git", "hooks"), { recursive: true });
    writeFileSync(join(workspace, "existing.txt"), "before");
    writeFileSync(join(workspace, ".git", "config"), "[core]\n");
});

after(async () => {
    if (!windows) return;
    for (const made of runtimes) await made.close();
    await clearWindowsMarks(state);
    rmSync(base, { recursive: true, force: true });
});

test("Windows command lines are quoted the way CommandLineToArgvW reads them", () => {
    assert.equal(quoteWindowsArg("plain"), "plain");
    assert.equal(quoteWindowsArg("a b"), '"a b"');
    assert.equal(quoteWindowsArg(""), '""');
    assert.equal(quoteWindowsArg('say "hi"'), '"say \\"hi\\""');
    assert.equal(quoteWindowsArg("C:\\dir with space\\"), '"C:\\dir with space\\\\"');
    assert.equal(windowsCommandLine("C:\\Program Files\\x.exe", ["a", "b c"]), '"C:\\Program Files\\x.exe" a "b c"');
});

test("workspace-write: the command writes in the working folder and cannot write anywhere else", { skip: !windows, timeout: 300_000 }, async () => {
    const sandbox = await runtime("workspace-write");
    assert.equal(sandbox.enforcement.available, true, sandbox.enforcement.detail);
    // The control: without the sandbox the same command writes outside, so the denial below is the sandbox's doing.
    const control = await shell(null, "echo out> ..\\other\\control.txt");
    assert.equal(control.exitCode, 0, control.stderr);
    assert.ok(existsSync(join(other, "control.txt")));

    const inside = await shell(sandbox, "echo in> a.txt & echo done");
    assert.equal(inside.exitCode, 0, `${inside.stdout}${inside.stderr}`);
    assert.match(inside.stdout, /done/);
    assert.equal(readFileSync(join(workspace, "a.txt"), "utf8").trim(), "in");

    const outside = await shell(sandbox, "echo out> ..\\other\\b.txt");
    assert.notEqual(outside.exitCode, 0, "writing outside the working folder must fail");
    assert.equal(existsSync(join(other, "b.txt")), false);
    assert.match(`${outside.stdout}${outside.stderr}`, /denied|access/i);

    // A file that existed before the folder was marked can be changed, and the folder's marker is on record.
    const edit = await shell(sandbox, "echo after> existing.txt");
    assert.equal(edit.exitCode, 0, `${edit.stdout}${edit.stderr}`);
    assert.equal(readFileSync(join(workspace, "existing.txt"), "utf8").trim(), "after");
    assert.equal(await isMarkedLow(state, workspace), true);
    assert.deepEqual(markedWorkspaces(state).map((p) => p.toLowerCase()), [workspace.toLowerCase()]);
});

test("workspace-write: the temp folder is writable, the real user temp folder is not, and git hooks and config stay read-only", { skip: !windows, timeout: 300_000 }, async () => {
    const sandbox = await runtime("workspace-write");
    const temp = await shell(sandbox, "echo t> %TEMP%\\t.txt & type %TEMP%\\t.txt");
    assert.equal(temp.exitCode, 0, `${temp.stdout}${temp.stderr}`);
    assert.match(temp.stdout, /t/);
    assert.ok(!temp.stdout.toLowerCase().includes(join(homedir(), "AppData", "Local", "Temp").toLowerCase()), "TEMP points at the sandbox's own folder");

    const hook = await shell(sandbox, "echo x> .git\\hooks\\pre-commit");
    assert.notEqual(hook.exitCode, 0, "a git hook cannot be planted");
    assert.equal(existsSync(join(workspace, ".git", "hooks", "pre-commit")), false);
    const config = await shell(sandbox, "echo x>> .git\\config");
    assert.notEqual(config.exitCode, 0, ".git/config cannot be changed");
    assert.equal(readFileSync(join(workspace, ".git", "config"), "utf8"), "[core]\n");
    // The rest of .git is the project's own and stays writable.
    const index = await shell(sandbox, "echo x> .git\\index");
    assert.equal(index.exitCode, 0, `${index.stdout}${index.stderr}`);
});

test("read-only: the command cannot write even in the working folder", { skip: !windows, timeout: 300_000 }, async () => {
    const sandbox = await runtime("read-only");
    assert.equal(sandbox.enforcement.available, true, sandbox.enforcement.detail);
    const read = await shell(sandbox, "type existing.txt");
    assert.equal(read.exitCode, 0, `${read.stdout}${read.stderr}`);
    assert.match(read.stdout, /after/);
    // Marked by the earlier test; a read-only run must not rely on that, so write to a place the read-only run owns nothing of.
    const fresh = join(base, "fresh");
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(fresh, "f.txt"), "keep");
    const readOnly = await runtime("read-only", fresh);
    const write = await run(readOnly, { argv: [cmd, "/d", "/c", "echo changed> f.txt"] }, fresh);
    assert.notEqual(write.exitCode, 0);
    assert.equal(readFileSync(join(fresh, "f.txt"), "utf8"), "keep");
    const create = await run(readOnly, { argv: [cmd, "/d", "/c", "echo new> g.txt"] }, fresh);
    assert.notEqual(create.exitCode, 0);
    assert.equal(existsSync(join(fresh, "g.txt")), false);
    assert.equal(await isMarkedLow(state, fresh), false, "read-only marks nothing");
});

test("the shell form runs in PowerShell inside the sandbox with the same limits", { skip: !windows, timeout: 300_000 }, async () => {
    const sandbox = await runtime("workspace-write");
    const result = await run(sandbox, { command: "$ExecutionContext.SessionState.LanguageMode; Set-Content -Path in.txt -Value ok; try { Set-Content -Path ..\\other\\ps.txt -Value no -ErrorAction Stop; 'wrote-outside' } catch { 'denied-outside' }" });
    assert.equal(result.exitCode, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /FullLanguage/);
    assert.match(result.stdout, /denied-outside/);
    assert.equal(existsSync(join(other, "ps.txt")), false);
    assert.equal(readFileSync(join(workspace, "in.txt"), "utf8").trim(), "ok");
});

test("a program that makes its own child processes with piped output still works (Node child_process)", { skip: !windows, timeout: 300_000 }, async () => {
    const sandbox = await runtime("workspace-write");
    const result = await run(sandbox, { argv: [process.execPath, "-e", "const c=require('child_process');const r=c.spawnSync(process.execPath,['-p','6*7'],{stdio:'pipe'});process.stdout.write(String(r.stdout).trim()+' '+r.status)"] });
    if (/cannot be read by a low-integrity process/.test(result.stderr)) return; // node itself is installed under AppData here
    assert.equal(result.exitCode, 0, `${result.stdout}${result.stderr}`);
    assert.equal(result.stdout.trim(), "42 0");
});

test("the filtering proxy's address reaches the command as environment variables", { skip: !windows, timeout: 300_000 }, async () => {
    const sandbox = await runtime("workspace-write");
    assert.ok(sandbox.proxy);
    const result = await shell(sandbox, "echo %HTTPS_PROXY%");
    assert.equal(result.stdout.trim(), sandbox.proxy!.url);
    assert.equal(sandbox.enforcement.network, "environment-only", "Windows cannot stop a connection that ignores the variables");
    assert.equal(sandbox.enforcement.credentialReads, "partial");
});

test("when the sandbox cannot be built the command is refused with the reason and nothing runs", { skip: !windows }, async () => {
    const refused = await createSandboxRuntime({
        settings: settings("workspace-write"), workspaceRoot: workspace, stateDir: state,
        windows: { prepare: async () => ({ ok: false, reason: "windows-launcher-failed", detail: "the launcher failed in this test" }) },
    });
    assert.ok(refused);
    assert.equal(refused.enforcement.available, false);
    assert.equal(refused.enforcement.unavailable, "windows-launcher-failed");
    assert.throws(() => refused.launch(cmd, ["/c", "echo hi"], { cwd: workspace, env: {} }), SandboxUnavailableError);
    const marker = join(workspace, "must-not-exist.txt");
    const result = await shell(refused, `echo ran> ${marker.split("\\").pop()}`);
    assert.ok(result.spawnError && /the launcher failed in this test/.test(result.spawnError), result.spawnError);
    assert.equal(existsSync(marker), false);
    await refused.close();

    // A working folder that is the whole home folder is not a project and is refused the same way.
    const broad = await createSandboxRuntime({ settings: settings("workspace-write"), workspaceRoot: homedir(), stateDir: state });
    assert.equal(broad?.enforcement.unavailable, "workspace-too-broad");
});

test("a folder whose owner lacks WRITE_OWNER is marked through one added entry, and clearing removes exactly that entry and the label", { skip: !windows, timeout: 300_000 }, async () => {
    const folder = join(base, "no-write-owner");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "kept.txt"), "x");
    // Reproduces a data drive: the account is left with Modify only (no WRITE_OWNER) and nothing inherited.
    const ps = (script: string) => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
    const prepare = ps(`$p='${folder}'; $me=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=Get-Acl -LiteralPath $p; $acl.SetAccessRuleProtection($true,$false); ` +
        `foreach($r in @($acl.Access)){ [void]$acl.RemoveAccessRule($r) }; $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($me,'Modify,Synchronize','ContainerInherit,ObjectInherit','None','Allow'))); ` +
        `$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($me,'ChangePermissions','ContainerInherit,ObjectInherit','None','Allow'))); Set-Acl -LiteralPath $p -AclObject $acl`);
    assert.equal(prepare.status, 0, prepare.stderr);
    const result = await markWorkspace(state, folder);
    assert.deepEqual(result, { ok: true, changed: true });
    assert.equal(await isMarkedLow(state, folder), true);
    const withEntry = spawnSync("icacls", [join(folder, "kept.txt")], { encoding: "utf8" }).stdout;
    assert.match(withEntry, /\(I\)\([^)]*\bWO\b[^)]*\)/, "the entry was inherited by the existing file");
    const cleared = await clearWindowsMarks(state, folder);
    assert.deepEqual(cleared, { cleared: [folder], failed: [] });
    assert.equal(await isMarkedLow(state, folder), false);
    assert.doesNotMatch(spawnSync("icacls", [join(folder, "kept.txt")], { encoding: "utf8" }).stdout, /\(I\)\([^)]*\bWO\b[^)]*\)/);
    assert.equal(markedWorkspaces(state).some((p) => p.toLowerCase() === folder.toLowerCase()), false);
});

test("clearing the marks sets the folder back and forgets it", { skip: !windows, timeout: 300_000 }, async () => {
    assert.equal(await isMarkedLow(state, workspace), true);
    const cleared = await clearWindowsMarks(state);
    assert.ok(cleared.cleared.some((p) => p.toLowerCase() === workspace.toLowerCase()), JSON.stringify(cleared));
    assert.deepEqual(cleared.failed, []);
    assert.equal(await isMarkedLow(state, workspace), false);
    assert.deepEqual(markedWorkspaces(state), []);
});
