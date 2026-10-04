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

/**
 * The four values GitHub accepts for `cache-mode`, and which of them can write.
 *
 * `cache-mode` is the only thing that takes a job's cache *write* capability
 * away: GitHub enforces it with a scoped cache token, and the runner publishes
 * the result as ACTIONS_CACHE_MODE. Choosing `actions/cache/restore` over the
 * combined action is a statement about one declared step, not about the token,
 * so a job that restores through a narrow action still holds a key with which
 * anything running in it -- a dependency's install script, a crate build
 * script, a `uses:` action -- can call the cache API directly and write any key
 * it likes. The key namespaces this file governs are not a permission
 * boundary; they only say which entry a *declared* step reaches.
 *
 * Omitting the key is not neutral: a trusted trigger (push, schedule,
 * workflow_dispatch and the rest) defaults to `write`.
 *
 * Reference: https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching
 */
export const CACHE_MODES = ["read", "write", "write-only", "none"];
export const NON_WRITE_CACHE_MODES = ["read", "none"];

/** Each capability as a verb, so a finding names exactly what it found. */
const CAPABILITY_WORDS = { restore: "restoring", save: "saving" };
const capabilityWords = (capabilities) => capabilities.map((name) => CAPABILITY_WORDS[name]).join(" and ");

/**
 * What each mode lets a job do, so "narrower" can be asked as a question.
 *
 * `read` and `write-only` grant different, non-overlapping things, which is why
 * the comparison is a subset test rather than a position on a scale -- GitHub's
 * own documentation makes the same point about a reusable workflow's caller.
 */
const CACHE_MODE_CAPABILITIES = {
  none: [],
  read: ["restore"],
  "write-only": ["save"],
  write: ["restore", "save"],
};

/** Where `cache-mode` is declared in a workflow, exactly as written. */
export const readCacheMode = (document) => {
  if (!isObj(document)) return { workflow: undefined, jobs: [] };
  const jobs = isObj(document.jobs) ? Object.entries(document.jobs) : [];
  return {
    workflow: document["cache-mode"],
    jobs: jobs
      .filter(([, job]) => isObj(job) && job["cache-mode"] !== undefined)
      .map(([jobId, job]) => [jobId, job["cache-mode"]]),
  };
};

/**
 * Why a workflow's `cache-mode` does not keep its cache token read-only.
 *
 * Only asked of a workflow that reaches a widely readable scope. A workflow
 * that can run only from a pull request is left alone: its writes land in
 * `refs/pull/<n>/merge`, which no other ref can restore, and requiring `read`
 * there would stop the entry its own later runs restore.
 *
 * The declaration is required at the *workflow* level rather than on each job,
 * because a job added later inherits the workflow value and a job-level
 * omission then cannot re-open writing by accident. A job may narrow it
 * further; it may not widen it, and `write-only` is a widening even though it
 * cannot restore.
 */
export const cacheModeFailures = (document) => {
  const declared = readCacheMode(document);
  const failures = [];
  const classify = (value) => {
    if (typeof value !== "string" || !CACHE_MODES.includes(value)) return "unknown";
    return NON_WRITE_CACHE_MODES.includes(value) ? "non_write" : "write_capable";
  };

  const workflowKind = declared.workflow === undefined ? "missing" : classify(declared.workflow);
  if (workflowKind !== "non_write") {
    failures.push({
      rule: "cache_mode_write_capable_in_widely_readable_scope",
      jobId: null,
      detail:
        workflowKind === "missing"
          ? "no workflow-level cache-mode, so a trusted trigger gets write by default"
          : `workflow-level cache-mode is ${JSON.stringify(declared.workflow)}`,
    });
  }
  // Being non-write is not the same as being narrower. `read` under a workflow
  // set to `none` turns restoring back on, which is an override rather than a
  // narrowing -- the only narrowing between two non-write modes is `none` under
  // `read`. So every valid value goes through the same subset test, and each
  // finding names the capabilities *this* pair would add and no others: two
  // rounds of independent review were spent on a detail and a message that
  // described a different case than the one they were printed for.
  for (const [jobId, value] of declared.jobs) {
    if (classify(value) === "unknown") {
      failures.push({
        rule: "cache_mode_unreadable_on_job",
        jobId,
        detail: `cache-mode is ${JSON.stringify(value)}`,
      });
      continue;
    }
    if (workflowKind !== "non_write") {
      // Nothing to subtract from: the workflow-level failure above already
      // names that, and a job value can only be reported on its own terms.
      if (classify(value) === "write_capable") {
        failures.push({
          rule: "cache_mode_widened_by_job",
          jobId,
          detail: `cache-mode is ${JSON.stringify(value)}, which grants ${capabilityWords(
            CACHE_MODE_CAPABILITIES[value],
          )}`,
        });
      }
      continue;
    }
    const allowed = CACHE_MODE_CAPABILITIES[declared.workflow];
    const widened = CACHE_MODE_CAPABILITIES[value].filter((capability) => !allowed.includes(capability));
    if (widened.length > 0) {
      failures.push({
        rule: "cache_mode_widened_by_job",
        jobId,
        detail: `cache-mode is ${JSON.stringify(value)} under a workflow set to ${JSON.stringify(
          declared.workflow,
        )}, which grants ${capabilityWords(widened)}`,
      });
    }
  }
  return failures;
};

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


