import { z } from "zod";
import { githubPullUrl, type PullEvidence, type PullLink } from "../github-pr-contract";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const pull = z.object({
  number: z.number().int(),
  base: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }) }),
  head: z.object({ sha }),
  merge_commit_sha: sha.nullable(),
  merged: z.boolean(),
  mergeable: z.boolean().nullable(),
  state: z.enum(["open", "closed"]),
});
const checks = z.object({
  total_count: z.number().int(),
  check_runs: z.array(z.object({ name: z.string(), head_sha: sha, conclusion: z.string().nullable(),
    app: z.object({ id: z.number().int() }).nullable() })),
});
const statuses = z.object({ sha, total_count: z.number().int(),
  statuses: z.array(z.object({ context: z.string(), state: z.string() })) });
const protection = z.object({
  checks: z.array(z.object({ context: z.string(), app_id: z.number().int().nullish() })).optional(),
  contexts: z.array(z.string()).optional(),
}).refine(row => row.checks !== undefined || row.contexts !== undefined);
const rules = z.array(z.object({ type: z.string(), parameters: z.unknown().optional() }));
const rulesChecks = z.object({ required_status_checks: z.array(z.object({ context: z.string(), integration_id: z.number().int().nullish() })) });
const deployments = z.array(z.object({ id: z.number().int().positive(), environment: z.string(), sha,
  created_at: z.iso.datetime() }));
const deploymentStatuses = z.array(z.object({ id: z.number().int().positive(), state: z.string(), environment: z.string(), created_at: z.iso.datetime() }));

type ReadGithubPage = (path: string, signal: AbortSignal) => Promise<unknown>;

export async function readGithubPublicPage(path: string, signal: AbortSignal) {
  const response = await fetch("https://api.github.com" + path, {
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    method: "GET", credentials: "omit", redirect: "error", cache: "no-store", signal,
  });
  if (!response.ok || /rel="next"/.test(response.headers.get("link") ?? "")) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Incomplete GitHub evidence");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing GitHub evidence");
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    for (;;) {
      const page = await reader.read();
      if (page.done) break;
      size += page.value.byteLength;
      if (size > 2_000_000) throw new Error("GitHub evidence is too large");
      text += decoder.decode(page.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readGithubPull(link: PullLink, signal: AbortSignal, read: ReadGithubPage = readGithubPublicPage): Promise<PullEvidence> {
  const ref = githubPullUrl(link.url);
  if (!ref) throw new Error("Invalid GitHub pull request URL");
  const root = "/repos/" + ref.repo;
  const path = root + "/pulls/" + ref.number;
  const evidence: PullEvidence = { ...link, url: ref.url, checkedAt: Date.now(), state: "unknown" };
  const limit = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  const load = async <T>(schema: z.ZodType<T>, path: string): Promise<T | undefined> => {
    try { return schema.parse(await read(path, limit)); }
    catch { return undefined; }
  };
  const pullRequest = await load(pull, path);
  if (!pullRequest || pullRequest.number !== ref.number ||
    pullRequest.base.repo.full_name.toLowerCase() !== ref.repo.toLowerCase()) return { ...evidence, state: "unavailable" };
  const head = pullRequest.head.sha;
  evidence.head = head;
  if (pullRequest.merged) {
    if (pullRequest.merge_commit_sha) evidence.merge = pullRequest.merge_commit_sha;
    if (!evidence.merge || !link.environment) return { ...evidence, state: "merged" };
    const query = new URLSearchParams({ environment: link.environment, sha: evidence.merge, per_page: "100" });
    const list = await load(deployments, root + "/deployments?" + query);
    const newest = list?.filter((row) => row.environment === link.environment && row.sha === evidence.merge)
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)[0];
    if (!newest) return { ...evidence, state: "merged" };
    const result = await load(deploymentStatuses, root + "/deployments/" + newest.id + "/statuses?per_page=100");
    const latest = result?.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)[0];
    if (latest?.environment !== link.environment) return { ...evidence, state: "merged" };
    if (latest.state === "success") return { ...evidence, state: "deployed" };
    if (["failure", "error"].includes(latest.state)) return { ...evidence, state: "deploy_failed" };
    return { ...evidence, state: ["pending", "queued", "in_progress"].includes(latest.state) ? "deploy_pending" : "merged" };
  }
  if (pullRequest.state === "closed") return { ...evidence, state: "closed" };
  const commit = root + "/commits/" + head;
  const branch = encodeURIComponent(pullRequest.base.ref);
  const [runs, commitStatuses, branchProtection, branchRules] = await Promise.all([
    load(checks, commit + "/check-runs?filter=latest&per_page=100"),
    load(statuses, commit + "/status?per_page=100"),
    load(protection, root + "/branches/" + branch + "/protection/required_status_checks"),
    load(rules, root + "/rules/branches/" + branch),
  ]);
  const current = await load(pull, path);
  if (!current || current.head.sha !== head || current.merged || current.state !== "open" ||
      current.base.ref !== pullRequest.base.ref || current.base.repo.full_name !== pullRequest.base.repo.full_name) {
    return { ...evidence, state: "unknown" };
  }
  const matchingRuns = runs?.check_runs.filter((run) => run.head_sha === head) ?? [];
  const matchingStatuses = commitStatuses?.sha === head ? commitStatuses.statuses : [];
  const rulesRequired = branchRules?.filter(({ type }) => type === "required_status_checks")
    .map(({ parameters }) => rulesChecks.safeParse(parameters));
  const classic = branchProtection?.checks ?? [];
  const required = [
    ...classic.map(check => ({ name: check.context, id: check.app_id })),
    ...(branchProtection?.contexts ?? []).filter(name => !classic.some(check => check.context === name))
      .map(name => ({ name, id: undefined })),
    ...(rulesRequired ?? []).flatMap(result => result.success
      ? result.data.required_status_checks.map(check => ({ name: check.context, id: check.integration_id })) : []),
  ];
  const observed = required.map(({ name, id }) => [
    ...matchingRuns.filter(run => run.name === name && (id == null || id === -1 || run.app?.id === id)).map(run => run.conclusion),
    ...(id == null || id === -1 ? matchingStatuses.filter(status => status.context === name).map(status => status.state) : []),
  ]);
  const failed = new Set(["failure", "timed_out", "action_required", "startup_failure", "error"]);
  if (observed.some(values => values.some(value => value !== null && failed.has(value)))) {
    return { ...evidence, state: "failed", ...(current.mergeable === false ? { conflict: true } : {}) };
  }
  if (current.mergeable === false) return { ...evidence, state: "conflict" };
  if (!runs || runs.total_count !== matchingRuns.length || !commitStatuses || commitStatuses.sha !== head ||
    commitStatuses.total_count !== matchingStatuses.length || !branchProtection || !rulesRequired || !required.length ||
    rulesRequired.some(result => !result.success) || current.mergeable !== true) return evidence;
  const allPassed = observed.every(values => values.length > 0 && values.every(value => value === "success"));
  return { ...evidence, state: allPassed ? "passed" : "pending" };
}
