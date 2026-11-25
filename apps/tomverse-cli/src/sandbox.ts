import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { CommandError, type CommandLaunch, type CommandLaunchResult } from "./commands.js";
import { DEFAULT_ALLOWED_DOMAINS, normalizeAllowedDomains, startFilteringProxy, type FilteringProxy } from "./net-proxy.js";
import { prepareWindowsSandbox, windowsSandboxAvailable, type WindowsSandbox } from "./sandbox-windows.js";

/**
 * An operating-system sandbox for the commands the agent runs.
 *
 *   off             nothing is added (the default).
 *   workspace-write the command can write the working folder and a temporary
 *                   folder, and nowhere else. It can read the rest, except the
 *                   places that hold credentials (macOS, Linux).
 *   read-only       the command can write nowhere.
 *
 * Network: a filtering proxy that lives in this process (net-proxy.ts) is
 * given to the command through HTTP_PROXY / HTTPS_PROXY. Where the OS can do
 * it the sandbox also stops every other connection, so the proxy is the only
 * way out: macOS (Seatbelt) and Linux (bubblewrap, whose network namespace has
 * the proxy's Unix socket relayed in by socat; without socat the namespace has
 * no network at all). Windows has no way to do that without administrator
 * rights, so there the proxy is only a variable the command may ignore.
 *
 * It fails closed. When the sandbox is on and cannot be built here, the
 * launcher throws and the command is not started. It never runs the command
 * without the sandbox.
 *
 * What is NOT enforced is part of the contract (docs/ops/desktop-sandbox.md,
 * and the settings screen shows `SandboxEnforcement` as it is for this
 * computer). Not enforced anywhere: reading ordinary files, the user's own
 * processes (a command can ask another program, an IDE or a running daemon, to
 * act), and what an allowed site is told (only the host name is judged).
 */

export type SandboxMode = "off" | "workspace-write" | "read-only";
export const sandboxModes = ["off", "workspace-write", "read-only"] as const satisfies readonly SandboxMode[];

export type SandboxSettings = { mode: SandboxMode; allowedDomains: string[]; allowLocalhost: boolean };

export const defaultSandboxSettings = (): SandboxSettings => ({ mode: "off", allowedDomains: [...DEFAULT_ALLOWED_DOMAINS], allowLocalhost: false });

/** Reads settings from whatever was stored; anything missing or malformed takes the safe default (sandbox off, small list, no localhost). */
export const normalizeSandboxSettings = (raw: unknown): SandboxSettings => {
    const value = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const defaults = defaultSandboxSettings();
    return {
        mode: sandboxModes.includes(value.mode as SandboxMode) ? (value.mode as SandboxMode) : defaults.mode,
        allowedDomains: Array.isArray(value.allowedDomains) ? normalizeAllowedDomains(value.allowedDomains) : defaults.allowedDomains,
        allowLocalhost: value.allowLocalhost === true,
    };
};

export type SandboxPlatform = "macos" | "linux" | "windows" | "other";
export const sandboxPlatform = (platform: NodeJS.Platform = process.platform): SandboxPlatform =>
    platform === "darwin" ? "macos" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : "other";

export type SandboxUnavailable =
    | "unsupported-platform"
    | "missing-sandbox-exec"
    | "sandbox-exec-failed"
    | "missing-bwrap"
    | "bwrap-failed"
    | "workspace-too-broad"
    | "windows-launcher-failed"
    | "windows-workspace-not-markable"
    | "proxy-failed";

/** What the OS really enforces on this computer for the chosen mode. `none` and `environment-only` are stated, not hidden. */
export type SandboxEnforcement = {
    platform: SandboxPlatform;
    mode: SandboxMode;
    available: boolean;
    unavailable?: SandboxUnavailable;
    /** English detail for logs and the error the command gets; the settings screen shows its own words for `unavailable`. */
    detail?: string;
    /** Writes outside the allowed folders are refused by the OS. */
    writes: "os" | "none";
    /** Credential folders cannot be read by the command. `partial`: Windows, only what Windows itself hides from low-integrity processes. */
    credentialReads: "os" | "partial" | "none";
    /** `os-proxy-only`: only the proxy is reachable. `os-blocked`: no network at all. `environment-only`: proxy variables the command may ignore. */
    network: "os-proxy-only" | "os-blocked" | "environment-only" | "none";
};

