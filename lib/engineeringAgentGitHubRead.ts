/**
 * The engineering agent's read-only view of GitHub, from the app
 * (docs/policy/engineering-agent.md §8: the app holds a read-only token for
 * this repository alone). It re-reads what a registration proposal claims to
 * come from (§2.2): the shared backlog at a pinned commit, the check runs of
 * develop's head, the failing checks of dependabot pull requests. It never
 * writes, never follows a URL a caller gives it, and never puts upstream text
 * in an error.
 */

import "server-only";

import { createHash } from "node:crypto";

import { REGISTRATION_SOURCES } from "@/lib/engineeringAgentRegistrationGuard";
import { checkListing, gitObjectId, type TreeEntry } from
  "@/lib/engineeringAgentTreeVerify";

/** One fixed repository. A caller supplies a commit id or a PR number, never a URL. */
const REPOSITORY = "mposition/Tomverse";
const API_ORIGIN = "https://api.github.com";
const API_VERSION = "2022-11-28";
const TIMEOUT_MS = 8_000;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_TREE_JSON_BYTES = 5 * 1024 * 1024;
const MAX_BACKLOG_BYTES = 1024 * 1024;
const MAX_CHECK_RUNS = 100;
/** One page of open pull requests; more than this and the list is refused, not cut. */
const MAX_OPEN_PULLS = 100;
const SHA = /^[0-9a-f]{40}$/;

export const ENGINEERING_AGENT_GITHUB_READ_TOKEN_ENV = "ENGINEERING_AGENT_GITHUB_READ_TOKEN";

type FetchLike = typeof fetch;

export class EngineeringAgentGitHubReadError extends Error {
  constructor(
    readonly code:
      | "not_configured"
      | "invalid_input"
      | "transport_error"
      | "http_error"
      | "invalid_response"
      | "oversized_response"
      | "not_text",
  ) {
    super(code);
    this.name = "EngineeringAgentGitHubReadError";
  }
}

const tokenFrom = (env: Readonly<Record<string, string | undefined>>) => {
  const token = env[ENGINEERING_AGENT_GITHUB_READ_TOKEN_ENV]?.trim();
  if (!token) throw new EngineeringAgentGitHubReadError("not_configured");
  return token;
};

async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  const claimed = response.headers.get("content-length");
  if (claimed !== null && /^\d+$/.test(claimed) && Number(claimed) > limit) {
    await response.body?.cancel();
    throw new EngineeringAgentGitHubReadError("oversized_response");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new EngineeringAgentGitHubReadError("invalid_response");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new EngineeringAgentGitHubReadError("oversized_response");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function githubJson(
  path: string,
  deps: { env: Readonly<Record<string, string | undefined>>; fetchImpl: FetchLike },
  limit = MAX_JSON_BYTES,
): Promise<unknown> {
  return (await githubPage(path, deps, limit)).body;
}

/** A `Link` header that names a next page: the answer is one page of more. */
const hasNextPage = (link: string | null) => link !== null && /<[^>]*>\s*;\s*rel="?next"?/i.test(link);

/**
 * One GET, with whether GitHub says more pages follow. A list that has more
 * is refused by its reader rather than taken as the whole (a check that fails
 * on page two is still a failing check).
 */
async function githubPage(
  path: string,
  deps: { env: Readonly<Record<string, string | undefined>>; fetchImpl: FetchLike },
  limit = MAX_JSON_BYTES,
): Promise<{ body: unknown; hasNext: boolean }> {
  const token = tokenFrom(deps.env);
  let response: Response;
  try {
    response = await deps.fetchImpl(`${API_ORIGIN}/repos/${REPOSITORY}${path}`, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": API_VERSION,
      },
    });
  } catch {
    throw new EngineeringAgentGitHubReadError("transport_error");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new EngineeringAgentGitHubReadError("http_error");
  }
  const hasNext = hasNextPage(response.headers.get("link"));
  const bytes = await readBounded(response, limit);
  try {
    return { body: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), hasNext };
  } catch {
    throw new EngineeringAgentGitHubReadError("invalid_response");
  }
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

