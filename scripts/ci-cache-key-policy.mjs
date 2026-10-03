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
 * Why this module stopped comparing whole keys.
 *
 * Three rounds of review were spent trying to make a textual comparison of
 * keys sound, and it cannot be. `hashFiles('package-lock.json')` and
 * `hashFiles('./package-lock.json')` hash the same file through different
 * text; two different glob patterns can match the same files; and canonicalising
 * whitespace to make equal values equal text turned `hashFiles('a b.json')`
 * into `hashFiles('ab.json')`, inventing a collision between different files.
 * Text can neither prove nor disprove that two hash expressions agree.
 *
 * So the comparison moved to the part that needs no proving. A governed key is
 * `${{ runner.os }}-<family>-v<n>-<namespace>-` followed by hashes, and that
 * leading region is pure literal -- `key_missing_generation_and_namespace`
 * already requires it. If two workflows hold distinct namespaces and neither is
 * a prefix of the other, then every restore-key of one begins with its own
 * namespace and every key of the other begins with theirs, so no restore-key
 * can reach across. That holds whatever the hashes do, which is why the hashes
 * no longer need to be read at all.
 */

/** `${{ runner.os }}-<family>-`, tolerating whitespace inside the expression. */
const familyPrefixPattern = (family) => new RegExp(`^\\$\\{\\{\\s*runner\\.os\\s*\\}\\}-${family}-`);

/** A key as alternating literal and expression tokens. */
const tokenise = (key) => {
  const tokens = [];
  let index = 0;
  for (const match of key.matchAll(/\$\{\{([^}]*)\}\}/g)) {
    if (match.index > index) tokens.push({ kind: "literal", text: key.slice(index, match.index) });
    tokens.push({ kind: "expression", text: match[1].trim() });
    index = match.index + match[0].length;
  }
  if (index < key.length) tokens.push({ kind: "literal", text: key.slice(index) });
  return tokens;
};

/**
 * Could the restore-key `restoreKey` prefix the key `key` at run time?
 *
 * The answer this needs to be is sound in one direction: "no" must mean no.
 * "Yes" may be wrong, and a wrong yes is a finding to resolve rather than an
 * entry one workflow executes from another.
 *
 * So identical expression text counts as equal -- the same expression resolves
 * the same way -- and *different* expression text counts as unknown rather than
 * as different. That is the opposite of what an earlier version did: it
 * canonicalised whitespace to make equal values equal text, which made
 * `hashFiles('a b.json')` and `hashFiles('ab.json')` the same expression and
 * invented a collision between different files. Treating unequal text as
 * unknown costs a false positive at worst; treating it as unequal cost a false
 * negative, and both reviewers found one.
 *
 * Literal text is compared character by character, and a divergence inside it
 * is the proof that the answer is no -- which is what the namespace segment
 * exists to create.
 */
export const restoreKeyCouldPrefix = (restoreKey, key) => {
  const left = tokenise(restoreKey);
  const right = tokenise(key);
  let li = 0;
  let ri = 0;
  let lo = 0;
  let ro = 0;
  for (;;) {
    if (li >= left.length) return true; // the restore-key ran out: it is a prefix
    if (ri >= right.length) return false; // the key ran out first: cannot be a prefix
    const l = left[li];
    const r = right[ri];
    if (l.kind === "literal" && r.kind === "literal") {
      const lRest = l.text.slice(lo);
      const rRest = r.text.slice(ro);
      const shared = Math.min(lRest.length, rRest.length);
      if (lRest.slice(0, shared) !== rRest.slice(0, shared)) return false; // diverged in fixed text
      if (lRest.length <= rRest.length) {
        li += 1;
        lo = 0;
        ro += shared;
        if (ro >= r.text.length) {
          ri += 1;
          ro = 0;
        }
      } else {
        ri += 1;
        ro = 0;
        lo += shared;
      }
      continue;
    }
    if (l.kind === "expression" && r.kind === "expression") {
      // Identical text, identical value. Anything else is unknown, and unknown
      // resolves towards "could".
      if (l.text !== r.text) return true;
      li += 1;
      ri += 1;
      lo = 0;
      ro = 0;
      continue;
    }
    // One side is an expression where the other has literal text: what it
    // expands to is not known here.
    return true;
  }
};

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
        // Canonical for every comparison; the raw text is kept only so a
        // finding can quote what the author actually wrote.
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
 * The literal `v<n>-<namespace>-` a governed key carries after its family, and
 * the prefix a restore-key may therefore not be shorter than.
 *
 * It is the literal text between the family token and the key's first `${{`,
 * because that is exactly the part identifying the generation and the workflow.
 * Everything after it is a hash, and this module deliberately does not read
 * those -- see the note above `familyPrefixPattern`.
 *
 * Covering the family token is NOT enough. `Linux-next-v2-` covers it, is a
 * prefix of its own key, and still matches every workflow's entry one
 * generation down -- the same shared pool the family-wide fallback made, just
 * harder to see.
 *
 * `prefix` is the text as written, so a caller can compare it against the key
 * it came from. `identity` is `<family>:<literal>`, which is what two workflows
 * are compared on, and it carries no expression at all.
 */