export class SandboxUnavailableError extends CommandError {
    constructor(readonly reason: SandboxUnavailable, detail: string) {
        super(`The sandbox is turned on but cannot be created here, so the command was not run: ${detail}. Turn the sandbox off or change it in the settings to run commands.`);
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// What to protect

/** Folders and files under the home folder that hold credentials. The command cannot read them (macOS, Linux). */
export const credentialPaths = (home: string, platform: SandboxPlatform, extra: readonly string[] = []): string[] => [
    ".ssh", ".aws", ".azure", ".config/gcloud", ".config/gh", ".config/git/credentials", ".gnupg", ".kube", ".docker/config.json",
    ".npmrc", ".yarnrc", ".yarnrc.yml", ".netrc", ".git-credentials", ".pypirc", ".cargo/credentials", ".cargo/credentials.toml", ".gem/credentials",
    ".terraform.d/credentials.tfrc.json", ".config/op", ".tomverse",
    ...(platform === "macos" ? ["Library/Keychains", "Library/Application Support/Google/Chrome", "Library/Application Support/Firefox"] : []),
    ...(platform === "linux" ? [".local/share/keyrings", ".config/google-chrome", ".mozilla"] : []),
].map((entry) => join(home, entry)).concat(extra.map((entry) => resolve(entry)));

/** Inside a writable workspace these stay read-only: a command could plant something that runs later, outside the sandbox. */
export const protectedWorkspacePaths = (workspace: string): string[] =>
    [".git/hooks", ".git/config", ".gitmodules", ".tomverse", ".mcp.json"].map((entry) => join(workspace, entry));

/** A working folder that is the whole machine, the whole home folder or a parent of it is not a project; the sandbox refuses it. */
export const workspaceTooBroad = (workspace: string, home: string, platform: SandboxPlatform = sandboxPlatform()): string | null => {
    const path = resolve(workspace);
    const lower = (value: string) => (platform === "windows" ? value.toLowerCase() : value);
    const a = lower(path.replace(/[\\/]+$/, ""));
    const h = lower(resolve(home).replace(/[\\/]+$/, ""));
    if (dirname(path) === path) return "the working folder is a drive or filesystem root";
    if (a === h || h.startsWith(`${a}/`) || h.startsWith(`${a}\\`)) return "the working folder is the home folder or contains it";
    return null;
};

const proxyEnv = (url: string, allowLocalhost: boolean): Record<string, string> => ({
    HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, ALL_PROXY: url, all_proxy: url,
    NODE_USE_ENV_PROXY: "1",
    NO_PROXY: allowLocalhost ? "localhost,127.0.0.1,::1" : "", no_proxy: allowLocalhost ? "localhost,127.0.0.1,::1" : "",
});

// ---------------------------------------------------------------------------------------------------------------------
// macOS: Seatbelt

const sbplString = (value: string) => {
    if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("A path with control characters cannot go into a sandbox profile.");
    return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
};

export type SeatbeltInput = {
    mode: Exclude<SandboxMode, "off">;
    workspace: string;
    tempDirs: readonly string[];
    denyRead: readonly string[];
    protectedWrite: readonly string[];
    /** The loopback port of the filtering proxy, the only place the command may connect to. */
    proxyPort: number | null;
    allowLocalhost: boolean;
};

/** The sandbox-exec profile. Later rules win in Seatbelt, so each deny that carves out of an allow comes after it. */
export const seatbeltProfile = (input: SeatbeltInput): string => {
    const lines = ["(version 1)", "(allow default)", "", ";; Writes: nothing unless allowed below.", "(deny file-write*)",
        '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/(fd/[0-9]+|tty[a-z0-9]*|pty[a-z0-9]*)$"))'];
    if (input.mode === "workspace-write") {
        lines.push(`(allow file-write* ${[input.workspace, ...input.tempDirs].map((path) => `(subpath ${sbplString(path)})`).join(" ")})`);
        for (const path of input.protectedWrite) lines.push(`(deny file-write* (subpath ${sbplString(path)}))`);
    }
    lines.push("", ";; Reads: everything, except where credentials live.");
    for (const path of input.denyRead) lines.push(`(deny file-read* (subpath ${sbplString(path)}))`);
    lines.push("", ";; Network: only the filtering proxy.", "(deny network*)");
    if (input.proxyPort !== null) lines.push(`(allow network-outbound (remote ip "localhost:${input.proxyPort}"))`);
    if (input.allowLocalhost) {
        lines.push('(allow network-outbound (remote ip "localhost:*"))', '(allow network-bind (local ip "localhost:*"))', '(allow network-inbound (local ip "localhost:*"))');
    }
    return `${lines.join("\n")}\n`;
};

// ---------------------------------------------------------------------------------------------------------------------
// Linux: bubblewrap

export type BwrapInput = {
    mode: Exclude<SandboxMode, "off">;
    workspace: string;
    cwd: string;
    /** Existing credential files and folders; a folder is hidden behind an empty tmpfs, a file behind /dev/null. */
    denyRead: readonly { path: string; directory: boolean }[];
    /** Existing paths inside the workspace that stay read-only. */
    protectedWrite: readonly string[];
    network: { kind: "none" } | { kind: "proxy"; socketPath: string; socatPath: string; port: number };
    file: string;
    args: readonly string[];
};

export const BWRAP_PROXY_SOCKET = "/tmp/.tomverse-proxy.sock";
export const BWRAP_PROXY_PORT = 3128;

const relayScript = (socatPath: string, port: number) =>
    `${shQuote(socatPath)} TCP-LISTEN:${port},bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${BWRAP_PROXY_SOCKET} >/dev/null 2>&1 & sleep 0.1; exec "$@"`;
const shQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** The bwrap arguments (not including the `bwrap` program). The command runs last, after `--`. */
export const bwrapArgs = (input: BwrapInput): string[] => {
    const args = ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
    if (input.mode === "workspace-write") {
        args.push("--bind", input.workspace, input.workspace);
        for (const path of input.protectedWrite) args.push("--ro-bind", path, path);
    }
    // After the workspace is bound, so a workspace that contains one of these cannot expose it again.
    for (const entry of input.denyRead) {
        if (entry.directory) args.push("--tmpfs", entry.path);
        else args.push("--ro-bind", "/dev/null", entry.path);
    }
    args.push("--unshare-net");
    if (input.network.kind === "proxy") args.push("--bind", input.network.socketPath, BWRAP_PROXY_SOCKET);
    args.push("--chdir", input.cwd, "--");
    if (input.network.kind === "proxy") {
        args.push("/bin/sh", "-c", relayScript(input.network.socatPath, input.network.port), "tomverse-sandbox", input.file, ...input.args);
    } else args.push(input.file, ...input.args);
    return args;
};

// ---------------------------------------------------------------------------------------------------------------------
// Runtime

export type SandboxProbe = {
    sandboxExec: () => Promise<boolean>;
    bwrap: () => Promise<{ path: string } | { error: string }>;
    socat: () => string | null;
};

const onPath = (name: string, env: NodeJS.ProcessEnv = process.env): string | null => {
    for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
        const candidate = join(dir, name);
        try {
            accessSync(candidate, fsConstants.X_OK);
            if (statSync(candidate).isFile()) return candidate;
        } catch {
            // not here
        }
    }
    return null;
};

const run = (file: string, args: string[], timeoutMs = 8000) =>
    new Promise<{ code: number | null; stderr: string }>((done) => {
        let stderr = "";
        const child = spawn(file, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
        const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
        child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk).slice(-400)));
        child.on("error", (error) => done({ code: null, stderr: error.message }));
        child.on("close", (code) => {
            clearTimeout(timer);
            done({ code, stderr });
        });
    });

