// The two model judges against the settled human verdicts, and what the
// pre-registered rule says about them.
//
// Reads three files and writes one. It calls no provider and costs nothing.
// The thresholds are not options here: they are frozen in
// lib/routerJudgeSelection.ts, and a report that could be re-run with a
// different tolerance would be a report with a thumb on it.
//
// Usage:
//   node --import tsx scripts/report-router-judge-comparison.mjs \
//     --human=<human-verdicts.json> \
//     --luna=<...answers.jsonl.<judge>.verdicts.jsonl> \
//     --fable=<route01-independent-<label>.verdicts.jsonl> \
//     --seed=<the run's seed> [--json=<out.json>]

import { readFileSync, writeFileSync } from "node:fs";

import { alignVerdicts, compareJudgesAgainstHumans } from "../lib/routerJudgeComparator.ts";

const die = (m) => { console.error(m); process.exit(1); };
const flag = (n) => { const m = process.argv.find((a) => a.startsWith(`--${n}=`)); return m ? m.slice(n.length + 3) : null; };

const humanPath = flag("human") ?? die("--human=<human-verdicts.json> is required.");
const lunaPath = flag("luna") ?? die("--luna=<verdicts.jsonl> is required.");
const fablePath = flag("fable") ?? die("--fable=<verdicts.jsonl> is required.");
const seed = Number(flag("seed") ?? die("--seed=<integer> is required: the run's own, so the interval is reproducible."));
if (!Number.isInteger(seed) || seed <= 0) die(`--seed must be a positive integer, not "${flag("seed")}".`);

const readJudge = (path) => {
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
  const header = lines.find((l) => l.kind === "header");
  if (!header) die(`${path} has no header line, so it is not a verdict file.`);
  return {
    judge: header.judge,
    bundleDigest: header.bundleDigest,
    verdicts: lines.filter((l) => l.kind === "verdict").map((l) => ({ pairId: l.pairId, verdict: l.verdict })),
  };
};

const human = JSON.parse(readFileSync(humanPath, "utf8"));
const luna = readJudge(lunaPath);
const fable = readJudge(fablePath);
if (luna.bundleDigest !== fable.bundleDigest) die(`the two judges graded different bundles (${luna.bundleDigest} vs ${fable.bundleDigest}).`);

const { aligned, problems } = alignVerdicts({ human, luna: luna.verdicts, fable: fable.verdicts });
if (problems.length > 0) die(`refusing to compare:\n  - ${problems.join("\n  - ")}`);

const report = compareJudgesAgainstHumans(aligned, { seed });
const pp = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}pp`;
const pct = (v) => `${(v * 100).toFixed(1)}%`;

console.log(`Judges against humans — ${report.pairs} settled pair(s) of ${human.length}, seed ${report.seed}, ${report.resamples} resamples`);
console.log(`  human baseline margin  ${pp(report.humanBaselineMarginPp)}`);
for (const j of [report.luna, report.fable]) {
  const id = j.judgeId === "luna" ? luna.judge : fable.judge;
  console.log(`  ${j.judgeId.padEnd(6)} ${String(id).padEnd(28)} shift ${pp(j.marginShiftPp).padStart(9)}  D ${pp(j.marginErrorPp).padStart(9)}  agree ${pct(j.exactAgreement).padStart(6)}  inverted ${pct(j.oppositeVerdictRate)}`);
}
console.log(`  dD = D_luna - D_fable   ${pp(report.marginErrorDifferencePp)}   95% CI [${pp(report.marginErrorDifferenceCi.lowerPp)}, ${pp(report.marginErrorDifferenceCi.upperPp)}]`);
console.log(`  thresholds              T ${report.thresholds.tolerancePp}pp, inversion rail ${pct(report.thresholds.oppositeVerdictCeiling)}`);
console.log(`\n${report.selection.outcome.toUpperCase()}${report.selection.judgeId ? ` — ${report.selection.judgeId}` : ""}`);
for (const r of report.selection.reasons) console.log(`  - ${r}`);
console.log(`\n  activatesSampleSize: ${report.selection.activatesSampleSize}`);
console.log(`  ${report.selection.resolutionCaveat}`);

const out = flag("json");
if (out) { writeFileSync(out, `${JSON.stringify({ ...report, judges: { luna: luna.judge, fable: fable.judge }, bundleDigest: luna.bundleDigest }, null, 2)}\n`); console.log(`\nwritten ${out}`); }