/**
 * Why there is no key comparator here any more.
 *
 * Four rounds of review were spent on one, and each round found a new way it
 * was unsound. Canonicalising whitespace made `hashFiles('a b.json')` equal
 * `hashFiles('ab.json')`. Treating identical expression text as an identical
 * value is wrong across workflows, because `matrix`, `env` and `steps` are
 * workflow-local -- two workflows writing `${{ matrix.prefix }}` mean different
 * things. The `${{ ... }}` tokeniser mis-read a `}` inside a string literal. And
 * a leftover expression can evaluate to the empty string, so a key running out
 * first does not prove a restore-key is not its prefix.
 *
 * The pattern is not that each attempt was careless; it is that deciding
 * whether two arbitrary GitHub expressions can agree is not a thing to decide
 * here. So the need for it is removed instead: EVERY cache step's key must
 * begin `${{ runner.os }}-<family>-v<n>-<namespace>-`, where everything after
 * the leading expression is fixed text. Two workflows holding distinct,
 * non-prefixing namespaces then cannot reach one another, because each key and
 * each restore-key begins with its own namespace and they diverge inside text
 * that no expression can change. Nothing after the namespace needs reading.
 */

/**
 * `${{ runner.os }}-<family>-v<n>-<namespace>-` at the head of a key.
 *
 * Only that one spelling of the leading expression is accepted. GitHub also
 * evaluates `${{ runner['os'] }}` and other equivalents, and this refuses them
 * -- deliberately, and in the safe direction: a refusal asks the author to
 * write the ordinary form, where letting an unrecognised spelling through would
 * mean a head this cannot read being treated as one it can. One spelling also
 * keeps the namespace identities comparable without normalising anything, which
 * is the mistake four earlier rounds were spent on.
 *
 * Whitespace inside the expression is allowed, because it changes nothing about
 * what the expression is.
 */
