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

const defaultModel = defaultMatch[1];
const reachable = new Set([
  defaultModel,
  ...VOICE_MODEL_PRICE_REGISTER.map((entry) => entry.modelId),
]);

const problems = auditVoicePriceRegister({
  modelIds: [...reachable],
  now: new Date(),
});

// An unknown audio input rate blocks the model this build will actually use,
// and is reported for the rest.
//
// The split is not leniency, it is the limit of what this check can see. The
// model is configuration (`VOICE_TRANSCRIPTION_MODEL`), so CI cannot know
// which entry a given deployment selects; what it can know is the compiled-in
// default. Failing every entry would mean the register could only ever hold
// models somebody had already paid to verify -- and then the honest record
// that `gpt-4o-transcribe`'s cost is *unknown* could not be written down at
// all, which is how a register ends up holding the published text rate
// instead (docs/policy/voice-input.md §6.1.3-5). Choosing that model is a
// decision with its own approval; this line is not the thing that gates it.
const blocking = problems.filter(
  (problem) =>
    problem.code !== "audio_input_rate_unknown" ||
    problem.modelId === defaultModel
);
const held = problems.filter(
  (problem) =>
    problem.code === "audio_input_rate_unknown" &&
    problem.modelId !== defaultModel
);

if (blocking.length > 0) {
  console.error(
    `\n${blocking.length} voice price register problem(s):\n` +
      blocking
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
  (entry) => entry.costObservation === null
).map((entry) => entry.modelId);

console.log(
  `Voice price register check passed: ${reachable.size} reachable model(s), ` +
    `all priced, owned and within their re-reading deadline.` +
    (held.length > 0
      ? `\nHeld -- audio input rate unknown, not this build's model (docs/policy/voice-input.md §6.1.3): ${held
          .map((problem) => problem.modelId)
          .join(", ")}.`
      : "") +
    (unobserved.length > 0
      ? `\nList price only, no invoice observed yet (docs/policy/voice-input.md §6.1.2): ${unobserved.join(", ")}.`
      : "")
);
