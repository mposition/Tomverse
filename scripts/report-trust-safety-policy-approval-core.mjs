/**
 * The §2 approval judgement of `docs/policy/trust-safety-compliance-agent.md`,
 * as code rather than as a person reading a document.
 *
 * ## Why this exists
 *
 * §2 says the judging party is this script, and that a person runs it and signs
 * the verdict (§12 (4)). Version 1 of that policy was merged on 2026-10-07 and
 * **failed two of its own steps** -- `approvedAt` named a different day from the
 * merge (step 5), and commit-level wording made the allowlist's own genesis PR a
 * permanent violation (step 0). Both were found by reading the document by hand
 * afterwards. That is the failure this file removes: the judgement is mechanical,
 * so it can be run before the approval PR is merged rather than after.
 *
 * ## What it is not
 *
 * It **reports**. It never writes the policy, the allowlist, a registry or a
 * status field: the three header fields are the operator's, and a report that
 * edits its own subject destroys the record it exists to produce. It is not a
 * gate either -- a verdict is evidence an operator signs, not a merge condition.
 *
 * ## Pure
 *
 * No git, no network, no filesystem, no clock. Every fact arrives in the
 * observation so a test can pin one, and so the three decisions below are
 * visible rather than buried in a shell pipeline.
 *
 * ## Three readings that decide the verdict, written down
 *
 * **1. "A commit that changed the file" is one whose blob differs from every
 * parent's.** §0 (나) enumerates the commits that changed the allowlist file.
 * Run against the real repository, `git log --full-history -- <path>` returns 33
 * commits, of which 31 are ancestry merges that carry an existing change across
 * branches; two of those merges were authored by `github-actions[bot]`. Counting
 * a merge as a change would therefore fail (다) item 2 (non-bot author) and
 * leave §0 permanently unmet. A merge whose blob equals at least one parent's
 * introduced nothing, which is what "changed" means. An evil merge -- a blob
 * differing from every parent -- does count, and is reported as such.
 *
 * **2. Step 6 reads the pull request's own commits, not the merge commit.**
 * GitHub's merge commit has committer `GitHub`, so including it would fail every
 * approval PR ever merged through the web UI, this policy's own two included.
 *
 * **3. `to-develop` is a path segment, not a substring.** The marker string
 * lives in `scripts/auto-pr-branch-policy.mjs`, which asks a different question
 * (whether to open a PR) and bundles other refusals into its answer, so only the
 * constant is shared.
 *
 * ## Two things the manifest always says
 *
 * That a force-push over a protected branch rewrites the very records steps 1-7
 * read, and that observing it is outside this judgement; and that the judgement
 * proves procedure rather than authorship, because an agent session in this
 * repository commits under the operator's git identity and uses that account's
 * token.
 *
 * ## Two things it must never output
 *
 * The first parent's `version` (step 0a discarded that comparison point), and a
 * 1-7 verdict for a `V_max` commit (step 0a does not judge those, and steps 1
 * and 7 are statements about the present that no past commit can satisfy).
 * Printing either would have the manifest demand work the script does not do.
 */

import { TARGET_MARKER } from "./auto-pr-branch-policy.mjs";

/** The header's three fields are blank when they hold one of these. */
const PLACEHOLDERS = ["(미기록)", "(미부여)", "(미승인)", ""];

export const FIXED_NOTES = {
  forcePush:
    "A force-push or branch deletion over a protected branch rewrites the records steps 1-7 read. Preventing that is branch protection, not this judgement; observing it is outside this report's scope.",
  authorship:
    "This judgement proves procedure, not authorship. An agent session in this repository commits under the operator's git identity and uses that account's GitHub token, so a commit made with the operator's credentials against the rules is indistinguishable in the record. It catches mistakes and circumvention; it does not catch credential misuse.",
};

export const isPlaceholder = (value) =>
  value === undefined || value === null || PLACEHOLDERS.includes(String(value).trim());

/**
 * A version is a positive integer with no leading zero. `01` and `1.0` are not
 * versions; neither is a placeholder.
 */
