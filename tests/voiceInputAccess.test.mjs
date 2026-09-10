import assert from "node:assert/strict";
import test from "node:test";

import {
  VOICE_INPUT_FLAG_KEY,
  VOICE_INPUT_KILL_SWITCH_ENV,
  voiceInputAvailable,
  voiceInputEnabledFromValue,
  voiceInputKillSwitchEngaged,
  voiceInputRefusal,
} from "../lib/voiceInputAccess.ts";
import {
  VOICE_GUARDRAIL_CEILING,
  VOICE_GUARDRAIL_DEFAULTS,
  resolveVoiceGuardrails,
} from "../lib/voiceInputGuardrails.ts";
import {
  appendVoiceTranscript,
  normalizeVoiceTranscript,
} from "../lib/voiceTranscript.ts";
import { VOICE_INPUT_ERROR_COPY_KEYS, voiceInputErrorCopyKey } from "../lib/voiceInputErrorCopy.ts";
import { en } from "../locales/en.ts";

/**
 * The two switches, the audience decision, the guardrail arithmetic and the
 * transcript's own rules: docs/policy/voice-input.md §2, §3, §4, §6, §7, §12.
 */

// ---------------------------------------------------------------------------
// The rollout flag is default-off and fails closed
// ---------------------------------------------------------------------------

test("only the literal \"true\" enables the flag", () => {
  assert.equal(voiceInputEnabledFromValue("true"), true);
  for (const value of [undefined, null, "", "false", "TRUE", "1", "yes", "on", " true"]) {
    assert.equal(
      voiceInputEnabledFromValue(value),
      false,
      `${JSON.stringify(value)} must not enable a feature whose price is undecided`
    );
  }
});

test("the flag key is namespaced with the other feature flags", () => {
  assert.equal(VOICE_INPUT_FLAG_KEY, "feature.voiceInputEnabled");
});

// ---------------------------------------------------------------------------
// The kill switch
// ---------------------------------------------------------------------------

test("any non-empty kill-switch value turns the feature off", () => {
  for (const value of ["1", "true", "on", "yes", "y", "STOP", "  x  "]) {
    assert.equal(
      voiceInputKillSwitchEngaged({ [VOICE_INPUT_KILL_SWITCH_ENV]: value }),
      true,
      `${JSON.stringify(value)} must engage the kill switch`
    );
  }
});

test("only an absent or empty kill switch leaves the feature reachable", () => {
  assert.equal(voiceInputKillSwitchEngaged({}), false);
  assert.equal(voiceInputKillSwitchEngaged({ [VOICE_INPUT_KILL_SWITCH_ENV]: "" }), false);
  assert.equal(voiceInputKillSwitchEngaged({ [VOICE_INPUT_KILL_SWITCH_ENV]: "   " }), false);
});

test("the kill switch beats an enabled flag", () => {
  assert.equal(
    voiceInputAvailable({
      storedFlagValue: "true",
      env: { [VOICE_INPUT_KILL_SWITCH_ENV]: "1" },
    }),
    false,
    "there must be no stored value that re-enables the feature during an incident"
  );
  assert.equal(
    voiceInputAvailable({ storedFlagValue: "true", env: {} }),
    true
  );
});

// ---------------------------------------------------------------------------
// Who may use it
// ---------------------------------------------------------------------------

test("an unavailable feature refuses before the audience is considered", () => {
  assert.equal(
    voiceInputRefusal({ available: false, isSignedIn: true, tier: "Max" }),
    "feature_unavailable"
  );
});

test("guests are admitted, and so is every plan", () => {
  // docs/policy/voice-input.md §4, revised 2026-09-10. The MVP was signed-in
  // only because transcription is a paid third-party call and a guest has no
  // account to attribute it to. Guests are now admitted on the same limits;
  // what keeps the exposure finite is the provider-wide seconds budget, not
  // the subject budget, because a cleared cookie is a new subject.
  //
  // Plan was never a gate and still is not: voice input replaces typing, it
  // does not buy a better answer.
  assert.equal(
    voiceInputRefusal({ available: true, isSignedIn: false }),
    null,
    "a guest is admitted"
  );
  assert.equal(
    voiceInputRefusal({ available: true }),
    null,
    "sign-in is not consulted at all, so omitting it admits too"
  );
  for (const tier of ["Guest", "Free", "Pro", "Max"]) {
    for (const isSignedIn of [true, false]) {
      assert.equal(
        voiceInputRefusal({ available: true, isSignedIn, tier }),
        null,
        `${tier} must not be gated by plan or by sign-in`
      );
    }
  }
});

test("an unavailable feature is refused whoever asks", () => {
  // The one refusal left. It has to outrank the guest admission above:
  // otherwise the kill switch would stop hiding the microphone from the very
  // callers who have no account to be told about it.
  for (const isSignedIn of [true, false]) {
    assert.equal(
      voiceInputRefusal({ available: false, isSignedIn }),
      "feature_unavailable"
    );
  }
});

// ---------------------------------------------------------------------------
// The operational guardrail, which is not an entitlement
// ---------------------------------------------------------------------------

test("the guardrail defaults apply when nothing is configured", () => {
  const { limits, clamped, ignored } = resolveVoiceGuardrails({});
  assert.deepEqual(limits, VOICE_GUARDRAIL_DEFAULTS);
  assert.deepEqual(clamped, []);
  assert.deepEqual(ignored, []);
});