export const systemProbe: SandboxProbe = {
    sandboxExec: async () => existsSync("/usr/bin/sandbox-exec") && (await run("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"])).code === 0,
    bwrap: async () => {
        const path = onPath("bwrap");
        if (!path) return { error: "bwrap (bubblewrap) is not installed" };
        // Creating the sandbox is the only reliable test: an unprivileged user namespace may be switched off.
        const probe = await run(path, ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--unshare-net", "true"]);
        return probe.code === 0 ? { path } : { error: `bwrap could not create a sandbox (${probe.stderr.trim() || `exit ${probe.code}`})` };
    },
    socat: () => onPath("socat"),
};

export type SandboxRuntimeOptions = {
    settings: SandboxSettings;
    workspaceRoot: string;
    /** A folder the sandbox may keep its own files in (Windows launcher, the list of marked folders). */
    stateDir?: string;
    /** More places the command may not read, for example the desktop app's own data folder. */
    extraDenyRead?: readonly string[];
    platform?: NodeJS.Platform;
    home?: string;
    probe?: SandboxProbe;
    startProxy?: typeof startFilteringProxy;
    /** Test hook for Windows. */
    windows?: { prepare?: typeof prepareWindowsSandbox; tempParent?: string };
};

export type SandboxRuntime = {
    settings: SandboxSettings;
    enforcement: SandboxEnforcement;
    proxy: FilteringProxy | null;
    launch: CommandLaunch;
    close(): Promise<void>;
};

