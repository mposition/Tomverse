/**
 * What an Actions cache key in this repository may look like.
 *
 * The rules exist because a cache entry's blast radius is decided by its key,
 * not by the workflow that wrote it. An entry written while running on the
 * default branch -- or on `develop` -- is restorable by every run that can see
 * that scope, so two workflows sharing a key share one pool, and a broad
 * restore-key quietly joins pools that were meant to be separate.
 *
 * .github/audits/actions-cache-poisoning-audit-2026-10-03.md F1 and F2 are the
 * findings. Two of them were observed rather than reasoned: `pr-fast-gate.yml`
 * already carries a comment about a bare `Linux-next-` prefix restoring another
 * workflow's Next 16.3.4 cache and breaking a 16.3.5 Turbopack font build.
 *
 * Pure: it takes workflow sources and returns findings. The runner is
 * scripts/check-ci-cache-keys.mjs.
 *
 * What this deliberately does NOT govern: `actions/setup-node`'s own npm cache.
 * It is read through the same backend, but `npm ci` verifies every tarball
 * against the integrity in package-lock.json, so a tampered entry fails or is
 * refetched rather than installing different code
 * (.github/audits/actions-cache-poisoning-audit-2026-10-03.md 4.4). Suppressing
 * it would slow every install for no change in what can execute. The entries
 * that have no such check -- build output and browser binaries -- are the ones
 * these rules are about, and they all arrive through `actions/cache`.
 *
 * One latent path that check does not cover is recorded in the audit's 4.2:
 * setup-node v6 defaults `package-manager-cache` to true, so adding a
 * `packageManager` field to package.json would start caching in steps that
 * declare no `cache:` input at all.
 */

import { parse as parseYaml } from "yaml";

/**
 * The cache paths this policy governs, and the family token their keys carry.
 *
 * A path that is not listed is not judged -- adding a new cached path is a
 * deliberate act, and the rule it needs is a row here rather than a guess.
 */
export const CACHE_FAMILIES = [
  { path: ".next/cache", family: "next" },
  { path: "~/.cache/ms-playwright", family: "playwright" },
];

const RUNNER_OS = "${{ runner.os }}";

/**
 * The scopes whose entries every run in the repository can reach.
 *
 * `main` is the default branch, so its entries are restorable everywhere.
 * `develop` is the base of every feature pull request, so its entries are
 * restorable by all of them. A cache written in either is shared state.
 */
export const WIDELY_READABLE_BRANCHES = ["main", "develop"];

const isObj = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** `actions/cache`, and its `restore`/`save` split, whatever the version. */
const CACHE_ACTION = /^actions\/cache(?:\/(restore|save))?@/i;

const stringList = (value) => {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") {
    return value
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.map((item) => item.trim()).filter((item) => item.length > 0);
  }
  return null;
};

/**
 * A branch-filter pattern as a regular expression, or "unknown".
 *
 * `*` within a segment, `**` across segments, and a leading `!` handled by the
 * caller. `?`, `+` and character classes mean things this does not model, and a
 * pattern using them compiles to "unknown" so every caller can resolve it in
 * its own conservative direction -- which is a different direction for an
 * include list than for an ignore list.
 */
