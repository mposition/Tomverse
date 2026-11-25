import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { commandEnv } from "../../../tomverse-cli/src/env.js";
import { githubPullUrl, type PullLink } from "../github-pr-contract";
import type { GhStatusResult, PrCheck, PrComment, PrDetails, PullRequestDraft } from "../git-actions-contract";
import { resolveProgram, runProgram } from "./tool-process";

/**
 * The GitHub CLI the person already installed and signed in to. Desktop never stores a GitHub token: every call here runs `gh`, which
 * reads its own saved sign-in. A runner returns `code: null` when `gh` could not start.
 */
export type GhRunner = (args: readonly string[], options?: { cwd?: string; timeoutMs?: number }) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const passthrough = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GH_HOST", "GH_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"];

function ghEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...commandEnv([], source), GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_SPINNER_DISABLED: "1", GH_PAGER: "cat" };
  // The person's own sign-in sources, passed to the program that uses them; Desktop never reads or keeps them.
  for (const name of passthrough) if (typeof source[name] === "string") env[name] = source[name];
  return env;
}

/** A runner for the installed `gh`, or null when none is on the PATH. */
export function createGhRunner(source: NodeJS.ProcessEnv = process.env): GhRunner | null {
  const file = resolveProgram("gh", source);
  if (!file) return null;
  const env = ghEnvironment(source);
  return (args, options) => runProgram(file, args, { cwd: options?.cwd ?? tmpdir(), env, timeoutMs: options?.timeoutMs ?? 30_000, maxBytes: 8 * 1024 * 1024 });
}

/**
 * A runner for test and QA builds, answering from `gh-fixture.json`: `{ "responses": [{ "args": "pr view", "code": 0, "stdout": "..." }] }`.
 * The first response whose `args` starts the joined arguments wins. It never starts a program.
 */
export function createFixtureGhRunner(file: string): GhRunner | null {
  let responses: Array<{ args: string; code: number; stdout: string; stderr?: string }>;
  try {
    responses = z.object({ responses: z.array(z.object({ args: z.string(), code: z.number().int(), stdout: z.string(), stderr: z.string().optional() })) })
      .parse(JSON.parse(readFileSync(file, "utf8"))).responses;
  } catch { return null; }
  return async (args) => {
    const line = args.join(" ");
    const hit = responses.find((response) => line.startsWith(response.args));
    return hit ? { code: hit.code, stdout: hit.stdout, stderr: hit.stderr ?? "" } : { code: 1, stdout: "", stderr: "No fixture response." };
  };
}

export async function readGhStatus(run: GhRunner | null): Promise<GhStatusResult> {
  if (!run) return { state: "missing" };
  const result = await run(["auth", "status", "--hostname", "github.com"], { timeoutMs: 15_000 });
  if (result.code === null) return { state: "missing" };
  return result.code === 0 ? { state: "ready" } : { state: "signed-out" };
}

/** Text from outside the app: control characters and terminal colour codes removed, so it shows and attaches as plain data. */
export function cleanExternalText(text: string, limit: number) {
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, "");
  return plain.length > limit ? plain.slice(0, limit) : plain;
}

const login = z.object({ login: z.string() }).nullish();
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const viewSchema = z.object({
  number: z.number().int().positive(), title: z.string(), state: z.string(), isDraft: z.boolean().optional(), url: z.string(),
  headRefName: z.string(), baseRefName: z.string(), headRefOid: sha, reviewDecision: z.string().nullish(), mergeable: z.string().nullish(),
  reviews: z.array(z.unknown()).default([]), comments: z.array(z.unknown()).default([]),
});
const reviewItem = z.object({ id: z.string().optional(), author: login, body: z.string().nullish(), state: z.string().optional(), submittedAt: z.string().nullish() });
const commentItem = z.object({ id: z.string().optional(), author: login, body: z.string(), createdAt: z.string().nullish(), url: z.string().optional() });
const inlineItem = z.object({ id: z.number().int(), user: login, path: z.string(), line: z.number().int().nullish(), original_line: z.number().int().nullish(),
  body: z.string(), created_at: z.string().optional(), html_url: z.string().optional() });
const checkItem = z.object({ name: z.string(), state: z.string(), bucket: z.enum(["pass", "fail", "pending", "skipping", "cancel"]),
  workflow: z.string().nullish(), link: z.string().nullish(), description: z.string().nullish(), startedAt: z.string().nullish(), completedAt: z.string().nullish() });

const MAX_COMMENTS = 60;
const MAX_CHECKS = 100;
const BODY_LIMIT = 4_000;

