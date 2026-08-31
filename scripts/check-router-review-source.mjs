// Whether the human review may be drawn from this bundle, and at what seed.
//
// Runs before anything is written. It reads the pinned bundle, computes its
// digest, checks that against the pre-registration, and prints the seed the
// digest implies.
//
// Nothing here is a choice. The bundle is pinned by run, artifact and
// filename; the digest is read off it; the seed follows from the digest. A
// dispatch may say who reviews and nothing about what they review -- which
// matters because the model judges have already graded these answers and
// disagree by +40.48pp, so a draw taken now is a draw somebody could steer.
//
// Usage:
//   node --import tsx scripts/check-router-review-source.mjs \
//     --bundle=<answers.jsonl> --preregistration=<json> \
//     [--recipient-key=<pub.pem>] [--print-seed]
//
// `--recipient-key` additionally requires that a person has opened a sealed
// probe with the private half of that exact key. It is passed on the draw and
// deliberately not on the first digest-reading dispatch, which has to be able
// to reach its refusal before any key exists.
//
// It reads files and exits. No provider is called.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { bundleDigest, parseAnswerBundle } from "../lib/routerAnswerBundle.ts";
import {
  keyRecoveryProblems,
  reviewSourceProblems,
  seedFromBundleDigest,
} from "../lib/routerHumanReviewSource.ts";

/**
 * SHA-256 over the DER SubjectPublicKeyInfo, which is what identifies a public
 * key independently of how the PEM around it happens to be written.
 */
export const recipientKeyFingerprint = (pemPath) => {
  const der = execFileSync("openssl", ["pkey", "-pubin", "-in", pemPath, "-outform", "DER"], {
    maxBuffer: 1 << 20,
  });
  return `sha256:${createHash("sha256").update(der).digest("hex")}`;
};

const die = (message) => {
  console.error(message);
  process.exit(1);
};
const flag = (name) => {
  const match = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : null;
};

const bundlePath = flag("bundle") ?? die("--bundle=<answers.jsonl> is required.");
const preregistrationPath =
  flag("preregistration") ?? die("--preregistration=<json> is required.");
const recipientKeyPath = flag("recipient-key");
const printSeedOnly = process.argv.includes("--print-seed");

const frozen = JSON.parse(readFileSync(preregistrationPath, "utf8"));
const bundle = parseAnswerBundle(readFileSync(bundlePath, "utf8"));
const digest = bundleDigest(bundle);
const cells = new Set(bundle.entries.map((entry) => `${entry.stratum}/${entry.cell}`));

const problems = [
  ...reviewSourceProblems(frozen, {
    bundleDigest: digest,
    pairs: bundle.entries.length,
    cells: cells.size,
  }),
];

// Named before the first two reviews exist, so a tie-breaker is not chosen
// once it is known which way they would break the tie.
if (!frozen.adjudicatorId) {
  problems.push(
    "the pre-registration names no adjudicatorId. The third reviewer is named before the first " +
      "two verdicts exist, not after a disagreement reveals which way they would break it"
  );
}

// Only when a key is named. The digest-reading dispatch runs before a recipient
// key exists and must still reach its refusal.
let fingerprint = null;
if (recipientKeyPath) {
  fingerprint = recipientKeyFingerprint(recipientKeyPath);
  problems.push(...keyRecoveryProblems(frozen, { recipientKeyFingerprint: fingerprint }));
}

if (printSeedOnly) {
  // For the workflow to read. Printed only once the checks above passed.
  if (problems.length > 0) {
    die(`refusing to print a seed for a bundle that failed its checks:\n  - ${problems.join("\n  - ")}`);
  }
  process.stdout.write(String(seedFromBundleDigest(digest)));
  process.exit(0);
}

console.log(`Human review source — ${bundlePath}`);
console.log(`  frozen     run ${frozen.sourceRunId}, artifact ${frozen.sourceArtifact}, file ${frozen.bundleFile}`);
console.log(`  observed   ${bundle.entries.length} pair(s) across ${cells.size} cell(s)`);
console.log(`  digest     ${digest}`);
console.log(`  frozen     ${frozen.bundleDigest ?? "(none yet)"}`);
console.log(`  adjudicator ${frozen.adjudicatorId ?? "(unnamed)"}`);
if (recipientKeyPath) {
  console.log(`  recipient  ${fingerprint}`);
  console.log(`  recovery   ${frozen.keyRecovery?.verifiedBy ?? "(unverified)"}`);
}

if (problems.length > 0) {
  console.error(`\nThis bundle may not be drawn from:\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("\nNothing was drawn and no sheet was written.");
  process.exit(1);
}

console.log(`  seed       ${seedFromBundleDigest(digest)}  (derived from the digest, not chosen)`);
console.log(`\nOK — the pinned bundle matches its pre-registration.`);
