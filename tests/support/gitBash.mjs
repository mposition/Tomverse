/**
 * Which `bash` runs a test's shell, decided rather than inherited.
 *
 * `spawnSync("bash", ...)` resolves through PATH, and on Windows the first
 * answer is usually `C:\Windows\System32\bash.exe` -- the WSL launcher, which
 * on a machine with no distribution installed fails with a message about
 * installing one, not with anything about the script it was handed. Git Bash is
 * present on any machine that cloned this repository, but it only wins the PATH
 * lookup inside a Git Bash session; from PowerShell it does not. A test whose
 * result depends on which terminal started it is not testing what it says.
 *
 * So on Windows the interpreter is resolved from where git already is:
 * `git --exec-path` points inside the Git installation, and `bin/bash.exe` or
 * `usr/bin/bash.exe` sits at its root. PATH is consulted only if that fails, and
 * with the two Windows system launchers excluded by name.
 *
 * `null` means no usable bash was found. The caller decides what that means --
 * a shell-behaviour test skips loudly rather than failing, because "this machine
 * has no Git Bash" is not the defect it is guarding.
 */

import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, dirname, join, resolve } from "node:path";

/** Ancestors of the git exec path, nearest first, up to the filesystem root. */
const ancestors = (start, limit = 8) => {
    const chain = [];
    let current = resolve(start);
    for (let depth = 0; depth < limit; depth += 1) {
        chain.push(current);
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return chain;
};

/**
 * The launchers that must never be chosen, matched on the directory rather than
 * the file name: both are called `bash.exe`, and both mean WSL.
 */
const isWindowsSystemLauncher = (candidate) => {
    const lowered = candidate.toLowerCase().replace(/\//g, "\\");
    return (
        lowered.includes("\\windows\\system32\\") ||
        lowered.includes("\\microsoft\\windowsapps\\")
    );
};

const defaultGitExecPath = () => {
    const result = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
    const value = result.stdout?.trim();
    return value ? value : null;
};

const defaultIsFile = (candidate) => {
    try {
        return existsSync(candidate) && statSync(candidate).isFile();
    } catch {
        return false;
    }
};

/**
 * @param {object} [options]
 * @param {NodeJS.Platform} [options.platform]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {() => string | null} [options.gitExecPath]
 * @param {(candidate: string) => boolean} [options.isFile]
 * @returns {string | null} an absolute interpreter path on Windows, the bare
 *   name elsewhere, or `null` when nothing usable was found.
 */
export function resolveBashCommand({
    platform = process.platform,
    env = process.env,
    gitExecPath = defaultGitExecPath,
    isFile = defaultIsFile,
} = {}) {
    // Everywhere else PATH is the right answer and the only one: the runner
    // images this repository uses have exactly one bash, and it is the shell
    // the workflow itself runs under.
    if (platform !== "win32") return "bash";

    const execPath = gitExecPath();
    if (execPath) {
        for (const root of ancestors(execPath)) {
            for (const relative of [
                join("bin", "bash.exe"),
                join("usr", "bin", "bash.exe"),
            ]) {
                const candidate = join(root, relative);
                if (!isWindowsSystemLauncher(candidate) && isFile(candidate)) {
                    return candidate;
                }
            }
        }
    }

    // Last resort, for an installation laid out differently than the one this
    // was written against. Still not a PATH lookup by `spawnSync`: the entries
    // are read here so the two system launchers can be refused by name.
    for (const entry of (env.PATH ?? env.Path ?? "").split(delimiter)) {
        if (!entry) continue;
        const candidate = join(entry, "bash.exe");
        if (!isWindowsSystemLauncher(candidate) && isFile(candidate)) {
            return candidate;
        }
    }

    return null;
}