export const viewFields = "number,title,state,isDraft,url,headRefName,baseRefName,headRefOid,reviewDecision,mergeable,reviews,comments";
export const checkFields = "name,state,bucket,workflow,link,description,startedAt,completedAt";

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

function items<T>(schema: z.ZodType<T>, value: unknown, limit: number): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => { const parsed = schema.safeParse(item); return parsed.success ? [parsed.data] : []; }).slice(0, limit);
}

/** `gh pr checks` ends with exit code 1 when a check failed and 8 while checks are pending; its JSON is complete either way. */
export function parseChecks(stdout: string): PrCheck[] {
  return items(checkItem, parseJson(stdout), MAX_CHECKS).map((row) => ({
    name: cleanExternalText(row.name, 200), bucket: row.bucket, state: cleanExternalText(row.state, 40),
    ...(row.workflow ? { workflow: cleanExternalText(row.workflow, 200) } : {}),
    ...(row.link ? { link: cleanExternalText(row.link, 500) } : {}),
    ...(row.description ? { description: cleanExternalText(row.description, 400) } : {}),
    ...(row.startedAt ? { startedAt: row.startedAt } : {}),
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
  }));
}

export function parseView(stdout: string, inline: string | null): Omit<PrDetails, "checks"> | null {
  const parsed = viewSchema.safeParse(parseJson(stdout));
  if (!parsed.success) return null;
  const view = parsed.data;
  const author = (value: { login: string } | null | undefined) => cleanExternalText(value?.login ?? "ghost", 80);
  const comments: PrComment[] = [
    ...items(reviewItem, view.reviews, 200).filter((row) => row.body?.trim()).map((row, index): PrComment => ({
      id: row.id ?? "review-" + index, kind: "review", author: author(row.author), body: cleanExternalText(row.body ?? "", BODY_LIMIT),
      ...(row.state ? { state: row.state } : {}), ...(row.submittedAt ? { createdAt: row.submittedAt } : {}),
    })),
    ...items(commentItem, view.comments, 200).map((row, index): PrComment => ({
      id: row.id ?? "comment-" + index, kind: "comment", author: author(row.author), body: cleanExternalText(row.body, BODY_LIMIT),
      ...(row.createdAt ? { createdAt: row.createdAt } : {}), ...(row.url ? { url: row.url } : {}),
    })),
    ...(inline ? items(inlineItem, parseJson(inline), 200).map((row): PrComment => ({
      id: "inline-" + row.id, kind: "inline", author: author(row.user), body: cleanExternalText(row.body, BODY_LIMIT), path: cleanExternalText(row.path, 400),
      ...((row.line ?? row.original_line) ? { line: (row.line ?? row.original_line)! } : {}),
      ...(row.created_at ? { createdAt: row.created_at } : {}), ...(row.html_url ? { url: row.html_url } : {}),
    })) : []),
  ].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  return {
    number: view.number, title: cleanExternalText(view.title, 300), state: view.state, isDraft: view.isDraft === true, url: view.url,
    headRef: cleanExternalText(view.headRefName, 200), baseRef: cleanExternalText(view.baseRefName, 200), headSha: view.headRefOid,
    ...(view.reviewDecision ? { reviewDecision: view.reviewDecision } : {}), ...(view.mergeable ? { mergeable: view.mergeable } : {}),
    comments: comments.slice(-MAX_COMMENTS), omittedComments: Math.max(0, comments.length - MAX_COMMENTS),
  };
}

export type PrReadResult = { status: "ok"; details: PrDetails } | { status: "error"; reason: "gh-missing" | "gh-signed-out" | "gh-error" };

/** The pull request, its checks and its comments, read with `gh`. Nothing is written. */
export async function readPullRequestWithGh(run: GhRunner, link: PullLink): Promise<PrReadResult> {
  const ref = githubPullUrl(link.url);
  if (!ref) return { status: "error", reason: "gh-error" };
  const [view, checks, inline] = await Promise.all([
    run(["pr", "view", ref.url, "--json", viewFields]),
    run(["pr", "checks", ref.url, "--json", checkFields]),
    run(["api", "repos/" + ref.repo + "/pulls/" + ref.number + "/comments?per_page=100"]),
  ]);
  if (view.code === null) return { status: "error", reason: "gh-missing" };
  if (view.code !== 0) return { status: "error", reason: /auth|login|credential|HTTP 401/i.test(view.stderr) ? "gh-signed-out" : "gh-error" };
  const details = parseView(view.stdout, inline.code === 0 ? inline.stdout : null);
  if (!details) return { status: "error", reason: "gh-error" };
  // A pull request without checks makes `gh pr checks` exit 1 with no JSON: that is an empty list, not a failure.
  return { status: "ok", details: { ...details, checks: checks.code === null ? [] : parseChecks(checks.stdout) } };
}