const compileBranchPattern = (pattern) => {
  if (typeof pattern !== "string") return "unknown";
  if (/[?+[\]{}()|]/.test(pattern)) return "unknown";
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern.startsWith("**/", i)) {
      source += "(?:.*/)?";
      i += 2;
    } else if (pattern.startsWith("/**", i) && i + 3 === pattern.length) {
      source += "/.*";
      i += 2;
    } else if (pattern.startsWith("**", i)) {
      source += ".*";
      i += 1;
    } else if (pattern[i] === "*") source += "[^/]*";
    else source += pattern[i].replace(/[.^$\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
};

/** Could this include pattern put a run on that branch? Unknown means yes. */
const patternCouldMatch = (pattern, branch) => {
  if (typeof pattern === "string" && pattern.startsWith("!")) return false; // a negation never adds a branch
  const compiled = compileBranchPattern(pattern);
  return compiled === "unknown" ? true : compiled.test(branch);
};

/** Does this ignore pattern certainly keep that branch out? Unknown means no. */
const patternCertainlyMatches = (pattern, branch) => {
  if (typeof pattern === "string" && pattern.startsWith("!")) return false; // a negation puts it back
  const compiled = compileBranchPattern(pattern);
  return compiled === "unknown" ? false : compiled.test(branch);
};

/**
 * Activity types of `pull_request` that are treated as narrow.
 *
 * A `pull_request` run's `GITHUB_REF` is the merge ref, which only that pull
 * request can restore. `closed` is left out deliberately: whether a merged
 * pull request's run still carries the merge ref is not something this module
 * can establish, and the whole point of this rule is that an uncertain answer
 * about a write resolves against writing. Nothing in this repository caches
 * through `actions/cache` on a `closed` trigger, so the conservatism is free.
 */
const NARROW_PULL_REQUEST_TYPES = new Set([
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
  "edited",
  "labeled",
  "unlabeled",
  "assigned",
  "unassigned",
  "review_requested",
  "review_request_removed",
  "converted_to_draft",
  "auto_merge_enabled",
  "auto_merge_disabled",
  "milestoned",
  "demilestoned",
  "enqueued",
  "dequeued",
]);

/**
 * Whether a workflow can run with `GITHUB_REF` on a widely readable branch.
 *
 * This is an allowlist, and it has to be. An earlier version asked only about
 * `push`, `schedule`, `workflow_dispatch` and `workflow_call` and answered "no"
 * for everything else -- so `workflow_run`, `repository_dispatch`,
 * `issue_comment` and the rest, all of which run on the default branch, were
 * read as narrow. Independent review caught it. Only two event shapes are known
 * narrow here:
 *
 * - `pull_request`, whose ref is the merge ref, with its activity types all in
 *   NARROW_PULL_REQUEST_TYPES.
 * - `push` whose filters provably keep it off both shared branches.
 *
 * Every other event, and anything unreadable, reaches. The question being
 * decided is whether a *write* into shared state is allowed, so an uncertain
 * answer has to be the restrictive one.
 */
export const reachesWidelyReadableScope = (document) => {
  const on = document?.on ?? document?.true; // YAML 1.1 parses a bare `on:` as true
  if (on === undefined || on === null) return true;
  const events = Array.isArray(on)
    ? Object.fromEntries(on.map((name) => [name, null]))
    : typeof on === "string"
      ? { [on]: null }
      : isObj(on)
        ? on
        : null;
  if (events === null) return true;
  if (Object.keys(events).length === 0) return true;

  for (const [event, filter] of Object.entries(events)) {
    if (event === "pull_request") {
      if (filter === null || filter === undefined) continue; // every type, all narrow
      if (!isObj(filter)) return true;
      if (filter.types === undefined) continue;
      const types = stringList(filter.types);
      if (types === null || types.length === 0) return true;
      if (!types.every((type) => NARROW_PULL_REQUEST_TYPES.has(type))) return true;
      continue;
    }

    if (event !== "push") return true; // every other event, allowlist style

    if (filter === null || filter === undefined) return true;
    if (!isObj(filter)) return true;
    const branches = filter.branches;
    const ignored = filter["branches-ignore"];

    if (branches === undefined && ignored === undefined) {
      // Tag filters alone never put GITHUB_REF on a branch.
      if (filter.tags !== undefined || filter["tags-ignore"] !== undefined) continue;
      return true;
    }
    if (branches !== undefined) {
      const list = stringList(branches);
      if (list === null) return true;
      // Narrow only when no pattern could name a shared branch.
      if (list.some((pattern) => WIDELY_READABLE_BRANCHES.some((branch) => patternCouldMatch(pattern, branch)))) {
        return true;
      }
      continue;
    }
    // `branches-ignore` alone: narrow only when BOTH shared branches are
    // certainly ignored. An unmodelled pattern proves nothing, so it does not
    // count as an exclusion -- the earlier version had this backwards and let
    // `branches-ignore: ['feat*ure']` read as excluding main and develop.
    const list = stringList(ignored);
    if (list === null) return true;
    const allExcluded = WIDELY_READABLE_BRANCHES.every((branch) =>
      list.some((pattern) => patternCertainlyMatches(pattern, branch)),
    );
    if (!allExcluded) return true;
  }
  return false;
};

/**
 * The exact save conditions this policy accepts.
 *
 * A closed list rather than an analysis, after two attempts at the latter were
 * both wrong. Looking for `github.event_name` or `github.ref` in the text
 * accepted `github.event_name == 'schedule'`. Requiring the pull-request
 * comparison as a substring with no `!` and no `||` accepted
 * `(github.event_name == 'pull_request') == false`, which is true on a
 * schedule. Independent review caught each in turn.
 *
 * Writing a GitHub expression evaluator to settle this would be a third
 * attempt at the same mistake. These are the forms a cache save needs; a
 * workflow wanting another one is a change to this list, reviewed, rather
 * than a string this module tries to reason about.
 */
export const ALLOWED_SAVE_CONDITIONS = [
  "github.event_name == 'pull_request'",
  'github.event_name == "pull_request"',
  "success() && github.event_name == 'pull_request'",
  "github.event_name == 'pull_request' && success()",
];

/**
 * Whether a save step's condition is one of the accepted forms.
 *
 * Whitespace is normalised and a wrapping `${{ }}` is stripped, because those
 * are formatting rather than meaning. Nothing else is interpreted.
 */
export const saveConditionKeepsToPullRequest = (condition) => {
  if (typeof condition !== "string") return false;
  let normalised = condition.replace(/\s+/g, " ").trim();
  const wrapped = /^\$\{\{(.*)\}\}$/.exec(normalised);
  if (wrapped) normalised = wrapped[1].replace(/\s+/g, " ").trim();
  return ALLOWED_SAVE_CONDITIONS.includes(normalised);
};

/**
 * Whether a `pull_request` trigger exists and every activity type is narrow.
 *
 * A save guarded by `github.event_name == 'pull_request'` only keeps to the
 * merge ref if the workflow's own `pull_request` trigger cannot fire on an
 * activity whose run carries something else. With `types: [closed]` the guard
 * is true on a merged pull request, and that run is not one this module will
 * claim is on the merge ref. Independent review caught the combination.
 */
export const hasOnlyNarrowPullRequestTrigger = (document) => {
  const on = document?.on ?? document?.true;
  if (typeof on === "string") return on === "pull_request";
  if (Array.isArray(on)) return on.includes("pull_request") && on.every((event) => event === "pull_request");
  if (!isObj(on)) return false;
  if (!Object.prototype.hasOwnProperty.call(on, "pull_request")) return false;
  const filter = on.pull_request;
  if (filter === null || filter === undefined) return true;
  if (!isObj(filter)) return false;
  if (filter.types === undefined) return true;
  const types = stringList(filter.types);
  if (types === null || types.length === 0) return false;
  return types.every((type) => NARROW_PULL_REQUEST_TYPES.has(type));
};

/**
 * Expressions a restore-key may contain.
 *
 * The cross-workflow prefix rule compares key text, so an expression whose
 * value this cannot predict breaks the comparison: a restore-key of
 * `...-v2-pr-${{ matrix.lane }}-` reaches `...-v2-pr-admin-...` when the lane
 * is `admin`, and `startsWith` on the raw text sees nothing. Independent review
 * caught it. `runner.os` and `hashFiles(...)` are allowed because identical
 * text means an identical value, which is what the comparison needs.
 */
const PREDICTABLE_EXPRESSION = /^\s*(?:runner\.os|hashFiles\([^)]*\))\s*$/;

