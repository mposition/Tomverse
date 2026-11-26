import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CommandLaunch, CommandLaunchResult } from "./commands.js";
import { commandEnv } from "./env.js";
import type { SandboxMode, SandboxUnavailable } from "./sandbox.js";

/**
 * The Windows sandbox.
 *
 * What it is: the command runs with a copy of the person's own token at the LOW integrity level (Windows' mandatory integrity
 * control), with every privilege except bypass-traverse removed, in a job object that ends the whole tree with it and takes away
 * clipboard, desktop, global atom and display access. A low-integrity process cannot write an object that is not labeled low.
 * Ordinary files, registry keys and other processes are not, so the command can write only where something was labeled low:
 *
 *   workspace-write  the working folder is labeled low (once; see `markWorkspace`), and the command's temp folder, which
 *                    lives under %USERPROFILE%\AppData\LocalLow, a place Windows already labels low.
 *   read-only        nothing is labeled; only the places Windows already labels low (LocalLow) are writable.
 *
 * Why not a restricted token with restricting SIDs, which is what Codex's unelevated Windows sandbox is: a restricted token fails
 * the access check on a named pipe the process makes itself (the default pipe ACL names no restricting SID), and Node.js makes
 * one for every child process it spawns with piped output, so `npm test` could not run. This was tried and measured; see
 * docs/ops/desktop-sandbox.md.
 *
 * What it changes on the person's disk, and how to undo it: `markWorkspace` writes an inheritable "low" mandatory label on the
 * working folder, which Windows copies to the folder's existing files and folders. When the person's account does not hold
 * WRITE_OWNER on the folder (a data drive whose ACL gives "Authenticated Users" only Modify), it first adds one inheritable ACE
 * granting that account WRITE_OWNER, and `clearWindowsMarks` removes exactly that ACE again. `clearWindowsMarks` also sets the
 * label back to medium, the level every ordinary file has. Which folders were changed is kept in `sandbox-marks.json`.
 *
 * What it does NOT do: restrict reading (files under %LOCALAPPDATA% and %APPDATA% could not be read by a low-integrity process
 * on the machine this was built on, but that is Windows' own default and is not relied on), restrict the network (the proxy
 * variables can be ignored), or stop writes to other places already labeled low (AppData\LocalLow, and Temp\Low folders).
 */

export type WindowsSandbox =
    | { ok: true; launch: CommandLaunch; tempDir: string; close: () => Promise<void> }
    | { ok: false; reason: Extract<SandboxUnavailable, "windows-launcher-failed" | "windows-workspace-not-markable">; detail: string };

export type WindowsSandboxOptions = {
    mode: Exclude<SandboxMode, "off">;
    workspaceRoot: string;
    stateDir: string;
    home: string;
    proxyEnv: Record<string, string>;
    /** Test hook: where the temp folder goes instead of %USERPROFILE%\AppData\LocalLow. */
    tempParent?: string;
};

