import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Voice input does not charge the user: docs/policy/voice-input.md §6.1-1,
 * §6.1-2, §6.2.
 *
 * This is a *policy* test, not a behaviour test, and the difference is the
 * point. There is no entitlement layer to exercise — the contract is that one
 * never appears. A behaviour test can only assert that today's code does not
 * deduct credits; this asserts that the code has no way to.
 *
 * §6 used to be undecided, and the same absence was then "an honest
 * implementation of not having decided". Now it is the decision, which is why
 * it gets a test: an absence nobody guards is an absence somebody fills in.
 */

const VOICE_SOURCES = [
  "app/api/chat/voice-transcription/route.ts",
  "lib/voiceInputAccess.ts",
  "lib/voiceInputBudget.ts",
  "lib/voiceInputGuardrails.ts",
  "lib/voiceProviderBudget.ts",
  "lib/voiceTranscriptionPort.ts",
  "lib/voiceTranscriptionPortCore.ts",
];

/**
 * The credit layer's own vocabulary. Matching by name rather than by import
 * because the failure this guards against is someone reaching for the credit
 * helpers *because they are there*, and the first sign of that is the words.
 */
const CREDIT_SYMBOLS = [
  "reserveAddOnCredits",
  "lockCreditAccount",
  "CreditLot",
  "usageCredits",
  "creditWeight",
  "settleCreditReservation",
  "refundCredits",
  "INSUFFICIENT_CREDITS",
];

const read = (path) => readFileSync(path, "utf8");

/**
 * The file with its comments removed.
 *
 * Needed because these modules *document* the names they must not use -- §7's
 * table lists the chat error code precisely so nobody reaches for it, and the
 * budget's docstring explains at length why it is not denominated in microUSD.
 * A scan that cannot tell an explanation from a use fails on the sentence that
 * exists to prevent the failure. The first version of this test did exactly
 * that.
 */
const codeOnly = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

test("the comment stripper actually strips, so the scans below mean something", () => {
  // A scanner nobody checks is a scanner that can quietly start passing
  // everything. Both comment forms, and code on the same line as one.
  const stripped = codeOnly(
    [
      "const a = 1; // FORBIDDEN_TOKEN",
      "/* FORBIDDEN_TOKEN */",
      "/* multi",
      "   FORBIDDEN_TOKEN",
      "*/",
      "const kept = 'FORBIDDEN_TOKEN_IN_CODE';",
    ].join("\n")
  );

  assert.ok(!stripped.includes("FORBIDDEN_TOKEN "), "line comments are removed");
  assert.equal(
    (stripped.match(/FORBIDDEN_TOKEN/g) || []).length,
    1,
    "only the one in real code survives"
  );
  assert.ok(stripped.includes("const a = 1;"), "code on a commented line stays");
});

test("no voice source reaches for the credit layer", () => {
  const offences = [];
  for (const path of VOICE_SOURCES) {
    const source = codeOnly(read(path));
    for (const symbol of CREDIT_SYMBOLS) {
      if (source.includes(symbol)) offences.push(`${path}: ${symbol}`);
    }
  }

  assert.deepEqual(
    offences,
    [],
    "voice input is free (§6.1-1); a credit symbol here is a policy change, not a refactor"
  );
});

test("the guardrail's vocabulary stays out of the credit and chat layers", () => {
  // §7's table, enforced. Two layers that answer different questions must not
  // borrow each other's names, or a later reader will assume one bounds the
  // other.
  const guardrail = codeOnly(read("lib/voiceInputGuardrails.ts"));
  const budget = codeOnly(read("lib/voiceProviderBudget.ts"));

  for (const [name, source] of [
    ["guardrail", guardrail],
    ["provider budget", budget],
  ]) {
    assert.ok(
      !/\bCHAT_[A-Z_]+\b/.test(source),
      `${name} must not name a CHAT_* environment variable`
    );
    assert.ok(
      !source.includes("OPERATIONAL_COST_GUARDRAIL_TRIGGERED"),
      `${name} must not reuse the chat guardrail's error code`
    );
  }
});

test("the provider budget is denominated in seconds, never in microUSD", () => {
  // §6.1-4. The unit is the decision: converting to USD at reservation time
  // would mean inventing a rate nobody approved. If a later change adds a USD
  // form it has to come with the verified rate, and with this test's update.
  const source = codeOnly(read("lib/voiceProviderBudget.ts"));

  assert.ok(
    !/MICROUSD|microUsd|micro_usd/i.test(source),
    "an approved USD rate does not exist yet (§6.1.1); a USD budget would be a guess"
  );
  assert.ok(
    source.includes("VOICE_PROVIDER_SECONDS_PER_DAY") &&
      source.includes("VOICE_PROVIDER_SECONDS_PER_MONTH"),
    "the env names say what the unit is"
  );
});

test("the composer never tells the user voice costs credits", () => {
  // The other half of §6.1-1: free has to read as free. A credit figure next
  // to the microphone would be a price this product does not charge.
  const copy = codeOnly(read("lib/voiceInputErrorCopy.ts"));

  for (const forbidden of ["credit", "크레딧", "Credit"]) {
    assert.ok(
      !copy.includes(forbidden),
      `voice copy must not mention credits: found ${forbidden}`
    );
  }
});