const unpredictableExpressions = (text) =>
  [...text.matchAll(/\$\{\{([^}]*)\}\}/g)]
    .map((match) => match[1])
    .filter((inner) => !PREDICTABLE_EXPRESSION.test(inner));

/**
 * Every cache step in a workflow, as {jobId, path, key, restoreKeys, mode}.
 *
 * `mode` separates the three actions: a `save` step declares no restore-keys
 * and a `restore` step writes nothing, and the rules below differ for them.
 */
export const readCacheSteps = (text) => {
  let document;
  try {
    document = parseYaml(text, { uniqueKeys: true, merge: false });
  } catch (error) {
    return { problem: `yaml_unparseable: ${error.message}` };
  }
  if (!isObj(document) || !isObj(document.jobs)) return { problem: "no_jobs" };

  const steps = [];
  for (const [jobId, job] of Object.entries(document.jobs)) {
    if (!isObj(job) || !Array.isArray(job.steps)) continue;
    for (const step of job.steps) {
      if (!isObj(step) || typeof step.uses !== "string") continue;
      const match = CACHE_ACTION.exec(step.uses.trim());
      if (!match) continue;
      const mode = match[1] ?? "cache";
      const withBlock = isObj(step.with) ? step.with : {};
      const paths = stringList(withBlock.path);
      const restoreKeys = stringList(withBlock["restore-keys"]);
      if (paths === null) return { problem: `${jobId}: path_unreadable` };
      if (restoreKeys === null) return { problem: `${jobId}: restore_keys_unreadable` };
      steps.push({
        jobId,
        name: typeof step.name === "string" ? step.name : null,
        mode,
        paths,
        key: typeof withBlock.key === "string" ? withBlock.key.trim() : null,
        restoreKeys,
        condition: typeof step.if === "string" ? step.if.trim() : step.if === undefined ? null : "",
      });
    }
  }
  return {
    steps,
    widelyReadable: reachesWidelyReadableScope(document),
    narrowPullRequestTrigger: hasOnlyNarrowPullRequestTrigger(document),
  };
};