const systemRoot = () => process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
const powershellFile = () => join(systemRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const icaclsFile = () => join(systemRoot(), "System32", "icacls.exe");

/** Windows command-line quoting: the rules CommandLineToArgvW reads back. */
export const quoteWindowsArg = (arg: string): string => {
    if (arg !== "" && !/[\s"]/.test(arg)) return arg;
    let out = '"';
    let backslashes = 0;
    for (const char of arg) {
        if (char === "\\") {
            backslashes += 1;
        } else if (char === '"') {
            out += `${"\\".repeat(backslashes * 2 + 1)}"`;
            backslashes = 0;
        } else {
            out += `${"\\".repeat(backslashes)}${char}`;
            backslashes = 0;
        }
    }
    return `${out}${"\\".repeat(backslashes * 2)}"`;
};

export const windowsCommandLine = (file: string, args: readonly string[]) => [file, ...args].map(quoteWindowsArg).join(" ");

// ---------------------------------------------------------------------------------------------------------------------
// The launcher: runs in the person's own PowerShell, builds the low-integrity token and starts the command with it.

const LAUNCHER_SOURCE = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class TvSandbox
{
    [StructLayout(LayoutKind.Sequential)] struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo
    {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential)]
    struct JobBasicLimit
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)]
    struct JobExtendedLimit
    {
        public JobBasicLimit Basic; public IoCounters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr p, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool CreateRestrictedToken(IntPtr existing, uint flags, uint disableCount, IntPtr disable, uint deleteCount, IntPtr delete,
        uint restrictCount, IntPtr restrict, out IntPtr newToken);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertStringSidToSid(string s, out IntPtr sid);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int cls, IntPtr info, int len);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessAsUserW(IntPtr token, string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags,
        IntPtr env, string cwd, ref StartupInfo si, out ProcessInformation pi);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr a, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, int len);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr p);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr t);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr p, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr p, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);

    static void Check(bool ok, string what)
    {
        if (ok) return;
        int e = Marshal.GetLastWin32Error();
        throw new Win32Exception(e, what + " (" + e + ")");
    }

    public static int Run(string commandLine, string cwd, string[] env)
    {
        IntPtr token;
        Check(OpenProcessToken(GetCurrentProcess(), 0x2 | 0x1 | 0x8 | 0x80, out token), "OpenProcessToken");
        // DISABLE_MAX_PRIVILEGE: every privilege but bypass-traverse is removed from the copy.
        IntPtr low;
        Check(CreateRestrictedToken(token, 0x1, 0, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero, out low), "CreateRestrictedToken");
        IntPtr lowSid;
        Check(ConvertStringSidToSid("S-1-16-4096", out lowSid), "ConvertStringSidToSid");
        IntPtr label = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SidAndAttributes)));
        Marshal.StructureToPtr(new SidAndAttributes { Sid = lowSid, Attributes = 0x20 }, label, false);
        Check(SetTokenInformation(low, 25, label, Marshal.SizeOf(typeof(SidAndAttributes))), "SetTokenInformation(IntegrityLevel)");

        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        Check(job != IntPtr.Zero, "CreateJobObject");
        var limit = new JobExtendedLimit();
        limit.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        int limitSize = Marshal.SizeOf(typeof(JobExtendedLimit));
        IntPtr limitMem = Marshal.AllocHGlobal(limitSize);
        Marshal.StructureToPtr(limit, limitMem, false);
        Check(SetInformationJobObject(job, 9, limitMem, limitSize), "SetInformationJobObject(limit)");
        IntPtr uiMem = Marshal.AllocHGlobal(4);
        // handles, read/write clipboard, system parameters, display settings, global atoms, desktop, exit windows
        Marshal.WriteInt32(uiMem, 0xFF);
        Check(SetInformationJobObject(job, 4, uiMem, 4), "SetInformationJobObject(ui)");

        var si = new StartupInfo();
        si.cb = Marshal.SizeOf(typeof(StartupInfo));
        // The interactive desktop, named: a parent that runs on another desktop would hand its own down, and a low-integrity process cannot open that one.
        si.lpDesktop = @"winsta0\default";
        si.dwFlags = 0x100; // STARTF_USESTDHANDLES
        si.hStdInput = GetStdHandle(-10); si.hStdOutput = GetStdHandle(-11); si.hStdError = GetStdHandle(-12);
        foreach (var h in new[] { si.hStdInput, si.hStdOutput, si.hStdError })
            if (h != IntPtr.Zero && h != new IntPtr(-1)) SetHandleInformation(h, 1, 1);
        Array.Sort(env, StringComparer.OrdinalIgnoreCase);
        var block = new StringBuilder();
        foreach (var e in env) { block.Append(e); block.Append((char)0); }
        block.Append((char)0);
        IntPtr envMem = Marshal.StringToHGlobalUni(block.ToString());
        ProcessInformation pi;
        // CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT. The job takes it before it runs a single instruction.
        Check(CreateProcessAsUserW(low, null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, 0x4 | 0x400, envMem, cwd, ref si, out pi), "CreateProcessAsUser");
        if (!AssignProcessToJobObject(job, pi.hProcess))
        {
            int err = Marshal.GetLastWin32Error();
            TerminateProcess(pi.hProcess, 1);
            throw new Win32Exception(err, "AssignProcessToJobObject (" + err + ")");
        }
        ResumeThread(pi.hThread);
        CloseHandle(pi.hThread);
        WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
        uint code;
        GetExitCodeProcess(pi.hProcess, out code);
        CloseHandle(pi.hProcess);
        CloseHandle(job);
        return unchecked((int)code);
    }
}
`;

const LAUNCHER_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$specPath = $env:TVSBX_SPEC
try {
    $spec = [IO.File]::ReadAllText($specPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    Remove-Item -LiteralPath $specPath -Force -ErrorAction SilentlyContinue
    Add-Type -TypeDefinition @'
${LAUNCHER_SOURCE}
'@
    $list = New-Object System.Collections.Generic.List[string]
    foreach ($p in $spec.env.PSObject.Properties) { $list.Add($p.Name + '=' + $p.Value) }
    exit ([TvSandbox]::Run([string]$spec.commandLine, [string]$spec.cwd, $list.ToArray()))
} catch {
    $message = $_.Exception.Message
    if ($message -match '\(5\)') { $message += ' The program, or the folder it is in, cannot be read by a low-integrity process (programs installed under %LOCALAPPDATA% or %APPDATA% cannot run in the Windows sandbox).' }
    [Console]::Error.WriteLine('tomverse-sandbox: ' + $message)
    exit 126
}
`;

