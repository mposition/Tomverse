/**
 * The rulesets the merge lane needs before it may run (docs/policy/
 * qa-release-agent.md version 7, section 8 items 7 and 9), as the exact
 * request bodies of `POST /repos/{owner}/{repo}/rulesets`.
 *
 * - "update outside develop": every branch but develop refuses updates and
 *   creations from anyone not on the bypass list. The lane's App is never on
 *   it, so the App cannot touch main or move a pull request's base.
 * - "develop pull requests": develop takes changes only through a pull
 *   request (no approvals required), so the App cannot push to develop
 *   directly; only the repository admin role bypasses it.
 *
 * The same bodies, pointed at test branches instead, are what the S-M0 test
 * observations run against (item 10), so the observed protection and the
 * applied one cannot drift apart: one builder makes both.
 *
 * Pure. The bypass list beyond the admin role is the operator's decision
 * after the observations (item 7); these builders refuse a list that holds
 * the lane's own App.
 */
import { createHash } from "node:crypto";

/** GitHub's built-in repository role ids for ruleset bypass: 5 is "admin". */
export const QA_RELEASE_REPOSITORY_ADMIN_ROLE_ID = 5;

/**
 * Automation that updates branches and can bypass the update ruleset
 * (item 7). Ids read from `GET /apps/{slug}` on 2026-10-07.
 *
 * Workflows that push with GH_AUTOMATION_PAT act as the account, which the
 * admin role already covers. GitHub Actions (app 15368) is not a candidate:
 * on this personal-account repository GitHub refuses it as a bypass actor
 * ("must be part of the ruleset source or owner organization", seen
 * 2026-10-08), so visual-baseline-record pushes its review branch with the PAT
 * instead. Dependabot opens and updates its own branches and was accepted.
 */
export const QA_RELEASE_BYPASS_CANDIDATES = Object.freeze([
  Object.freeze({
    appId: 29110,
    slug: "dependabot",
    botLogin: "dependabot[bot]",
    branchPattern: "dependabot/**",
    reason: "Dependabot creates and updates its own branches",
  }),
]);

export const QA_RELEASE_UPDATE_RULESET_NAME = "qa-release-lane: no updates outside develop";
export const QA_RELEASE_DEVELOP_RULESET_NAME = "qa-release-lane: develop through pull requests";
/** The exact names the test rulesets carry; teardown removes these and nothing else. */
export const QA_RELEASE_TEST_RULESET_NAMES = Object.freeze([
  `${QA_RELEASE_UPDATE_RULESET_NAME} (test)`,
  `${QA_RELEASE_DEVELOP_RULESET_NAME} (test)`,
]);
export const QA_RELEASE_TEST_PREFIX = "qa-lane-test/";

/**
 * The branches of the bypass automation that the test update ruleset also
 * covers, so the observations see each listed App update a branch the
 * ruleset applies to (item 7: the automation's branch updates succeed). Only
 * a candidate's own branch pattern may be named, and only while its App is
 * on the bypass list.
 */
export function qaReleaseAutomationRefs(bypassAppIds: readonly number[]): string[] {
  return QA_RELEASE_BYPASS_CANDIDATES.filter((candidate) => bypassAppIds.includes(candidate.appId))
    .map((candidate) => `refs/heads/${candidate.branchPattern}`)
    .sort();
}

export type QaReleaseRulesetBody = {
  name: string;
  target: "branch";
  enforcement: "active";
  conditions: { ref_name: { include: string[]; exclude: string[] } };
  rules: Array<{ type: string; parameters?: Record<string, unknown> }>;
  bypass_actors: Array<{ actor_id: number; actor_type: "RepositoryRole" | "Integration"; bypass_mode: "always" }>;
};

export type QaReleaseRulesetScope =
  | { kind: "real" }
  /** The test branches of the observations: their full names. */
  | { kind: "test"; updateBranches: string[]; developBranch: string };

const ref = (branch: string) => `refs/heads/${branch}`;
const TEST_BRANCH = /^qa-lane-test\/[a-z0-9][a-z0-9-]{0,48}$/;

const adminBypass = { actor_id: QA_RELEASE_REPOSITORY_ADMIN_ROLE_ID, actor_type: "RepositoryRole" as const, bypass_mode: "always" as const };

