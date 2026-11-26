import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSshRunner } from "../src/remote-ssh.js";
import { RemoteWorkspace } from "../src/remote-workspace.js";

/**
 * A "remote machine" for tests: a folder of this computer reached through tests/fake-ssh.mjs, which runs the remote command
 * string through `sh -c` like a login shell. Needs a POSIX `sh` with the usual tools (Git for Windows has one).
 */

export const FAKE_SSH = fileURLToPath(new URL("./fake-ssh.mjs", import.meta.url));

const found = spawnSync("sh", ["-c", "echo ok"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${process.platform === "win32" ? "C:\\Program Files\\Git\\usr\\bin;" : ""}${process.env.PATH ?? ""}` },
});
export const HAS_SH = found.status === 0 && found.stdout.trim() === "ok";

/** The folder as the remote machine's sh names it: on Windows (Git's sh) C:\a\b is /c/a/b. */
export const remotePath = (local: string) => process.platform === "win32" ? local.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`).replaceAll("\\", "/") : local;

export const tempFolder = (prefix: string) => realpathSync.native(mkdtempSync(join(tmpdir(), `tvrem-${prefix}-`)));

export type FakeRemote = ReturnType<typeof makeFakeRemote>;

export const makeFakeRemote = (options: { sh?: string; path?: string; destination?: string; port?: number; subfolder?: string; timeouts?: { connectMs?: number; operationMs?: number } } = {}) => {
    const scratch = tempFolder("scratch");
    const base = tempFolder("project");
    const root = options.subfolder ? join(base, options.subfolder) : base;
    mkdirSync(root, { recursive: true });
    const control = join(scratch, "control.json");
    const log = join(scratch, "log.jsonl");
    writeFileSync(control, "{}");
    writeFileSync(log, "");
    const runner = createSshRunner({
        file: process.execPath,
        prefixArgs: [FAKE_SSH, `--fake-control=${control}`, `--fake-log=${log}`, ...(options.sh ? [`--fake-sh=${options.sh}`] : []), ...(options.path ? [`--fake-path=${options.path}`] : [])],
    });
    const target = { destination: options.destination ?? "devbox", ...(options.port ? { port: options.port } : {}), folder: remotePath(root) };
    const workspace = new RemoteWorkspace(target, runner, options.timeouts);
    return {
        base, root, scratch, control, log, runner, target, workspace,
        /** Makes the next `times` calls fail the way `fail` says. */
        failNext: (fail: "reset" | "drop-mid", times = 1, afterMs = 300) => writeFileSync(control, JSON.stringify({ fail, times, afterMs })),
        calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { destination: string; options: string[][]; command: string }),
        /** Runs a shell line "on the remote machine" (to set up links and the like). */
        sh: (line: string, cwd = root) => {
            const done = spawnSync("sh", ["-c", line], {
                cwd, encoding: "utf8",
                env: { ...process.env, MSYS: "winsymlinks:lnk", PATH: `${process.platform === "win32" ? "C:\\Program Files\\Git\\usr\\bin;" : ""}${process.env.PATH ?? ""}` },
            });
            if (done.status !== 0) throw new Error(`sh failed: ${done.stderr}`);
            return done.stdout;
        },
    };
};

const withGitTools = () => ({ ...process.env, PATH: `${process.platform === "win32" ? "C:\\Program Files\\Git\\usr\\bin;" : ""}${process.env.PATH ?? ""}` });

/** A folder with an `sh` that is dash, so the remote scripts run under the strictest common POSIX shell. Null where there is no dash. */
export const dashShim = () => {
    const found = spawnSync("sh", ["-c", "command -v dash"], { encoding: "utf8", env: withGitTools() });
    if (found.status !== 0 || !found.stdout.trim()) return null;
    const folder = tempFolder("dash");
    writeFileSync(join(folder, "sh"), '#!/bin/sh\nexec dash "$@"\n');
    spawnSync("sh", ["-c", "chmod +x sh"], { cwd: folder, env: withGitTools() });
    return folder;
};

/** The path of a tool as the remote sh finds it (for a shim that hands over to the real one). */
export const realTool = (name: string) => spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8", env: withGitTools() }).stdout.trim();

/** A folder of small `sh` programs, to be put in front of PATH on the "remote machine" so a test can make a tool fail or act at a chosen moment. */
export const shimFolder = (programs: Record<string, string>, options: { dash?: boolean } = {}) => {
    const folder = tempFolder("shim");
    for (const [name, body] of Object.entries(programs)) writeFileSync(join(folder, name), `#!/bin/sh\n${body}\n`);
    if (options.dash) writeFileSync(join(folder, "sh"), '#!/bin/sh\nexec dash "$@"\n');
    spawnSync("sh", ["-c", "chmod +x *"], { cwd: folder, env: withGitTools() });
    return folder;
};
