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

/** Read the complete pinned base from GitHub. The worker supplies only the
 * commit SHA; neither its tree listing nor a caller-provided URL is trusted. */
export async function readEngineeringAgentPinnedBaseTree(baseSha: string,
  deps: Deps = {}): Promise<{ base: TreeEntry[]; rootTreeId: string;
    baseGitattributes: string | null; baseCommitterDate: string | null }> {
  if (!SHA.test(baseSha)) throw new EngineeringAgentGitHubReadError("invalid_input");
  const resolved = withDefaults(deps);
  if (await readEngineeringAgentDevelopHead(deps) !== baseSha)
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