type Deps = { env?: Readonly<Record<string, string | undefined>>; fetchImpl?: FetchLike };
const withDefaults = (deps: Deps) => ({ env: deps.env ?? process.env, fetchImpl: deps.fetchImpl ?? fetch });

/** The shared backlog branch's head commit: the pin a registration round starts from (§2.2 S1). */
export async function readEngineeringAgentBacklogHead(deps: Deps = {}): Promise<string> {
  const branch = REGISTRATION_SOURCES.S1.branch;
  const body = record(await githubJson(`/commits/${encodeURIComponent(branch)}`, withDefaults(deps)));
  const sha = typeof body?.sha === "string" ? body.sha.toLowerCase() : null;
  if (sha === null || !SHA.test(sha)) throw new EngineeringAgentGitHubReadError("invalid_response");
  return sha;
}

/**
 * A pinned commit must be the branch's head or behind it on the same line: a
 * commit of another branch is not the source, whatever it holds.
 */
async function requireOnBranch(
  pinnedCommit: string,
  branch: string,
  resolved: { env: Readonly<Record<string, string | undefined>>; fetchImpl: FetchLike },
) {
  if (!SHA.test(pinnedCommit)) throw new EngineeringAgentGitHubReadError("invalid_input");
  const comparison = record(
    await githubJson(`/compare/${pinnedCommit}...${encodeURIComponent(branch)}`, resolved),
  );
  if (comparison?.status !== "identical" && comparison?.status !== "ahead") {
    throw new EngineeringAgentGitHubReadError("invalid_input");
  }
}

/** The backlog document as it stands at a pinned commit of the backlog branch (§2.2 S1). */
export async function readEngineeringAgentBacklogAt(pinnedCommit: string, deps: Deps = {}): Promise<string> {
  if (!SHA.test(pinnedCommit)) throw new EngineeringAgentGitHubReadError("invalid_input");
  const resolved = withDefaults(deps);
  await requireOnBranch(pinnedCommit, REGISTRATION_SOURCES.S1.branch, resolved);
  const file = record(
    await githubJson(
      `/contents/${REGISTRATION_SOURCES.S1.path.split("/").map(encodeURIComponent).join("/")}?ref=${pinnedCommit}`,
      resolved,
    ),
  );
  if (file?.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string") {
    throw new EngineeringAgentGitHubReadError("invalid_response");
  }
  const bytes = Buffer.from(file.content.replace(/\n/g, ""), "base64");
  if (bytes.byteLength > MAX_BACKLOG_BYTES) throw new EngineeringAgentGitHubReadError("oversized_response");
  // A NUL is not text: the whole source is refused, not the row that holds it.
  if (bytes.includes(0)) throw new EngineeringAgentGitHubReadError("not_text");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new EngineeringAgentGitHubReadError("not_text");
  }
}

export type EngineeringAgentCheckRun = { id: number; name: string; conclusion: string | null };

/**
 * Every check run of a commit, or a refusal: a page that is not the whole
 * list -- GitHub's own count says more, or a next page is linked -- is never
 * read as the whole.
 */
const checkRunsOf = (page: { body: unknown; hasNext: boolean }): EngineeringAgentCheckRun[] => {
  const body = record(page.body);
  const runs = body?.check_runs;
  if (!Array.isArray(runs) || runs.length > MAX_CHECK_RUNS) throw new EngineeringAgentGitHubReadError("invalid_response");
  if (page.hasNext || body?.total_count !== runs.length) throw new EngineeringAgentGitHubReadError("invalid_response");
  return runs.map((run) => {
    const value = record(run);
    if (
      typeof value?.id !== "number" ||
      !Number.isSafeInteger(value.id) ||
      typeof value.name !== "string" ||
      (value.conclusion !== null && typeof value.conclusion !== "string")
    ) {
      throw new EngineeringAgentGitHubReadError("invalid_response");
    }
    return { id: value.id, name: value.name, conclusion: value.conclusion as string | null };
  });
};

