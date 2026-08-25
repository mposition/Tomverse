// Reports which open issues are still real work, and which the tracker is
// merely behind on.
//
// See scripts/report-issue-backlog-core.mjs for why this exists and what each
// signal proves. This file only gathers the facts the core reasons over: git
// history on the release branches, and each release branch's own copy of the
// files the probes read.
//
// Usage:
//   node --import tsx scripts/report-issue-backlog.mjs [--json]
//   node --import tsx scripts/report-issue-backlog.mjs --issues-file open.json
//
// Issues come from the GitHub REST API when GITHUB_TOKEN (or GH_TOKEN) is set,
// and from --issues-file otherwise. The file may be either a bare
// [{ "number": 1, "title": "..." }] array or a saved API response.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  MODEL_PRICING,
  PENDING_VERIFIED_PRICE_MODEL_IDS,
} from "../lib/modelPricing.ts";
import {
  auditIssueBacklog,
  issueReferencesInCommit,
  parseModelPricingSource,
  VERDICTS,
} from "./report-issue-backlog-core.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const issuesFileIndex = args.indexOf("--issues-file");
const issuesFile = issuesFileIndex === -1 ? null : args[issuesFileIndex + 1];
if (issuesFileIndex !== -1 && (!issuesFile || issuesFile.startsWith("--"))) {
  // Falling through to the API path here would report "set GITHUB_TOKEN" at
  // someone who did supply a file and only mistyped the argument.
  console.error("--issues-file needs a path.");
  process.exit(1);
}

/**
 * The branches a change has to reach, in promotion order. `develop` is where
 * work lands and `main` is what runs in production, and the distance between
 * them is not incidental -- on 2026-08-12 it was 117 commits, and the open
 * issues were not uniformly split across it.
 */
const RELEASE_BRANCHES = ["develop", "main"];

const MODEL_PRICING_PATH = "lib/modelPricing.ts";