/** Both ruleset bodies for one scope, with the operator's bypass apps. */
export function qaReleaseLaneRulesets(input: {
  scope: QaReleaseRulesetScope;
  bypassAppIds: readonly number[];
  laneAppId: number;
}): { update: QaReleaseRulesetBody; develop: QaReleaseRulesetBody } {
  const { scope, laneAppId } = input;
  if (!Number.isSafeInteger(laneAppId) || laneAppId <= 0) throw new Error("lane_app_id_invalid");
  const apps = [...new Set(input.bypassAppIds)].sort((a, b) => a - b);
  if (apps.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error("bypass_app_id_invalid");
  // The point of the update ruleset is that this App is not exempt from it.
  if (apps.includes(laneAppId)) throw new Error("lane_app_in_bypass");

  let updateInclude: string[];
  let updateExclude: string[];
  let developInclude: string[];
  let suffix = "";
  if (scope.kind === "real") {
    updateInclude = ["~ALL"];
    updateExclude = [ref("develop")];
    developInclude = [ref("develop")];
  } else {
    const names = [...scope.updateBranches, scope.developBranch];
    if (names.length < 2 || !names.every((name) => TEST_BRANCH.test(name)) || new Set(names).size !== names.length) {
      throw new Error("test_branches_invalid");
    }
    // The bypass automation's own branches too, so its updates under the
    // ruleset can be observed (item 7).
    updateInclude = [...scope.updateBranches.map(ref), ...qaReleaseAutomationRefs(apps)].sort();
    updateExclude = [];
    developInclude = [ref(scope.developBranch)];
    suffix = " (test)";
  }

  return {
    update: {
      name: QA_RELEASE_UPDATE_RULESET_NAME + suffix,
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: updateInclude, exclude: updateExclude } },
      // The App never creates a branch, so creation is restricted with updates.
      rules: [{ type: "creation" }, { type: "update", parameters: { update_allows_fetch_and_merge: false } }],
      bypass_actors: [adminBypass, ...apps.map((id) => ({ actor_id: id, actor_type: "Integration" as const, bypass_mode: "always" as const }))],
    },
    develop: {
      name: QA_RELEASE_DEVELOP_RULESET_NAME + suffix,
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: developInclude, exclude: [] } },
      // Zero approvals (item 10, version 4): the rule exists to refuse a direct
      // push, not to require a review the lane cannot give. Every parameter
      // GitHub stores is named, because one left out is filled with GitHub's
      // default -- and that default for unattributed changes (read back on
      // 2026-10-08) is an extra approval, which zero approvals rules out.
      rules: [
        {
          type: "pull_request",
          parameters: {
            allowed_merge_methods: ["merge", "squash", "rebase"],
            dismiss_stale_reviews_on_push: false,
            require_code_owner_review: false,
            require_extra_approval_for_unattributed_changes: false,
            require_last_push_approval: false,
            required_approving_review_count: 0,
            required_review_thread_resolution: false,
            required_reviewers: [],
          },
        },
      ],
      // Item 9: the admin role only.
      bypass_actors: [adminBypass],
    },
  };
}

/**
 * Rules in a form where what was sent and what GitHub stored compare equal
 * when they mean the same: sorted by type, and the update rule's one
 * parameter, which GitHub omits when it is false (read back on 2026-10-08),
 * treated as absent when false. Every other parameter is compared as given.
 */
export function qaReleaseComparableRules(rules: readonly { type: string; parameters?: unknown }[] | null | undefined) {
  return [...(rules ?? [])]
    .map((rule) => {
      const parameters = rule.parameters ?? null;
      if (rule.type === "update") {
        const fetchAndMerge = parameters && typeof parameters === "object" ? (parameters as Record<string, unknown>).update_allows_fetch_and_merge : undefined;
        const others = parameters && typeof parameters === "object" ? Object.keys(parameters).filter((key) => key !== "update_allows_fetch_and_merge") : [];
        if ((fetchAndMerge === undefined || fetchAndMerge === false) && others.length === 0) return { type: "update", parameters: null };
      }
      return { type: rule.type, parameters };
    })
    .sort((a, b) => a.type.localeCompare(b.type));
}

type Json = Record<string, unknown>;
const asRecord = (value: unknown): Json | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;

/** Stable JSON: object keys sorted at every depth. */
const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Json)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Json)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
};

/**
 * Whether a step can update a branch: a non-comment script line naming both
 * `git` and `push` (which also catches `VAR=x git push`, `command git push`,
 * `/usr/bin/git push` and `bash -c "git push ..."`), a `gh pr merge` or a
 * `gh api` call on refs or merges, or an action whose name says it pushes.
 * Deliberately broad: a step it flags that does not push only needs a review.
 */
export function qaReleaseStepMayUpdateBranch(step: unknown): boolean {
  const record = asRecord(step) ?? {};
  if (typeof record.uses === "string" && /push|auto-commit|create-pull-request|merge/i.test(record.uses)) return true;
  if (typeof record.run !== "string") return false;
  return record.run.split("\n").some((raw) => {
    const line = raw.trim();
    if (line.startsWith("#")) return false;
    return (/\bgit\b/.test(line) && /\bpush\b/.test(line)) || /\bgh\s+pr\s+merge\b/.test(line) || (/\bgh\s+api\b/.test(line) && /(refs|merges)\b/.test(line));
  });
}

/**
 * The digest a person reviews for one branch-updating step: the step itself
 * with everything that decides which credential its commands use -- the
 * workflow's and job's env, the job's `if`, and every checkout step in the
 * job (its `with` and `if`). Any change to any of them is a new digest.
 */
