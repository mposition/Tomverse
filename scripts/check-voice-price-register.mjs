// Every transcription model this deployment can reach has a price somebody is
// accountable for, and that price has been read recently enough to still be
// true.
//
//   npm run check:voice-price-register
//
// ## What this exists for
//
// docs/policy/voice-input.md §6.1-3 made the audio price register a decision
// rather than a proposal. A register nobody audits becomes a record of what
// was true once: the deadline is the whole mechanism, and a deadline that
// only a unit test knows about passes forever because the test pins its own
// clock.
//
// So this runs against *today*. The test file proves the rule; this proves the
// rule still holds now.

import { readFileSync } from "node:fs";

const { auditVoicePriceRegister, VOICE_MODEL_PRICE_REGISTER } = await import(
  "../lib/voiceInputPricing.ts"
);

// The models a deployment can actually reach: the compiled-in default plus
// anything the register itself names. Reading the default from source rather
// than importing the port, which is server-only.
const portSource = readFileSync("lib/voiceTranscriptionPortCore.ts", "utf8");
const defaultMatch = /DEFAULT_VOICE_TRANSCRIPTION_MODEL = "([^"]+)"/.exec(
  portSource
);
if (!defaultMatch) {
  console.error(
    "\nCould not read DEFAULT_VOICE_TRANSCRIPTION_MODEL from the port.\n" +
      "That name is what decides which price has to exist, so a check that\n" +
      "cannot find it is not a check.\n"
  );
  process.exit(1);
}

const reachable = new Set([
  defaultMatch[1],
  ...VOICE_MODEL_PRICE_REGISTER.map((entry) => entry.modelId),
]);

const problems = auditVoicePriceRegister({
  modelIds: [...reachable],
  now: new Date(),
});

if (problems.length > 0) {
  console.error(
    `\n${problems.length} voice price register problem(s):\n` +
      problems
        .map((problem) => `  - ${problem.modelId}: ${problem.detail}`)
        .join("\n") +
      "\n\nThe register is in lib/voiceInputPricing.ts. Re-read the provider's\n" +
      "pricing page, update the entry with today's date and a new deadline,\n" +
      "and record the reading under its ticket. Moving the deadline without\n" +
      "re-reading the price is the one repair that does not repair anything.\n"
  );
  process.exit(1);
}

// Reported rather than enforced: whether a price has been checked against an
// invoice is a fact about work that needs its own approval (§6.1.2), not
// something this check can demand.
const unobserved = VOICE_MODEL_PRICE_REGISTER.filter(
  (entry) => !entry.costObserved
).map((entry) => entry.modelId);

console.log(
  `Voice price register check passed: ${reachable.size} reachable model(s), ` +
    `all priced, owned and within their re-reading deadline.` +
    (unobserved.length > 0
      ? `\nList price only, no invoice observed yet (docs/policy/voice-input.md §6.1.2): ${unobserved.join(", ")}.`
      : "")
);