export const namespacePrefix = (key, family) => {
  const match = familyPrefixPattern(family).exec(key);
  if (match === null) return { prefix: null, identity: null, problem: "key_missing_family_prefix" };
  const rest = key.slice(match[0].length);
  const expression = rest.indexOf("${{");
  const literal = expression === -1 ? rest : rest.slice(0, expression);
  if (!/^v\d+-[a-z0-9][a-z0-9-]*-$/.test(literal)) {
    return { prefix: null, identity: null, problem: "key_missing_generation_and_namespace" };
  }
  return { prefix: match[0] + literal, identity: `${family}:${literal}`, problem: null };
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
  /** Namespace identity -> the workflows declaring it, for the cross-workflow rules. */
  const namespaceOwners = new Map();
  /** Cached path with no family row -> the workflows using it. */
  const unGovernedPathOwners = new Map();
  /** Every restore-key with where it was declared, for the all-paths reach rule. */
  const restoreProbes = [];

  for (const source of sources) {
    const read = readCacheSteps(source.text);
    if (read.problem) {
      problems.push({ workflowPath: source.path, problem: read.problem });
      continue;
    }
    for (const step of read.steps) {
      const family = familyFor(step.paths);
      if (family === null) {
        for (const path of step.paths) {
          const owners = unGovernedPathOwners.get(path) ?? new Set();
          owners.add(source.path);
          unGovernedPathOwners.set(path, owners);
        }
      }

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
        } else {
          const owners = namespaceOwners.get(required.identity) ?? new Set();
          owners.add(source.path);
          namespaceOwners.set(required.identity, owners);
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

  // The rule that answers "can this workflow restore another's entry", decided
  // on the namespace rather than on the whole key.
  //
  // Every restore-key covers its own namespace prefix (the rule above) and
  // every key begins with its own (the rule before that). So if two workflows
  // hold namespaces that are distinct and where neither is a prefix of the
  // other, no restore-key of one can prefix a key of the other -- they diverge
  // at the namespace, whatever the hashes after it do. That is the whole
  // argument, and it needs none of the hash text, which is what three rounds of
  // review established cannot be compared soundly.
  //
  // Sharing inside one workflow stays legal: its jobs are one unit of trust.
  const namespaces = [...namespaceOwners].sort(([a], [b]) => a.localeCompare(b));

  // The rule that answers the reach question for EVERY restore-key, whatever
  // path its step caches.
  //
  // The cache is keyed by key alone -- the paths a step caches are not part of
  // the entry's identity -- so a step caching `node_modules` with a restore-key
  // of `${{ runner.os }}-next-v2-` reaches every governed `next` entry in every
  // other workflow. The namespace rules below cannot see that: they only
  // register keys whose step is on a governed path. Both reviewers found it
  // after an earlier version of this module deleted the all-paths rule and
  // replaced it with namespace comparison alone.
  for (const probe of restoreProbes) {
    for (const [key, owners] of keyOwners) {
      const others = [...owners].filter((owner) => owner !== probe.workflowPath);
      if (others.length === 0) continue;
      if (!restoreKeyCouldPrefix(probe.restoreKey, key)) continue;
      findings.push({
        rule: "restore_key_may_reach_another_workflow",
        workflowPath: probe.workflowPath,
        jobId: probe.jobId,
        detail: `"${probe.restoreKey}" could prefix a key declared by ${others.sort().join(", ")}`,
      });
    }
  }

  // A path with no family row has no namespace, so the namespace rules say
  // nothing about it. One workflow using such a path is fine; two means the
  // only thing standing between them is the rule above, which needs a
  // restore-key to fire. Give the path a CACHE_FAMILIES row and each workflow
  // its own namespace instead.
  for (const [path, owners] of unGovernedPathOwners) {
    if (owners.size < 2) continue;
    findings.push({
      rule: "ungoverned_path_shared_across_workflows",
      workflowPath: [...owners].sort().join(", "),
      jobId: null,
      detail: path,
    });
  }

  // One namespace held by two workflows is one shared pool.
  for (const [identity, owners] of namespaces) {
    if (owners.size < 2) continue;
    const [family, literal] = identity.split(":");
    findings.push({
      rule: "namespace_shared_across_workflows",
      workflowPath: [...owners].sort().join(", "),
      jobId: null,
      detail: `${family} namespace "${literal}"`,
    });
  }

  // One namespace a prefix of another's, across workflows: `pr` reaches
  // `pr-admin`, because a restore-key stopping at `pr-` prefixes a key
  // beginning `pr-admin-`.
  for (const [identity, owners] of namespaces) {
    const [family, literal] = identity.split(":");
    for (const [otherIdentity, otherOwners] of namespaces) {
      if (otherIdentity === identity) continue;
      const [otherFamily, otherLiteral] = otherIdentity.split(":");
      if (otherFamily !== family) continue;
      if (!otherLiteral.startsWith(literal)) continue;
      // A problem only if some workflow holding the shorter one is not the only
      // holder of the longer one -- otherwise it is one workflow's own two keys.
      const reaching = [...owners].filter((owner) => [...otherOwners].some((other) => other !== owner));
      if (reaching.length === 0) continue;
      findings.push({
        rule: "namespace_reaches_another_workflow",
        workflowPath: reaching.sort().join(", "),
        jobId: null,
        detail: `${family} namespace "${literal}" is a prefix of "${otherLiteral}", held by ${[...otherOwners].sort().join(", ")}`,
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
    case "restore_key_may_reach_another_workflow":
      return `${where}: ${finding.detail}. The cache is keyed by key alone, so the path a step caches does not separate it. Narrow the restore-key to this workflow own namespace.`;
    case "ungoverned_path_shared_across_workflows":
      return `${where}: these workflows both cache "${finding.detail}", which has no CACHE_FAMILIES row, so nothing here can say whether one's restore-key reaches the other's entry. Give the path a family row and each workflow its own namespace.`;
    case "namespace_shared_across_workflows":
      return `${where}: these workflows hold the same ${finding.detail}, so they share one pool of entries. Give each its own.`;
    case "namespace_reaches_another_workflow":
      return `${where}: ${finding.detail}. A restore-key stopping at the shorter namespace prefixes the longer one's keys. Rename so neither is a prefix of the other.`;
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
