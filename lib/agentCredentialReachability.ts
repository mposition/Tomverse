/**
 * Which files the engineering agent may never change at T1 because a
 * workflow its own actions trigger would run that change next to a writable
 * credential.
 *
 * docs/policy/engineering-agent.md §5 is the contract. The analysis starts from
 * every workflow at the base commit -- not from the ones that mention secrets
 * -- and fails closed: a workflow, filter, expression or callee it cannot read
 * makes every change push-forbidden. The only way to narrow a result is a
 * human-reviewed exclusion pinned to the workflow file's blob, and an
 * exclusion whose blob no longer matches is void.
 *
 * This runs in the app (it parses YAML), never in the services that clone the
 * repository.
 */

import { parse as parseYaml } from "yaml";

export type WorkflowFile = { path: string; blobSha: string; text: string };

export type HumanExclusion = {
  workflowPath: string;
  jobId: string;
  blobSha: string;
  reason: string;
  reviewedBy: string;
};

/** The branch namespace and base the agent's writes touch. */
const AGENT_BRANCH_PREFIX = "agent/engineering/";
const PR_BASE = "develop";

/** A reusable workflow in this repository, as a job's `uses` names it. */
const LOCAL_CALLEE = /^\.\/(\.github\/workflows\/[^/@]+\.ya?ml)$/;

/**
 * Events the agent's own writes can set off: pushing and creating its branch,
 * deleting it, the pull request it opens against develop (every activity type,
 * including a person's review on it), the comment it leaves on an expired PR,
 * and anything chained off those or off the checks they start.
 */
const PATH_FILTERED_EVENTS = new Set(["push", "pull_request"]);
const ALWAYS_REACHED_EVENTS = new Set([
  "create",
  "delete",
  "pull_request_target",
  "pull_request_review",
  "pull_request_review_comment",
  "issue_comment",
  "issues",
  "check_run",
  "check_suite",
  "status",
  "deployment_status",
]);

type Problem = { path: string; problem: string };

export type CredentialReason =
  | { workflowPath: string; jobId: string | null; reason: "credential_job_reached_without_path_filter" }
  | {
      workflowPath: string;
      jobId: string | null;
      reason: "credential_job_restores_cache";
      /** The kinds that job restores. An unverified or unreadable one is the gated case. */
      cacheKinds: CacheKind[];
    }
  | { workflowPath: string; jobId: string | null; reason: "credential_job_reached_by_chained_event" };

export type PathRule =
  | { workflowPath: string; kind: "paths"; patterns: string[] }
  | { workflowPath: string; kind: "paths-ignore"; patterns: string[] };

export type CredentialAnalysis =
  | { status: "failed"; problems: Problem[] }
  | {
      status: "analysed";
      forbidsAll: boolean;
      reasons: CredentialReason[];
      pathRules: PathRule[];
      voidExclusions: HumanExclusion[];
      /** Every job judged to hold a writable credential, for the record of what was analysed. */
      credentialedJobs: Array<{ workflowPath: string; jobId: string }>;
      /**
       * Every workflow an event the agent raises reaches, directly or through a
       * `workflow_run` chain, sorted.
       *
       * The cache rule above deliberately ignores this: a credentialed job that
       * restores a cache forbids every change wherever it lives (policy §5).
       * This set answers the narrower question policy §5's isolation record
       * needs instead -- which of those jobs can run on the agent's own pull
       * request -- and is reported rather than recomputed so there is one
       * reachability judgement rather than two
       * (.github/audits/actions-cache-poisoning-audit-2026-10-03.md P3 and P7).
       */
      reachedWorkflows: string[];
    };

/* ------------------------------------------------------------------------- */
/* Filter patterns                                                            */
/* ------------------------------------------------------------------------- */

/**
 * GitHub's filter patterns: `*` within a segment, `**` across, and a leading
 * `!` negates. `?`, `+` and `[...]` have meanings this does not model, so a
 * pattern using them is "unknown", and every caller resolves unknown towards
 * forbidding.
 */
