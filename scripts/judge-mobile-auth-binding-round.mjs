// Judges one three-sample binding round from the verifier's own run summaries.
//
//   npm run judge:mobile-auth-binding-round -- --round 1 \
//     run-1.json run-2.json run-3.json
//
// Each file is what `verify:mobile-auth-deployment` wrote when
// MOBILE_AUTH_VERIFY_SUMMARY_PATH was set on that run. They hold no token, no
// digest and no key material -- deployment ids, two timestamps and verdicts.
//
// Why this exists rather than a person reading three consoles: E5 judges the
// three samples *together* and re-checks every one of them at the moment of
// judgement, so an earlier pass is not carried forward. Doing that by hand
// means retyping `iat` and `exp` off tokens.
//
// What a met sample condition is NOT: proof that the deployment is stable, that
// no older instance is still serving, or that this evidence came from the new
// version. See scripts/mobile-auth-binding-round-core.mjs.
//
// Procedure: docs/ops/mobile-auth-key-rotation.md

import { readFileSync } from "node:fs";

import {
  MOBILE_BINDING_ROUND_SAMPLES,
  judgeMobileBindingRound,
} from "./mobile-auth-binding-round-core.mjs";

const argv = process.argv.slice(2);
const paths = [];
let round = null;
let resumeApprovedBy = "";

for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index];
  if (argument === "--round") {
    round = Number(argv[index + 1]);
    index += 1;
  } else if (argument.startsWith("--round=")) {
    round = Number(argument.slice("--round=".length));
  } else if (argument === "--resumed-by") {
    resumeApprovedBy = argv[index + 1] ?? "";
    index += 1;
  } else if (argument.startsWith("--resumed-by=")) {
    resumeApprovedBy = argument.slice("--resumed-by=".length);
  } else {
    paths.push(argument);
  }
}

const fail = (message) => {
  console.log("Mobile auth binding round");
  console.log(`FAIL binding round: ${message}`);
  process.exit(1);
};

if (paths.length !== MOBILE_BINDING_ROUND_SAMPLES) {
  fail(
    `expected ${MOBILE_BINDING_ROUND_SAMPLES} run summaries, got ${paths.length}.\n` +
      "  A partial round is not judged on what arrived: collect all three, or\n" +
      "  record the round as undetermined."
  );
}

const samples = paths.map((path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    // The path is the operator's own argument, so echoing it tells them nothing
    // they did not type; the parse error is the file's shape, never its values.
    fail(`could not read ${path} (${error.message})`);
    return null;
  }
});

const judgedAtSeconds = Math.floor(Date.now() / 1000);
const result = judgeMobileBindingRound({
  samples,
  round,
  resumeApprovedBy,
  judgedAtSeconds,
});

console.log("Mobile auth binding round");
console.log(`  round        ${round ?? "(not given)"}`);
console.log(`  judged at    ${new Date(judgedAtSeconds * 1000).toISOString()}`);
console.log(`  verdict      ${result.verdict}`);
for (const reason of result.reasons) console.log(`  -            ${reason}`);
if (result.record) {
  console.log("");
  console.log("  Record this round with these lines, the caveat included --");
  console.log("  a probability written down without it reads as a measurement:");
  console.log(`    round: ${result.record.round}`);
  console.log(`    resumption decided by: ${result.record.resumeDecidedBy ?? "(first round)"}`);
  console.log(`    illustrative miss probability: ${result.record.illustrativeMiss}`);
  console.log(`    ${result.record.modelCaveat}`);
}
console.log("");

if (result.verdict === "sample_condition_met") {
  console.log(
    "PASS binding round: the three samples met the condition E5 states.\n" +
      "  NOT established: that the deployment is stable, that no older instance is\n" +
      "  still serving, or that this evidence came from the new version. A fourth\n" +
      "  sample could name a different deployment and this round would not know.\n" +
      "  This is one input to promotion, not the promotion condition:\n" +
      "  docs/ops/mobile-auth-key-rotation.md"
  );
  process.exit(0);
}

if (result.verdict === "halt") {
  console.log(
    "STOP binding round: every sample names the same unexpected deployment.\n" +
      "  Do not open another round -- it would sample the same thing again. Find\n" +
      "  out what is serving before continuing:\n" +
      "  docs/ops/mobile-auth-key-rotation.md"
  );
  process.exit(1);
}

if (result.verdict === "refused") {
  console.log(
    "REFUSED binding round: this round cannot be judged as it was submitted.\n" +
      "  A second or later round on the same deployment needs a person to decide\n" +
      "  the resumption and be named in the record (--resumed-by): reopening a\n" +
      "  round is a retry under another name, and a record is an observation\n" +
      "  rather than a control."
  );
  process.exit(1);
}

console.log(
  "UNDETERMINED binding round: nothing was decided.\n" +
    "  Not a pass and not a defect. Do NOT promote, roll back, restore or disable\n" +
    "  anything on the strength of this round, and do NOT re-sample to get a\n" +
    "  different answer -- sampling until it passes re-draws the pass condition.\n" +
    "  Opening another round on the same deployment is a person's decision:\n" +
    "  docs/ops/mobile-auth-key-rotation.md"
);
process.exit(1);
