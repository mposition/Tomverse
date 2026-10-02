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
      });
    }
  }
  return { steps };
};

/** The family row a step's paths fall under, or null when none is governed. */
const familyFor = (paths) => {
  for (const candidate of CACHE_FAMILIES) {
    if (paths.includes(candidate.path)) return candidate;
  }
  return null;
};

/**
 * What a governed key must start with: `${{ runner.os }}-<family>-`. Anything
 * at exactly that length names the family and nothing else, which is the pool
 * every workflow would share.
 */
const familyPrefix = (family) => `${RUNNER_OS}-${family}-`;

/**
 * Judges the cache keys across a set of workflows.
 *
 * Three rules, each from a finding:
 *
 * - `restore_key_not_a_prefix` -- a restore-key that is not a prefix of its own
 *   step's key cannot be a narrower fallback for that step; it is reaching for
 *   somebody else's entry.
 * - `restore_key_names_only_the_family` -- a restore-key no longer than
 *   `<os>-<family>-` matches every workflow's entry in that family (F2).
 * - `key_shared_across_workflows` -- one exact key declared by two workflow
 *   files is one entry those workflows share, so whichever writes it first in a
 *   scope every run can see owns what the others execute (F1). Sharing inside
 *   one workflow is fine: its jobs are one unit of trust.
 */
export const judgeCacheKeys = (sources) => {
  const findings = [];
  const problems = [];
  const keyOwners = new Map();

  for (const source of sources) {
    const read = readCacheSteps(source.text);
    if (read.problem) {
      problems.push({ workflowPath: source.path, problem: read.problem });
      continue;
    }
    for (const step of read.steps) {
      const family = familyFor(step.paths);
      if (family === null) continue;
      const prefix = familyPrefix(family.family);

      if (step.mode !== "save" && step.key === null) {
        problems.push({ workflowPath: source.path, problem: `${step.jobId}: key_missing` });
        continue;
      }

      for (const restoreKey of step.restoreKeys) {
        if (step.key !== null && !step.key.startsWith(restoreKey)) {
          findings.push({
            rule: "restore_key_not_a_prefix",
            workflowPath: source.path,
            jobId: step.jobId,
            detail: restoreKey,
          });
        }
        if (restoreKey.length <= prefix.length && prefix.startsWith(restoreKey)) {
          findings.push({
            rule: "restore_key_names_only_the_family",
            workflowPath: source.path,
            jobId: step.jobId,
            detail: restoreKey,
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
    case "restore_key_names_only_the_family":
      return `${where}: restore-key "${finding.detail}" names the cache family and nothing else, so it matches every workflow's entry in it. Keep the namespace segment.`;
    case "key_shared_across_workflows":
      return `${where}: these workflows declare the same cache key "${finding.detail}", so they share one entry. Give each its own namespace segment.`;
    default:
      return `${where}: ${finding.rule} (${finding.detail})`;
  }
};