const checkRunsAt = (sha: string, resolved: { env: Readonly<Record<string, string | undefined>>; fetchImpl: FetchLike }) =>
  githubPage(`/commits/${sha}/check-runs?per_page=${MAX_CHECK_RUNS}`, resolved).then(checkRunsOf);

/** develop's head and its check runs (§2.2 S2). */
export async function readEngineeringAgentDevelopChecks(
  deps: Deps = {},
): Promise<{ headSha: string; checkRuns: EngineeringAgentCheckRun[] }> {
  const resolved = withDefaults(deps);
  const head = record(await githubJson(`/commits/develop`, resolved));
  const headSha = typeof head?.sha === "string" ? head.sha.toLowerCase() : null;
  if (headSha === null || !SHA.test(headSha)) throw new EngineeringAgentGitHubReadError("invalid_response");
  return { headSha, checkRuns: await checkRunsAt(headSha, resolved) };
}

/** Exact develop head for a v22 attempt's optional publication run. A later
 * patch whose local baseline differs from this commit cannot be published. */
export async function readEngineeringAgentDevelopHead(deps: Deps = {}): Promise<string> {
  const head = record(await githubJson("/commits/develop", withDefaults(deps)));
  const sha = typeof head?.sha === "string" ? head.sha.toLowerCase() : null;
  if (sha === null || !SHA.test(sha))
    throw new EngineeringAgentGitHubReadError("invalid_response");
  return sha;
}

/** One content-addressed Git blob, never an arbitrary URL or branch path. */
export async function readEngineeringAgentGitBlob(oid: string,
  deps: Deps = {}, maxBytes = 200 * 1024): Promise<Uint8Array> {
  if (!SHA.test(oid) || !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 || maxBytes > 2 * 1024 * 1024)
    throw new EngineeringAgentGitHubReadError("invalid_input");
  const blob = record(await githubJson(`/git/blobs/${oid}`,
    withDefaults(deps), Math.min(MAX_TREE_JSON_BYTES,
      4 * Math.ceil(maxBytes / 3) + 4_096)));
  if (!blob || blob.sha !== oid || blob.encoding !== "base64" ||
      typeof blob.content !== "string" ||
      typeof blob.size !== "number" || blob.size > maxBytes ||
      blob.size < 0)
    throw new EngineeringAgentGitHubReadError("invalid_response");
  const compact = blob.content.replace(/\n/g, "");
  const bytes = Buffer.from(compact, "base64");
  if (bytes.length !== blob.size || bytes.toString("base64") !== compact ||
      gitObjectId("blob", bytes) !== oid) {
    bytes.fill(0);
    throw new EngineeringAgentGitHubReadError("invalid_response");
  }
  return bytes;
}

/** Whether develop's head is this commit or descends from it: a base develop
 * has since moved past is still one of develop's own commits. */
async function developContains(sha: string, deps: Deps): Promise<boolean> {
  const head = await readEngineeringAgentDevelopHead(deps);
  if (head === sha) return true;
  const compare = record(await githubJson(`/compare/${sha}...${head}?per_page=1`,
    withDefaults(deps), MAX_TREE_JSON_BYTES));
  return compare?.status === "ahead" && compare.behind_by === 0 &&
    record(compare.merge_base_commit)?.sha === sha;
}

/** Read the complete pinned base from GitHub. The worker supplies only the
 * commit SHA; neither its tree listing nor a caller-provided URL is trusted.
 * The base is develop's head, or with `onDevelop` any commit develop's head
 * contains (a tier read after settlement, when develop may have moved). */