const KEY_HEAD = /^\$\{\{\s*runner\.os\s*\}\}-([a-z0-9]+(?:-[a-z0-9]+)*?)-(v\d+)-([a-z0-9]+(?:-[a-z0-9]+)*)-/;

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
  const widelyReadable = reachesWidelyReadableScope(document);
  return {
    steps,
    widelyReadable,
    narrowPullRequestTrigger: hasOnlyNarrowPullRequestTrigger(document),
    // Asked of every workflow that reaches a shared scope, whether or not it
    // declares a cache step: the token is write-capable either way, and a
    // workflow that caches nothing today is exactly where an added step, or an
    // action that caches on its own, would start writing unnoticed.
    cacheModeFailures: widelyReadable ? cacheModeFailures(document) : [],
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
 * Reads a key's head: `${{ runner.os }}-<family>-v<n>-<namespace>-`.
 *
 * `prefix` is that head as written, so a caller can compare it against the key
 * it came from and against the step's restore-keys. `identity` is
 * `<family>:v<n>-<namespace>-`, which is what two workflows are compared on,
 * and it is fixed text -- no expression can appear inside it, which is the
 * whole reason the comparison needs nothing else (see the note above
 * `KEY_HEAD`). `family` is what the key declared, for a caller that wants to
 * report it.
 *
 * `expectedFamily` is the family CACHE_FAMILIES gives this step's path, or null
 * when no row names it. A path with no row declares its own family token and is
 * held to the same discipline; a listed path may not declare a different one.
 *
 * Covering the family token alone is NOT enough, and `restore_key_broader_than_namespace`
 * is what says so: `Linux-next-v2-` covers it, is a prefix of its own key, and
 * still matches every workflow's entry one generation down -- the same shared
 * pool the family-wide fallback made, just harder to see.
 */
export const namespacePrefix = (key, expectedFamily = null) => {
  const head = KEY_HEAD.exec(key);
  if (head === null) {
    return { prefix: null, identity: null, family: null, problem: "key_missing_generation_and_namespace" };
  }
  const [matched, family, generation, namespace] = head;
  // Nothing before the namespace may be an expression: the whole argument is
  // that this region is fixed text. `${{ runner.os }}` is the one exception,
  // and it sits at the very front where KEY_HEAD has already matched it.
  if (matched.slice(matched.indexOf("}}") + 2).includes("${{")) {
    return { prefix: null, identity: null, family: null, problem: "key_missing_generation_and_namespace" };
  }
  if (expectedFamily !== null && family !== expectedFamily) {
    return { prefix: null, identity: null, family, problem: "key_family_does_not_match_path" };
  }
  return {
    prefix: matched,
    identity: `${family}:${generation}-${namespace}-`,
    family,
    problem: null,
  };
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
 * - `key_missing_generation_and_namespace` -- a key that does not begin
 *   `${{ runner.os }}-<family>-v<n>-<namespace>-` in fixed text. The rule above
 *   needs that boundary to exist, `v<n>` is what lets a poisoned generation be
 *   abandoned without deleting entries by hand, and "fixed text" is what makes
 *   the whole argument hold without reading any expression.
 * - `key_family_does_not_match_path` -- a key naming a family that
 *   CACHE_FAMILIES does not give this step's path, which would take its
 *   namespace from another family's space.
 * - `key_shared_across_workflows` -- one exact key declared by two workflow
 *   files is one entry those workflows share, so whichever writes it first in a
 *   scope every run can see owns what the others execute (F1). Sharing inside
 *   one workflow is fine: its jobs are one unit of trust.
 * - `namespace_shared_across_workflows` and `namespace_reaches_another_workflow`
 *   -- two workflows holding one namespace, or one whose namespace is a prefix
 *   of another's. These are the rules that answer "can this workflow restore
 *   another's entry", and they answer it without reading a hash.
 * - `unguarded_save_in_widely_readable_scope` -- a workflow that can run on the
 *   default branch or on `develop` must not use the combined `actions/cache`,
 *   whose post step writes, and a `save` step there must state the condition
 *   that keeps it to a pull-request run. Restoring is not the write; the write
 *   is what makes one run's output every later run's input (P1).
 *
 * **Every rule applies to every cached path.** CACHE_FAMILIES decides only
 * which family token a listed path must declare; a path with no row declares
 * its own and is held to the same namespace discipline. Exempting unlisted
 * paths was a hole both reviewers of round 9 found: the cache is keyed by key
 * alone, so a step's paths never separated its entry from anyone else's, and
 * exempting a path exempted it from the rules rather than from the collision.
 */
export const judgeCacheKeys = (sources) => {
  const findings = [];
  const problems = [];
  const keyOwners = new Map();
  /** Namespace identity -> the workflows declaring it, for the cross-workflow rules. */
  const namespaceOwners = new Map();

  for (const source of sources) {
    const read = readCacheSteps(source.text);
    if (read.problem) {
      problems.push({ workflowPath: source.path, problem: read.problem });
      continue;
    }
    for (const failure of read.cacheModeFailures) {
      findings.push({ ...failure, workflowPath: source.path });
    }
    for (const step of read.steps) {
      // The family a listed path must declare. An unlisted path declares its own
      // family token and is held to the same namespace discipline -- the cache
      // is keyed by key alone, so a step's paths never separated it anyway.
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

      const parsed = step.key === null ? null : namespacePrefix(step.key, family === null ? null : family.family);

      for (const restoreKey of step.restoreKeys) {
        if (step.key !== null && !step.key.startsWith(restoreKey)) {
          findings.push({
            rule: "restore_key_not_a_prefix",
            workflowPath: source.path,
            jobId: step.jobId,
            detail: restoreKey,
          });
        }
        // Must cover its own namespace. With the rule above, that makes every
        // restore-key begin with its own `<family>-v<n>-<namespace>-`, which is
        // the whole of the cross-workflow argument.
        if (parsed !== null && parsed.prefix !== null && !restoreKey.startsWith(parsed.prefix)) {
          findings.push({
            rule: "restore_key_broader_than_namespace",
            workflowPath: source.path,
            jobId: step.jobId,
            detail: `${restoreKey} (must start with ${parsed.prefix})`,
          });
        }
      }

      if (parsed !== null) {
        if (parsed.prefix === null) {
          findings.push({
            rule: parsed.problem,
            workflowPath: source.path,
            jobId: step.jobId,
            detail: step.key,
          });
        } else {
          const owners = namespaceOwners.get(parsed.identity) ?? new Set();
          owners.add(source.path);
          namespaceOwners.set(parsed.identity, owners);
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

  // One key is read by both a restore and a save step in some workflows, so the
  // same finding can be raised twice. Report each once.
  const seen = new Set();
  const unique = findings.filter((finding) => {
    const identity = `${finding.rule}\u0000${finding.workflowPath}\u0000${finding.jobId ?? ""}\u0000${finding.detail}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  findings.length = 0;
  findings.push(...unique);

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
      return `${where}: key "${finding.detail}" must begin \${{ runner.os }}-<family>-v<n>-<namespace>- in fixed text, with no expression before the namespace. That head is what gives a restore-key a boundary to stop at and lets a poisoned generation be abandoned by bumping v<n>.`;
    case "key_family_does_not_match_path":
      return `${where}: key "${finding.detail}" names a family that CACHE_FAMILIES does not give this step's path, so it would take its namespace from another family's space.`;
    case "namespace_shared_across_workflows":
      return `${where}: these workflows hold the same ${finding.detail}, so they share one pool of entries. Give each its own.`;
    case "namespace_reaches_another_workflow":
      return `${where}: ${finding.detail}. A restore-key stopping at the shorter namespace prefixes the longer one's keys. Rename so neither is a prefix of the other.`;
    case "key_shared_across_workflows":
      return `${where}: these workflows declare the same cache key "${finding.detail}", so they share one entry. Give each its own namespace segment.`;
    case "cache_mode_write_capable_in_widely_readable_scope":
      return `${where}: this workflow can run on ${WIDELY_READABLE_BRANCHES.join(" or ")} and ${finding.detail}. Restore-only steps do not take that away: the job's token can still write any key through the cache API, so anything executing in the job can plant an entry a required gate restores. Declare cache-mode: ${NON_WRITE_CACHE_MODES.join(" or ")} at the workflow level.`;
    case "cache_mode_widened_by_job":
      return `${where}: ${finding.detail}. A job-level value replaces the workflow's rather than combining with it, so it may only take capability away -- what it grants has to be a subset of what the workflow granted. The detail above names what this one adds and nothing else. A job that needs no narrower mode is left without one, and inherits.`;
    case "cache_mode_unreadable_on_job":
      return `${where}: ${finding.detail}, which is not one of GitHub's four values (${CACHE_MODES.join(", ")}). It is refused because nothing can say what it grants, rather than for what it grants; an expression counts here, since the documented key takes a literal.`;
    case "unguarded_save_in_widely_readable_scope":
      return `${where}: this workflow can run on ${WIDELY_READABLE_BRANCHES.join(" or ")}, where a written entry is restorable by every run that can see that scope — ${finding.detail}. Use actions/cache/restore, and if a save is needed give it an if: on github.event_name or github.ref.`;
    default:
      return `${where}: ${finding.rule} (${finding.detail})`;
  }
};