const compileFilter = (pattern: string): RegExp | "unknown" => {
  if (/[?+[\]]/.test(pattern)) return "unknown";
  // `**` means something definite only as a whole path segment; glued to
  // other characters its meaning is not modelled here.
  if (/[^/]\*\*|\*\*[^/]/.test(pattern.replace(/^\*\*$/, ""))) return "unknown";
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern.startsWith("**/", i)) {
      // Zero or more directories, so `**/a.ts` matches a root `a.ts`.
      source += "(?:.*/)?";
      i += 2;
    } else if (pattern.startsWith("/**", i) && i + 3 === pattern.length) {
      // Everything below the directory.
      source += "/.*";
      i += 2;
    } else if (pattern.startsWith("**", i)) {
      source += ".*";
      i += 1;
    } else if (pattern[i] === "*") source += "[^/]*";
    else source += pattern[i].replace(/[.^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
};

/**
 * Evaluates an ordered include list with negations, GitHub style: the last
 * matching pattern decides. An unknown positive pattern matches; an unknown
 * negation never un-matches.
 */
const includeListMatches = (patterns: readonly string[], value: string) => {
  let matched = false;
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const compiled = compileFilter(negated ? raw.slice(1) : raw);
    if (compiled === "unknown") {
      if (!negated) matched = true;
      continue;
    }
    if (compiled.test(value)) matched = !negated;
  }
  return matched;
};

/** An ignore list matches only on a pattern it fully understands. */
const ignoreListMatches = (patterns: readonly string[], value: string) => {
  // GitHub style: the last matching pattern decides, and a `!` pattern puts
  // back what an earlier one ignored. A pattern this does not model is
  // resolved towards "not ignored": an unknown ignore adds nothing, and an
  // unknown negation may be putting the value back.
  let ignored = false;
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const compiled = compileFilter(negated ? raw.slice(1) : raw);
    if (compiled === "unknown") {
      if (negated) ignored = false;
      continue;
    }
    if (compiled.test(value)) ignored = !negated;
  }
  return ignored;
};

/* ------------------------------------------------------------------------- */
/* Workflow reading                                                           */
/* ------------------------------------------------------------------------- */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringList = (value: Json | undefined): string[] | null => {
  if (value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value as string[];
  return null;
};

/** The `on:` block as event -> filter object. */
const readTriggers = (on: Json | undefined): Map<string, Obj> | null => {
  const triggers = new Map<string, Obj>();
  if (typeof on === "string") triggers.set(on, {});
  else if (Array.isArray(on)) {
    for (const event of on) {
      if (typeof event !== "string") return null;
      triggers.set(event, {});
    }
  } else if (isObj(on)) {
    for (const [event, filter] of Object.entries(on)) {
      if (filter === null) triggers.set(event, {});
      else if (isObj(filter)) triggers.set(event, filter);
      // A schedule is a list of crons; nothing the agent does sets it off.
      else if (event === "schedule" && Array.isArray(filter)) triggers.set(event, {});
      else return null;
    }
  } else return null;
  return triggers;
};

const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
const SAFE_CONTEXTS = new Set([
  "github",
  "env",
  "vars",
  "job",
  "jobs",
  "steps",
  "runner",
  "strategy",
  "matrix",
  "needs",
  "inputs",
  "hashFiles",
  "format",
  "contains",
  "startsWith",
  "endsWith",
  "join",
  "toJSON",
  "fromJSON",
  "success",
  "always",
  "cancelled",
  "failure",
  "true",
  "false",
  "null",
]);

/**
 * Whether a value carries an expression this analysis cannot resolve to
 * something harmless: any context outside the safe list, or `secrets` other
 * than exactly `secrets.GITHUB_TOKEN`.
 */
const hasUnresolvedExpression = (value: Json | undefined): boolean => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  for (const match of text.matchAll(EXPRESSION)) {
    const body = match[1].replace(/'[^']*'/g, "''");
    // GitHub expression property names may contain hyphens (for example,
    // needs.static-and-unit.result). A suffix after `-` is not a new context.
    for (const identifier of body.matchAll(/(?<![.\w-])([A-Za-z_][A-Za-z0-9_-]*)/g)) {
      const name = identifier[1];
      if (name === "secrets") {
        const rest = body.slice((identifier.index ?? 0) + name.length);
        if (!/^\s*\.\s*GITHUB_TOKEN\b/.test(rest)) return true;
        continue;
      }
      if (!SAFE_CONTEXTS.has(name)) return true;
    }
  }
  return false;
};

