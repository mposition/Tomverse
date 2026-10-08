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

/** The one expression that names the admin PAT, compared without spaces. */
const isPat = (value: unknown): boolean =>
  typeof value === "string" && value.replace(/\s+/g, "") === "${{secrets.GH_AUTOMATION_PAT}}";

type Json = Record<string, unknown>;
const asRecord = (value: unknown): Json | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;

/** A script's lines without comment lines, with backslash continuations joined. */
const scriptLines = (run: string): string[] => {
  const joined: string[] = [];
  let pending = "";
  for (const raw of run.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#")) continue;
    if (line.endsWith("\\")) {
      pending += `${line.slice(0, -1)} `;
      continue;
    }
    joined.push(pending + line);
    pending = "";
  }
  if (pending) joined.push(pending);
  return joined;
};

/**
 * The commands on one shell line, each as its words: quotes respected, an
 * unquoted `#` ends the line, and `;`, `&&`, `||` and `|` separate
 * commands. Leading control words (`if`, `then`, `!`, ...) are dropped, so
 * `if git push origin x; then` reads as `git push origin x`.
 */
const shellCommands = (line: string): string[][] => {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: string | null = null;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      inWord = true;
      continue;
    }
    if (char === "#" && !inWord) break;
    if (char === ";" || char === "|" || char === "&") {
      endCommand();
      if ((char === "|" || char === "&") && line[i + 1] === char) i += 1;
      continue;
    }
    if (/\s/.test(char)) {
      endWord();
      continue;
    }
    word += char;
    inWord = true;
  }
  endCommand();
  const CONTROL = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "("]);
  return commands.map((command) => {
    let index = 0;
    while (index < command.length && CONTROL.has(command[index])) index += 1;
    return command.slice(index);
  });
};

const ACCESS_TOKEN_URL = /^https:\/\/x-access-token:\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?@[^\s]+$/;
/** The first argument that is not an option. */
const firstOperand = (args: string[]): string | undefined => args.find((arg) => !arg.startsWith("-"));

/**
 * Every `git push` in the workflows that is not authenticated with the admin
 * PAT, as `path#job/step`. The update ruleset refuses a workflow-token push to
 * every branch but develop once applied (GitHub Actions cannot be on its
 * bypass list here), so the real-ruleset step refuses while any is listed.
 *
 * Each push is read as a shell command and judged by its own target:
 * - a URL target counts only as `https://x-access-token:${VAR}@...` with VAR
 *   the PAT in the step's effective environment; any other URL is listed;
 * - a remote-name target counts when that same remote was given such a URL by
 *   an earlier `git remote set-url`, when `gh auth setup-git` ran earlier in
 *   the same step with GH_TOKEN the PAT, or -- for `origin` -- when the job's
 *   checkout took the PAT and kept the credential.
 * Authentication set up in an earlier step that carries an `if:` is not
 * relied on: it may not have run. Comments, other commands on the line, other
 * jobs and unreadable workflows never count.
 *
 * Pure: the caller parses each workflow (the `yaml` package) and passes the
 * object, or null when it could not.
 */
export function qaReleaseWorkflowTokenPushers(files: readonly { path: string; workflow: unknown }[]): string[] {
  const unsafe: string[] = [];
  for (const { path, workflow } of files) {
    const root = asRecord(workflow);
    const jobs = asRecord(root?.jobs);
    if (!root || !jobs) {
      unsafe.push(`${path}#unreadable`);
      continue;
    }
    for (const [jobId, rawJob] of Object.entries(jobs)) {
      const job = asRecord(rawJob);
      const steps = Array.isArray(job?.steps) ? job.steps : [];
      let checkoutKeepsPat = false;
      const remotesWithPat = new Set<string>();
      steps.forEach((rawStep, index) => {
        const step = asRecord(rawStep) ?? {};
        const conditional = step.if !== undefined;
        const env = { ...(asRecord(root.env) ?? {}), ...(asRecord(job?.env) ?? {}), ...(asRecord(step.env) ?? {}) };
        const uses = typeof step.uses === "string" ? step.uses : "";
        if (uses.startsWith("actions/checkout@")) {
          const withs = asRecord(step.with) ?? {};
          const keeps = isPat(withs.token) && withs["persist-credentials"] !== false && withs["persist-credentials"] !== "false";
          // A later checkout replaces the credential either way; a conditional
          // one may not have run, so it can only take the PAT away.
          checkoutKeepsPat = conditional ? checkoutKeepsPat && keeps : keeps;
        }
        if (typeof step.run !== "string") return;
        // Set up inside this step: it ran if this step's push runs.
        let setupGitWithPat = false;
        const stepRemotes = new Map<string, boolean>();
        for (const line of scriptLines(step.run)) {
          for (const words of shellCommands(line)) {
            if (words[0] === "gh" && words[1] === "auth" && words[2] === "setup-git") {
              setupGitWithPat = isPat(env.GH_TOKEN);
              continue;
            }
            if (words[0] === "git" && words[1] === "remote" && words[2] === "set-url") {
              const operands = words.slice(3).filter((arg) => !arg.startsWith("-"));
              const [name, url] = operands;
              const match = typeof url === "string" ? ACCESS_TOKEN_URL.exec(url) : null;
              if (name) stepRemotes.set(name, Boolean(match && isPat(env[match[1]])));
              continue;
            }
            if (words[0] !== "git" || words[1] !== "push") continue;
            const target = firstOperand(words.slice(2)) ?? "origin";
            let authenticated: boolean;
            if (target.includes("://") || target.includes("@")) {
              const match = ACCESS_TOKEN_URL.exec(target);
              authenticated = Boolean(match && isPat(env[match[1]]));
            } else {
              const remotePat = stepRemotes.has(target) ? stepRemotes.get(target) === true : remotesWithPat.has(target);
              authenticated = remotePat || setupGitWithPat || (target === "origin" && checkoutKeepsPat);
            }
            if (!authenticated) unsafe.push(`${path}#${jobId}/${index}`);
          }
        }
        // A remote's URL set in this step stays for the later steps, unless
        // the step was conditional and may not have run.
        for (const [name, pat] of stepRemotes) {
          if (pat && !conditional) remotesWithPat.add(name);
          else remotesWithPat.delete(name);
        }
      });
    }
  }
  return [...new Set(unsafe)].sort();
}