/** The family row a step's paths fall under, or null when none is governed. */
const familyFor = (paths) => {
  for (const candidate of CACHE_FAMILIES) {
    if (paths.includes(candidate.path)) return candidate;
  }
  return null;
};

/**
 * What a governed key must start with: `${{ runner.os }}-<family>-`.
 */
const familyPrefix = (family) => `${RUNNER_OS}-${family}-`;

/**
 * The literal `v<n>-<namespace>-` a governed key must carry after its family,
 * and the prefix a restore-key may therefore not be shorter than.
 *
 * It is read as the literal text between the family token and the key's first
 * `${{` expression, because that is exactly the part that identifies the
 * generation and the workflow; everything after it is a hash of inputs.
 *
 * Being longer than the family token is NOT enough. `Linux-next-v2-` is longer,
 * and is a prefix of this step's own key, and still matches every workflow's
 * entry one generation down -- which is the same shared pool the family-wide
 * fallback made, just harder to see. So the boundary is the namespace segment,
 * not a character count.
 *
 * Returns null when the key has no expression at all: the literal region cannot
 * be told apart from the whole key, so the caller requires the whole key.
 */
export const namespacePrefix = (key, family) => {
  const prefix = familyPrefix(family);
  if (!key.startsWith(prefix)) return { prefix: null, problem: "key_missing_family_prefix" };
  const rest = key.slice(prefix.length);
  const expression = rest.indexOf("${{");
  const literal = expression === -1 ? rest : rest.slice(0, expression);
  if (!/^v\d+-[a-z0-9][a-z0-9-]*-$/.test(literal)) {
    return { prefix: null, problem: "key_missing_generation_and_namespace" };
  }
  return { prefix: prefix + literal, problem: null };
};