/** Any reference to a secret other than the job token, anywhere in the value. */
const referencesSecret = (value: Json | undefined) => {
  const text = JSON.stringify(value ?? null);
  return (
    /secrets\s*\.\s*(?!GITHUB_TOKEN\b)[A-Za-z_]/.test(text) ||
    /secrets\s*\[/.test(text) ||
    /toJSON\s*\(\s*secrets\s*\)/.test(text)
  );
};

const permissionsWrite = (permissions: Json | undefined): "write" | "read" | "unknown" => {
  if (permissions === undefined) return "unknown";
  if (typeof permissions === "string") {
    if (permissions === "read-all") return "read";
    if (permissions === "write-all") return "write";
    return "unknown";
  }
  if (!isObj(permissions)) return "unknown";
  for (const value of Object.values(permissions)) {
    if (value === "write") return "write";
    if (value !== "read" && value !== "none") return "unknown";
  }
  return "read";
};

/**
 * What kind of cache a restoring step reads.
 *
 * The distinction is whether anything verifies the restored bytes before they
 * are used. A lockfile-checked package manager cache is content-addressed and
 * compared against the lockfile, so a tampered entry fails or is refetched
 * rather than installing different code. Build output and browser binaries
 * have no such check: `npm run build` reads `.next/cache` into the server
 * bundle it then runs, and on a cache hit `playwright install` launches the
 * cached binaries without downloading or hashing anything.
 *
 * `unreadable` is neither, and is treated as the worse of the two everywhere.
 * .github/audits/actions-cache-poisoning-audit-2026-10-03.md 3.1 and 4.4.
 */
export type CacheKind = "verified_package_manager" | "unverified" | "unreadable";

/** The kinds a job restores, deduplicated and ordered for a stable record. */
const KIND_ORDER: CacheKind[] = ["unreadable", "unverified", "verified_package_manager"];

/**
 * The only setup actions whose cache counts as verified, and with which input.
 *
 * Treating every `actions/setup-*` cache as verified was wrong: the property
 * belongs to the package manager, not to the family of actions.
 * `actions/setup-go` caches `GOCACHE`, which is compiled build output with
 * nothing checking it, and `setup-java` and `setup-python` cache artefacts of
 * their own. Independent review caught it. So this is an allowlist of
 * (action, cache input) pairs that are lockfile-checked, and everything else
 * that caches is `unverified`.
 *
 * Only npm is listed because it is the only one this repository uses and the
 * only one whose verification has been read here. Adding yarn or pnpm is a
 * change to this list with that reading done, not an assumption.
 */
const VERIFIED_SETUP_CACHES: ReadonlyArray<{ action: RegExp; caches: ReadonlySet<string> }> = [
  { action: /^actions\/setup-node@/i, caches: new Set(["npm"]) },
];

/**
 * Setup actions that cache without being asked, where `package-manager-cache`
 * is the switch rather than `cache`.
 *
 * Only setup-node v6 behaves this way. On every other setup action the `cache`
 * input is its own switch, and `package-manager-cache` is not an input it has,
 * so writing it there suppresses nothing.
 */
const AUTOMATIC_PACKAGE_MANAGER_CACHE: readonly RegExp[] = [/^actions\/setup-node@/i];

/**
 * Setup actions that cache nothing unless `cache` names something.
 *
 * `setup-python` caches only for `pip`, `pipenv` or `poetry`, and
 * `setup-java` only for `maven`, `gradle` or `sbt`; with no `cache` input they
 * restore nothing. Reporting them as restoring would mark a credentialed job
 * that holds no cache as one, which is a false positive rather than caution.
 *
 * An action on neither this list nor the automatic one still counts as
 * restoring, because what it would cache is unknown and this governs a
 * credential gate. `setup-go` is the example: `cache` defaults to true there
 * and what it caches is GOCACHE, compiled build output.
 */
const CACHES_ONLY_WHEN_NAMED: readonly RegExp[] = [
  /^actions\/setup-python@/i,
  /^actions\/setup-java@/i,
  /^actions\/setup-dotnet@/i,
];

const restoredCacheKinds = (job: Obj): CacheKind[] => {
  // What cannot be read counts as restoring: a `uses` that is not a plain
  // string, is an expression, or names an action kept in this repository
  // (its steps are not read here). A setup action restores unless its cache
  // is switched off explicitly, because several enable it by default. GitHub
  // resolves owner and repository names case-insensitively, and so does this.
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const kinds = new Set<CacheKind>();
  for (const step of steps) {
    if (!isObj(step) || step.uses === undefined) continue;
    if (typeof step.uses !== "string") {
      kinds.add("unreadable");
      continue;
    }
    const uses = step.uses.trim();
    // A container step's work is not read here either.
    if (uses.includes("${{") || uses.startsWith("./") || /^docker:\/\//i.test(uses)) {
      kinds.add("unreadable");
      continue;
    }
    if (/^actions\/cache(?:\/restore)?@/i.test(uses)) {
      kinds.add("unverified");
      continue;
    }
    // Any action told to read the Actions cache backend, whatever its name.
    if (isObj(step.with) && /type\s*=\s*gha\b/i.test(JSON.stringify(step.with))) {
      kinds.add("unverified");
      continue;
    }
    if (/^actions\/setup-[a-z-]+@/i.test(uses)) {
      const withBlock = isObj(step.with) ? step.with : {};
      const packageManagerCache = withBlock["package-manager-cache"];
      const cache = withBlock.cache;
      const cacheOff = cache === false || cache === "false";
      const named = typeof cache === "string" && cache.trim() !== "" && cache.trim() !== "false" ? cache.trim() : null;

      // An explicitly named cache is restored whatever else is set. Treating
      // `package-manager-cache: false` as switching everything off was wrong:
      // it governs only the automatic cache, so `cache: yarn` beside it still
      // restores, and on an action that has no such input it means nothing at
      // all. Independent review caught both.
      if (named !== null) {
        const verified = VERIFIED_SETUP_CACHES.some((entry) => entry.action.test(uses) && entry.caches.has(named));
        kinds.add(verified ? "verified_package_manager" : "unverified");
        continue;
      }

      // No named cache. Which input decides now depends on the action.
      const hasAutomaticCache = AUTOMATIC_PACKAGE_MANAGER_CACHE.some((pattern) => pattern.test(uses));
      if (hasAutomaticCache) {
        // setup-node v6 caches whenever package.json names a package manager,
        // and `package-manager-cache: false` is the only thing that stops it --
        // `cache: false` does not
        // (.github/audits/actions-cache-poisoning-audit-2026-10-03.md 4.2).
        if (packageManagerCache === false || packageManagerCache === "false") continue;
        kinds.add("unverified");
        continue;
      }
      // Every other setup action: its own `cache` input is its switch. Some
      // cache nothing without it, and some default it on -- setup-go caches
      // GOCACHE, which is compiled build output.
      if (cacheOff) continue;
      // `cache: true` turns caching on without naming a manager, which is how
      // setup-dotnet enables its NuGet cache. Read as "not named" it fell
      // through the list below and the step was classified as caching nothing
      // -- a false negative on a credential gate, found by both reviewers.
      const cacheOn = cache === true || cache === "true";
      if (!cacheOn && CACHES_ONLY_WHEN_NAMED.some((pattern) => pattern.test(uses))) continue;
      kinds.add("unverified");
    }
  }
  return KIND_ORDER.filter((kind) => kinds.has(kind));
};

/* ------------------------------------------------------------------------- */
/* The agent's branch language                                                */
/* ------------------------------------------------------------------------- */

/**
 * Every branch the agent can push is `agent/engineering/` followed by one to
 * twelve digits. These two answer, conservatively, whether a filter pattern
 * could touch that language at all, and whether it certainly covers all of
 * it. Anything uncertain answers towards "reached".
 */
const AGENT_RUN_BRANCH = /^agent\/engineering\/[0-9]{1,12}$/;

export const agentBranchMayMatch = (pattern: string): boolean => {
  if (pattern.includes("${{")) return true;
  if (compileFilter(pattern) === "unknown") return true;
  // The Auto PR opt-in filters require this literal path segment, which an
  // agent/engineering/<digits> branch can never contain. Do not infer safety
  // from the workflow's job-level `if` or from arbitrary glob shapes.
  if (pattern === "to-develop/**" || pattern === "**/to-develop/**") return false;
  const star = pattern.indexOf("*");
  if (star === -1) return AGENT_RUN_BRANCH.test(pattern);
  const prefix = pattern.slice(0, star);
  if (prefix.length <= AGENT_BRANCH_PREFIX.length) return AGENT_BRANCH_PREFIX.startsWith(prefix);
  return (
    prefix.startsWith(AGENT_BRANCH_PREFIX) && /^[0-9]{0,12}$/.test(prefix.slice(AGENT_BRANCH_PREFIX.length))
  );
};

export const agentBranchesAllCovered = (pattern: string): boolean => {
  if (pattern.includes("${{") || pattern.startsWith("!")) return false;
  // A pattern this file does not model cannot be relied on to cover anything.
  if (compileFilter(pattern) === "unknown") return false;
  if (pattern === `${AGENT_BRANCH_PREFIX}*`) return true;
  if (!pattern.endsWith("**")) return false;
  const prefix = pattern.slice(0, -2);
  return !prefix.includes("*") && AGENT_BRANCH_PREFIX.startsWith(prefix);
};

/* ------------------------------------------------------------------------- */
/* Judging one job                                                            */
/* ------------------------------------------------------------------------- */

const HOSTED_RUNNER = /^(?:ubuntu|windows|macos)-[A-Za-z0-9.-]+$/;

/**
 * Where a job runs and in what: a self-hosted runner, a container or a service
 * with credentials, or any of these chosen by an expression, can carry
 * credentials the workflow file never names.
 */
const executionEnvironmentCredentialed = (workflow: Obj, job: Obj): boolean => {
  const runsOn = job["runs-on"];
  const hosted =
    (typeof runsOn === "string" && HOSTED_RUNNER.test(runsOn)) ||
    (Array.isArray(runsOn) && runsOn.length > 0 && runsOn.every((label) => typeof label === "string" && HOSTED_RUNNER.test(label)));
  if (!hosted) return true;
  for (const field of ["container", "services", "defaults"] as const) {
    const value = job[field];
    if (value === undefined) continue;
    const text = JSON.stringify(value);
    if (text.includes("${{") || /"credentials"\s*:/.test(text)) return true;
  }
  if (workflow.defaults !== undefined && JSON.stringify(workflow.defaults).includes("${{")) return true;
  return false;
};

type JobVerdict = {
  /** Holds a writable credential once valid human exclusions are applied. */
  credential: boolean;
  /** Holds one ignoring exclusions -- the cache rule's view, which no exclusion narrows. */
  credentialIgnoringExclusions: boolean;
  /** Restores an Actions cache, itself or through a local callee. */
  restoresCache: boolean;
  /** Which kinds, so a change from verified-only to unverified is visible. */
  cacheKinds: CacheKind[];
  problem: string | null;
};

/* ------------------------------------------------------------------------- */
/* The analysis                                                               */
/* ------------------------------------------------------------------------- */

export const analyseCredentialReachability = (input: {
  workflows: readonly WorkflowFile[];
  exclusions: readonly HumanExclusion[];
  /** A dated record that pull_request-run caches never reach other refs' runs. */
  cacheIsolationRecorded: boolean;
}): CredentialAnalysis => {
  const problems: Problem[] = [];
  const parsed = new Map<string, Obj>();
  for (const file of input.workflows) {
    if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file.path)) continue;
    let document: unknown;
    try {
      document = parseYaml(file.text, { uniqueKeys: true, merge: false });
    } catch {
      problems.push({ path: file.path, problem: "yaml_unparseable" });
      continue;
    }
    if (!isObj(document) || !isObj(document.jobs)) {
      problems.push({ path: file.path, problem: "not_a_workflow" });
      continue;
    }
    parsed.set(file.path, document);
  }
  if (problems.length > 0) return { status: "failed", problems };

  const blobOf = new Map(input.workflows.map((file) => [file.path, file.blobSha]));
  const voidExclusions = input.exclusions.filter(
    (exclusion) => blobOf.get(exclusion.workflowPath) !== exclusion.blobSha,
  );
  const validExclusions = input.exclusions.filter((exclusion) => !voidExclusions.includes(exclusion));
  const excluded = (path: string, jobId: string) =>
    validExclusions.some((exclusion) => exclusion.workflowPath === path && exclusion.jobId === jobId);

  /**
   * Every workflow a local call reaches, the called file included; null when
   * any call on the way is remote or unreadable.
   */
  const calleesOf = (path: string, seen: Set<string>): Set<string> | null => {
    if (seen.has(path)) return seen;
    const workflow = parsed.get(path);
    if (workflow === undefined) return null;
    seen.add(path);
    for (const job of Object.values(workflow.jobs as Obj)) {
      if (!isObj(job) || typeof job.uses !== "string") continue;
      const local = LOCAL_CALLEE.exec(job.uses);
      if (local === null || calleesOf(local[1], seen) === null) return null;
    }
    return seen;
  };

  const judgeJob = (workflow: Obj, path: string, jobId: string, job: Json, depth: number): JobVerdict => {
    if (!isObj(job)) {
      return {
        credential: true,
        credentialIgnoringExclusions: true,
        restoresCache: false,
        cacheKinds: [],
        problem: "job_not_an_object",
      };
    }
    const own = (
      credential: boolean,
      kinds: CacheKind[],
      problem: string | null = null,
    ): JobVerdict => ({
      credential: credential && !excluded(path, jobId),
      credentialIgnoringExclusions: credential,
      restoresCache: kinds.length > 0,
      cacheKinds: kinds,
      problem,
    });

    const callerPermissions = job.permissions !== undefined ? job.permissions : workflow.permissions;
    if (typeof job.uses === "string") {
      // Calling a reusable workflow is a credential in itself (policy §5); the
      // callee is still read for what the rule set needs from it -- whether it
      // restores a cache, and whether it can be read at all.
      const local = LOCAL_CALLEE.exec(job.uses);
      // A remote or computed callee cannot be read: whether it restores a cache
      // or calls further is unknown, so the analysis fails (policy §5).
      if (local === null) {
        return {
          credential: true,
          credentialIgnoringExclusions: true,
          restoresCache: true,
          cacheKinds: ["unreadable"],
          problem: "callee_unreadable",
        };
      }
      const callee = parsed.get(local[1]);
      if (callee === undefined || depth > 8) return own(true, ["unreadable"], "callee_unreadable");
      const reached = new Set<CacheKind>();
      for (const [calleeJobId, calleeJob] of Object.entries(callee.jobs as Obj)) {
        const verdict = judgeJob(callee, local[1], calleeJobId, calleeJob, depth + 1);
        for (const kind of verdict.cacheKinds) reached.add(kind);
        if (verdict.problem) return own(true, KIND_ORDER.filter((k) => reached.has(k)), verdict.problem);
      }
      const cache = KIND_ORDER.filter((k) => reached.has(k));
      // An exclusion on the caller pins the caller's blob only. It holds when
      // every workflow the call reaches is local and pinned at its current blob
      // by an exclusion of its own; otherwise a changed callee would ride on
      // the caller's review.
      const reach = calleesOf(local[1], new Set());
      if (reach === null) return own(true, ["unreadable"], "callee_unreadable");
      // Pinned means every job of every workflow the call reaches is covered
      // by a valid exclusion at its current blob -- a callee job left out runs
      // with the call all the same.
      const calleesPinned = [...reach].every((path) =>
        Object.keys((parsed.get(path)?.jobs ?? {}) as Obj).every((jobId) => excluded(path, jobId)),
      );
      return calleesPinned
        ? own(true, cache)
        : {
            credential: true,
            credentialIgnoringExclusions: true,
            restoresCache: cache.length > 0,
            cacheKinds: cache,
            problem: null,
          };
    }

    const cache = restoredCacheKinds(job);
    const credential =
      job.secrets === "inherit" ||
      job.environment !== undefined ||
      permissionsWrite(callerPermissions) !== "read" ||
      executionEnvironmentCredentialed(workflow, job) ||
      referencesSecret(job) ||
      referencesSecret(workflow.env) ||
      referencesSecret(workflow.defaults) ||
      // The whole job, steps included: an expression reaching a context this
      // cannot see into is as good as a secret for the purpose of this analysis.
      hasUnresolvedExpression(job) ||
      hasUnresolvedExpression(workflow.env);
    return own(credential, cache);
  };

  const reasons: CredentialReason[] = [];
  const pathRules: PathRule[] = [];
  let forbidsAll = false;
  const reachedNames = new Set<string>();
  const credentialed = new Map<string, string[]>();
  const credentialedJobs: Array<{ workflowPath: string; jobId: string }> = [];

  for (const [path, workflow] of parsed) {
    const jobs: string[] = [];
    for (const [jobId, job] of Object.entries(workflow.jobs as Obj)) {
      const verdict = judgeJob(workflow, path, jobId, job, 0);
      if (verdict.problem) problems.push({ path, problem: `${jobId}:${verdict.problem}` });
      if (verdict.credential) {
        jobs.push(jobId);
        credentialedJobs.push({ workflowPath: path, jobId });
      }
      // The cache rule ignores exclusions: only the recorded isolation lifts it.
      //
      // `cacheKinds` rides along rather than narrowing this: the rule is
      // unchanged, and the kinds are what makes a job going from a verified
      // package-manager cache to an unverified one a visible change instead of
      // the same reason twice. scripts/check-credential-cache-separation.mjs is
      // the gate that acts on the distinction.
      if (verdict.credentialIgnoringExclusions && verdict.restoresCache && !input.cacheIsolationRecorded) {
        forbidsAll = true;
        reasons.push({
          workflowPath: path,
          jobId,
          reason: "credential_job_restores_cache",
          cacheKinds: verdict.cacheKinds,
        });
      }
    }
    credentialed.set(path, jobs);
  }
  if (problems.length > 0) return { status: "failed", problems };

  // First pass: direct triggers. Second: workflow_run chains, to a fixed point.
  const reached = new Set<string>();
  for (const [path, workflow] of parsed) {
    const triggers = readTriggers(workflow.on);
    if (triggers === null) return { status: "failed", problems: [{ path, problem: "triggers_unreadable" }] };
    for (const [event, filter] of triggers) {
      let hit = false;
      if (ALWAYS_REACHED_EVENTS.has(event)) hit = true;
      else if (PATH_FILTERED_EVENTS.has(event)) {
        const branches = stringList(filter.branches);
        const ignored = stringList(filter["branches-ignore"]);
        const tags = stringList(filter.tags);
        if (branches === null || ignored === null || tags === null) {
          return { status: "failed", problems: [{ path, problem: `${event}:branch_filter_unreadable` }] };
        }
        if (event === "push") {
          // GitHub judges a branch push by the branch filters alone: only a push
          // with tag filters and no branch filter at all ignores branches.
          const onlyTags =
            filter.branches === undefined &&
            filter["branches-ignore"] === undefined &&
            (filter.tags !== undefined || filter["tags-ignore"] !== undefined);
          // Negations in an include list can only remove branches, so they are
          // ignored here: that errs towards "reached".
          const included =
            branches.length === 0 ||
            branches.some((pattern) => !pattern.startsWith("!") && agentBranchMayMatch(pattern));
          // Every agent branch is ignored only if an ignore pattern covers them
          // all and no later `!` pattern could put one back.
          let allIgnored = false;
          for (const pattern of ignored) {
            if (pattern.startsWith("!")) {
              if (agentBranchMayMatch(pattern.slice(1))) allIgnored = false;
            } else if (agentBranchesAllCovered(pattern)) allIgnored = true;
          }
          hit = !onlyTags && included && !allIgnored;
        } else {
          const expression = [...branches, ...ignored].some((pattern) => pattern.includes("${{"));
          hit =
            expression ||
            ((branches.length === 0 || includeListMatches(branches, PR_BASE)) &&
              !ignoreListMatches(ignored, PR_BASE));
        }
        if (hit) reached.add(path);
        if (hit && (credentialed.get(path) ?? []).length > 0) {
          const paths = stringList(filter.paths);
          const pathsIgnore = stringList(filter["paths-ignore"]);
          if (paths === null || pathsIgnore === null || (paths.length > 0 && pathsIgnore.length > 0)) {
            return { status: "failed", problems: [{ path, problem: `${event}:path_filter_unreadable` }] };
          }
          const expression = [...paths, ...pathsIgnore].some((pattern) => pattern.includes("${{"));
          if (!expression && paths.length > 0) {
            pathRules.push({ workflowPath: path, kind: "paths", patterns: paths });
          } else if (!expression && pathsIgnore.length > 0) {
            pathRules.push({ workflowPath: path, kind: "paths-ignore", patterns: pathsIgnore });
          } else {
            forbidsAll = true;
            reasons.push({ workflowPath: path, jobId: null, reason: "credential_job_reached_without_path_filter" });
          }
        }
        continue;
      }
      if (hit) {
        reached.add(path);
        if ((credentialed.get(path) ?? []).length > 0) {
          forbidsAll = true;
          reasons.push({ workflowPath: path, jobId: null, reason: "credential_job_reached_by_chained_event" });
        }
      }
    }
  }

  let grew = true;
  while (grew) {
    grew = false;
    // `workflow_run.workflows` matches a workflow's name, its file name, or --
    // for a workflow with no name, which GitHub shows by path -- its path. A
    // reached workflow answers to all three. One whose name is computed or not
    // a string could answer to anything, and so could an upstream entry that
    // is an expression: both chain.
    let reachedNameUnknown = false;
    for (const path of reached) {
      const name = parsed.get(path)?.name;
      if (typeof name === "string" && !name.includes("${{")) reachedNames.add(name);
      else if (name !== undefined) reachedNameUnknown = true;
      reachedNames.add(path.slice(path.lastIndexOf("/") + 1));
      reachedNames.add(path);
    }
    for (const [path, workflow] of parsed) {
      if (reached.has(path)) continue;
      const triggers = readTriggers(workflow.on) as Map<string, Obj>;
      const run = triggers.get("workflow_run");
      if (run === undefined) continue;
      const upstream = stringList(run.workflows);
      const chained =
        reachedNameUnknown ||
        upstream === null ||
        upstream.length === 0 ||
        upstream.some((name) => name.includes("${{") || reachedNames.has(name));
      if (!chained) continue;
      reached.add(path);
      grew = true;
      if ((credentialed.get(path) ?? []).length > 0) {
        forbidsAll = true;
        reasons.push({ workflowPath: path, jobId: null, reason: "credential_job_reached_by_chained_event" });
      }
    }
  }

  return {
    status: "analysed",
    forbidsAll,
    reasons,
    pathRules,
    voidExclusions,
    credentialedJobs,
    reachedWorkflows: [...reached].sort(),
  };
};

/**
 * The changed paths the analysis forbids. A `paths` filter forbids what it
 * matches; a `paths-ignore` filter forbids everything it does not ignore.
 */
export const credentialForbiddenPaths = (
  analysis: Extract<CredentialAnalysis, { status: "analysed" }>,
  paths: readonly string[],
): Set<string> => {
  const forbidden = new Set<string>();
  for (const path of paths) {
    if (analysis.forbidsAll) {
      forbidden.add(path);
      continue;
    }
    for (const rule of analysis.pathRules) {
      const hit =
        rule.kind === "paths"
          ? includeListMatches(rule.patterns, path)
          : !ignoreListMatches(rule.patterns, path);
      if (hit) forbidden.add(path);
    }
  }
  return forbidden;
};
