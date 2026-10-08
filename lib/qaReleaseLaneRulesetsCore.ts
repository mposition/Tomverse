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

import { parseDocument, visit } from "yaml";

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

/** Whether a `permissions` value gives the workflow token write access to contents. */
const contentsWrite = (permissions: unknown): boolean => {
  if (permissions === "write-all") return true;
  const record = asRecord(permissions);
  return record !== null && record.contents === "write";
};

/**
 * The secrets a workflow may use without its file being reviewed, because
 * none is a credential that could update a branch past the lane rulesets:
 * GH_AUTOMATION_PAT acts as the repository admin, which the rulesets' bypass
 * list holds; the rest are alert webhooks, mail settings, model and price API
 * keys, and the app's own sync secrets. Read on 2026-10-08 from every
 * workflow on develop and main. Inside an expression, the secrets context is
 * harmless only as `secrets.NAME` with NAME here. A name not here -- a GitHub
 * App key minted into a token by any action, a deploy key, a second PAT --
 * lists the workflow for a whole-file review, and so does any use that could
 * reach every secret: the bare object (`toJSON(secrets)`, a function
 * argument, `secrets[...]`) or a job's `secrets` key handing them to a
 * called workflow (`inherit` or a mapping, however the YAML spells it).
 */
export const QA_RELEASE_NON_BRANCH_SECRETS: readonly string[] = Object.freeze([
  "ADMIN_ALERT_EMAIL",
  "ANTHROPIC_API_KEY",
  "AUTO_FIX_SYNC_SECRET",
  "DEEPSEEK_API_KEY",
  "FAL_KEY",
  "FEEDBACK_AUTOFIX_ANTHROPIC_API_KEY",
  "FEEDBACK_AUTOFIX_SYNC_SECRET",
  "GH_AUTOMATION_PAT",
  "GITHUB_TOKEN",
  "OPENAI_API_KEY",
  "OPS_ALERT_EMAIL",
  "OPS_ALERT_SLACK_WEBHOOK_URL",
  "RELEASE_LANE_ALERT_SLACK_WEBHOOK_URL",
  "RESEND_API_KEY",
  "SECURITY_AUDIT_EMAILS",
  "SECURITY_AUDIT_SLACK_WEBHOOK_URL",
  "SLACK_WEBHOOK_URL",
]);

/**
 * Where Actions evaluates the `secrets` context: inside `${{ }}` anywhere in
 * the file, and in every job and step `if`, whose condition may be written
 * without the braces and over several lines -- read from the parsed workflow,
 * not from text lines.
 */