export async function readEngineeringAgentPinnedBaseTree(baseSha: string,
  deps: Deps = {}, options: { onDevelop?: boolean } = {}): Promise<{
    base: TreeEntry[]; rootTreeId: string;
    baseGitattributes: string | null; baseCommitterDate: string | null }> {
  if (!SHA.test(baseSha)) throw new EngineeringAgentGitHubReadError("invalid_input");
  const resolved = withDefaults(deps);
  if (!(options.onDevelop ? await developContains(baseSha, deps) :
      await readEngineeringAgentDevelopHead(deps) === baseSha))
    throw new EngineeringAgentGitHubReadError("invalid_input");
  const commit = record(await githubJson(`/git/commits/${baseSha}`, resolved));
  const treeRef = record(commit?.tree);
  const rootTreeId = treeRef?.sha;
  if (commit?.sha !== baseSha || typeof rootTreeId !== "string" ||
      !SHA.test(rootTreeId))
    throw new EngineeringAgentGitHubReadError("invalid_response");
  // GitHub normalizes the JSON committer date to UTC. A verified commit's
  // signed payload retains the exact Git timestamp and zone needed for the
  // Publisher's deterministic commit object. Without it, publication stays
  // private rather than inventing a timezone.
  const verification = record(commit?.verification);
  const payload = verification?.verified === true &&
    typeof verification.payload === "string" ? verification.payload : null;
  const headerEnd = payload?.indexOf("\n\n") ?? -1;
  const header = payload?.startsWith(`tree ${rootTreeId}\n`) &&
    headerEnd > 0 ? payload.slice(0, headerEnd) : null;
  const committerLines = header?.split("\n").filter((line) =>
    line.startsWith("committer ")) ?? [];
  const baseCommitterDate = committerLines.length === 1 ?
    /^committer [^\r\n]+ <[^<>\r\n]+> (\d{1,12} [+-]\d{4})$/.exec(
      committerLines[0])?.[1] ?? null : null;
  const tree = record(await githubJson(`/git/trees/${rootTreeId}?recursive=1`,
    resolved, MAX_TREE_JSON_BYTES));
  if (!tree || tree.sha !== rootTreeId || tree.truncated !== false ||
      !Array.isArray(tree.tree) || tree.tree.length > 20_000)
    throw new EngineeringAgentGitHubReadError("invalid_response");
  const base: TreeEntry[] = tree.tree.map((item: unknown) => {
    const entry = record(item);
    if (typeof entry?.path !== "string" ||
        typeof entry.mode !== "string" ||
        typeof entry.sha !== "string" ||
        (entry.type !== "blob" && entry.type !== "tree" &&
          entry.type !== "commit"))
      throw new EngineeringAgentGitHubReadError("invalid_response");
    return { path: entry.path, mode: entry.mode,
      type: entry.type, oid: entry.sha };
  });
  const checked = checkListing(base);
  if (!checked.ok || checked.rootTreeId !== rootTreeId)
    throw new EngineeringAgentGitHubReadError("invalid_response");
  const attributes = base.find((item) => item.path === ".gitattributes");
  let baseGitattributes: string | null = null;
  if (attributes) {
    if (attributes.type !== "blob" || attributes.mode !== "100644")
      throw new EngineeringAgentGitHubReadError("invalid_response");
    const bytes = await readEngineeringAgentGitBlob(
      attributes.oid, deps, 65_536);
    try {
      baseGitattributes = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } finally { bytes.fill(0); }
  }
  return { base, rootTreeId, baseGitattributes,
    baseCommitterDate };
}

/**
 * The check runs of an S2 proposal's pinned commit, which must be develop's
 * head or behind it on develop: a caller's commit of another line is not
 * develop's CI, whatever fails there.
 */
export async function readEngineeringAgentCheckRunsAt(sha: string, deps: Deps = {}): Promise<EngineeringAgentCheckRun[]> {
  if (!SHA.test(sha)) throw new EngineeringAgentGitHubReadError("invalid_input");
  const resolved = withDefaults(deps);
  await requireOnBranch(sha, "develop", resolved);
  return checkRunsAt(sha, resolved);
}

