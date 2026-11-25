import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { planCommand, runCommand, type CommandLaunch } from "../src/commands.js";
import { startFilteringProxy, type FilteringProxy } from "../src/net-proxy.js";
import {
    BWRAP_PROXY_SOCKET, bwrapArgs, composeLaunch, createSandboxRuntime, credentialPaths, defaultSandboxSettings, normalizeSandboxSettings,
    protectedWorkspacePaths, sandboxEnforcement, SandboxUnavailableError, seatbeltProfile, workspaceTooBroad, type SandboxProbe,
} from "../src/sandbox.js";
import { tempDir } from "./helpers.js";

// The macOS and Linux sandboxes cannot be run on the machine these tests were written on (Windows). What can be checked
// anywhere is what they are built from: which paths the profile or the bwrap arguments allow, deny and hide.

const WS = "/home/dev/project";
const TMP = "/private/var/tmp/tv";
const HOME = "/home/dev";

const sbplPaths = (profile: string, rule: string) => {
    const out: string[] = [];
    for (const line of profile.split("\n")) {
        if (!line.startsWith(`(${rule} `)) continue;
        for (const match of line.matchAll(/\(subpath "((?:[^"\\]|\\.)*)"\)/g)) out.push(match[1]!.replaceAll('\\"', '"').replaceAll("\\\\", "\\"));
    }
    return out;
};

const seatbelt = (overrides: Partial<Parameters<typeof seatbeltProfile>[0]> = {}) => seatbeltProfile({
    mode: "workspace-write", workspace: WS, tempDirs: [TMP], denyRead: credentialPaths(HOME, "macos"),
    protectedWrite: protectedWorkspacePaths(WS), proxyPort: 3128, allowLocalhost: false, ...overrides,
});

test("Seatbelt workspace-write: only the working folder and the temp folder can be written", () => {
    const profile = seatbelt();
    assert.deepEqual(sbplPaths(profile, "allow file-write*"), [WS, TMP]);
    // Everything is denied before anything is allowed, so what is not listed is refused.
    assert.ok(profile.indexOf("(deny file-write*)") < profile.indexOf(`(allow file-write* (subpath "${WS}")`));
    assert.ok(profile.startsWith("(version 1)\n(allow default)"));
});

test("Seatbelt: what a command could plant to run later stays read-only, and the rule comes after the allow that it carves out of", () => {
    const profile = seatbelt();
    const denied = sbplPaths(profile, "deny file-write*");
    for (const path of [join(WS, ".git", "hooks"), join(WS, ".git", "config")]) assert.ok(denied.includes(path), path);
    assert.ok(profile.lastIndexOf("(deny file-write* (subpath") > profile.indexOf(`(allow file-write* (subpath "${WS}")`));
});

test("Seatbelt: every credential location is denied for reading", () => {
    const profile = seatbelt();
    const denied = sbplPaths(profile, "deny file-read*");
    for (const name of [".ssh", ".aws", ".config/gcloud", ".gnupg", ".kube", ".npmrc", ".netrc", ".git-credentials", ".tomverse", "Library/Keychains"]) {
        assert.ok(denied.includes(join(HOME, name)), name);
    }
    const withApp = seatbelt({ denyRead: credentialPaths(HOME, "macos", ["/Users/dev/Library/Application Support/Tomverse"]) });
    assert.ok(sbplPaths(withApp, "deny file-read*").includes(resolve("/Users/dev/Library/Application Support/Tomverse")));
});

test("Seatbelt read-only: no folder is writable, not even the working folder", () => {
    const profile = seatbelt({ mode: "read-only" });
    assert.deepEqual(sbplPaths(profile, "allow file-write*"), []);
    assert.ok(!profile.includes(`(subpath "${WS}")`.replace("(subpath", "(allow file-write* (subpath")));
    assert.match(profile, /\(deny file-write\*\)/);
});

test("Seatbelt network: everything is denied and the only way out is the proxy's loopback port", () => {
    const profile = seatbelt();
    assert.match(profile, /\(deny network\*\)/);
    const allows = profile.split("\n").filter((line) => line.startsWith("(allow network"));
    assert.deepEqual(allows, ['(allow network-outbound (remote ip "localhost:3128"))']);
    const local = seatbelt({ allowLocalhost: true });
    assert.ok(local.includes('(allow network-outbound (remote ip "localhost:*"))'));
    const none = seatbelt({ proxyPort: null });
    assert.equal(none.split("\n").filter((line) => line.startsWith("(allow network")).length, 0);
});

test("Seatbelt: a path with a quote or backslash is escaped, and one with a control character is refused", () => {
    const profile = seatbelt({ workspace: '/Users/a"b\\c', tempDirs: [] });
    assert.ok(profile.includes('(subpath "/Users/a\\"b\\\\c")'));
    assert.throws(() => seatbelt({ workspace: "/Users/a\nb" }), /control characters/);
});