export const parseVersion = (value) => {
  if (isPlaceholder(value)) return undefined;
  const text = String(value).trim();
  if (!/^[1-9][0-9]*$/.test(text)) return undefined;
  return Number(text);
};

/**
 * `V_max`: the largest non-placeholder version among the policy file's commits
 * reachable from the approval PR's base, with **every** commit holding it. Two
 * commits can hold the same maximum -- including two commits of one PR -- so the
 * value and the holders are reported together and the holders are never a single
 * SHA.
 */
export const maxApprovedVersion = (commits) => {
  if (commits === undefined) return { value: undefined, holders: [], unreadable: true };
  let value;
  const holders = [];
  const unread = [];
  for (const commit of commits) {
    // A commit whose file could not be read is not a commit without a version.
    // Skipping it silently would let a reused number pass while a commit the
    // reader never saw held a higher one -- which is the opposite of what §2
    // says about a fact it cannot read.
    if (commit.unreadable) {
      unread.push(commit.sha);
      continue;
    }
    const version = parseVersion(commit.version);
    if (version === undefined) continue;
    if (value === undefined || version > value) {
      value = version;
      holders.length = 0;
    }
    if (version === value) holders.push(commit.sha);
  }
  if (unread.length > 0) {
    return { value: undefined, holders: [], unreadable: true, unread };
  }
  return { value, holders };
};

/**
 * Whether a commit changed the file: its blob differs from every parent's. A
 * root commit changed it when the file is present. `undefined` is absence.
 */
export const changedTheFile = (commit) => {
  const parents = commit.parents ?? [];
  if (parents.length === 0) return commit.blob !== undefined;
  return parents.every((parent) => parent.blob !== commit.blob);
};

/** Whether a merge introduced the change itself rather than carrying one. */
export const isEvilMerge = (commit) =>
  (commit.parents ?? []).length > 1 && changedTheFile(commit);

/**
 * Every item, or nothing at all.
 *
 * The lookup is injected so this is testable without a repository: it is the
 * rule that one unreadable commit makes a whole observation unreadable, and a
 * review found it missing from the wrapper, where `filter(Boolean)` dropped the
 * commits it could not read. An empty result then passed `every()`.
 */
export const readAllOrNothing = (items, lookup) => {
  if (items === undefined) return undefined;
  const read = [];
  for (const item of items) {
    const value = lookup(item);
    if (value === undefined) return undefined;
    read.push(value);
  }
  return read;
};

/**
 * One commit's entry for the V_max calculation, from a three-state read.
 *
 * `absent` is an ordinary fact -- the file had a first commit, and before it
 * there is no version. `unreadable` is §2's "could not read", which it calls
 * unmet. Collapsing the two is what let a version the reader never opened drop
 * out of the maximum.
 */
export const versionEntryOf = (sha, read, versionOf) => {
  if (read?.state === "unreadable" || read === undefined) return { sha, unreadable: true };
  if (read.state === "absent") return { sha, version: undefined };
  return { sha, version: versionOf(read.text) };
};

export const hasToDevelopSegment = (branch) =>
  String(branch ?? "")
    .split("/")
    .filter((segment) => segment !== "")
    .includes(TARGET_MARKER);

/**
 * A bot identity, read from the git author and committer only. The
 * `Co-Authored-By:` trailer is deliberately not read: nearly every commit in
 * this repository carries one, and that trailer is the record that an agent
 * wrote the change -- so this operand gives that up, which is the same limit
 * FIXED_NOTES.authorship states.
 */
export const isBotIdentity = (identity) => {
  const name = String(identity?.name ?? "");
  const email = String(identity?.email ?? "");
  return (
    /\[bot\]$/.test(name.trim()) ||
    /\[bot\]@/.test(email) ||
    name.trim() === "github-actions" ||
    email.startsWith("github-actions@")
  );
};

const identityIs = (identity, login) =>
  String(identity?.name ?? "").trim() === String(login ?? "").trim() &&
  !isBotIdentity(identity);

/** A step's result. `met: undefined` means the facts needed were not readable. */
const step = (id, title, met, because, detail = {}) => ({
  id,
  title,
  met,
  because,
  ...detail,
});