export function qaReleasePushStepDigest(workflow: unknown, jobId: string, stepIndex: number): string {
  const root = asRecord(workflow) ?? {};
  const job = asRecord(asRecord(root.jobs)?.[jobId]) ?? {};
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const material = {
    workflowEnv: root.env ?? null,
    jobEnv: job.env ?? null,
    jobIf: job.if ?? null,
    checkouts: steps
      .map((raw) => asRecord(raw) ?? {})
      .filter((step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"))
      .map((step) => ({ with: step.with ?? null, if: step.if ?? null })),
    step: steps[stepIndex] ?? null,
  };
  return createHash("sha256").update(stableJson(material), "utf8").digest("hex");
}

/**
 * The branch-updating steps a person has read and found to authenticate with
 * GH_AUTOMATION_PAT (repository admin) or to push nothing, by workflow, job,
 * step index and digest. Reviewed on 2026-10-08 against develop and main
 * (a branch's own version of a step is its own entry). Adding or
 * changing an entry is a change a reviewer reads; a step not listed here,
 * or listed with another digest, refuses the real rulesets.
 */
export const QA_RELEASE_REVIEWED_PUSH_STEPS: readonly { path: string; job: string; step: number; sha256: string; why: string }[] = Object.freeze([
  Object.freeze({
    path: ".github/workflows/back-merge-main-to-develop.yml",
    job: "back-merge",
    step: 6,
    sha256: "a66d39957f6ae6245e89c75314d2a568dd4803a0419c9a349c64684d00ad9592",
    why: "git push origin develop; the job checkout keeps GH_AUTOMATION_PAT as origin credential",
  }),
  Object.freeze({
    path: ".github/workflows/back-merge-main-to-develop.yml",
    job: "back-merge",
    step: 7,
    sha256: "ab70d297b2d69710dcd7d4a3663a1ae75eec98abdb5e0af370c6992be9b16242",
    why: "git push -u origin branch; same checkout credential",
  }),
  Object.freeze({
    path: ".github/workflows/cron-auto-fix.yml",
    job: "attempt-fix",
    step: 18,
    sha256: "baa3471a9078c07b259a424fe926dc36020086e72c9de1827a1ea29a6f2a3646",
    why: "gh auth setup-git in the same step with GH_TOKEN the PAT, then git push origin",
  }),
  Object.freeze({
    path: ".github/workflows/cron-auto-fix.yml",
    job: "attempt-fix",
    step: 18,
    sha256: "fc2f35e999323a753c409de42eb377a65f009a2af54d7eea3ed617fb04db6450",
    why: "main version of the same step: gh auth setup-git with GH_TOKEN the PAT, then git push origin and gh pr merge --auto, all as the PAT",
  }),
  Object.freeze({
    path: ".github/workflows/feedback-autofix-promotion-pr.yml",
    job: "promotion-pr",
    step: 8,
    sha256: "85815692015c9a0f16b4ae8ea673b32d8b2eb41202fab00eefe52dcdc546f998",
    why: "git push to the x-access-token URL of GH_TOKEN, the PAT",
  }),
  Object.freeze({
    path: ".github/workflows/feedback-autofix.yml",
    job: "attempt-fix",
    step: 11,
    sha256: "47b779bfe76794714a56f2c5f976c7684a62d96e33738c0b534f866e5cea2d12",
    why: "git remote set-url origin to the PAT URL in the same step, then git push origin",
  }),
  Object.freeze({
    path: ".github/workflows/visual-baseline-record.yml",
    job: "record",
    step: 10,
    sha256: "e20aa7c1c05a9d3a853e33282254ec0e1fccde5d5a1ab1e95d376c45441f0126",
    why: "git push to the x-access-token URL of GH_TOKEN, the PAT (the version that pushes with the PAT)",
  }),
]);

/**
 * Every branch-updating step in the workflows that is not a reviewed one, as
 * `path#job/step sha256`. Applied, the update ruleset refuses workflow-token
 * updates to every branch but develop (GitHub Actions cannot be on its bypass
 * list here), so the real-ruleset step refuses while any is listed.
 *
 * Shell is not interpreted: whether a push uses the PAT is a person's reading
 * of the exact step, pinned by its digest. An unreadable workflow is listed.
 *
 * Pure but for hashing: the caller parses each workflow (the `yaml` package)
 * and passes the object, or null when it could not.
 */
export function qaReleaseWorkflowTokenPushers(
  files: readonly { path: string; workflow: unknown }[],
  reviewed: readonly { path: string; job: string; step: number; sha256: string }[] = QA_RELEASE_REVIEWED_PUSH_STEPS,
): string[] {
  const unsafe: string[] = [];
  for (const { path, workflow } of files) {
    const jobs = asRecord(asRecord(workflow)?.jobs);
    if (!jobs) {
      unsafe.push(`${path}#unreadable`);
      continue;
    }
    for (const [jobId, rawJob] of Object.entries(jobs)) {
      const steps = Array.isArray(asRecord(rawJob)?.steps) ? (asRecord(rawJob)?.steps as unknown[]) : [];
      steps.forEach((step, index) => {
        if (!qaReleaseStepMayUpdateBranch(step)) return;
        const sha256 = qaReleasePushStepDigest(workflow, jobId, index);
        const known = reviewed.some((entry) => entry.path === path && entry.job === jobId && entry.step === index && entry.sha256 === sha256);
        if (!known) unsafe.push(`${path}#${jobId}/${index} ${sha256}`);
      });
    }
  }
  return [...new Set(unsafe)].sort();
}