/**
 * Judges the cache keys across a set of workflows.
 *
 * The rules, each from a finding:
 *
 * - `restore_key_not_a_prefix` -- a restore-key that is not a prefix of its own
 *   step's key cannot be a narrower fallback for that step; it is reaching for
 *   somebody else's entry.
 * - `restore_key_broader_than_namespace` -- a restore-key shorter than its own
 *   key's `<os>-<family>-v<n>-<namespace>-` matches other workflows' entries,
 *   which is F2. Being longer than `<os>-<family>-` is not enough: an earlier
 *   version of this module allowed `Linux-next-v2-`, which is a prefix of its
 *   own key and still reaches every namespace one generation down. Independent
 *   review caught that, and a test had been written to permit it.
 * - `key_missing_generation_and_namespace` -- a governed key whose literal
 *   region before its first expression is not `v<n>-<namespace>-`. The rule
 *   above needs that boundary to exist, and `v<n>` is what lets a poisoned
 *   generation be abandoned without deleting entries by hand.
 * - `key_shared_across_workflows` -- one exact key declared by two workflow
 *   files is one entry those workflows share, so whichever writes it first in a
 *   scope every run can see owns what the others execute (F1). Sharing inside
 *   one workflow is fine: its jobs are one unit of trust.
 * - `unguarded_save_in_widely_readable_scope` -- a workflow that can run on the
 *   default branch or on `develop` must not use the combined `actions/cache`,
 *   whose post step writes, and a `save` step there must state the condition
 *   that keeps it to a pull-request run. Restoring is not the write; the write
 *   is what makes one run's output every later run's input (P1).
 *
 * The prefix and sharing rules apply to every cached path. The namespace rules
 * need CACHE_FAMILIES because only a listed family has a namespace to require,
 * and the save rule applies to every path for the same reason as sharing: the
 * scope is a property of the run, not of what is being cached.
 */
export const judgeCacheKeys = (sources) => {
  const findings = [];
  const problems = [];
  const keyOwners = new Map();
  /** Every restore-key with where it was declared, for the cross-workflow rule below. */
  const restoreProbes = [];

  for (const source of sources) {
    const read = readCacheSteps(source.text);
    if (read.problem) {
      problems.push({ workflowPath: source.path, problem: read.problem });
      continue;
    }
    for (const step of read.steps) {
      const family = familyFor(step.paths);

      if (step.mode !== "save" && step.key === null) {
        problems.push({ workflowPath: source.path, problem: `${step.jobId}: key_missing` });
        continue;
      }

      if (read.widelyReadable && step.mode !== "restore") {
        // A combined step cannot be guarded: its post step decides on its own.
        // A split save can be, by one of the accepted conditions -- and only if
        // this workflow's own `pull_request` trigger cannot fire on an activity
        // whose run is not on the merge ref. `types: [closed]` with an
        // event_name guard satisfies the condition and still writes from a
        // merged pull request, which is why both halves are required.
        const conditionOk = step.mode === "save" && saveConditionKeepsToPullRequest(step.condition);
        const guarded = conditionOk && read.narrowPullRequestTrigger;
        if (!guarded) {
          findings.push({
            rule: "unguarded_save_in_widely_readable_scope",
            workflowPath: source.path,
            jobId: step.jobId,
            detail:
              step.mode !== "save"
                ? "actions/cache (combined)"
                : conditionOk
                  ? "save guarded on pull_request, but this workflow's pull_request trigger is not narrow"
                  : `save if: ${step.condition ?? "(none)"}`,
          });
        }
      }

      for (const restoreKey of step.restoreKeys) {
        restoreProbes.push({ workflowPath: source.path, jobId: step.jobId, restoreKey });
        for (const expression of unpredictableExpressions(restoreKey)) {
          findings.push({
            rule: "restore_key_has_unpredictable_expression",
            workflowPath: source.path,
            jobId: step.jobId,
            detail: `\${{${expression}}} in ${restoreKey}`,
          });
        }
        if (step.key !== null && !step.key.startsWith(restoreKey)) {
          findings.push({
            rule: "restore_key_not_a_prefix",
            workflowPath: source.path,
            jobId: step.jobId,
            detail: restoreKey,
          });
        }
        if (family !== null && step.key !== null) {
          const required = namespacePrefix(step.key, family.family);
          if (required.prefix === null) continue; // reported once below, not per restore-key
          if (restoreKey.length < required.prefix.length) {
            findings.push({
              rule: "restore_key_broader_than_namespace",
              workflowPath: source.path,
              jobId: step.jobId,
              detail: `${restoreKey} (must start with ${required.prefix})`,
            });
          }
        }
      }

      if (family !== null && step.key !== null) {
        const required = namespacePrefix(step.key, family.family);
        if (required.prefix === null) {
          findings.push({
            rule: required.problem,
            workflowPath: source.path,
            jobId: step.jobId,
            detail: step.key,
          });
        }
      }

      if (step.key !== null) {
        const owners = keyOwners.get(step.key) ?? new Set();
        owners.add(source.path);
        keyOwners.set(step.key, owners);
      }
    }
  }

  for (const [key, owners] of keyOwners) {
    if (owners.size < 2) continue;
    findings.push({
      rule: "key_shared_across_workflows",
      workflowPath: [...owners].sort().join(", "),
      jobId: null,
      detail: key,
    });
  }

  // The rule that actually answers "can this workflow restore another's entry".
  //
  // Comparing namespaces was not enough, and the local namespace rule is not
  // enough either. `Linux-next-v2-pr-` is a legitimate restore-key for a key
  // whose namespace is `pr`, and it is also a prefix of a key whose namespace
  // is `pr-admin`; and a key of `...-v2-pr-${{ matrix.lane }}-...` has its own
  // namespace end at `pr-`, which collides the same way. Independent review
  // raised both. Rather than model namespaces further, this asks the question
  // directly: a restore-key may not be a prefix of any key another workflow
  // declares. Within one workflow it may be -- its jobs are one unit of trust.
  for (const probe of restoreProbes) {
    for (const [key, owners] of keyOwners) {
      if (!key.startsWith(probe.restoreKey)) continue;
      const others = [...owners].filter((owner) => owner !== probe.workflowPath);
      if (others.length === 0) continue;
      findings.push({
        rule: "restore_key_reaches_another_workflow",
        workflowPath: probe.workflowPath,
        jobId: probe.jobId,
        detail: `${probe.restoreKey} also matches a key declared by ${others.sort().join(", ")}`,
      });
    }
  }

  findings.sort((a, b) =>
    `${a.rule}${a.workflowPath}${a.jobId ?? ""}${a.detail}`.localeCompare(
      `${b.rule}${b.workflowPath}${b.jobId ?? ""}${b.detail}`,
    ),
  );
  problems.sort((a, b) => `${a.workflowPath}${a.problem}`.localeCompare(`${b.workflowPath}${b.problem}`));
  return { findings, problems };
};