const git = (...argv) => {
  const result = spawnSync("git", argv, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout : null;
};

/** `origin/develop` when the remote-tracking ref exists, else `develop`. */
const resolveRef = (name) => {
  for (const ref of [`origin/${name}`, name]) {
    if (git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`)) return ref;
  }
  return null;
};

const refByBranch = new Map();
for (const name of RELEASE_BRANCHES) {
  const ref = resolveRef(name);
  if (ref) refByBranch.set(name, ref);
}
if (refByBranch.size === 0) {
  console.error(
    `No release branch is available locally (looked for ${RELEASE_BRANCHES.join(", ")}).`
  );
  process.exit(1);
}

// Unit and record separators, written as escapes: a commit subject may contain
// anything, and a literal control character in this file would make git treat
// it as binary and unreviewable.
const UNIT = "\x1f";
const RECORD = "\x1e";

const commitsOnRef = (ref) => {
  // `-E --grep` narrows history to commits that mention an issue-shaped token
  // before any of it is parsed. Without it this walks every commit in the
  // repository to find the handful that reference a number.
  const out = git(
    "log",
    ref,
    "-E",
    "--grep=#[0-9]+",
    `--format=%H${UNIT}%s${UNIT}%b${RECORD}`
  );
  if (out === null) return [];
  return out
    .split(RECORD)
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const [sha, subject, body] = record.split(UNIT);
      return { sha, subject: subject ?? "", body: body ?? "" };
    });
};

/** Commits referencing each issue number, tagged with the branches holding them. */
const collectCommitsByIssue = () => {
  const byIssue = new Map();
  const seen = new Map();

  for (const [name, ref] of refByBranch) {
    for (const commit of commitsOnRef(ref)) {
      const existing = seen.get(commit.sha);
      if (existing) {
        existing.branches.push(name);
        continue;
      }
      seen.set(commit.sha, { ...commit, branches: [name] });
    }
  }

  for (const commit of seen.values()) {
    for (const number of issueReferencesInCommit(commit)) {
      if (!byIssue.has(number)) byIssue.set(number, []);
      byIssue.get(number).push({
        sha: commit.sha.slice(0, 8),
        subject: commit.subject,
        branches: commit.branches,
      });
    }
  }
  return byIssue;
};

/**
 * Which models a pricing verification has actually been done for, on one branch.
 *
 * Read from the audit directory's own filenames rather than from a hand-written
 * list, because the record *is* the deliverable: #244 produced
 * `pricing-verification-claude-fable-5-2026-08-04.md` and that file is what
 * distinguishes a checked model from one that merely has a profile. A list here
 * would be a second place to forget.
 *
 * The date suffix is discarded. It says when the check happened, and this only
 * needs to know that it did.
 */
const AUDIT_DIR = ".github/audits";
const VERIFICATION_PREFIX = "pricing-verification-";

const pricingVerificationRecords = (ref) => {
  const listing = git("ls-tree", "--name-only", `${ref}:${AUDIT_DIR}`);
  const ids = new Set();
  if (!listing) return ids;
  for (const name of listing.split("\n")) {
    if (!name.startsWith(VERIFICATION_PREFIX) || !name.endsWith(".md")) continue;
    const middle = name.slice(VERIFICATION_PREFIX.length, -".md".length);
    // Trailing `-YYYY-MM-DD`. Stripped by shape rather than by splitting on
    // "-", which every model id also contains.
    ids.add(middle.replace(/-\d{4}-\d{2}-\d{2}$/, "").toLowerCase());
  }
  return ids;
};

/** One branch's content, read from git rather than from the working tree. */
const branchState = (branch) => {
  const ref = refByBranch.get(branch);
  const cache = new Map();
  const readFile = (path) => {
    if (!cache.has(path)) cache.set(path, git("show", `${ref}:${path}`));
    return cache.get(path);
  };
  const pricingSource = readFile(MODEL_PRICING_PATH);
  const pricing = pricingSource
    ? parseModelPricingSource(pricingSource)
    : { pricedModelIds: new Set(), pendingPriceModelIds: new Set() };
  return {
    readFile,
    ...pricing,
    pricingVerificationRecords: pricingVerificationRecords(ref),
  };
};

const states = new Map(
  [...refByBranch.keys()].map((branch) => [branch, branchState(branch)])
);

// The positional split in parseModelPricingSource is a shortcut, not a parse.
// Checking it against the imported module is what makes the shortcut safe: if
// the file is ever reordered so the split lands in the wrong place, every
// pricing verdict this tool prints would be wrong, and silently.
const verifyPricingParser = () => {
  const source = readFileSync(new URL("../lib/modelPricing.ts", import.meta.url), "utf8");
  const parsed = parseModelPricingSource(source);
  const imported = {
    priced: new Set(MODEL_PRICING.map((profile) => profile.modelId.toLowerCase())),
    pending: new Set(
      PENDING_VERIFIED_PRICE_MODEL_IDS.map((id) => id.toLowerCase())
    ),
  };
  const difference = (left, right) => [...left].filter((id) => !right.has(id));
  const problems = [
    ...difference(parsed.pricedModelIds, imported.priced).map(
      (id) => `parsed ${id} as a profile, the module does not have one`
    ),
    ...difference(imported.priced, parsed.pricedModelIds).map(
      (id) => `the module has a profile for ${id}, the parser missed it`
    ),
    ...difference(parsed.pendingPriceModelIds, imported.pending).map(
      (id) => `parsed ${id} as pending verification, the module does not list it`
    ),
    ...difference(imported.pending, parsed.pendingPriceModelIds).map(
      (id) => `the module lists ${id} as pending verification, the parser missed it`
    ),
  ];
  if (problems.length > 0) {
    console.error(
      `${MODEL_PRICING_PATH} no longer matches what report-issue-backlog-core.mjs assumes:`
    );
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
};

const readRepositoryIssues = () => {
  const payload = JSON.parse(readFileSync(issuesFile, "utf8"));
  const list = Array.isArray(payload)
    ? payload
    : (payload?.issues ?? payload?.items ?? []);
  return normaliseIssues(list);
};

const normaliseIssues = (list) =>
  list
    // A pull request is an issue in GitHub's data model and is not backlog.
    .filter((entry) => !entry.pull_request)
    .filter((entry) => typeof entry.number === "number" && entry.title)
    .map((entry) => ({ number: entry.number, title: entry.title }));

const repositorySlug = () => {
  const url = git("remote", "get-url", "origin")?.trim();
  const match = url?.match(/github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/.]+)/);
  return match ? { owner: match.groups.owner, repo: match.groups.repo } : null;
};

const fetchOpenIssues = async () => {
  if (issuesFile) return readRepositoryIssues();

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const slug = repositorySlug();
  if (!token || !slug) {
    throw new Error(
      "No issue source. Set GITHUB_TOKEN, or pass --issues-file with a saved issue list."
    );
  }

  const issues = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetch(
      `https://api.github.com/repos/${slug.owner}/${slug.repo}/issues` +
        `?state=open&per_page=100&page=${page}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
        },
      }
    );
    if (!response.ok) {
      throw new Error(`GitHub returned ${response.status} listing open issues.`);
    }
    const batch = await response.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    issues.push(...normaliseIssues(batch));
    if (batch.length < 100) break;
  }
  return issues;
};

const LABELS = {
  [VERDICTS.RESOLVED_IN_CODE]: "resolved in code",
  [VERDICTS.CODE_COMPLETE_REMAINDER]: "code complete, stated remainder left",
  [VERDICTS.RESOLVED_NOT_ON_ALL_BRANCHES]: "resolved on some branches only",
  [VERDICTS.LANDED_BUT_UNVERIFIED]: "commits landed, completion unverified",
  [VERDICTS.BLOCKED]: "blocked, not startable",
  [VERDICTS.OPEN_WORK]: "open work",
};

const numbers = (issues) => issues.map((issue) => `#${issue.number}`).join(", ");

verifyPricingParser();

let openIssues;
try {
  openIssues = await fetchOpenIssues();
} catch (error) {
  // A missing token or an unreadable file is an ordinary way to run this
  // wrong, and a stack trace answers none of it.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const report = auditIssueBacklog({
  issues: openIssues,
  facts: {
    refs: [...refByBranch.keys()],
    stateAt: (branch) => states.get(branch),
    commitsByIssue: collectCommitsByIssue(),
  },
});

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `Open issues: ${report.classified.length}  (release branches: ${[...refByBranch.values()].join(", ")})\n`
  );
  for (const issue of report.classified) {
    console.log(`#${issue.number}  ${issue.title}`);
    console.log(`  verdict: ${LABELS[issue.verdict]}`);
    if (issue.missingFrom.length > 0 && issue.resolvedOn.length > 0) {
      console.log(
        `  on ${issue.resolvedOn.join(", ")}; still missing from ${issue.missingFrom.join(", ")}`
      );
    }
    for (const signal of issue.signals) {
      const where = signal.ref ? `@${signal.ref}` : "";
      console.log(`  [${signal.kind}${where}] ${signal.detail}`);
    }
    if (issue.remainder) console.log(`  remaining: ${issue.remainder}`);
    if (issue.blockedOn) console.log(`  blocked on: ${issue.blockedOn}`);
    console.log("");
  }

  console.log(
    `Candidates for the next task: ${
      report.candidates.length === 0
        ? "none -- every open issue is already answered by the repository."
        : numbers(report.candidates)
    }`
  );
  if (report.staleOpen.length > 0) {
    console.log(`Open but already done: ${numbers(report.staleOpen)}`);
  }
  if (report.awaitingPromotion.length > 0) {
    console.log(
      `Done on some branches, awaiting promotion: ${numbers(report.awaitingPromotion)}`
    );
  }
  if (report.needsReview.length > 0) {
    console.log(`Needs a person to confirm: ${numbers(report.needsReview)}`);
  }
  if (report.blocked.length > 0) {
    // Deliberately printed beside the candidates rather than among them: these
    // are open and unfinished, and still must not be started.
    console.log(
      `Blocked, do not start: ${numbers(report.blocked)} -- see "blocked on" above`
    );
  }
}

// Reporting only. A stale tracker is not a build failure, and making it one
// would put every unclosed issue in the path of an unrelated pull request. The
// one non-zero exit above is different in kind: it means this tool's own reading
// of lib/modelPricing.ts is broken, so its output cannot be trusted.
process.exit(0);