const expressionTexts = (text: string, workflow: unknown): string[] => {
  const expressions = [...text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((match) => match[1]);
  for (const rawJob of Object.values(asRecord(asRecord(workflow)?.jobs) ?? {})) {
    const job = asRecord(rawJob) ?? {};
    if (typeof job.if === "string") expressions.push(job.if);
    for (const rawStep of Array.isArray(job.steps) ? job.steps : []) {
      const step = asRecord(rawStep) ?? {};
      if (typeof step.if === "string") expressions.push(step.if);
    }
  }
  return expressions;
};

/**
 * The other-credential reasons in a workflow, empty when there are none (see
 * QA_RELEASE_NON_BRANCH_SECRETS for the rule).
 */
const otherCredentials = (text: string, workflow: unknown): string[] => {
  const reasons = new Set<string>();
  for (const expression of expressionTexts(text, workflow)) {
    for (const match of expression.matchAll(/\bsecrets\b(\s*\.\s*([A-Za-z0-9_]+))?/g)) {
      const name = match[2];
      if (!name) reasons.add("secrets object");
      else if (!QA_RELEASE_NON_BRANCH_SECRETS.includes(name)) reasons.add(`secret ${name}`);
    }
  }
  // A job's `secrets` key, read from the parse whatever its quoting or flow
  // style, hands secrets to the workflow it calls.
  for (const [jobId, rawJob] of Object.entries(asRecord(asRecord(workflow)?.jobs) ?? {})) {
    if (asRecord(rawJob)?.secrets !== undefined) reasons.add(`${jobId}: secrets passed to a called workflow`);
  }
  // A token minted from a key the workflow reads some other way.
  if (/github-app-token|\bapp[-_]id\s*:|\bprivate[-_]key\s*:|ssh-agent|\bssh[-_]key\s*:|deploy[-_]key/i.test(text)) reasons.add("app or deploy key");
  return [...reasons].sort();
};

type QaReleaseWorkflowFile = { path: string; text: string; workflow: unknown; yamlAliases?: boolean };

/**
 * One workflow file as qaReleaseWorkflowBranchWriters reads it. `workflow` is
 * null when the YAML does not parse. `yamlAliases` is true when the document
 * holds an alias node -- the only way an anchor is reused or a merge key
 * (`<<`) appears -- so the caller never relies on how a merge was expanded.
 */
export const qaReleaseReadWorkflow = (path: string, text: string): QaReleaseWorkflowFile => {
  try {
    const document = parseDocument(text);
    if (document.errors.length > 0) return { path, text, workflow: null, yamlAliases: false };
    let yamlAliases = false;
    visit(document, {
      Alias() {
        yamlAliases = true;
        return visit.BREAK;
      },
    });
    return { path, text, workflow: document.toJS(), yamlAliases };
  } catch {
    return { path, text, workflow: null, yamlAliases: false };
  }
};

/** The digest a person reviews: the workflow file's text, line endings normalised. */
export const qaReleaseWorkflowDigest = (text: string): string =>
  createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex");

/**
 * Workflows a person has read whole and found to update no branch except with
 * GH_AUTOMATION_PAT (repository admin), though they hold a credential that
 * could. Pinned by the file's digest: any change to the file is a new review.
 * Read on 2026-10-08 on develop and main (each branch's text is its own
 * entry).
 */
export const QA_RELEASE_REVIEWED_WRITER_WORKFLOWS: readonly { path: string; sha256: string; why: string }[] = Object.freeze([
  // develop (24083083e)
  Object.freeze({
    path: ".github/workflows/cron-auto-fix.yml",
    sha256: "26dc4dd34d8cf5bfa2c396c9b4958e3b3496b52c615d6e2b25c9e6d23d726f1e",
    why: "workflow-level contents: write, but no step uses the workflow token to write: the checkout takes GH_AUTOMATION_PAT without keeping it, and the only push (and, on main, gh pr merge --auto) runs after gh auth setup-git in the same step with GH_TOKEN the PAT",
  }),
  // main
  Object.freeze({
    path: ".github/workflows/cron-auto-fix.yml",
    sha256: "93413e0e4a12fb234712a507ad34faa6e6cdfce36cc2472aee3040e4eda37941",
    why: "workflow-level contents: write, but no step uses the workflow token to write: the checkout takes GH_AUTOMATION_PAT without keeping it, and the only push (and, on main, gh pr merge --auto) runs after gh auth setup-git in the same step with GH_TOKEN the PAT",
  }),
]);

/**
 * Every workflow that could update a branch with something the lane's update
 * ruleset will refuse, unless a person has reviewed that exact file. Applied,
 * the ruleset refuses updates to every branch but develop from anyone off its
 * bypass list -- the repository admin role and Dependabot -- and GitHub
 * Actions cannot be on it here. So the real-ruleset step refuses while any
 * workflow is listed.
 *
 * The test is what GitHub itself enforces, not a reading of shell: the
 * workflow token can change a branch -- by git push, a merge API call,
 * GraphQL, a script action or a reusable workflow it calls -- only with
 * `contents: write`. A workflow is listed when:
 * - any job's effective token permission grants contents write (`write-all`,
 *   `contents: write`, or no `permissions` while the repository default is
 *   write), a reusable-workflow call included, since the called workflow
 *   cannot exceed it;
 * - it uses a secret not in QA_RELEASE_NON_BRANCH_SECRETS, passes secrets on
 *   wholesale, or mints an App token or uses a deploy key -- none of which
 *   can bypass;
 * - it cannot be read as YAML, or uses anchors, aliases or merge keys: a
 *   value reached only through one (a `secrets: inherit` or an `if` in an
 *   anchored job) is not in the plain parse, so such a file is read by a
 *   person instead. No workflow here uses them (2026-10-08).
 * A listed workflow passes only by its whole-file digest in the reviewed list.
 *
 * Pure but for hashing: the caller passes each file's text and its parse
 * (the `yaml` package), or null when it could not be parsed.
 */
export function qaReleaseWorkflowBranchWriters(
  files: readonly QaReleaseWorkflowFile[],
  defaultPermission: "read" | "write",
  reviewed: readonly { path: string; sha256: string }[] = QA_RELEASE_REVIEWED_WRITER_WORKFLOWS,
): string[] {
  const listed: string[] = [];
  for (const { path, text, workflow, yamlAliases } of files) {
    const sha256 = qaReleaseWorkflowDigest(text);
    const reasons: string[] = [];
    // Unknown counts as present: a caller that did not check is not trusted.
    if (yamlAliases !== false) reasons.push("yaml anchors or aliases");
    const root = asRecord(workflow);
    const jobs = asRecord(root?.jobs);
    if (!root || !jobs) reasons.push("unreadable");
    else {
      for (const [jobId, rawJob] of Object.entries(jobs)) {
        const job = asRecord(rawJob) ?? {};
        const effective = job.permissions !== undefined ? job.permissions : root.permissions;
        if (effective === undefined ? defaultPermission === "write" : contentsWrite(effective)) reasons.push(`${jobId}: contents write`);
      }
    }
    reasons.push(...otherCredentials(text, workflow));
    if (reasons.length === 0) continue;
    if (reviewed.some((entry) => entry.path === path && entry.sha256 === sha256)) continue;
    listed.push(`${path} ${sha256} (${reasons.join("; ")})`);
  }
  return listed.sort();
}