const bwrap = (overrides: Partial<Parameters<typeof bwrapArgs>[0]> = {}) => bwrapArgs({
    mode: "workspace-write", workspace: WS, cwd: `${WS}/sub`, denyRead: [{ path: `${HOME}/.ssh`, directory: true }, { path: `${HOME}/.npmrc`, directory: false }],
    protectedWrite: [`${WS}/.git/hooks`], network: { kind: "none" }, file: "/usr/bin/npm", args: ["test", "--", "a b", "$(x)"], ...overrides,
});
const groups = (args: string[]) => {
    const out: string[][] = [];
    for (let i = 0; i < args.length; ) {
        if (args[i] === "--") break;
        const arity = args[i] === "--ro-bind" || args[i] === "--bind" ? 2 : ["--tmpfs", "--dev", "--proc", "--chdir"].includes(args[i]!) ? 1 : 0;
        out.push(args.slice(i, i + 1 + arity));
        i += 1 + arity;
    }
    return out;
};

test("bubblewrap workspace-write: the root is read-only and the only writable bind is the working folder", () => {
    const args = bwrap();
    const parts = groups(args);
    assert.deepEqual(parts.find((g) => g[0] === "--ro-bind" && g[1] === "/"), ["--ro-bind", "/", "/"]);
    const writable = parts.filter((g) => g[0] === "--bind");
    assert.deepEqual(writable, [["--bind", WS, WS]]);
    for (const flag of ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-net"]) assert.ok(args.includes(flag), flag);
    // /tmp is a private tmpfs, so the temporary folder is writable without exposing the machine's.
    assert.ok(parts.some((g) => g[0] === "--tmpfs" && g[1] === "/tmp"));
    assert.deepEqual(args.slice(args.indexOf("--") + 1), ["/usr/bin/npm", "test", "--", "a b", "$(x)"], "the command's words stay separate arguments");
    assert.deepEqual(parts.find((g) => g[0] === "--chdir"), ["--chdir", `${WS}/sub`]);
});

test("bubblewrap: credential folders are hidden behind an empty tmpfs or /dev/null, after the working folder is bound", () => {
    const parts = groups(bwrap());
    const bindAt = parts.findIndex((g) => g[0] === "--bind" && g[1] === WS);
    const ssh = parts.findIndex((g) => g[0] === "--tmpfs" && g[1] === `${HOME}/.ssh`);
    const npmrc = parts.findIndex((g) => g[0] === "--ro-bind" && g[1] === "/dev/null" && g[2] === `${HOME}/.npmrc`);
    assert.ok(ssh > bindAt && npmrc > bindAt, "a workspace that contains a credential folder cannot expose it again");
    const hooks = parts.findIndex((g) => g[0] === "--ro-bind" && g[1] === `${WS}/.git/hooks` && g[2] === `${WS}/.git/hooks`);
    assert.ok(hooks > bindAt, "the hooks folder is read-only inside the writable working folder");
});

test("bubblewrap read-only: nothing is bound writable", () => {
    const parts = groups(bwrap({ mode: "read-only" }));
    assert.deepEqual(parts.filter((g) => g[0] === "--bind"), []);
    assert.deepEqual(parts.filter((g) => g[0] === "--ro-bind" && g[1] === WS), []);
});

test("bubblewrap network: no network at all unless the proxy's socket is relayed in by socat", () => {
    const none = bwrap();
    assert.ok(none.includes("--unshare-net"));
    assert.ok(!none.some((arg) => arg.includes("socat") || arg === "/bin/sh"));
    const proxy = bwrap({ network: { kind: "proxy", socketPath: "/tmp/host-proxy.sock", socatPath: "/usr/bin/socat", port: 3128 } });
    assert.ok(proxy.includes("--unshare-net"), "still no direct network");
    const bound = groups(proxy).filter((g) => g[0] === "--bind");
    assert.deepEqual(bound.map((g) => g.slice(1)), [[WS, WS], ["/tmp/host-proxy.sock", BWRAP_PROXY_SOCKET]]);
    const script = proxy[proxy.indexOf("-c") + 1]!;
    assert.match(script, /TCP-LISTEN:3128,bind=127\.0\.0\.1/);
    assert.ok(script.includes(`UNIX-CONNECT:${BWRAP_PROXY_SOCKET}`));
    assert.ok(script.endsWith('exec "$@"'), "the command itself is not part of the script text");
    assert.deepEqual(proxy.slice(proxy.indexOf("tomverse-sandbox") + 1), ["/usr/bin/npm", "test", "--", "a b", "$(x)"]);
});

test("settings: anything missing or malformed means off, the small default list, and no localhost", () => {
    assert.deepEqual(normalizeSandboxSettings(undefined), defaultSandboxSettings());
    assert.equal(defaultSandboxSettings().mode, "off");
    assert.ok(defaultSandboxSettings().allowedDomains.includes("registry.npmjs.org"));
    assert.deepEqual(normalizeSandboxSettings({ mode: "danger", allowedDomains: "x", allowLocalhost: "yes" }), defaultSandboxSettings());
    assert.deepEqual(normalizeSandboxSettings({ mode: "read-only", allowedDomains: [" PyPI.org ", "bad host", "*.x.test"], allowLocalhost: true }),
        { mode: "read-only", allowedDomains: ["pypi.org", "*.x.test"], allowLocalhost: true });
    assert.deepEqual(normalizeSandboxSettings({ mode: "workspace-write", allowedDomains: [] }).allowedDomains, [], "an empty list is a choice: no network");
});

test("a working folder that is a root, the home folder or a parent of it is refused", () => {
    assert.ok(workspaceTooBroad("/", HOME, "linux"));
    assert.ok(workspaceTooBroad("C:\\", "C:\\Users\\dev", "windows"));
    assert.ok(workspaceTooBroad(HOME, HOME, "linux"));
    assert.ok(workspaceTooBroad("/home", HOME, "linux"));
    assert.ok(workspaceTooBroad("c:\\users\\DEV", "C:\\Users\\dev", "windows"));
    assert.equal(workspaceTooBroad(`${HOME}/project`, HOME, "linux"), null);
    assert.equal(workspaceTooBroad("D:\\work\\app", "C:\\Users\\dev", "windows"), null);
});

const probe = (overrides: Partial<SandboxProbe> = {}): SandboxProbe => ({
    sandboxExec: async () => true, bwrap: async () => ({ path: "/usr/bin/bwrap" }), socat: () => "/usr/bin/socat", ...overrides,
});
const fakeProxy = async (): Promise<FilteringProxy> => ({ port: 4555, url: "http://127.0.0.1:4555", decisions: [], setAllowed: () => {}, close: async () => {}, socketPath: "/tmp/fake.sock" });
const options = (workspaceRoot: string, extra: Record<string, unknown> = {}) => ({
    settings: { ...defaultSandboxSettings(), mode: "workspace-write" as const }, workspaceRoot, home: join(workspaceRoot, "..", "home"), startProxy: fakeProxy, ...extra,
});

test("the macOS runtime launches the command through sandbox-exec with the profile and the proxy variables", async () => {
    const workspace = tempDir("sbx");
    const runtime = await createSandboxRuntime({ ...options(workspace, { platform: "darwin", probe: probe() }), });
    assert.ok(runtime);
    assert.equal(runtime.enforcement.available, true);
    assert.deepEqual([runtime.enforcement.writes, runtime.enforcement.credentialReads, runtime.enforcement.network], ["os", "os", "os-proxy-only"]);
    const launched = runtime.launch("/usr/bin/git", ["status"], { cwd: workspace, env: {} });
    assert.equal(launched.file, "/usr/bin/sandbox-exec");
    assert.deepEqual([launched.args[0], launched.args.slice(2)], ["-p", ["/usr/bin/git", "status"]]);
    assert.ok(sbplPaths(launched.args[1]!, "allow file-write*").includes(workspace.replaceAll("\\", "/")) || sbplPaths(launched.args[1]!, "allow file-write*").some((p) => p.toLowerCase() === workspace.toLowerCase()));
    assert.equal(launched.env?.HTTPS_PROXY, "http://127.0.0.1:4555");
    assert.ok(launched.env?.TMPDIR);
    await runtime.close();
});

test("the Linux runtime launches through bwrap, and says plainly when there is no socat so the network is closed entirely", async () => {
    const workspace = tempDir("sbx");
    const withSocat = await createSandboxRuntime(options(workspace, { platform: "linux", probe: probe() }));
    assert.equal(withSocat?.enforcement.network, "os-proxy-only");
    const launched = withSocat!.launch("/usr/bin/node", ["-v"], { cwd: workspace, env: {} });
    assert.equal(launched.file, "/usr/bin/bwrap");
    assert.ok(launched.args.includes("--unshare-net"));
    assert.equal(launched.env?.HTTP_PROXY, `http://127.0.0.1:3128`);
    assert.equal(launched.env?.TMPDIR, "/tmp");
    const without = await createSandboxRuntime(options(workspace, { platform: "linux", probe: probe({ socat: () => null }) }));
    assert.equal(without?.enforcement.network, "os-blocked");
    const closed = without!.launch("/usr/bin/node", ["-v"], { cwd: workspace, env: {} });
    assert.ok(closed.args.includes("--unshare-net"));
    assert.equal(closed.env?.HTTP_PROXY, undefined, "no proxy to point at when there is no way to reach it");
});

test("when bwrap, sandbox-exec or the platform is missing the launcher refuses and says why", async () => {
    const workspace = tempDir("sbx");
    const cases: Array<[string, Record<string, unknown>, string]> = [
        ["linux without bwrap", { platform: "linux", probe: probe({ bwrap: async () => ({ error: "bwrap (bubblewrap) is not installed" }) }) }, "missing-bwrap"],
        ["linux where namespaces are off", { platform: "linux", probe: probe({ bwrap: async () => ({ error: "bwrap could not create a sandbox (Operation not permitted)" }) }) }, "bwrap-failed"],
        ["a Mac without sandbox-exec", { platform: "darwin", probe: probe({ sandboxExec: async () => false }) }, "missing-sandbox-exec"],
        ["another system", { platform: "freebsd" }, "unsupported-platform"],
    ];
    for (const [name, extra, reason] of cases) {
        const runtime = await createSandboxRuntime(options(workspace, extra));
        assert.ok(runtime, name);
        assert.equal(runtime.enforcement.available, false, name);
        assert.equal(runtime.enforcement.unavailable, reason, name);
        assert.deepEqual([runtime.enforcement.writes, runtime.enforcement.network], ["none", "none"], "nothing is claimed as enforced");
        assert.throws(() => runtime.launch("/bin/echo", ["hi"], { cwd: workspace, env: {} }), (error) => error instanceof SandboxUnavailableError && error.reason === reason, name);
    }
    const off = await createSandboxRuntime({ ...options(workspace), settings: defaultSandboxSettings() });
    assert.equal(off, null, "off adds nothing");
});

test("a refused command does not run: the process is never started and the model gets the reason", async () => {
    const workspace = tempDir("sbx");
    const runtime = await createSandboxRuntime(options(workspace, { platform: "linux", probe: probe({ bwrap: async () => ({ error: "bwrap (bubblewrap) is not installed" }) }) }));
    const marker = join(workspace, "ran.txt");
    const plan = planCommand({ argv: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'x')`] }, workspace, 20_000);
    const result = await runCommand(plan, new AbortController().signal, undefined, [], runtime!.launch);
    assert.match(result.spawnError ?? "", /sandbox is turned on but cannot be created here, so the command was not run: bwrap \(bubblewrap\) is not installed/);
    assert.equal(existsSync(marker), false);
    assert.equal(result.exitCode, null);
});

test("composeLaunch puts the sandbox inside the supervisor and merges what each adds to the environment", () => {
    const sandbox: CommandLaunch = (file, args) => ({ file: "sandbox", args: ["--", file, ...args], env: { A: "1" } });
    const supervisor: CommandLaunch = (file, args) => ({ file: "super", args: ["--", file, ...args], env: { B: "2" } });
    const composed = composeLaunch(sandbox, supervisor)!;
    assert.deepEqual(composed("prog", ["x"], { cwd: "/w", env: {} }), { file: "super", args: ["--", "sandbox", "--", "prog", "x"], env: { A: "1", B: "2" } });
    assert.equal(composeLaunch(undefined, supervisor), supervisor);
    assert.equal(composeLaunch(sandbox, undefined), sandbox);
});

test("the settings screen's enforcement report matches what each platform can do, and is honest about Windows", async () => {
    const mac = await sandboxEnforcement("workspace-write", { platform: "darwin", probe: probe() });
    assert.deepEqual([mac.available, mac.writes, mac.credentialReads, mac.network], [true, "os", "os", "os-proxy-only"]);
    const linux = await sandboxEnforcement("read-only", { platform: "linux", probe: probe({ socat: () => null }) });
    assert.deepEqual([linux.available, linux.network], [true, "os-blocked"]);
    const off = await sandboxEnforcement("off", { platform: "linux", probe: probe() });
    assert.deepEqual([off.writes, off.credentialReads, off.network], ["none", "none", "none"]);
    const missing = await sandboxEnforcement("workspace-write", { platform: "linux", probe: probe({ bwrap: async () => ({ error: "bwrap (bubblewrap) is not installed" }) }) });
    assert.deepEqual([missing.available, missing.unavailable, missing.writes], [false, "missing-bwrap", "none"]);
});

test("the Unix socket the Linux proxy needs is created by the real proxy and refuses a site that is not on the list", { skip: process.platform === "win32" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "tvsbx-sock-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".keep"), "");
    const proxy = await startFilteringProxy({ allowed: [], unixSocketPath: join(dir, "p.sock") });
    assert.equal(existsSync(join(dir, "p.sock")), true);
    await proxy.close();
    assert.equal(existsSync(join(dir, "p.sock")), false);
});