/** One dependabot pull request as it stands now: its head and the checks that fail there (§2.2 S3). */
export async function readEngineeringAgentDependabotPull(
  prNumber: number,
  deps: Deps = {},
): Promise<{ prNumber: number; headSha: string; failingChecks: string[] } | null> {
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) throw new EngineeringAgentGitHubReadError("invalid_input");
  const resolved = withDefaults(deps);
  const value = record(await githubJson(`/pulls/${prNumber}`, resolved));
  const user = record(value?.user);
  const head = record(value?.head);
  if (value?.state !== "open" || user?.login !== "dependabot[bot]") return null;
  const headSha = typeof head?.sha === "string" ? head.sha.toLowerCase() : null;
  if (headSha === null || !SHA.test(headSha)) throw new EngineeringAgentGitHubReadError("invalid_response");
  const runs = await checkRunsAt(headSha, resolved);
  const failingChecks = runs
    .filter((run) => run.conclusion === "failure" || run.conclusion === "timed_out")
    .map((run) => run.name);
  return { prNumber, headSha, failingChecks };
}

/**
 * Open dependabot pull requests and the checks that fail on each head (§2.2
 * S3). The PRs are only read. The author is filtered from the whole open
 * list, never from a cut of it: more open pull requests than one page holds
 * is a refusal, not a shorter list.
 */
