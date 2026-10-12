import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  goalPosition,
  goalSpecsFromText,
  listingReachedStart,
  normalisePullRequests,
  parseGoalStepDeclaration,
  repositoryDeclarationStats,
  SIDE_WORK_CHAIN_N,
  STEP_CHURN_M,
  STEP_STALL_HOURS,
  validateGoalSpec,
} from "../scripts/report-goal-position-core.mjs";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-10T00:00:00Z");
const iso = (hours) => new Date(T0 + hours * HOUR).toISOString();

const goal = (overrides = {}) => validateGoalSpec({
  goal: "AMUX-V22-ACT",
  title: "Activate v22 intake, claim and Task execution",
  since: iso(0),
  steps: [
    { id: "LATCH", title: "Code latches on main", evidence: "completing_pr_merged", base: "main" },
    { id: "ENV", title: "Environment values on", evidence: "operator_confirmed" },
    { id: "FIRST-TASK", title: "First Task executed", evidence: "operator_confirmed" },
  ],
  ...overrides,
}).goal;

let next = 1000;
const pr = (line, { created = 1, merged = null, base = "develop", head = "codex/work", title = "work" } = {}) => ({
  number: next++,
  title,
  body: line === null ? "No declaration here." : `Summary.\n\n${line}\n`,
  baseRefName: base,
  headRefName: head,
  createdAt: iso(created),
  mergedAt: merged === null ? null : iso(merged),
});

test("a Goal-Step line is read in its four forms, and anything else is missing or invalid", () => {
  assert.deepEqual(parseGoalStepDeclaration("Goal-Step: CHAT-01/B07"), { kind: "step", goal: "CHAT-01", step: "B07" });
  assert.deepEqual(parseGoalStepDeclaration("x\n  Goal-Step: CHAT-01/B07 completes  \r\ny"),
    { kind: "completes", goal: "CHAT-01", step: "B07" });
  assert.deepEqual(parseGoalStepDeclaration("Goal-Step: CHAT-01/-"), { kind: "side", goal: "CHAT-01" });
  assert.deepEqual(parseGoalStepDeclaration("Goal-Step: CHAT-01/op"), { kind: "op", goal: "CHAT-01" });
  assert.deepEqual(parseGoalStepDeclaration(""), { kind: "missing" });
  assert.deepEqual(parseGoalStepDeclaration(null), { kind: "missing" });
  assert.deepEqual(parseGoalStepDeclaration("goal-step: CHAT-01/B07"), { kind: "missing" }, "the key is case-sensitive");
  for (const bad of [
    "Goal-Step: chat-01/B07",
    "Goal-Step: CHAT-01",
    "Goal-Step: CHAT-01/B07 done",
    "Goal-Step: CHAT-01/- completes",
    "Goal-Step: CHAT-01/op completes",
    "Goal-Step: CHAT-01/B07 그 단계의 작업",
    `Goal-Step: ${"A".repeat(41)}/B07`,
    "Goal-Step: CHAT-01/B07\nGoal-Step: CHAT-01/B07",
  ]) {
    assert.equal(parseGoalStepDeclaration(bad).kind, "invalid", bad);
  }
});

test("a body that quotes the grammar in a code block has not declared anything", () => {
  const body = "How to declare:\n\n```\nGoal-Step: <goal>/<step>\nGoal-Step: CHAT-01/B07\n```\n";
  assert.deepEqual(parseGoalStepDeclaration(body), { kind: "missing" });
  assert.deepEqual(parseGoalStepDeclaration(`${body}\nGoal-Step: CHAT-01/-\n`), { kind: "side", goal: "CHAT-01" });
  assert.deepEqual(parseGoalStepDeclaration("~~~\nGoal-Step: CHAT-01/B07\n~~~"), { kind: "missing" });
});

