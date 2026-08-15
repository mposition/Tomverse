// Whether the Auto rollout readiness register may be believed.
//
// The register in lib/autoRolloutReadiness.ts is what stands between "Auto
// works in shadow" and "Auto answers a real person": lib/autoCohort.ts refuses
// to place anybody in the cohort while any entry is `pending`. That makes the
// register worth attacking, and the attack is trivial -- change one word from
// "pending" to "passed".
//
// So this refuses a `passed` entry that does not carry a person, a date, an
// artefact, an evaluated commit, a written summary, a re-attestation deadline
// and its known limitations. An agent may add pending entries and keep their
// notes current; moving one to `passed` is a human attestation, and the commit
// history is the audit record.
//
// Runs on the PR Fast Gate. It also prints the current state, because "which
// gates are outstanding" is the question everyone asks about this rollout and
// the answer should not require reading a TypeScript file.

import {
  AUTO_ROLLOUT_READINESS,
  AUTO_ROLLOUT_READINESS_VERSION,
  autoRolloutReadiness,
} from "../lib/autoRolloutReadiness.ts";
import { autoCohortConfig, decideAutoCohort } from "../lib/autoCohort.ts";

const state = autoRolloutReadiness();

console.log(`Auto rollout readiness — ${AUTO_ROLLOUT_READINESS_VERSION}\n`);

for (const entry of AUTO_ROLLOUT_READINESS) {
  const mark = entry.status === "passed" ? "PASSED " : "pending";
  console.log(`  ${mark}  ${entry.id}`);
  console.log(`           ${entry.title}`);
  if (entry.status === "passed" && entry.evidence) {
    console.log(`           attested by ${entry.attestedBy} on ${entry.attestedAt}`);
    console.log(`           ${entry.evidence.artifactRef} @ ${entry.evidence.evaluatedCommit}`);
    console.log(`           expires ${entry.evidence.expiresAt}`);
  }
}

if (state.problems.length > 0) {
  console.log("\nProblems:");
  for (const problem of state.problems) console.log(`  - ${problem}`);
  console.log(
    "\nA gate that passed because somebody edited a string is indistinguishable\n" +
      "from a real pass unless something demands the evidence. This is that."
  );
  process.exit(1);
}

console.log(
  `\nReady: ${state.ready ? "yes" : "no"}` +
    (state.ready ? "" : ` — outstanding: ${state.outstanding.join(", ")}`)
);

// What the configuration would do if the gates were open. Printed rather than
// enforced: a deployment's environment is not this repository's business, but
// "the rollout percentage is 25 and nobody is being routed" is a confusing
// state to debug without being told which of the two reasons applies.
const config = autoCohortConfig();
console.log("\nCohort configuration in this environment");
console.log(`  kill switch      ${config.killSwitch ? "ON — Auto disabled for everybody" : "off"}`);
console.log(`  rollout percent  ${config.rolloutPercent}`);
console.log(`  eligible plans   ${config.eligiblePlans.join(", ") || "(none)"}`);
console.log(`  cohort salt      ${config.salt}`);

const sample = decideAutoCohort({
  subjectKey: "readiness-check-probe",
  isGuest: false,
  plan: config.eligiblePlans[0] ?? "Pro",
});
console.log(
  `\nA probe account on an eligible plan would be ${sample.eligible ? "ROUTED by Auto" : "left on its own model"}` +
    (sample.eligible ? "." : ` (${sample.reason}).`)
);