test("an override above the ceiling is clamped and reported", () => {
  const { limits, clamped } = resolveVoiceGuardrails({
    VOICE_INPUT_SECONDS_PER_DAY: String(VOICE_GUARDRAIL_CEILING.secondsPerDay * 10),
  });
  assert.equal(limits.secondsPerDay, VOICE_GUARDRAIL_CEILING.secondsPerDay);
  assert.deepEqual(clamped, ["VOICE_INPUT_SECONDS_PER_DAY"]);
});

test("a zero or negative override is ignored rather than used to disable", () => {
  // Zero would refuse every request with a budget message, which reads as an
  // outage. Disabling is the kill switch, which says so out loud.
  const { limits, ignored } = resolveVoiceGuardrails({
    VOICE_INPUT_REQUESTS_PER_DAY: "0",
    VOICE_INPUT_REQUESTS_PER_MINUTE: "-4",
    VOICE_INPUT_SECONDS_PER_DAY: "not a number",
  });
  assert.deepEqual(limits, VOICE_GUARDRAIL_DEFAULTS);
  assert.deepEqual(ignored.sort(), [
    "VOICE_INPUT_REQUESTS_PER_DAY",
    "VOICE_INPUT_REQUESTS_PER_MINUTE",
    "VOICE_INPUT_SECONDS_PER_DAY",
  ]);
});

test("a lower override is accepted; tightening a spending limit is always allowed", () => {
  const { limits, clamped } = resolveVoiceGuardrails({
    VOICE_INPUT_SECONDS_PER_DAY: "60",
  });
  assert.equal(limits.secondsPerDay, 60);
  assert.deepEqual(clamped, []);
});

test("the guardrail borrows no name from the credit or chat cost layers", () => {
  // AGENTS.md, "Credit entitlement vs operational guardrail": the layers must
  // not share vocabulary, or a spending cap starts reading as a product limit.
  const source = Object.keys(VOICE_GUARDRAIL_DEFAULTS).join(" ");
  assert.ok(!/credit/i.test(source));
  const envNames = [
    "VOICE_INPUT_REQUESTS_PER_DAY",
    "VOICE_INPUT_REQUESTS_PER_MINUTE",
    "VOICE_INPUT_SECONDS_PER_DAY",
  ];
  for (const name of envNames) {
    assert.ok(name.startsWith("VOICE_INPUT_"), name);
    assert.ok(!name.startsWith("CHAT_"), name);
    // Proven live rather than asserted about a string: an unknown variable is
    // ignored, so a `CHAT_`-prefixed spelling changes nothing.
    assert.deepEqual(
      resolveVoiceGuardrails({ [name.replace("VOICE_INPUT_", "CHAT_")]: "1" }).limits,
      VOICE_GUARDRAIL_DEFAULTS
    );
  }
});

// ---------------------------------------------------------------------------
// The transcript
// ---------------------------------------------------------------------------

test("whitespace is normalised and a silent result becomes nothing", () => {
  assert.equal(
    normalizeVoiceTranscript("  hello   there \n world ", { maxCharacters: 100 }),
    "hello there world"
  );
  for (const empty of ["", "   ", "\n", ".", "。", "…"]) {
    assert.equal(normalizeVoiceTranscript(empty, { maxCharacters: 100 }), null);
  }
});

test("an over-long transcript is refused rather than truncated", () => {
  // Truncating would end mid-sentence with nothing to say it was cut, and the
  // user would send it believing it was what they said.
  assert.equal(
    normalizeVoiceTranscript("a".repeat(101), { maxCharacters: 100 }),
    null
  );
});

test("the transcript is returned as spoken, not corrected", () => {
  const spoken = "um so the thing is i dont know";
  assert.equal(
    normalizeVoiceTranscript(spoken, { maxCharacters: 100 }),
    spoken,
    "silently improving the transcript would hide that the recogniser got it wrong"
  );
});

test("a transcript is appended to the draft, never replacing it", () => {
  assert.equal(appendVoiceTranscript("", "spoken"), "spoken");
  assert.equal(appendVoiceTranscript("typed", "spoken"), "typed spoken");
  assert.equal(appendVoiceTranscript("typed ", "spoken"), "typed spoken");
  assert.equal(appendVoiceTranscript("typed\n", "spoken"), "typed\nspoken");
});

// ---------------------------------------------------------------------------
// Error copy
// ---------------------------------------------------------------------------

test("every refusal code resolves to a key that exists in English", () => {
  const lookup = (key) =>
    key.split(".").reduce((node, part) => (node ?? {})[part], en);

  for (const [code, key] of Object.entries(VOICE_INPUT_ERROR_COPY_KEYS)) {
    assert.equal(
      typeof lookup(key),
      "string",
      `${code} points at ${key}, which does not exist`
    );
  }
  assert.equal(typeof lookup(voiceInputErrorCopyKey("SOMETHING_NEW")), "string");
});

test("codes with different fixes get different sentences", () => {
  // The failure `lib/chatAttachmentErrorCopy.ts` records: one sentence for
  // every cause gives wrong advice to most of the people who see it.
  const distinct = [
    "VOICE_PERMISSION_DENIED",
    "VOICE_UNSUPPORTED_BROWSER",
    "VOICE_CLIP_EMPTY",
    "VOICE_TRANSCRIPT_EMPTY",
    "VOICE_OPERATIONAL_LIMIT_REACHED",
    "VOICE_AUTHENTICATION_REQUIRED",
    "VOICE_PROVIDER_UNAVAILABLE",
  ].map((code) => voiceInputErrorCopyKey(code));

  assert.equal(new Set(distinct).size, distinct.length);
});