/**
 * The seven items (다) requires of each pull request that changed the allowlist,
 * and the count condition (나) supplies. A genesis PR is exempt from items 6 and
 * 7 only, and the exemptions are reported as skipped rather than as passes.
 */
export const judgeAllowlistPr = (pr, { genesis = false } = {}) => {
  const items = [];
  const add = (id, title, met, because) => items.push({ id, title, met, because });

  // (나)'s condition, judged where the mapping is made.
  add(
    "count",
    "exactly one pull request put each of its commits into develop",
    pr.commitPrCounts === undefined
      ? undefined
      : pr.commitPrCounts.every((count) => count === 1),
    pr.commitPrCounts === undefined
      ? "the pull requests containing those commits could not be read"
      : `commits mapped to ${pr.commitPrCounts.join(", ")} pull request(s)`,
  );

  add(
    1,
    "changed the allowlist file alone",
    pr.files === undefined ? undefined : pr.files.length === 1 && pr.files[0] === pr.allowlistPath,
    pr.files === undefined ? "the changed files could not be read" : `changed ${(pr.files ?? []).join(", ")}`,
  );

  // §2 0번 (다) 2 and 3 name **the allowlist's approvedBy at that pull
  // request's own merge commit**, not the policy's current approver. An earlier
  // draft passed the current one into every past judgement, which both ways
  // round is wrong: a different legitimate approver signing the policy today
  // would fail the genesis history, and a past allowlist whose approvedBy
  // differed from its author would pass whenever it happened to match today's.
  const approver = pr.approvedByAtMerge;
  const identities = pr.commits ?? [];
  add(
    2,
    "every commit's git author and committer is that merge's approver and not a bot",
    pr.commits === undefined || approver === undefined || identities.length === 0
      ? undefined
      : identities.every(
          (commit) => identityIs(commit.author, approver) && identityIs(commit.committer, approver),
        ),
    pr.commits === undefined
      ? "the commits could not be read"
      : approver === undefined
        ? "the allowlist's approvedBy at this pull request's merge commit could not be read"
        : identities.length === 0
          ? "no commit was readable for this pull request, which is unmet rather than vacuously true"
          : `against approvedBy ${approver}: ` +
            identities
              .map(
                (commit) =>
                  `${commit.sha}: author ${commit.author?.name ?? "?"}, committer ${commit.committer?.name ?? "?"}`,
              )
              .join("; "),
  );

  add(
    3,
    "the merger is that merge's approver and a GitHub User",
    pr.mergedBy === undefined || approver === undefined
      ? undefined
      : pr.mergedBy.login === approver && pr.mergedBy.type === "User",
    pr.mergedBy === undefined
      ? "the merger could not be read"
      : approver === undefined
        ? "the allowlist's approvedBy at this pull request's merge commit could not be read"
        : `merged by ${pr.mergedBy.login} (type ${pr.mergedBy.type}) against approvedBy ${approver}`,
  );

  add(
    4,
    "the allowlist's approvedAt at the merge commit equals the merge's UTC date",
    pr.approvedAtAtMerge === undefined || pr.mergedAtUtcDate === undefined
      ? undefined
      : pr.approvedAtAtMerge === pr.mergedAtUtcDate,
    pr.approvedAtAtMerge === undefined || pr.mergedAtUtcDate === undefined
      ? "the file at the merge commit or the merge time could not be read"
      : `approvedAt ${pr.approvedAtAtMerge} against merge date ${pr.mergedAtUtcDate}`,
  );

  add(
    5,
    "the branch names no to-develop segment",
    pr.headRef === undefined ? undefined : !hasToDevelopSegment(pr.headRef),
    pr.headRef === undefined ? "the branch name could not be read" : `branch ${pr.headRef}`,
  );

  if (genesis) {
    items.push({
      id: 6,
      title: "an account already on the list approved and merged it",
      met: "skipped",
      because: "(라): the genesis pull request established the list, so there is no earlier list to satisfy",
    });
    items.push({
      id: 7,
      title: "version increased strictly",
      met: "skipped",
      because: "(라): the file does not exist in this pull request's base, so there is no earlier value to exceed",
    });
  } else {
    add(
      6,
      "an account already on the list approved and merged it",
      pr.approverWasOnBaseList,
      pr.approverWasOnBaseList === undefined
        ? "the list at this pull request's base could not be read"
        : `base list ${(pr.baseListApprovers ?? []).join(", ") || "(empty)"}, merged by ${pr.mergedBy?.login ?? "?"}`,
    );
    const baseVersion = parseVersion(pr.baseVersion);
    const mergeVersion = parseVersion(pr.mergeVersion);
    add(
      7,
      "version increased strictly",
      baseVersion === undefined || mergeVersion === undefined ? undefined : mergeVersion > baseVersion,
      baseVersion === undefined || mergeVersion === undefined
        ? "the version at the base or at the merge commit could not be read"
        : `base ${baseVersion} -> merge ${mergeVersion}`,
    );
  }

  const met = items.every((item) => item.met === true || item.met === "skipped")
    ? items.some((item) => item.met === undefined)
      ? undefined
      : true
    : items.some((item) => item.met === false)
      ? false
      : undefined;

  return { number: pr.number, genesis, items, met };
};

