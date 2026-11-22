import { opendir } from "node:fs/promises";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { readProcess } from "./readprocess.js";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { commandEnv } from "./commands.js";
import { tomverseHome } from "./config.js";

/**
 * The folder the CLI works in, and every path check the file tools make. A
 * path the model names is resolved against the real root, symlinks and
 * junctions included; only a path whose real location is inside the root is
 * used. For a new file, the nearest existing parent's real path decides.
 */

export class PathError extends Error {}

const caseInsensitive = process.platform === "win32" || process.platform === "darwin";

const inside = (root: string, target: string) => {
    const rel = relative(root, target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

export const normalizeRoot = (input: string) => {
    let real: string;
    try {
        real = realpathSync.native(resolve(input));
    } catch {
        throw new PathError(`The folder ${input} does not exist.`);
    }
    if (!statSync(real).isDirectory()) throw new PathError(`${real} is not a folder.`);
    if (/^\\\\[?.]\\/.test(real)) throw new PathError("Device paths (\\\\?\\ or \\\\.\\) are not supported as a workspace.");
    if (parse(real).root === real) throw new PathError("A drive or filesystem root is too broad to work in. Choose a project folder.");
    // Paths are checked relative to the root, so a root inside a credential
    // folder (.ssh, .aws, .git, the CLI's own home …) would expose all of it.
    if (real.split(/[\\/]/).some((segment) => SECRET_DIRS.has(segment.toLowerCase()))) {
        throw new PathError(`${real} is inside a folder that can hold credentials; the CLI does not work there.`);
    }
    const home = (() => {
        try {
            return realpathSync.native(homedir());
        } catch {
            return homedir();
        }
    })();
    if (same(real, home)) throw new PathError("Your home folder is too broad to work in. Choose a project folder.");
    return real;
};

export const same = (a: string, b: string) => (caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * Paths that can hold credentials, by name. The same list as Tomverse Code's
 * Rust gate (policy/secrets.rs): name-based, and it does not claim a file
 * outside it is secret-free.
 */
const SECRET_DIRS = new Set([".ssh", ".aws", ".gnupg", ".git", ".tomverse"]);

export const isSecretPath = (relativePath: string) => {
    // Compatibility-folded, lower case, with invisible format characters
    // removed, so a zero-width or look-alike character cannot hide a name.
    const normalized = relativePath
        .normalize("NFKC")
        .replace(/[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
        .replaceAll("\\", "/")
        .toLowerCase();
    const fileName = normalized.split("/").pop() ?? normalized;
    // Whole folders: Git internals (remote URLs and credential helpers live in
    // .git/config) and the CLI's own home are in this list too.
    if (normalized.split("/").some((segment) => SECRET_DIRS.has(segment))) return true;
    if (fileName.startsWith(".env")) return true;
    if ([".npmrc", ".netrc", ".pgpass", ".htpasswd", ".git-credentials", ".pypirc"].includes(fileName)) return true;
    for (const ext of [".pem", ".key", ".p12", ".pfx", ".keystore", ".jks", ".asc", ".ppk"]) if (fileName.endsWith(ext)) return true;
    for (const prefix of ["id_rsa", "id_ed25519", "id_dsa", "id_ecdsa"]) if (fileName.startsWith(prefix)) return true;
    // credentials*, secret* (secrets.yaml, secret-token.txt, credentials-prod.json …),
    // erring towards leaving a file out.
    if (fileName.startsWith("credential") || fileName.startsWith("secret")) return true;
    if (fileName.endsWith(".json") && /service[-_]account|gcp[-_]key/.test(fileName)) return true;
    return false;
};

/** Generated or vendored folders that listing and search skip. */
const SKIPPED_DIRS = new Set([
    "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "target", "coverage", ".cache",
    "__pycache__", ".venv", "venv", ".tox", ".gradle", ".idea", ".turbo", ".parcel-cache", ".tomverse",
]);

export type ResolvedPath = { absolute: string; relative: string; exists: boolean };

export class Workspace {
    /**
     * The CLI's own home (sessions, backups, config), wherever TOMVERSE_HOME
     * puts it: never readable or writable through the file tools, even when it
     * sits inside the workspace under another name.
     */
    private readonly privateDirs: string[];

    constructor(readonly root: string, privateDirs: string[] = [tomverseHome()]) {
        this.privateDirs = privateDirs.map((dir) => {
            try {
                return realpathSync.native(dir);
            } catch {
                return resolve(dir);
            }
        });
    }

    private isPrivate(absolute: string) {
        return this.privateDirs.some((dir) => inside(dir, absolute));
    }

    /** Resolves a model-named path; refuses anything whose real location leaves the root. */
    resolve(input: string, purpose: "read" | "write"): ResolvedPath {
        if (typeof input !== "string" || input.length === 0) throw new PathError("A path is required.");
        if (input.includes("\0")) throw new PathError("A path cannot contain NUL.");
        if (/^\\\\[?.]\\/.test(input)) throw new PathError("Device paths are not allowed.");
        if (process.platform === "win32" && /^\\\\/.test(input)) throw new PathError("Network (UNC) paths are not allowed.");
        if (process.platform === "win32" && input.replace(/^[A-Za-z]:/, "").includes(":")) {
            throw new PathError("A ':' after the drive (an alternate data stream) is not allowed.");
        }
        const lexical = resolve(this.root, input);
        if (!inside(this.root, lexical)) throw new PathError(`${input} is outside the workspace.`);
        // The nearest part of the path that exists decides where it really is.
        let existing = lexical;
        const missing: string[] = [];
        while (!existsSync(existing)) {
            const parent = dirname(existing);
            if (parent === existing) throw new PathError(`${input} cannot be resolved.`);
            missing.unshift(existing.slice(parent.length).replace(/^[\\/]/, ""));
            existing = parent;
        }
        let real: string;
        try {
            real = realpathSync.native(existing);
        } catch {
            throw new PathError(`${input} cannot be resolved.`);
        }
        const absolute = missing.length ? join(real, ...missing) : real;
        if (!inside(this.root, absolute)) throw new PathError(`${input} resolves outside the workspace (through a link).`);
        const rel = relative(this.root, absolute).split(sep).join("/");
        if (this.isPrivate(absolute)) throw new PathError(`${rel} is inside the Tomverse CLI's own data folder, which the file tools never touch.`);
        if (isSecretPath(rel)) {
            throw new PathError(`${rel} can hold credentials, so the CLI does not ${purpose === "read" ? "read" : "change"} it. You can open it yourself.`);
        }
        const exists = missing.length === 0;
        if (exists && purpose === "write" && lstatSync(absolute).isSymbolicLink()) {
            throw new PathError(`${rel} is a link; the CLI does not write through links.`);
        }
        return { absolute, relative: rel || ".", exists };
    }

    /** Editor-safe listing: bounded Git subprocess, then a yielding directory walk. */
    async listFilesAsync(dir: string, limit: number, signal: AbortSignal): Promise<{ files: string[]; truncated: boolean; source: "git" | "walk" }> {
        const start = this.resolve(dir || ".", "read");
        const deadline = Date.now() + 30_000;
        const files: string[] = [];
        const check = async () => { signal.throwIfAborted(); await yieldTurn(); signal.throwIfAborted(); };
        if (this.isGitRepo()) {
            const result = await readProcess("git", ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", start.relative], { cwd: this.root, env: gitEnv(), signal, timeoutMs: 30_000 });
            if (result.code === 0) {
                const seen = new Set<string>();
                let scanned = 0;
                for (const name of result.stdout.split("\0")) {
                    if (++scanned % 64 === 0) await check();
                    if (Date.now() > deadline) return { files, truncated: true, source: "git" };
                    if (!name || seen.has(name)) continue;
                    seen.add(name);
                    try { if (!statSync(this.resolve(name, "read").absolute).isFile()) continue; } catch { continue; }
                    if (files.length >= limit) return { files, truncated: true, source: "git" };
                    files.push(name);
                }
                return { files, truncated: false, source: "git" };
            }
        }
        if (statSync(start.absolute).isFile()) return { files: [start.relative], truncated: false, source: "walk" };
        const stack = [start.absolute];
        let scanned = 0;
        while (stack.length) {
            await check();
            const current = stack.pop()!;
            const directory = await opendir(current).catch(() => null);
            if (!directory) continue;
            for await (const entry of directory) {
                if (++scanned % 64 === 0) await check();
                if (Date.now() > deadline || scanned > 100_000) return { files, truncated: true, source: "walk" };
                if (entry.isSymbolicLink()) continue;
                const abs = join(current, entry.name);
                let resolved: ResolvedPath;
                try { resolved = this.resolve(abs, "read"); } catch { continue; }
                if (!same(resolved.absolute, abs)) continue;
                if (entry.isDirectory()) { if (!SKIPPED_DIRS.has(entry.name)) stack.push(abs); }
                else if (entry.isFile()) {
                    if (files.length >= limit) return { files, truncated: true, source: "walk" };
                    files.push(resolved.relative);
                }
            }
        }
        return { files: files.sort(), truncated: false, source: "walk" };
    }

    isGitRepo() {
        return existsSync(join(this.root, ".git"));
    }

    /**
     * Files under a folder, bounded. In a Git repo the list is Git's (tracked
     * and untracked, minus ignored); otherwise a walk that skips generated
     * folders. Git runs with fsmonitor off so no repository-configured
     * program is started by listing.
     */
    listFiles(dir: string, limit: number): { files: string[]; truncated: boolean; source: "git" | "walk" } {
        const start = this.resolve(dir || ".", "read");
        const files: string[] = [];
        let truncated = false;
        if (this.isGitRepo() && gitAvailable()) {
            const result = spawnSync(
                "git",
                ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", start.relative === "." ? "." : start.relative],
                { cwd: this.root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true, shell: false, env: gitEnv() }
            );
            if (result.status === 0) {
                const seen = new Set<string>();
                for (const name of result.stdout.split("\0")) {
                    if (!name || seen.has(name) || isSecretPath(name) || this.isPrivate(join(this.root, name))) continue;
                    seen.add(name);
                    if (!existsSync(join(this.root, name))) continue;
                    // Git lists a link by its own name; where it points decides. The
                    // same real-path and credential check as read_file: a link to a
                    // file outside, or to .env under an ordinary name, is left out.
                    try {
                        const real = this.resolve(name, "read");
                        if (!statSync(real.absolute).isFile()) continue;
                    } catch {
                        continue;
                    }
                    if (files.length >= limit) {
                        truncated = true;
                        break;
                    }
                    files.push(name);
                }
                return { files, truncated, source: "git" };
            }
        }
        const stack = [start.absolute];
        while (stack.length) {
            const current = stack.pop()!;
            let entries;
            try {
                entries = readdirSync(current, { withFileTypes: true });
            } catch {
                continue;
            }
            entries.sort((a, b) => (a.name < b.name ? 1 : -1));
            for (const entry of entries) {
                const abs = join(current, entry.name);
                const rel = relative(this.root, abs).split(sep).join("/");
                if (entry.isSymbolicLink()) continue;
                if (entry.isDirectory()) {
                    // A junction is a directory to Dirent; its real path gives it away.
                    let real: string;
                    try {
                        real = realpathSync.native(abs);
                    } catch {
                        continue;
                    }
                    if (!same(real, abs) || this.isPrivate(real)) continue;
                    if (!SKIPPED_DIRS.has(entry.name) && !isSecretPath(`${rel}/`)) stack.push(abs);
                    continue;
                }
                if (!entry.isFile() || isSecretPath(rel)) continue;
                if (files.length >= limit) {
                    truncated = true;
                    break;
                }
                files.push(rel);
            }
            if (truncated) break;
        }
        files.sort();
        return { files, truncated, source: "walk" };
    }
}

/**
 * git for listing runs without approval, so it reads no global or system
 * configuration (a user's aliases, credential helpers, pagers), and the
 * repository's fsmonitor is off on the command line. Git ignores an alias that
 * names a built-in command such as ls-files, and ls-files runs no hook, filter
 * or pager; tests/review-fixes.test.ts pins both.
 */
export const gitEnv = () => ({
    ...commandEnv(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
});

let gitChecked: boolean | null = null;
export const gitAvailable = () => {
    if (gitChecked === null) {
        const result = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true, shell: false, env: commandEnv() });
        gitChecked = result.status === 0;
    }
    return gitChecked;
};

let rgChecked: boolean | null = null;
export const ripgrepAvailable = () => {
    if (rgChecked === null) {
        const result = spawnSync("rg", ["--version"], { encoding: "utf8", windowsHide: true, shell: false, env: commandEnv() });
        rgChecked = result.status === 0;
    }
    return rgChecked;
};