export async function readEngineeringAgentDependabotFailures(
  deps: Deps = {},
): Promise<Array<{ prNumber: number; headSha: string; failingChecks: string[] }>> {
  const resolved = withDefaults(deps);
  const page = await githubPage(`/pulls?state=open&per_page=${MAX_OPEN_PULLS}`, resolved);
  const pulls = page.body;
  if (!Array.isArray(pulls) || page.hasNext || pulls.length > MAX_OPEN_PULLS) {
    throw new EngineeringAgentGitHubReadError("invalid_response");
  }
  const out: Array<{ prNumber: number; headSha: string; failingChecks: string[] }> = [];
  for (const pull of pulls) {
    const value = record(pull);
    const user = record(value?.user);
    const head = record(value?.head);
    if (user?.login !== "dependabot[bot]") continue;
    const prNumber = value?.number;
    const headSha = typeof head?.sha === "string" ? head.sha.toLowerCase() : null;
    if (typeof prNumber !== "number" || !Number.isSafeInteger(prNumber) || headSha === null || !SHA.test(headSha)) {
      throw new EngineeringAgentGitHubReadError("invalid_response");
    }
    const runs = await checkRunsAt(headSha, resolved);
    const failingChecks = runs
      .filter((run) => run.conclusion === "failure" || run.conclusion === "timed_out")
      .map((run) => run.name);
    out.push({ prNumber, headSha, failingChecks });
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* A published pull request, as the approval observer reads it (§9-10)        */
/* ------------------------------------------------------------------------- */

const MAX_REVIEWS = 100;
const MAX_PR_FILES = 3_000;
const MAX_DIFF_BYTES = 1024 * 1024;
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const FAILING_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required", "stale", "startup_failure"]);

export type EngineeringAgentPullObservation = {
  state: "open" | "closed";
  merged: boolean;
  mergedAt: Date | null;
  mergeCommitSha: string | null;
  /** Who merged, as a kind only (§9-10: the merger is an observation, never an identity). */
  mergedByKind: "user" | "bot" | "app" | "unknown";
  baseRef: string;
  baseSha: string;
  headSha: string;
  reviews: Array<{ id: number; userId: number; login: string; state: string; commitId: string; submittedAt: Date }>;
  /** Every required check of the head, or null while one is pending or the list cannot be read whole. */
  requiredChecks: { allPassed: boolean } | null;
  /** sha256 of the diff's own bytes, as the publisher binds it; null when it could not be read. */
  diffDigest: string | null;
  /** Complete GitHub PR file names at the observed base/head, or unknown. */
  changedFiles?: string[] | null;
};

async function readPullFileNames(prNumber: number,
  comparison: { baseSha: string; headSha: string; changedFiles: number },
  resolved: { env: Readonly<Record<string, string | undefined>>;
    fetchImpl: FetchLike }): Promise<string[] | null> {
  if (!Number.isSafeInteger(comparison.changedFiles) ||
      comparison.changedFiles < 0 || comparison.changedFiles > MAX_PR_FILES) return null;
  const names: string[] = [];
  const seen = new Set<string>();
  const pages = Math.max(1, Math.ceil(comparison.changedFiles / 100));
  for (let pageNumber = 1; pageNumber <= pages; pageNumber++) {
    const page = await githubPage(
      `/pulls/${prNumber}/files?per_page=100&page=${pageNumber}`, resolved);
    const expectedLength = Math.min(100,
      comparison.changedFiles - (pageNumber - 1) * 100);
    if (!Array.isArray(page.body) || page.body.length !== expectedLength ||
        page.hasNext !== (pageNumber < pages)) return null;
    for (const raw of page.body) {
      const file = record(raw);
      if (typeof file?.filename !== "string" ||
          typeof file.status !== "string" || seen.has(file.filename)) return null;
      seen.add(file.filename);
      names.push(file.filename);
      if (file.status === "renamed") {
        if (typeof file.previous_filename !== "string") return null;
        names.push(file.previous_filename);
      }
    }
  }
  const current = record(await githubJson(`/pulls/${prNumber}`, resolved));
  if (current?.number !== prNumber ||
      record(current.base)?.sha !== comparison.baseSha ||
      record(current.head)?.sha !== comparison.headSha ||
      current.changed_files !== comparison.changedFiles) return null;
  return names;
}

const instant = (value: unknown): Date | null => {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

async function readPullDiffDigest(
  prNumber: number,
  resolved: { env: Readonly<Record<string, string | undefined>>; fetchImpl: FetchLike },
): Promise<string | null> {
  const token = tokenFrom(resolved.env);
  let response: Response;
  try {
    response = await resolved.fetchImpl(`${API_ORIGIN}/repos/${REPOSITORY}/pulls/${prNumber}`, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Accept: "application/vnd.github.diff",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": API_VERSION,
      },
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  try {
    return createHash("sha256").update(await readBounded(response, MAX_DIFF_BYTES)).digest("hex");
  } catch {
    return null;
  }
}

/** Required check names of develop, or null when the protection is not readable with this token. */
async function readRequiredCheckNames(
  resolved: { env: Readonly<Record<string, string | undefined>>; fetchImpl: FetchLike },
): Promise<string[] | null> {
  const branch = record(await githubJson(`/branches/develop`, resolved));
  const required = record(record(branch?.protection)?.required_status_checks);
  if (!required) return null;
  const checks = Array.isArray(required.checks)
    ? required.checks.map((entry) => record(entry)?.context)
    : required.contexts;
  if (!Array.isArray(checks) || checks.some((name) => typeof name !== "string")) return null;
  return checks as string[];
}

async function readRequiredChecks(
  headSha: string,
  resolved: { env: Readonly<Record<string, string | undefined>>; fetchImpl: FetchLike },
): Promise<{ allPassed: boolean } | null> {
  const names = await readRequiredCheckNames(resolved);
  if (names === null) return null;
  const runs = await checkRunsAt(headSha, resolved);
  const combined = record(await githubJson(`/commits/${headSha}/status`, resolved));
  const statuses = Array.isArray(combined?.statuses) ? combined.statuses.map(record) : null;
  if (statuses === null) throw new EngineeringAgentGitHubReadError("invalid_response");
  let pending = false;
  for (const name of names) {
    // A re-run leaves the earlier run beside it; the newest one counts.
    const run = runs.filter((entry) => entry.name === name).sort((a, b) => b.id - a.id)[0];
    const status = statuses.find((entry) => entry?.context === name);
    // GitHub requires every result of a required name to pass: a check run
    // and a commit status of the same name are both judged.
    if (!run && !status) pending = true;
    if (run) {
      if (run.conclusion === null) pending = true;
      else if (FAILING_CONCLUSIONS.has(run.conclusion)) return { allPassed: false };
      else if (!PASSING_CONCLUSIONS.has(run.conclusion)) pending = true;
    }
    if (status) {
      if (status.state === "failure" || status.state === "error") return { allPassed: false };
      if (status.state !== "success") pending = true;
    }
  }
  return pending ? null : { allPassed: true };
}

/**
 * One published pull request with what the approval judgement needs: its
 * state and merge, its reviews, its head's required checks and its diff
 * digest. Reads only; a list that is not whole is a refusal, not a shorter
 * list, and a check still running leaves the checks undecided.
 */
export async function readEngineeringAgentPullObservation(
  prNumber: number,
  deps: Deps = {},
): Promise<EngineeringAgentPullObservation> {
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) throw new EngineeringAgentGitHubReadError("invalid_input");
  const resolved = withDefaults(deps);
  const pull = record(await githubJson(`/pulls/${prNumber}`, resolved));
  const base = record(pull?.base);
  const head = record(pull?.head);
  const baseSha = typeof base?.sha === "string" ? base.sha.toLowerCase() : null;
  const headSha = typeof head?.sha === "string" ? head.sha.toLowerCase() : null;
  const state = pull?.state;
  const merged = pull?.merged === true;
  const mergeCommitSha = merged && typeof pull?.merge_commit_sha === "string" ? pull.merge_commit_sha.toLowerCase() : null;
  const mergedAt = merged ? instant(pull?.merged_at) : null;
  if (
    pull?.number !== prNumber || (state !== "open" && state !== "closed") ||
    typeof base?.ref !== "string" || baseSha === null || !SHA.test(baseSha) ||
    headSha === null || !SHA.test(headSha) ||
    (merged && (mergeCommitSha === null || !SHA.test(mergeCommitSha) || mergedAt === null))
  ) {
    throw new EngineeringAgentGitHubReadError("invalid_response");
  }
  const mergedBy = record(pull?.merged_by);
  const mergedByKind = !merged ? "unknown" :
    record(pull?.performed_via_github_app) ? "app" :
    mergedBy?.type === "Bot" ? "bot" : mergedBy?.type === "User" ? "user" : "unknown";

  const page = await githubPage(`/pulls/${prNumber}/reviews?per_page=${MAX_REVIEWS}`, resolved);
  if (!Array.isArray(page.body) || page.hasNext || page.body.length > MAX_REVIEWS) {
    throw new EngineeringAgentGitHubReadError("invalid_response");
  }
  const reviews: EngineeringAgentPullObservation["reviews"] = [];
  for (const entry of page.body) {
    const review = record(entry);
    const user = record(review?.user);
    const submittedAt = instant(review?.submitted_at);
    const commitId = typeof review?.commit_id === "string" ? review.commit_id.toLowerCase() : null;
    // A pending review is the reviewer's draft: not submitted, not counted.
    if (review?.state === "PENDING" || submittedAt === null) continue;
    if (typeof review?.id !== "number" || !Number.isSafeInteger(review.id) ||
        typeof user?.id !== "number" || !Number.isSafeInteger(user.id) || typeof user.login !== "string" ||
        typeof review.state !== "string" || commitId === null || !SHA.test(commitId)) {
      throw new EngineeringAgentGitHubReadError("invalid_response");
    }
    reviews.push({ id: review.id, userId: user.id, login: user.login, state: review.state, commitId, submittedAt });
  }
  return {
    state,
    merged,
    mergedAt,
    mergeCommitSha,
    mergedByKind,
    baseRef: base.ref,
    baseSha,
    headSha,
    reviews,
    requiredChecks: await readRequiredChecks(headSha, resolved),
    diffDigest: await readPullDiffDigest(prNumber, resolved),
    changedFiles: merged ? await readPullFileNames(prNumber, {
      baseSha, headSha, changedFiles: pull.changed_files as number,
    }, resolved) : null,
  };
}