test("a checklist is validated strictly, so a misspelt field cannot silently reopen a step", () => {
  assert.ok(goal());
  const problems = (spec) => validateGoalSpec(spec).problems ?? [];
  const base = { goal: "CHAT-01", title: "t", since: iso(0), steps: [{ id: "A", title: "a", evidence: "operator_confirmed" }] };
  assert.deepEqual(problems(base), []);
  assert.match(problems({ ...base, extra: 1 }).join(), /unknown field extra/);
  assert.match(problems({ ...base, steps: [{ ...base.steps[0], confirmedAT: iso(1) }] }).join(), /unknown field confirmedAT/);
  assert.match(problems({ ...base, goal: "chat-01" }).join(), /goal:/);
  assert.match(problems({ ...base, since: "2026-10-10" }).join(), /since:/);
  assert.match(problems({ ...base, steps: [] }).join(), /steps:/);
  assert.match(problems({ ...base, steps: [{ ...base.steps[0], id: "op" }] }).join(), /not '-' or 'op'/);
  assert.match(problems({ ...base, steps: [base.steps[0], base.steps[0]] }).join(), /appears twice/);
  assert.match(problems({ ...base, steps: [{ ...base.steps[0], base: "main" }] }).join(), /only for completing_pr_merged/);
  assert.match(problems({ ...base, steps: [{ id: "A", title: "a", evidence: "completing_pr_merged", confirmedAt: iso(1) }] }).join(),
    /only for operator_confirmed/);
  assert.match(problems({ ...base, steps: [{ id: "A", title: "a", evidence: "pr" }] }).join(), /evidence:/);
  assert.equal(validateGoalSpec({ ...base, steps: [{ id: "A", title: "a", evidence: "completing_pr_merged" }] }).goal.steps[0].base,
    "develop", "a completing PR lands on develop unless the step says main");
});