/** Puts `outer` around what `inner` produced (the sandbox goes inside, a process supervisor outside). */
export const composeLaunch = (inner: CommandLaunch | undefined, outer: CommandLaunch | undefined): CommandLaunch | undefined => {
    if (!inner) return outer;
    if (!outer) return inner;
    return (file, args, context) => {
        const first = inner(file, args, context);
        const second = outer(first.file, first.args, context ? { ...context, env: { ...context.env, ...first.env } } : context);
        return { file: second.file, args: second.args, ...(first.env || second.env ? { env: { ...first.env, ...second.env } } : {}) };
    };
};

const refuse = (reason: SandboxUnavailable, detail: string): CommandLaunch => () => {
    throw new SandboxUnavailableError(reason, detail);
};

const describe = (platform: SandboxPlatform, mode: SandboxMode): Pick<SandboxEnforcement, "writes" | "credentialReads" | "network"> => {
    if (mode === "off") return { writes: "none", credentialReads: "none", network: "none" };
    if (platform === "windows") return { writes: "os", credentialReads: "partial", network: "environment-only" };
    return { writes: "os", credentialReads: "os", network: "os-proxy-only" };
};

/**
 * Builds what a sandboxed command needs: the proxy, the platform's wrapper, and a launcher for it. Never throws for "this computer
 * cannot do it": that comes back as a runtime whose launcher refuses every command, with the reason in `enforcement`.
 */
