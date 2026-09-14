import assert from "node:assert/strict";
import test from "node:test";

import {
  PROMPT_REFINER_KILL_SWITCH_ENV,
  promptRefinerAvailable,
  promptRefinerEnabledFromValue,
  promptRefinerKillSwitchEngaged,
  promptRefinerOfferDecision,
  promptRefinerProductAdapterReady,
  readPromptRefinerAvailability,
} from "../lib/promptRefinerAccess.ts";

test("Prompt Refiner rollout is strict and default-off", () => {
  for (const value of [undefined, null, "", "TRUE", "1", " true ", "false"]) {
    assert.equal(promptRefinerEnabledFromValue(value), false, String(value));
  }
  assert.equal(promptRefinerEnabledFromValue("true"), true);
});

test("any non-empty kill switch value wins over an enabled rollout", () => {
  for (const value of ["1", "true", "yes", "stop", " false "]) {
    const env = { [PROMPT_REFINER_KILL_SWITCH_ENV]: value };
    assert.equal(promptRefinerKillSwitchEngaged(env), true, value);
    assert.equal(
      promptRefinerAvailable({ storedFlagValue: "true", env }),
      false,
      value
    );
  }
  assert.equal(
    promptRefinerAvailable({
      storedFlagValue: "true",
      env: { [PROMPT_REFINER_KILL_SWITCH_ENV]: "  " },
    }),
    true
  );
});

test("the server offers only when rollout and adapter readiness both hold", () => {
  assert.equal(promptRefinerProductAdapterReady(), false);
  assert.equal(
    promptRefinerOfferDecision({ available: true, adapterReady: true }),
    true
  );
  for (const input of [
    { available: false, adapterReady: false },
    { available: false, adapterReady: true },
    { available: true, adapterReady: false },
  ]) {
    assert.equal(promptRefinerOfferDecision(input), false);
  }
});

test("the kill switch and disabled database refuse before reading rollout state", async () => {
  let reads = 0;
  const readStoredFlag = async () => {
    reads += 1;
    return "true";
  };

  assert.equal(
    await readPromptRefinerAvailability({
      env: { [PROMPT_REFINER_KILL_SWITCH_ENV]: "stop" },
      databaseEnabled: true,
      readStoredFlag,
    }),
    false
  );
  assert.equal(reads, 0);

  assert.equal(
    await readPromptRefinerAvailability({
      env: {},
      databaseEnabled: false,
      readStoredFlag,
    }),
    false
  );
  assert.equal(reads, 0);

  assert.equal(
    await readPromptRefinerAvailability({
      env: {},
      databaseEnabled: true,
      readStoredFlag,
    }),
    true
  );
  assert.equal(reads, 1);
});