test("a Markdown checklist carries one goal per goal-steps block", () => {
  const block = (id) => "```goal-steps\n" + JSON.stringify({ goal: id, title: id, since: iso(0),
    steps: [{ id: "S1", title: "one", evidence: "operator_confirmed" }] }) + "\n```";
  const result = goalSpecsFromText(`# Work item\n\n${block("CHAT-01")}\n\ntext\n\n${block("AMUX-01")}\n`, { markdown: true });
  assert.deepEqual(result.goals.map((g) => g.goal), ["CHAT-01", "AMUX-01"]);
  assert.match(goalSpecsFromText("# nothing here", { markdown: true }).problems.join(), /no ```goal-steps block/);
  assert.match(goalSpecsFromText("```goal-steps\n{not json\n```", { markdown: true }).problems.join(), /not JSON/);
  const wrapped = goalSpecsFromText(JSON.stringify({ goals: [JSON.parse(block("CHAT-01").split("\n")[1])] }), { markdown: false });
  assert.deepEqual(wrapped.goals.map((g) => g.goal), ["CHAT-01"]);
});

test("pull requests are read from gh's shape and from the REST shape", () => {
  const [gh, rest] = normalisePullRequests([
    { number: 1, title: "a", body: "Goal-Step: CHAT-01/-", baseRefName: "develop", headRefName: "x", createdAt: iso(1), mergedAt: iso(2) },
    { number: 2, title: "b", body: null, base: { ref: "main" }, head: { ref: "release/y" }, created_at: iso(1), merged_at: null },
    { title: "no number" },
  ]);
  assert.deepEqual([gh.base, gh.head, gh.mergedAt, gh.declaration.kind], ["develop", "x", iso(2), "side"]);
  assert.deepEqual([rest.base, rest.head, rest.mergedAt, rest.declaration.kind], ["main", "release/y", null, "missing"]);
});

test("a goal no pull request declares is insufficient evidence, not on track", () => {
  const position = goalPosition(goal(), normalisePullRequests([pr(null, { merged: 2 })]), T0 + 30 * HOUR);
  assert.equal(position.state, "insufficient_evidence");
  assert.equal(position.declaredEver, 0);
});

test("a step finishes only on its completing PR merged to its own base, and a rejected one does not count", () => {
  const prs = normalisePullRequests([
    pr("Goal-Step: AMUX-V22-ACT/LATCH completes", { merged: 2, base: "develop" }),
    pr("Goal-Step: AMUX-V22-ACT/LATCH", { merged: 3, base: "main" }),
  ]);
  const notYet = goalPosition(goal(), prs, T0 + 4 * HOUR);
  assert.equal(notYet.steps[0].done, false, "develop is not the step's base, and a plain step PR completes nothing");
  const onMain = pr("Goal-Step: AMUX-V22-ACT/LATCH completes", { merged: 5, base: "main" });
  const done = goalPosition(goal(), [...prs, ...normalisePullRequests([onMain])], T0 + 6 * HOUR);
  assert.deepEqual([done.steps[0].done, done.steps[0].doneBy, done.baselineFrom], [true, `#${onMain.number}`, "step LATCH"]);
  const rejected = validateGoalSpec({ goal: "AMUX-V22-ACT", title: "t", since: iso(0), steps: [
    { id: "LATCH", title: "l", evidence: "completing_pr_merged", base: "main", rejectedPrs: [onMain.number] }] }).goal;
  assert.equal(goalPosition(rejected, normalisePullRequests([onMain]), T0 + 6 * HOUR).steps[0].done, false);
});

test("an operator-confirmed step is done at its confirmation time", () => {
  const confirmed = goal({ steps: [{ id: "ENV", title: "env", evidence: "operator_confirmed", confirmedAt: iso(8) }] });
  const position = goalPosition(confirmed, normalisePullRequests([pr("Goal-Step: AMUX-V22-ACT/ENV", { merged: 7 })]), T0 + 9 * HOUR);
  assert.deepEqual([position.completed, position.baselineAt, position.steps[0].doneBy], [1, iso(8), "operator"]);
});

test("side work after the last finished step drifts at N; side work before it does not count", () => {
  const latch = pr("Goal-Step: AMUX-V22-ACT/LATCH completes", { merged: 10, base: "main" });
  const before = [1, 2, 3, 4].map((h) => pr("Goal-Step: AMUX-V22-ACT/-", { created: h, merged: h + 0.5 }));
  const after = (n) => Array.from({ length: n }, (_, i) => pr("Goal-Step: AMUX-V22-ACT/-", { created: 11 + i, merged: 11.5 + i }));
  const at = (prs) => goalPosition(goal(), normalisePullRequests([latch, ...before, ...prs]), T0 + 20 * HOUR);
  assert.equal(at(after(SIDE_WORK_CHAIN_N - 1)).signals.sideWorkChain.fired, false);
  const drifting = at(after(SIDE_WORK_CHAIN_N));
  assert.deepEqual([drifting.signals.sideWorkChain.value, drifting.state], [SIDE_WORK_CHAIN_N, "drifting"]);
});

test("no step for X hours is attention only when declared work happened in that time", () => {
  const work = pr("Goal-Step: AMUX-V22-ACT/ENV", { created: 1, merged: 2 });
  const quiet = goalPosition(goal(), normalisePullRequests([work]), T0 + (STEP_STALL_HOURS - 0.1) * HOUR);
  assert.deepEqual([quiet.signals.stepStall.fired, quiet.state], [false, "on_track"]);
  const stalled = goalPosition(goal(), normalisePullRequests([work]), T0 + STEP_STALL_HOURS * HOUR);
  assert.deepEqual([stalled.signals.stepStall.fired, stalled.state], [true, "attention"]);
  // Declared work only before the last finished step: the goal is idle, not stalled.
  const confirmed = goal({ steps: [{ id: "ENV", title: "env", evidence: "operator_confirmed", confirmedAt: iso(3) }] });
  const idle = goalPosition(confirmed, normalisePullRequests([work]), T0 + 30 * HOUR);
  assert.deepEqual([idle.signals.stepStall.active, idle.signals.stepStall.fired], [false, false]);
});

test("a step that keeps absorbing pull requests without finishing is churn at M; a finished one is not", () => {
  const onEnv = (n) => Array.from({ length: n }, (_, i) => pr("Goal-Step: AMUX-V22-ACT/ENV", { created: 1 + i * 0.1, merged: 1.05 + i * 0.1 }));
  const now = T0 + 2 * HOUR;
  assert.equal(goalPosition(goal(), normalisePullRequests(onEnv(STEP_CHURN_M - 1)), now).signals.stepChurn.fired, false);
  const churn = goalPosition(goal(), normalisePullRequests(onEnv(STEP_CHURN_M)), now);
  assert.deepEqual([churn.signals.stepChurn.steps, churn.state], [[{ id: "ENV", count: STEP_CHURN_M }], "attention"]);
});

test("operator requests are counted and change no state", () => {
  const prs = normalisePullRequests(Array.from({ length: 5 }, (_, i) => pr("Goal-Step: AMUX-V22-ACT/op", { created: 1 + i * 0.1, merged: 1.05 + i * 0.1 })));
  const position = goalPosition(goal(), prs, T0 + 2 * HOUR);
  assert.deepEqual([position.signals.operatorDisplacement.value, position.state], [5, "on_track"]);
});

test("another goal's declarations are not this goal's work", () => {
  const prs = normalisePullRequests(Array.from({ length: 4 }, (_, i) => pr("Goal-Step: CHAT-01/-", { created: 1 + i, merged: 1.5 + i })));
  assert.equal(goalPosition(goal(), prs, T0 + 10 * HOUR).state, "insufficient_evidence");
});

test("repository statistics count recent merged work and leave release, back-merge and bot branches out", () => {
  const now = T0 + 24 * HOUR;
  const prs = normalisePullRequests([
    pr("Goal-Step: CHAT-01/B07", { merged: 20 }),
    pr(null, { merged: 20 }),
    pr("Goal-Step: CHAT-01/B07\nGoal-Step: CHAT-01/-", { merged: 20 }),
    pr(null, { merged: 20, head: "release/2026-10-10-x" }),
    pr(null, { merged: 20, head: "claude/to-develop/back-merge-main-1" }),
    pr(null, { merged: 20, head: "dependabot/npm/x" }),
    pr(null, { merged: 20, head: "claude/hotfix/x" }),
    pr(null, { merged: -24 * 8 }),
    pr(null, { merged: null }),
  ]);
  const stats = repositoryDeclarationStats(prs, now);
  assert.deepEqual([stats.merged, stats.declared, stats.missing, stats.invalid.length], [3, 1, 1, 1]);
  assert.match(stats.invalid[0].reason, /more than one/);
});

test("the command reports from a checklist and a saved pull request list, and refuses a bad checklist", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-position-"));
  try {
    const checklist = join(dir, "goal.md");
    writeFileSync(checklist, "# Goal\n\n```goal-steps\n" + JSON.stringify({ goal: "AMUX-V22-ACT", title: "Activation",
      since: "2026-10-10T00:00:00Z", steps: [{ id: "ENV", title: "Environment on", evidence: "operator_confirmed" }] }) + "\n```\n");
    const prsFile = join(dir, "prs.json");
    writeFileSync(prsFile, JSON.stringify([
      { number: 1, title: "side", body: "Goal-Step: AMUX-V22-ACT/-", baseRefName: "develop", headRefName: "codex/a",
        createdAt: "2026-10-10T01:00:00Z", mergedAt: "2026-10-10T02:00:00Z" },
    ]));
    const run = (...extra) => spawnSync(process.execPath, ["scripts/report-goal-position.mjs", "--goal-file", checklist, "--prs-file", prsFile, ...extra],
      { encoding: "utf8", env: { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "" } });
    const text = run();
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /AMUX-V22-ACT — Activation/);
    assert.match(text.stdout, /Steps: 0\/1 done/);
    assert.match(text.stdout, /AEST/);
    const json = JSON.parse(run("--json").stdout);
    assert.equal(json.positions[0].sinceBaseline.side, 1);
    writeFileSync(checklist, "```goal-steps\n{\"goal\":\"bad\"}\n```\n");
    const refused = run();
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /goal: an id like CHAT-01/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fences close only on the same character, at least as long, with nothing after it", () => {
  const missing = (body) => assert.deepEqual(parseGoalStepDeclaration(body), { kind: "missing" }, body);
  // A four-backtick example quoting a three-backtick one stays one block.
  missing("````md\n```\nGoal-Step: CHAT-01/B07 completes\n```\n````\n");
  missing("````\nx\n```\nGoal-Step: CHAT-01/B07\n````");
  missing("~~~\n```\nGoal-Step: CHAT-01/B07\n~~~");
  missing("```\n```js\nGoal-Step: CHAT-01/B07\n```");
  // An unclosed block runs to the end.
  missing("```\nGoal-Step: CHAT-01/B07");
  // A longer closing fence closes; the declaration after it counts.
  assert.deepEqual(parseGoalStepDeclaration("```\nx\n`````\nGoal-Step: CHAT-01/-"), { kind: "side", goal: "CHAT-01" });
});

test("a goal-steps block with a longer closing fence is read, and an unclosed one is refused", () => {
  const json = JSON.stringify({ goal: "CHAT-01", title: "t", since: iso(0), steps: [{ id: "A", title: "a", evidence: "operator_confirmed" }] });
  assert.deepEqual(goalSpecsFromText("```goal-steps\n" + json + "\n`````\n", { markdown: true }).goals.map((g) => g.goal), ["CHAT-01"]);
  assert.deepEqual(goalSpecsFromText("````goal-steps\n" + json + "\n````", { markdown: true }).goals.map((g) => g.goal), ["CHAT-01"]);
  assert.match(goalSpecsFromText("```goal-steps\n" + json + "\n", { markdown: true }).problems.join(), /not closed/);
});

test("an open step's churn is cumulative and survives another step finishing", () => {
  const onEnv = Array.from({ length: STEP_CHURN_M }, (_, i) => pr("Goal-Step: AMUX-V22-ACT/ENV", { created: 1 + i * 0.1, merged: 1.05 + i * 0.1 }));
  const latch = pr("Goal-Step: AMUX-V22-ACT/LATCH completes", { created: 1.9, merged: 2, base: "main" });
  const position = goalPosition(goal(), normalisePullRequests([...onEnv, latch]), T0 + 3 * HOUR);
  assert.equal(position.baselineFrom, "step LATCH");
  assert.deepEqual(position.signals.stepChurn.steps, [{ id: "ENV", count: STEP_CHURN_M }]);
  assert.equal(position.state, "attention");
});

test("work and evidence from before the goal started are not this goal's", () => {
  const early = pr("Goal-Step: AMUX-V22-ACT/LATCH completes", { created: -6, merged: -5, base: "main" });
  const position = goalPosition(goal(), normalisePullRequests([early]), T0 + 3 * HOUR);
  assert.deepEqual([position.steps[0].done, position.declaredEver, position.state], [false, 0, "insufficient_evidence"]);
  // Created before the start but merged after it: that merge is evidence.
  const straddling = pr("Goal-Step: AMUX-V22-ACT/LATCH completes", { created: -6, merged: 1, base: "main" });
  assert.equal(goalPosition(goal(), normalisePullRequests([straddling]), T0 + 3 * HOUR).steps[0].done, true);
});

test("a time that does not parse is no time, and does not break the report", () => {
  const [broken] = normalisePullRequests([{ number: 7, body: "Goal-Step: AMUX-V22-ACT/LATCH completes", baseRefName: "main",
    headRefName: "x", createdAt: "yesterday", mergedAt: "soon" }]);
  assert.deepEqual([broken.createdAt, broken.mergedAt], [null, null]);
  const position = goalPosition(goal(), [broken], T0 + 3 * HOUR);
  assert.deepEqual([position.steps[0].done, position.state], [false, "insufficient_evidence"]);
});

test("a newest-first listing is complete only when it reaches back past the start", () => {
  const start = T0;
  const page = (n, updated) => Array.from({ length: n }, () => ({ updated_at: iso(updated) }));
  assert.equal(listingReachedStart(page(40, 5), start), true, "a short page is the end of the list");
  assert.equal(listingReachedStart(page(100, -1), start), true);
  assert.equal(listingReachedStart(page(100, 1), start), false);
  assert.equal(listingReachedStart(Array.from({ length: 100 }, () => ({ updated_at: "?" })), start), false);
});

test("the command refuses the same goal in two checklists", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-position-dup-"));
  try {
    const one = JSON.stringify({ goal: "CHAT-01", title: "t", since: "2026-10-10T00:00:00Z",
      steps: [{ id: "A", title: "a", evidence: "operator_confirmed" }] });
    writeFileSync(join(dir, "a.json"), one);
    writeFileSync(join(dir, "b.json"), one);
    writeFileSync(join(dir, "prs.json"), "[]");
    const run = spawnSync(process.execPath, ["scripts/report-goal-position.mjs", "--goal-file", join(dir, "a.json"),
      "--goal-file", join(dir, "b.json"), "--prs-file", join(dir, "prs.json")], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /more than one checklist: CHAT-01/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an indented code block is an example: four columns of indentation make no fence and no declaration", () => {
  const json = JSON.stringify({ goal: "CHAT-01", title: "t", since: iso(0), steps: [{ id: "A", title: "a", evidence: "operator_confirmed" }] });
  const indented = (text) => text.split("\n").map((line) => `    ${line}`).join("\n");
  assert.match(goalSpecsFromText(`Example:\n\n${indented("```goal-steps\n" + json + "\n```")}\n`, { markdown: true }).problems.join(),
    /no ```goal-steps block/);
  assert.match(goalSpecsFromText(`Example:\n\n\t\`\`\`goal-steps\n\t${json}\n\t\`\`\`\n`, { markdown: true }).problems.join(),
    /no ```goal-steps block/, "a tab counts as four columns");
  // Up to three columns is still a fence and still a declaration.
  assert.deepEqual(goalSpecsFromText("   ```goal-steps\n" + json + "\n   ```", { markdown: true }).goals.map((g) => g.goal), ["CHAT-01"]);
  assert.deepEqual(parseGoalStepDeclaration("Example:\n\n    Goal-Step: CHAT-01/B07 completes\n"), { kind: "missing" });
  assert.deepEqual(parseGoalStepDeclaration("  Goal-Step: CHAT-01/B07"), { kind: "step", goal: "CHAT-01", step: "B07" });
  // An indented fence-looking line inside a block does not close it.
  assert.deepEqual(parseGoalStepDeclaration("```\n    ```\nGoal-Step: CHAT-01/B07\n```"), { kind: "missing" });
});