export async function createSandboxRuntime(options: SandboxRuntimeOptions): Promise<SandboxRuntime | null> {
    const { settings } = options;
    if (settings.mode === "off") return null;
    const mode = settings.mode;
    const platform = sandboxPlatform(options.platform);
    const home = options.home ?? homedir();
    const workspace = realpathSync(options.workspaceRoot);
    const probe = options.probe ?? systemProbe;
    const base = describe(platform, mode);
    const unavailable = (reason: SandboxUnavailable, detail: string): SandboxRuntime => ({
        settings, proxy: null, close: async () => {}, launch: refuse(reason, detail),
        enforcement: { platform, mode, available: false, unavailable: reason, detail, writes: "none", credentialReads: "none", network: "none" },
    });
    if (platform === "other") return unavailable("unsupported-platform", `there is no sandbox for ${options.platform ?? process.platform}`);
    const broad = workspaceTooBroad(workspace, home, platform);
    if (broad) return unavailable("workspace-too-broad", broad);

    const deny = credentialPaths(home, platform, options.extraDenyRead);
    let proxy: FilteringProxy | null = null;
    const cleanup: Array<() => Promise<void> | void> = [];
    const startProxy = options.startProxy ?? startFilteringProxy;
    const close = async () => {
        for (const step of cleanup.splice(0).reverse()) {
            try {
                await step();
            } catch {
                // best effort
            }
        }
        await proxy?.close().catch(() => {});
    };
    const fail = async (reason: SandboxUnavailable, detail: string) => {
        await close();
        return unavailable(reason, detail);
    };

    try {
        if (platform === "macos") {
            if (!(await probe.sandboxExec())) return await fail("missing-sandbox-exec", "sandbox-exec is missing or does not work on this Mac");
            proxy = await startProxy({ allowed: settings.allowedDomains });
            const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "tomverse-sbx-")));
            cleanup.push(() => rmSync(tempDir, { recursive: true, force: true }));
            const profile = seatbeltProfile({
                mode, workspace, tempDirs: [tempDir], denyRead: deny.map(realOr), protectedWrite: protectedWorkspacePaths(workspace),
                proxyPort: proxy.port, allowLocalhost: settings.allowLocalhost,
            });
            const launch: CommandLaunch = (file, args): CommandLaunchResult => ({
                file: "/usr/bin/sandbox-exec", args: ["-p", profile, file, ...args],
                env: { ...proxyEnv(proxy!.url, settings.allowLocalhost), TMPDIR: tempDir },
            });
            return { settings, proxy, launch, close, enforcement: { platform, mode, available: true, ...base } };
        }
        if (platform === "linux") {
            const found = await probe.bwrap();
            if ("error" in found) return await fail(found.error.startsWith("bwrap could not") ? "bwrap-failed" : "missing-bwrap", found.error);
            const socat = probe.socat();
            const socketPath = join(tmpdir(), `tvsbx-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`);
            proxy = socat ? await startProxy({ allowed: settings.allowedDomains, unixSocketPath: socketPath }) : null;
            const existing = (paths: readonly string[]) => paths.filter((path) => existsSync(path)).map((path) => ({ path: realOr(path), directory: statSync(path).isDirectory() }));
            const launch: CommandLaunch = (file, args, context): CommandLaunchResult => ({
                file: found.path,
                args: bwrapArgs({
                    mode, workspace, cwd: context?.cwd ?? workspace, denyRead: existing(deny),
                    protectedWrite: protectedWorkspacePaths(workspace).filter((path) => existsSync(path)).map(realOr),
                    network: proxy && socat ? { kind: "proxy", socketPath, socatPath: socat, port: BWRAP_PROXY_PORT } : { kind: "none" },
                    file, args,
                }),
                env: { TMPDIR: "/tmp", ...(proxy && socat ? proxyEnv(`http://127.0.0.1:${BWRAP_PROXY_PORT}`, false) : {}) },
            });
            const network = proxy && socat ? "os-proxy-only" : "os-blocked";
            return { settings, proxy, launch, close, enforcement: { platform, mode, available: true, ...base, network } };
        }
        // Windows
        const stateDir = options.stateDir ?? join(tmpdir(), "tomverse-sandbox");
        mkdirSync(stateDir, { recursive: true });
        proxy = await startProxy({ allowed: settings.allowedDomains });
        const windows: WindowsSandbox = await (options.windows?.prepare ?? prepareWindowsSandbox)({
            mode, workspaceRoot: workspace, stateDir, home, proxyEnv: proxyEnv(proxy.url, settings.allowLocalhost), tempParent: options.windows?.tempParent,
        });
        if (!windows.ok) return await fail(windows.reason, windows.detail);
        cleanup.push(windows.close);
        return { settings, proxy, launch: windows.launch, close, enforcement: { platform, mode, available: true, ...base } };
    } catch (error) {
        return await fail("proxy-failed", `the sandbox could not be set up: ${(error as Error).message}`);
    }
}

const realOr = (path: string) => {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
};

/** For the settings screen: what would be enforced here for a mode, without starting anything. Needs a probe only where the OS decides. */
export async function sandboxEnforcement(mode: SandboxMode, options: { platform?: NodeJS.Platform; probe?: SandboxProbe; stateDir?: string; home?: string } = {}): Promise<SandboxEnforcement> {
    const platform = sandboxPlatform(options.platform);
    const probe = options.probe ?? systemProbe;
    const base = describe(platform, mode);
    if (mode === "off") return { platform, mode, available: true, ...base };
    const no = (unavailable: SandboxUnavailable, detail: string): SandboxEnforcement => ({ platform, mode, available: false, unavailable, detail, writes: "none", credentialReads: "none", network: "none" });
    if (platform === "other") return no("unsupported-platform", "no sandbox for this system");
    if (platform === "macos") return (await probe.sandboxExec()) ? { platform, mode, available: true, ...base } : no("missing-sandbox-exec", "sandbox-exec is missing");
    if (platform === "linux") {
        const found = await probe.bwrap();
        if ("error" in found) return no(found.error.startsWith("bwrap could not") ? "bwrap-failed" : "missing-bwrap", found.error);
        return { platform, mode, available: true, ...base, network: probe.socat() ? "os-proxy-only" : "os-blocked" };
    }
    const found = await windowsSandboxAvailable(options.stateDir ?? join(tmpdir(), "tomverse-sandbox"), options.home ?? homedir());
    return found.ok ? { platform, mode, available: true, ...base } : no("windows-launcher-failed", found.detail);
}