export const describeFinding = (finding) => {
  const where = finding.jobId === null ? finding.workflowPath : `${finding.workflowPath} # ${finding.jobId}`;
  switch (finding.rule) {
    case "restore_key_not_a_prefix":
      return `${where}: restore-key "${finding.detail}" is not a prefix of this step's own key, so it can only match another entry.`;
    case "restore_key_broader_than_namespace":
      return `${where}: restore-key "${finding.detail}" is broader than this step's own generation and namespace, so it matches other workflows' entries.`;
    case "key_missing_generation_and_namespace":
      return `${where}: key "${finding.detail}" must read <os>-<family>-v<n>-<namespace>- before its first expression, so a restore-key has a namespace boundary to stop at and a poisoned generation can be abandoned by bumping v<n>.`;
    case "restore_key_has_unpredictable_expression":
      return `${where}: restore-key contains ${finding.detail}, whose value this cannot predict, so whether it reaches another workflow's entry cannot be decided. A restore-key may use only runner.os and hashFiles().`;
    case "restore_key_reaches_another_workflow":
      return `${where}: ${finding.detail}. Give the two namespaces names where neither is a prefix of the other.`;
    case "key_missing_family_prefix":
      return `${where}: key "${finding.detail}" does not start with its cache family's prefix.`;
    case "key_shared_across_workflows":
      return `${where}: these workflows declare the same cache key "${finding.detail}", so they share one entry. Give each its own namespace segment.`;
    case "unguarded_save_in_widely_readable_scope":
      return `${where}: this workflow can run on ${WIDELY_READABLE_BRANCHES.join(" or ")}, where a written entry is restorable by every run that can see that scope — ${finding.detail}. Use actions/cache/restore, and if a save is needed give it an if: on github.event_name or github.ref.`;
    default:
      return `${where}: ${finding.rule} (${finding.detail})`;
  }
};
