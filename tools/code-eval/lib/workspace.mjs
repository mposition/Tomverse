// Per-run working folders: a copy of repo/ with its own git history.
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "./proc.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const CHECK_DIR_NAME = "__check__";

const gitEnv = () => ({
    ...process.env,
    GIT_AUTHOR_NAME: "code-eval",
    GIT_AUTHOR_EMAIL: "code-eval@example.invalid",
    GIT_COMMITTER_NAME: "code-eval",
    GIT_COMMITTER_EMAIL: "code-eval@example.invalid",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
});

export const git = (cwd, args) => runProcess({ file: "git", args: ["-c", "core.autocrlf=false", "-c", "core.quotepath=off", "-c", "commit.gpgsign=false", ...args], cwd, env: gitEnv(), timeoutMs: 60_000 });

/** A fresh folder under the OS temp directory holding a git repository of the task's repo/. */
export const prepareWorkspace = async (task, { base = tmpdir() } = {}) => {
    const root = mkdtempSync(join(base, "code-eval-"));
    const workDir = join(root, "work");
    mkdirSync(workDir);
    cpSync(join(task.dir, "repo"), workDir, { recursive: true });
    for (const args of [["init", "-q"], ["add", "-A"], ["commit", "-q", "-m", "initial state"]]) {
        const result = await git(workDir, args);
        if (result.code !== 0) {
            rmSync(root, { recursive: true, force: true });
            throw new Error(`git ${args[0]} failed: ${result.stderr || result.spawnError || result.code}`);
        }
    }
    return { root, workDir, dispose: () => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) };
};

/** Files the agent added, changed or removed, as git sees them. */
export const changedFiles = async (workDir) => {
    const result = await git(workDir, ["status", "--porcelain", "--untracked-files=all"]);
    if (result.code !== 0) return null;
    return result.stdout.split("\n").map((line) => line.trimEnd()).filter(Boolean).length;
};

/** The hidden tests enter the folder only after the agent has finished. */
export const installCheck = (task, workDir) => {
    const target = join(workDir, CHECK_DIR_NAME);
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    cpSync(join(task.dir, "check"), target, { recursive: true });
    cpSync(join(here, "mutation-check.mjs"), join(target, "mutation-check.mjs"));
    return target;
};
