import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { PluginError } from "./plugin-fs.js";
import { gitEnv } from "./workspace.js";

/**
 * Downloads one commit of a git repository into an empty folder, with the person's own git and nothing else of theirs: no global or
 * system git configuration, no credential helper, no terminal prompt, no hooks, no submodules, no links. The download runs no program
 * from the repository. The commit that was fetched is returned so the caller can pin it. This is the only place a plugin or marketplace
 * touches the network, and only when the person asked for it.
 */

export type GitSource = { url: string; ref?: string; sha?: string };

/**
 * The person's own GitHub sign-in, for a private repository on github.com. Only a credential helper command (which asks the GitHub CLI
 * the person already signed in with) and the environment names that program reads: this app never reads, keeps or logs a token.
 */
export type GitAuth = { credentialHelper: string; env: Record<string, string> };

/** The repository could not be read without signing in (or it does not exist: GitHub answers a private repository the same way). */
export class GitAuthRequired extends PluginError {}

const AUTH_NEEDED = /could not read (?:Username|Password)|terminal prompts disabled|Authentication failed|HTTP Basic: Access denied|Repository not found|returned error: 40[134]/i;

export const isGithubHttps = (url: string) => /^https:\/\/github\.com\//i.test(url.trim());

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/@+-]{0,199}$/;
const SHA = /^[0-9a-f]{40}$/;

/** Anything shown or logged from a git or download failure: a user name or password in an address, and anything shaped like a GitHub token. */
export const maskUrl = (text: string) => text
    .replace(/\/\/[^/@\s]+@/g, "//***@")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "***")
    .replace(/[\u0000-\u001f\u007f]/g, " ");

/**
 * What a git address may be: https, ssh (ssh:// or user@host:path), file://, or an absolute path to a folder on this computer. Never one that
 * starts with `-`, uses a helper program (`ext::`), or carries a password.
 */
export const checkGitUrl = (text: string): { url: string; protocol: "https" | "ssh" | "file" } => {
    const url = text.trim();
    if (!url || url.length > 1000 || /[\u0000-\u001f\u007f\s]/.test(url) || url.startsWith("-")) throw new PluginError("That is not a git address.");
    if (/^https:\/\//i.test(url)) {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            throw new PluginError("That is not a git address.");
        }
        if (parsed.username || parsed.password) throw new PluginError("An address with a user name or password is not accepted: this app stores no credentials.");
        return { url, protocol: "https" };
    }
    if (/^ssh:\/\//i.test(url)) return { url, protocol: "ssh" };
    if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^:\s]+$/.test(url)) return { url, protocol: "ssh" };
    if (/^file:\/\//i.test(url)) return { url, protocol: "file" };
    if (isAbsolute(url) && existsSync(url)) return { url: resolve(url), protocol: "file" };
    throw new PluginError("Use an https:// address, an ssh address, or a folder on this computer.");
};

export const checkRef = (ref: string | undefined) => {
    if (ref !== undefined && !SAFE_REF.test(ref)) throw new PluginError("That branch or tag name is not usable.");
};

const run = (args: string[], cwd: string, protocol: string, timeoutMs: number, signal?: AbortSignal, auth?: GitAuth) =>
    new Promise<string>((done, fail) => {
        execFile("git", args, {
            cwd, env: { ...gitEnv(), ...(auth?.env ?? {}), GIT_ALLOW_PROTOCOL: protocol, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" },
            encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024, signal,
        }, (error, stdout, stderr) => {
            if (!error) return done(stdout.trim());
            const raw = `${stderr || (error as Error).message}`.trim();
            const text = maskUrl(raw).slice(0, 300);
            fail(AUTH_NEEDED.test(raw) ? new GitAuthRequired(`git failed: ${text}`) : new PluginError(`git failed: ${text}`));
        });
    });

/** Credential helper settings for a download that uses the person's GitHub sign-in: github.com only, and no other helper is consulted. */
const authArguments = (auth: GitAuth | undefined) => auth
    ? ["-c", "credential.helper=", "-c", `credential.https://github.com.helper=${auth.credentialHelper}`]
    : [];

/**
 * Fetches `ref` (default: the repository's default branch) or `sha` into `destination` (created here, under the CLI's own staging
 * folder) and leaves a plain checkout without `.git`. Returns the commit. Throws PluginError, including when `sha` was asked for and
 * the repository gave another commit.
 */
export const fetchGitSnapshot = async (source: GitSource, destination: string, options: { signal?: AbortSignal; timeoutMs?: number; auth?: GitAuth } = {}): Promise<{ commit: string }> => {
    const { url, protocol } = checkGitUrl(source.url);
    if (options.auth && (protocol !== "https" || !isGithubHttps(url))) throw new PluginError("A GitHub sign-in is used only for https://github.com addresses.");
    checkRef(source.ref);
    if (source.sha !== undefined && !SHA.test(source.sha)) throw new PluginError("A pinned commit must be a full 40-character SHA.");
    if (protocol === "file" && !/^file:\/\//i.test(url) && !statSync(url).isDirectory()) throw new PluginError("That path is not a folder.");
    const parent = dirname(destination);
    mkdirSync(destination, { recursive: true });
    const timeout = options.timeoutMs ?? 120_000;
    // Always from the parent folder with -C: the checked-out repository is never the working folder of a git process.
    const git = (args: string[]) => run(["--no-pager", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${resolve(parent, ".no-hooks")}`, "-c", "init.templateDir=", "-c", "submodule.recurse=false",
        "-c", "core.symlinks=false", "-c", "core.autocrlf=false", "-c", "protocol.ext.allow=never", ...authArguments(options.auth), "-C", destination, ...args], parent, protocol, timeout, options.signal, options.auth);
    try {
        await git(["init", "--quiet"]);
        await git(["fetch", "--quiet", "--depth", "1", "--no-tags", "--no-recurse-submodules", url, source.sha ?? source.ref ?? "HEAD"]);
        const commit = (await git(["rev-parse", "--verify", "FETCH_HEAD^{commit}"])).toLowerCase();
        if (!SHA.test(commit)) throw new PluginError("git did not report a commit.");
        if (source.sha !== undefined && commit !== source.sha) throw new PluginError("The repository gave a different commit than the pinned one.");
        await git(["checkout", "--quiet", "--detach", "--force", "FETCH_HEAD"]);
        rmSync(`${destination}/.git`, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        return { commit };
    } catch (error) {
        rmSync(destination, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        throw error;
    }
};

/**
 * `fetchGitSnapshot`, and when a github.com repository cannot be read without signing in, one more try with the person's GitHub sign-in
 * if `signIn` gives one (it asks the person first and may return null). Without `signIn` this is exactly `fetchGitSnapshot`.
 */
export const fetchGitSnapshotSigningIn = async (
    source: GitSource, destination: string,
    options: { signal?: AbortSignal; timeoutMs?: number; signIn?: (url: string) => Promise<GitAuth | null> } = {},
): Promise<{ commit: string }> => {
    const { signIn, ...rest } = options;
    try {
        return await fetchGitSnapshot(source, destination, rest);
    } catch (error) {
        if (!(error instanceof GitAuthRequired) || !signIn || !isGithubHttps(source.url)) throw error;
        const auth = await signIn(source.url);
        if (!auth) throw error;
        return fetchGitSnapshot(source, destination, { ...rest, auth });
    }
};