/** The run and job a check's link points at, only when the link is a GitHub Actions page of the same repository. */
export function checkRunReference(link: string, repo: string): { run: string; job?: string } | null {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100})\/actions\/runs\/([1-9][0-9]{0,18})(?:\/job\/([1-9][0-9]{0,18}))?\/?$/.exec(link);
  if (!match || (match[1] + "/" + match[2]).toLowerCase() !== repo.toLowerCase()) return null;
  return { run: match[3]!, ...(match[4] ? { job: match[4] } : {}) };
}

const LOG_LIMIT = 8_000;

/** The end of the failed steps' log, where the error is. External text: shown and attached as data, never as an instruction. */
export async function readFailedCheckLog(run: GhRunner, link: PullLink, check: string): Promise<{ status: "ok"; text: string; truncated: boolean } | { status: "error"; code: "no-failed-check" | "log-unavailable" | "gh-missing" }> {
  const ref = githubPullUrl(link.url);
  if (!ref) return { status: "error", code: "log-unavailable" };
  const checks = await run(["pr", "checks", ref.url, "--json", checkFields]);
  if (checks.code === null) return { status: "error", code: "gh-missing" };
  const failed = parseChecks(checks.stdout).find((row) => row.name === check && row.bucket === "fail");
  if (!failed) return { status: "error", code: "no-failed-check" };
  const target = failed.link ? checkRunReference(failed.link, ref.repo) : null;
  if (!target) return { status: "error", code: "log-unavailable" };
  const args = target.job ? ["run", "view", "--job", target.job, "--log-failed", "--repo", ref.repo]
    : ["run", "view", target.run, "--log-failed", "--repo", ref.repo];
  const log = await run(args, { timeoutMs: 60_000 });
  if (log.code !== 0 || !log.stdout.trim()) return { status: "error", code: "log-unavailable" };
  const text = cleanExternalText(log.stdout, Number.MAX_SAFE_INTEGER).trimEnd();
  return text.length > LOG_LIMIT ? { status: "ok", text: text.slice(text.length - LOG_LIMIT), truncated: true } : { status: "ok", text, truncated: false };
}

/** The repository a GitHub remote address names (https or ssh), or null for any other host. */
export function githubRepoOfRemote(url: string): string | null {
  const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100})$/.exec(url.trim().replace(/\/$/, ""));
  if (!match) return null;
  const name = match[2]!.replace(/\.git$/, "");
  return name && name !== "." && name !== ".." ? match[1] + "/" + name : null;
}

export type CreatePullRequestResult = { state: "created"; url: string } | { state: "exists"; url: string } | { state: "failed" } | { state: "unknown" };

/**
 * Opens the pull request that was approved. Called once. When the outcome is not known (timeout, unreadable output) the pull requests of
 * the branch are listed before anything is reported, and the call is never repeated.
 */
export async function createPullRequest(run: GhRunner, repo: string, head: string, draft: PullRequestDraft, cwd: string): Promise<CreatePullRequestResult> {
  const created = await run(["pr", "create", "--repo", repo, "--head", head, "--base", draft.base, "--title", draft.title, "--body", draft.body,
    ...(draft.draft ? ["--draft"] : [])], { cwd, timeoutMs: 60_000 });
  const url = created.stdout.split("\n").map((line) => line.trim()).findLast((line) => githubPullUrl(line)?.repo.toLowerCase() === repo.toLowerCase());
  if (created.code === 0 && url) return { state: "created", url: githubPullUrl(url)!.url };
  const listed = await run(["pr", "list", "--repo", repo, "--head", head, "--state", "open", "--json", "url", "--limit", "5"], { cwd, timeoutMs: 30_000 });
  const rows = listed.code === 0 ? items(z.object({ url: z.string() }), parseJson(listed.stdout), 5) : null;
  const existing = rows?.map((row) => githubPullUrl(row.url)).find((row) => row?.repo.toLowerCase() === repo.toLowerCase());
  if (existing) return { state: "exists", url: existing.url };
  return created.code === null || created.code === 0 || !rows ? { state: "unknown" } : { state: "failed" };
}

export const ghFixtureFile = (profile: string) => join(profile, "gh-fixture.json");