/**
 * Step 0: the approver is on the list, and the list's own history holds.
 */
const judgeStepZero = (o) => {
  const sub = [];

  sub.push(
    step(
      "0-member",
      "the approver is on the allowlist at the approval pull request's base",
      o.approverOnAllowlistAtBase,
      o.approverOnAllowlistAtBase === undefined
        ? "the allowlist at the base could not be read"
        : `list at base: ${(o.allowlistApproversAtBase ?? []).join(", ") || "(empty)"}`,
    ),
  );

  sub.push(
    step(
      "0-ga",
      "(가) the allowlist's first commit is the declared genesis",
      o.observedAllowlistGenesis === undefined || o.declaredGenesisCommit === undefined
        ? undefined
        : o.observedAllowlistGenesis === o.declaredGenesisCommit,
      o.observedAllowlistGenesis === undefined || o.declaredGenesisCommit === undefined
        ? "the first commit or the declared genesis could not be read"
        : `declared ${o.declaredGenesisCommit}, observed ${o.observedAllowlistGenesis}`,
    ),
  );

  const changes = o.allowlistChanges ?? [];
  const unmapped = changes.filter((change) => (change.prNumbers ?? []).length !== 1);
  sub.push(
    step(
      "0-na",
      "(나) every commit that changed the allowlist maps to exactly one pull request",
      o.allowlistChanges === undefined ? undefined : unmapped.length === 0,
      o.allowlistChanges === undefined
        ? "the allowlist's history could not be read"
        : `${changes.length} commit(s) changed the file; ` +
          (unmapped.length === 0
            ? "each maps to exactly one pull request"
            : `unmapped or ambiguous: ${unmapped.map((c) => `${c.sha} -> ${(c.prNumbers ?? []).length}`).join(", ")}`),
      {
        changes: changes.map((change) => ({
          sha: change.sha,
          pullRequests: change.prNumbers ?? [],
          evilMerge: Boolean(change.evilMerge),
        })),
        carriedWithoutChanging: o.allowlistCarryingMerges ?? [],
      },
    ),
  );

  const prJudgements = (o.allowlistPrs ?? []).map((pr) =>
    judgeAllowlistPr({ ...pr, allowlistPath: o.allowlistPath }, {
      genesis: pr.number === o.genesisPrNumber,
    }),
  );
  const nonGenesis = prJudgements.filter((judgement) => !judgement.genesis);
  sub.push(
    step(
      "0-da",
      "(다) every pull request that changed the allowlist kept the same procedure",
      o.allowlistPrs === undefined
        ? undefined
        : prJudgements.every((judgement) => judgement.met === true)
          ? true
          : prJudgements.some((judgement) => judgement.met === false)
            ? false
            : undefined,
      o.allowlistPrs === undefined
        ? "the pull requests could not be read"
        : nonGenesis.length === 0
          ? "no pull request other than the genesis one ever changed the file, so the non-genesis set is empty"
          : `${nonGenesis.length} non-genesis pull request(s) judged`,
      { pullRequests: prJudgements },
    ),
  );

  const met = sub.every((entry) => entry.met === true)
    ? true
    : sub.some((entry) => entry.met === false)
      ? false
      : undefined;
  return step(0, "the approver is an operator the allowlist names", met, "see the four conditions", {
    conditions: sub,
  });
};

