// Where each long goal stands against its step checklist, from the Goal-Step
// line in pull request bodies. Read-only: it writes nothing, anywhere.
//
// See scripts/report-goal-position-core.mjs for what is counted and why.
//
// Usage:
//   npm run report:goal-position -- --goal-file <checklist> [--goal-file <another>] [--json]
//   npm run report:goal-position -- --goal-file <checklist> --prs-file prs.json
//
// The checklist is JSON, or Markdown with one ```goal-steps block per goal
// holding the same JSON. A goal is:
//   { "goal": "CHAT-01", "title": "...", "since": "2026-10-10T00:00:00Z",
//     "steps": [
//       { "id": "B07", "title": "...", "evidence": "completing_pr_merged", "base": "develop" },
//       { "id": "ENV-ON", "title": "...", "evidence": "operator_confirmed",
//         "confirmedAt": "2026-10-11T03:00:00Z" } ] }
//
// Pull requests come from --prs-file (the output of `gh pr list --state all
// --json number,title,body,baseRefName,headRefName,createdAt,mergedAt`, or a
// saved REST response), or else from the GitHub REST API with GITHUB_TOKEN,
// GH_TOKEN or the token of a logged-in `gh`. The token is never printed.
// Only the Goal-Step line of each body is kept.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  goalPosition,
  goalSpecsFromText,
  normalisePullRequests,
  repositoryDeclarationStats,
  REPOSITORY_WINDOW_DAYS,
} from "./report-goal-position-core.mjs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");

const values = (flag) => {
  const found = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      console.error(`${flag} needs a value.`);
      process.exit(1);
    }
    found.push(value);
  }
  return found;
};

const goalFiles = values("--goal-file");
const prsFile = values("--prs-file")[0] ?? null;
const repository = values("--repo")[0] ?? "mposition/Tomverse";
if (goalFiles.length === 0) {
  console.error("Pass --goal-file <checklist>. See the header of scripts/report-goal-position.mjs for its shape.");
  process.exit(1);
}
if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
  console.error("--repo is owner/name.");
  process.exit(1);
}

const goals = [];
for (const file of goalFiles) {
  const result = goalSpecsFromText(readFileSync(file, "utf8"), { markdown: /\.md$/i.test(file) });
  if (result.problems) {
    console.error(`${file}:`);
    for (const problem of result.problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  goals.push(...result.goals);
}

const token = () => {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  const gh = spawnSync("gh", ["auth", "token"], { encoding: "utf8", shell: process.platform === "win32" });
  return gh.status === 0 ? gh.stdout.trim() : "";
};

/** Every pull request updated since the oldest goal start, newest first. */
const fetchPullRequests = async (oldest) => {
  const secret = token();
  if (!secret) {
    throw new Error("No pull request source. Set GITHUB_TOKEN, log in with gh, or pass --prs-file.");
  }
  const found = [];
  for (let page = 1; page <= 30; page += 1) {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`,
      { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${secret}` } }
    );
    if (!response.ok) throw new Error(`GitHub returned ${response.status} listing pull requests.`);
    const batch = await response.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    found.push(...batch);
    if (batch.length < 100 || Date.parse(batch.at(-1).updated_at) < oldest) break;
  }
  return found;
};

const now = Date.now();
const oldest = Math.min(...goals.map((goal) => Date.parse(goal.since)), now - REPOSITORY_WINDOW_DAYS * 86_400_000);
let raw;
try {
  raw = prsFile ? JSON.parse(readFileSync(prsFile, "utf8")) : await fetchPullRequests(oldest);
} catch (error) {
  // No position is reported without its source: a goal with no pull requests
  // read would otherwise look like a goal with nothing declared.
  console.error(error.message);
  process.exit(1);
}
const pullRequests = normalisePullRequests(raw);
const positions = goals.map((goal) => goalPosition(goal, pullRequests, now));
const repositoryStats = repositoryDeclarationStats(pullRequests, now);

if (asJson) {
  console.log(JSON.stringify({ generatedAt: new Date(now).toISOString(), repository, positions, repository_declarations: repositoryStats }, null, 2));
  process.exit(0);
}

// The operator reads times in Brisbane time (AEST, UTC+10, no daylight saving).
const aest = (iso) => {
  const value = Date.parse(iso);
  return Number.isFinite(value) ? `${new Date(value + 36e5 * 10).toISOString().slice(5, 16).replace("T", " ")} AEST` : "-";
};
const STATE = {
  on_track: "on track",
  attention: "attention",
  drifting: "drifting",
  insufficient_evidence: "insufficient evidence (no pull request declares this goal)",
};

for (const position of positions) {
  const { signals } = position;
  console.log(`\n${position.goal} — ${position.title}`);
  console.log(`  State: ${STATE[position.state]}`);
  console.log(`  Steps: ${position.completed}/${position.total} done; counting from ${position.baselineFrom} at ${aest(position.baselineAt)}`);
  const stepCounts = Object.entries(position.sinceBaseline.stepPrs).map(([id, n]) => `${id} ${n}`).join(", ") || "none";
  console.log(`  Merged since then: step work ${stepCounts}; side work ${position.sinceBaseline.side}; operator requests ${position.sinceBaseline.op}`);
  console.log(`  Signals: side work ${signals.sideWorkChain.value}/${signals.sideWorkChain.threshold}` +
    `${signals.sideWorkChain.fired ? " (fired)" : ""}; no step for ${signals.stepStall.value.toFixed(1)}h/${signals.stepStall.threshold}h` +
    `${signals.stepStall.fired ? " (fired)" : signals.stepStall.active ? "" : " (no declared activity since)"}` +
    `; step churn ${signals.stepChurn.steps.map((s) => `${s.id} ${s.count}`).join(", ") || "none"}/${signals.stepChurn.threshold}` +
    `${signals.stepChurn.fired ? " (fired)" : ""}`);
  for (const step of position.steps) {
    const done = step.done ? `done ${aest(step.doneAt)} by ${step.doneBy}` : "open";
    console.log(`    [${step.done ? "x" : " "}] ${step.id} — ${step.title} (${done})`);
  }
  console.log(`  Last declared pull request: ${position.lastDeclared ? `#${position.lastDeclared.number} ${position.lastDeclared.title}` : "none"}`);
}

console.log(`\nRepository, last ${repositoryStats.windowDays} days (release, hotfix, back-merge and bot branches excluded):`);
console.log(`  merged ${repositoryStats.merged}; declare a step ${repositoryStats.declared}; no Goal-Step line ${repositoryStats.missing}; invalid ${repositoryStats.invalid.length}`);
for (const pr of repositoryStats.invalid) console.log(`    #${pr.number}: ${pr.reason}`);
console.log("\nA report, not a judgement: declarations are the sessions' own claims.");