/** Reads or changes the security of one folder: the mandatory label (read) and the WRITE_OWNER entry (add, remove). */
const TOOL_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TvLabel
{
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern uint GetNamedSecurityInfoW(string n, int t, uint info, IntPtr o, IntPtr g, IntPtr d, IntPtr s, out IntPtr sd);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr sd, uint rev, uint info, out IntPtr str, out uint len);
    public static string Get(string path)
    {
        IntPtr sd;
        // LABEL_SECURITY_INFORMATION = 0x10
        uint r = GetNamedSecurityInfoW(path, 1, 0x10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out sd);
        if (r != 0) return "error " + r;
        IntPtr str; uint len;
        if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, 1, 0x10, out str, out len)) return "error convert";
        return Marshal.PtrToStringUni(str);
    }
}
'@
$path = $env:TVSBX_PATH
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User
switch ($env:TVSBX_OP) {
    'label' { [Console]::Out.Write([TvLabel]::Get($path)) }
    default {
        $acl = [IO.Directory]::GetAccessControl($path, [Security.AccessControl.AccessControlSections]::Access)
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($me, 'TakeOwnership', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        if ($env:TVSBX_OP -eq 'ace-add') { $acl.AddAccessRule($rule) } else { [void]$acl.RemoveAccessRule($rule) }
        [IO.Directory]::SetAccessControl($path, $acl)
    }
}
`;

// ---------------------------------------------------------------------------------------------------------------------

type Finished = { code: number | null; stdout: string; stderr: string };

const exec = (file: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<Finished> =>
    new Promise((done) => {
        let stdout = "";
        let stderr = "";
        const child = spawn(file, args, { env: commandEnv([], process.env, env), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        const timer = setTimeout(() => child.kill(), timeoutMs);
        child.stdout.on("data", (chunk: Buffer) => (stdout = (stdout + chunk).slice(-4000)));
        child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk).slice(-4000)));
        child.on("error", (error) => done({ code: null, stdout, stderr: `${stderr}${error.message}` }));
        child.on("close", (code) => {
            clearTimeout(timer);
            done({ code, stdout, stderr });
        });
    });

const scriptArgs = (path: string) => ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `& ([scriptblock]::Create([IO.File]::ReadAllText('${path.replaceAll("'", "''")}')))`];

/** Writes a script into the state folder under a name that holds its hash, so an edited copy is never run by mistake. */
const installScript = (stateDir: string, name: string, text: string) => {
    mkdirSync(stateDir, { recursive: true });
    const path = join(stateDir, `${name}-${createHash("sha256").update(text).digest("hex").slice(0, 12)}.ps1`);
    if (!existsSync(path)) {
        const temporary = `${path}.${process.pid}.tmp`;
        writeFileSync(temporary, text);
        renameSync(temporary, path);
    }
    return path;
};

/** The command a sandboxed program is started through. `spec` is read and deleted by the launcher before it starts anything. */
const launcherLaunch = (stateDir: string, tempDir: string, extraEnv: Record<string, string>, readOnly: boolean): CommandLaunch => {
    const script = installScript(stateDir, "sandbox-launch", LAUNCHER_SCRIPT);
    return (file, args, context): CommandLaunchResult => {
        if (!context) throw new Error("The Windows sandbox needs the command's working folder and environment.");
        // Names are case-insensitive on Windows (HTTP_PROXY and http_proxy are one variable), and the launcher's JSON reader refuses duplicates.
        const sandboxEnv: Record<string, string> = {};
        const spell = new Map<string, string>();
        const put = (name: string, value: string) => {
            const key = name.toLowerCase();
            sandboxEnv[spell.get(key) ?? name] = value;
            if (!spell.has(key)) spell.set(key, name);
        };
        for (const [name, value] of Object.entries({ ...context.env, ...extraEnv })) put(name, value);
        if (!readOnly) {
            for (const [name, value] of Object.entries({ TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir, APPDATA: join(tempDir, "appdata", "Roaming"), LOCALAPPDATA: join(tempDir, "appdata", "Local") })) put(name, value);
            mkdirSync(join(tempDir, "appdata", "Roaming"), { recursive: true });
            mkdirSync(join(tempDir, "appdata", "Local"), { recursive: true });
        }
        const specPath = join(stateDir, `spec-${randomBytes(8).toString("hex")}.json`);
        writeFileSync(specPath, JSON.stringify({ commandLine: windowsCommandLine(file, args), cwd: context.cwd, env: sandboxEnv }), { mode: 0o600 });
        return { file: powershellFile(), args: scriptArgs(script), env: { TVSBX_SPEC: specPath } };
    };
};

/** Runs one command through the launcher, outside any task: the probe, and the tests. */
export const runThroughLauncher = (stateDir: string, commandLine: string, cwd: string, env: Record<string, string>, timeoutMs = 60_000): Promise<Finished> => {
    const script = installScript(stateDir, "sandbox-launch", LAUNCHER_SCRIPT);
    const specPath = join(stateDir, `spec-${randomBytes(8).toString("hex")}.json`);
    writeFileSync(specPath, JSON.stringify({ commandLine, cwd, env }), { mode: 0o600 });
    return exec(powershellFile(), scriptArgs(script), { TVSBX_SPEC: specPath }, timeoutMs).finally(() => rmSync(specPath, { force: true }));
};

const labelOf = async (stateDir: string, path: string) => {
    const script = installScript(stateDir, "sandbox-tool", TOOL_SCRIPT);
    const result = await exec(powershellFile(), scriptArgs(script), { TVSBX_OP: "label", TVSBX_PATH: path }, 30_000);
    return result.code === 0 ? result.stdout.trim() : `error ${result.stderr.trim() || result.code}`;
};

/** True when the folder carries the low label that new files inherit (`;;;LW)`). */
export const isMarkedLow = async (stateDir: string, path: string) => /\(ML;[A-Z]*;[A-Z]*;;;LW\)/.test(await labelOf(stateDir, path));

const aceTool = async (stateDir: string, op: "ace-add" | "ace-remove", path: string) => {
    const script = installScript(stateDir, "sandbox-tool", TOOL_SCRIPT);
    return exec(powershellFile(), scriptArgs(script), { TVSBX_OP: op, TVSBX_PATH: path }, 10 * 60_000);
};

/** `inherit` is for folders: icacls ignores the inheritance flags on a file, and a file is set with the plain level. */
const setLevel = (path: string, level: "L" | "M", inherit = true) => exec(icaclsFile(), [path, "/setintegritylevel", inherit ? `(OI)(CI)${level}` : level], {}, 15 * 60_000);

// ---------------------------------------------------------------------------------------------------------------------
// The list of folders this sandbox changed

type Marks = { roots: { path: string; aceAdded: boolean; at: string }[] };

const marksFile = (stateDir: string) => join(stateDir, "sandbox-marks.json");

const readMarks = (stateDir: string): Marks => {
    try {
        const parsed = JSON.parse(readFileSync(marksFile(stateDir), "utf8")) as Marks;
        return { roots: Array.isArray(parsed.roots) ? parsed.roots.filter((r) => typeof r?.path === "string") : [] };
    } catch {
        return { roots: [] };
    }
};

const writeMarks = (stateDir: string, marks: Marks) => {
    mkdirSync(stateDir, { recursive: true });
    const temporary = `${marksFile(stateDir)}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(marks, null, 2));
    renameSync(temporary, marksFile(stateDir));
};

/** The working folders this sandbox has labeled, for the settings screen. */
export const markedWorkspaces = (stateDir: string) => readMarks(stateDir).roots.map((root) => root.path);

export type MarkResult = { ok: true; changed: boolean } | { ok: false; detail: string };

/** Labels the working folder low (and what is inside it), granting WRITE_OWNER first when the account lacks it. Idempotent. */
export async function markWorkspace(stateDir: string, root: string): Promise<MarkResult> {
    const path = resolve(root);
    let changed = false;
    let aceAdded = false;
    if (!(await isMarkedLow(stateDir, path))) {
        let result = await setLevel(path, "L");
        if (result.code !== 0 && /denied/i.test(`${result.stdout}${result.stderr}`)) {
            const grant = await aceTool(stateDir, "ace-add", path);
            if (grant.code !== 0) return { ok: false, detail: `the account has no right to change the folder's security: ${grant.stderr.trim().slice(0, 200)}` };
            aceAdded = true;
            result = await setLevel(path, "L");
        }
        if (result.code !== 0) {
            if (aceAdded) await aceTool(stateDir, "ace-remove", path);
            return { ok: false, detail: `the working folder could not be marked: ${`${result.stdout}${result.stderr}`.trim().slice(0, 300)}` };
        }
        changed = true;
        const marks = readMarks(stateDir);
        marks.roots = [...marks.roots.filter((entry) => entry.path.toLowerCase() !== path.toLowerCase()), { path, aceAdded, at: new Date().toISOString() }];
        writeMarks(stateDir, marks);
    }
    // Always: what a command could plant to run later outside the sandbox stays medium, which a low process cannot write.
    for (const protectedPath of [join(path, ".git", "hooks"), join(path, ".git", "config"), join(path, ".gitmodules"), join(path, ".tomverse"), join(path, ".mcp.json")]) {
        if (existsSync(protectedPath)) await setLevel(protectedPath, "M", statSync(protectedPath).isDirectory());
    }
    return { ok: true, changed };
}

/** Undoes `markWorkspace` for one folder (or all of them): label back to medium, and the WRITE_OWNER entry removed when this added it. */
export async function clearWindowsMarks(stateDir: string, only?: string): Promise<{ cleared: string[]; failed: string[] }> {
    const marks = readMarks(stateDir);
    const cleared: string[] = [];
    const failed: string[] = [];
    const keep: Marks["roots"] = [];
    for (const entry of marks.roots) {
        if (only && entry.path.toLowerCase() !== resolve(only).toLowerCase()) {
            keep.push(entry);
            continue;
        }
        let ok = true;
        if (existsSync(entry.path)) {
            ok = (await setLevel(entry.path, "M")).code === 0;
            if (ok && entry.aceAdded) ok = (await aceTool(stateDir, "ace-remove", entry.path)).code === 0;
        }
        if (ok) cleared.push(entry.path);
        else {
            failed.push(entry.path);
            keep.push(entry);
        }
    }
    writeMarks(stateDir, { roots: keep });
    return { cleared, failed };
}

// ---------------------------------------------------------------------------------------------------------------------

let launcherProbe: Promise<{ ok: true } | { ok: false; detail: string }> | undefined;

/** Starts a trivial command through the launcher and has it write a file into the temp folder: the whole chain, once per process. */
export const probeWindowsLauncher = (stateDir: string, tempDir: string) => (launcherProbe ??= (async () => {
    const proof = join(tempDir, "probe-write");
    const result = await runThroughLauncher(stateDir, windowsCommandLine(join(systemRoot(), "System32", "cmd.exe"), ["/d", "/c", "copy nul probe-write"]), tempDir,
        { SystemRoot: systemRoot(), PATH: join(systemRoot(), "System32"), TEMP: tempDir, TMP: tempDir });
    const written = existsSync(proof);
    rmSync(proof, { force: true });
    if (result.code === 0 && written) return { ok: true as const };
    launcherProbe = undefined;
    return { ok: false as const, detail: `the Windows launcher did not start a low-integrity command (exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 300)}` };
})());

export async function prepareWindowsSandbox(options: WindowsSandboxOptions): Promise<WindowsSandbox> {
    const parent = options.tempParent ?? join(options.home, "AppData", "LocalLow", "Tomverse", "sandbox-tmp");
    const tempDir = join(parent, randomBytes(6).toString("hex"));
    try {
        mkdirSync(tempDir, { recursive: true });
    } catch (error) {
        return { ok: false, reason: "windows-launcher-failed", detail: `the sandbox temp folder could not be created: ${(error as Error).message}` };
    }
    const close = async () => {
        rmSync(tempDir, { recursive: true, force: true });
    };
    const probe = await probeWindowsLauncher(options.stateDir, tempDir);
    if (!probe.ok) {
        await close();
        return { ok: false, reason: "windows-launcher-failed", detail: probe.detail };
    }
    if (options.mode === "workspace-write") {
        const marked = await markWorkspace(options.stateDir, options.workspaceRoot);
        if (!marked.ok) {
            await close();
            return { ok: false, reason: "windows-workspace-not-markable", detail: marked.detail };
        }
    }
    return { ok: true, tempDir, close, launch: launcherLaunch(options.stateDir, tempDir, options.proxyEnv, options.mode === "read-only") };
}

/** Whether a low-integrity command can be started here at all, for the settings screen. Starts one trivial command. */
export async function windowsSandboxAvailable(stateDir: string, home: string): Promise<{ ok: true } | { ok: false; detail: string }> {
    const tempDir = join(home, "AppData", "LocalLow", "Tomverse", "sandbox-tmp", `probe-${randomBytes(4).toString("hex")}`);
    try {
        mkdirSync(tempDir, { recursive: true });
        return await probeWindowsLauncher(stateDir, tempDir);
    } catch (error) {
        return { ok: false, detail: (error as Error).message };
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}