const judgeStepZeroA = (o) => {
  const header = o.header ?? {};
  // A file that could not be read is not a file with empty fields. Both block
  // an approval, but only one of them is a statement about the document, and
  // this report is read as a record of what the document says.
  const readable = o.header !== undefined;
  const filled =
    !readable
      ? undefined
      : !isPlaceholder(header.version) &&
        !isPlaceholder(header.approvedBy) &&
        !isPlaceholder(header.approvedAt);
  const version = parseVersion(header.version);
  const lastRow = parseVersion(o.historyLastRowVersion);
  const vMax = maxApprovedVersion(o.policyCommitsReachableFromBase);

  const checks = [
    step(
      "0a-filled",
      "version, approvedBy and approvedAt are filled, not placeholders",
      filled,
      readable
        ? `version ${header.version ?? "(absent)"}, approvedBy ${header.approvedBy ?? "(absent)"}, approvedAt ${header.approvedAt ?? "(absent)"}`
        : "the policy file could not be read, so the header says nothing either way",
    ),
    step(
      "0a-integer",
      "version is a positive integer with no leading zero",
      readable ? version !== undefined : undefined,
      readable ? `read ${header.version ?? "(absent)"}` : "the policy file could not be read",
    ),
    step(
      "0a-last-row",
      "version equals the last row of the version history table",
      version === undefined || lastRow === undefined ? undefined : version === lastRow,
      version === undefined || lastRow === undefined
        ? "the header version or the last history row could not be read"
        : `header ${version} against last row ${lastRow}`,
    ),
    step(
      "0a-increase",
      "version is strictly greater than V_max",
      vMax.unreadable || version === undefined
        ? undefined
        : vMax.value === undefined
          ? version === 1
          : version > vMax.value,
      vMax.unreadable
        ? `a reachable commit's copy of the file could not be read, so V_max is unknown${
            vMax.unread ? `: ${vMax.unread.join(", ")}` : ""
          }`
        : version === undefined
          ? "the header version could not be read"
          : vMax.value === undefined
            ? `no non-placeholder version is reachable, so this version must be exactly 1; it is ${version}`
            : `${version} against V_max ${vMax.value}`,
      { vMax: vMax.value ?? null, vMaxHolders: vMax.holders, vMaxUnread: vMax.unread ?? [] },
    ),
  ];

  const met = checks.every((check) => check.met === true)
    ? true
    : checks.some((check) => check.met === false)
      ? false
      : undefined;
  return step("0a", "the header's three fields, and the version moving forward", met, "see the four checks", {
    checks,
  });
};

export const judgeTrustSafetyPolicyApproval = (observation) => {
  const o = observation ?? {};
  const header = o.header ?? {};
  const pr = o.approvalPr;
  const steps = [judgeStepZero(o), judgeStepZeroA(o)];

  steps.push(
    step(
      1,
      "the commit that last changed the policy file",
      o.lastChangeCommit === undefined ? undefined : true,
      o.lastChangeCommit === undefined
        ? "no commit changing the policy file could be read"
        : `commit ${o.lastChangeCommit}`,
    ),
  );

  const containing = o.pullRequestsContainingLastChange;
  steps.push(
    step(
      2,
      "exactly one pull request put that commit into develop",
      containing === undefined ? undefined : containing.length === 1,
      containing === undefined
        ? "the pull requests containing that commit could not be read"
        : `${containing.length}: ${containing.map((entry) => `#${entry.number} (base ${entry.base})`).join(", ") || "none"}`,
    ),
  );

  steps.push(
    step(
      3,
      "that pull request's branch names no to-develop segment",
      pr?.headRef === undefined ? undefined : !hasToDevelopSegment(pr.headRef),
      pr?.headRef === undefined
        ? "the branch name could not be read"
        : `branch ${pr.headRef}`,
    ),
  );

  steps.push(
    step(
      4,
      "the merger is approvedBy and a GitHub User",
      pr?.mergedBy === undefined
        ? undefined
        : pr.mergedBy.login === header.approvedBy && pr.mergedBy.type === "User",
      pr?.mergedBy === undefined
        ? "the merger could not be read, which is unmet rather than unknown by §2's wording"
        : `merged by ${pr.mergedBy.login} (type ${pr.mergedBy.type}) against approvedBy ${header.approvedBy}`,
    ),
  );

  steps.push(
    step(
      5,
      "approvedAt equals the merge's UTC date",
      pr?.mergedAtUtcDate === undefined || isPlaceholder(header.approvedAt)
        ? undefined
        : header.approvedAt === pr.mergedAtUtcDate,
      pr?.mergedAtUtcDate === undefined || isPlaceholder(header.approvedAt)
        ? "the merge time or approvedAt could not be read"
        : `approvedAt ${header.approvedAt} against merge ${pr.mergedAtIso} (UTC date ${pr.mergedAtUtcDate})`,
    ),
  );

  const prCommits = pr?.commits;
  steps.push(
    step(
      6,
      "the pull request changed this file alone, by the approver and not a bot",
      pr?.files === undefined || prCommits === undefined || prCommits.length === 0
        ? undefined
        : pr.files.length === 1 &&
          pr.files[0] === o.policyPath &&
          prCommits.every(
            (commit) =>
              identityIs(commit.author, header.approvedBy) &&
              identityIs(commit.committer, header.approvedBy),
          ),
      pr?.files === undefined || prCommits === undefined
        ? "the changed files or the commits could not be read"
        : prCommits.length === 0
          ? "no commit was readable for this pull request, which is unmet rather than vacuously true"
          : `changed ${pr.files.join(", ")}; ` +
          prCommits
            .map(
              (commit) =>
                `${commit.sha}: author ${commit.author?.name ?? "?"}, committer ${commit.committer?.name ?? "?"}`,
            )
            .join("; "),
    ),
  );

  const later = o.policyChangesAfterMerge;
  steps.push(
    step(
      7,
      "nothing changed the file after that merge, so no re-judgement is pending",
      later === undefined ? undefined : later.length === 0,
      later === undefined
        ? "later commits could not be read"
        : later.length === 0
          ? "no later commit changed the policy file"
          : `re-judge from step 0 against the newer pull request's base: ${later.join(", ")}`,
    ),
  );

  const verdict = steps.every((entry) => entry.met === true)
    ? "approved"
    : steps.some((entry) => entry.met === false)
      ? "unmet"
      : "unreadable";

  return {
    verdict,
    steps,
    manifest: {
      policyPath: o.policyPath,
      allowlistPath: o.allowlistPath,
      header: {
        version: header.version ?? null,
        approvedBy: header.approvedBy ?? null,
        approvedAt: header.approvedAt ?? null,
      },
      declaredGenesisCommit: o.declaredGenesisCommit ?? null,
      observedAllowlistGenesis: o.observedAllowlistGenesis ?? null,
      lastChangeCommit: o.lastChangeCommit ?? null,
      approvalPullRequest: pr
        ? {
            number: pr.number ?? null,
            headRef: pr.headRef ?? null,
            baseSha: pr.baseSha ?? null,
            mergedBy: pr.mergedBy ?? null,
            mergedAtIso: pr.mergedAtIso ?? null,
            mergedAtUtcDate: pr.mergedAtUtcDate ?? null,
            files: pr.files ?? null,
            commits: pr.commits ?? null,
          }
        : null,
      notes: [FIXED_NOTES.forcePush, FIXED_NOTES.authorship],
      omitted: [
        "the first parent's version: step 0a discarded that comparison point",
        "a steps 1-7 verdict for a V_max commit: step 0a does not judge those, and steps 1 and 7 are statements about the present",
      ],
    },
  };
};
