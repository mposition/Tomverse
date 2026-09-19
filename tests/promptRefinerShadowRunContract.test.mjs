import assert from "node:assert/strict";
import test from "node:test";

import {
  PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
} from "../lib/promptRefinerExecutionContract.ts";
import {
  PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
  PROMPT_REFINER_RESERVATION_STAGE_ID,
} from "../lib/promptRefinerReservationCore.ts";
import {
  PROMPT_REFINER_SHADOW_ADMISSION_CORPUS_DIGEST,
} from "../lib/promptRefinerShadowAdmissionCore.ts";
import {
  PROMPT_REFINER_SHADOW_ADAPTER_VERSION,
  PROMPT_REFINER_SHADOW_BYTE_PREFILTER_FRAMING_ALLOWANCE,
  PROMPT_REFINER_SHADOW_CORPUS_DIGEST,
  PROMPT_REFINER_SHADOW_RUN_CONTRACT,
  PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST,
  PROMPT_REFINER_SHADOW_RUN_COST_CEILING_MICRO_USD,
  PROMPT_REFINER_SHADOW_RUN_MAX_DISPATCHES,
  promptRefinerShadowRunContractProblems,
} from "../lib/promptRefinerShadowRunContract.ts";

test("shadow run contract narrows the durable stage to the frozen 16-case run", () => {
  assert.equal(PROMPT_REFINER_SHADOW_RUN_MAX_DISPATCHES, 16);
  assert.equal(
    PROMPT_REFINER_SHADOW_RUN_COST_CEILING_MICRO_USD,
    16 * PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
  );
  assert.equal(PROMPT_REFINER_SHADOW_RUN_COST_CEILING_MICRO_USD, 398_656);
  assert.equal(
    PROMPT_REFINER_SHADOW_RUN_CONTRACT.reservationContractDigest,
    PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
  );
  assert.equal(
    PROMPT_REFINER_SHADOW_RUN_CONTRACT.stageId,
    PROMPT_REFINER_RESERVATION_STAGE_ID,
  );
  assert.equal(
    PROMPT_REFINER_SHADOW_RUN_CONTRACT.adapterVersion,
    PROMPT_REFINER_SHADOW_ADAPTER_VERSION,
  );
  assert.equal(
    PROMPT_REFINER_SHADOW_CORPUS_DIGEST,
    PROMPT_REFINER_SHADOW_ADMISSION_CORPUS_DIGEST,
  );
  assert.equal(PROMPT_REFINER_SHADOW_BYTE_PREFILTER_FRAMING_ALLOWANCE, 32);
  assert.deepEqual(
    PROMPT_REFINER_SHADOW_RUN_CONTRACT.request.renderedInputPrefilter,
    {
      method: "utf8_bytes_plus_fixed_framing",
      framingTokenAllowance: 32,
      satisfiesActualTokenizerRequirement: false,
    },
  );
  assert.equal(
    PROMPT_REFINER_SHADOW_RUN_CONTRACT.run.unknownOutcomePolicy,
    "stop_no_redispatch",
  );
  assert.equal(
    PROMPT_REFINER_SHADOW_RUN_CONTRACT.run.requiresExplicitCostApproval,
    true,
  );
  assert.deepEqual(promptRefinerShadowRunContractProblems(), []);
});

test("shipping the adapter does not make the run or product executable", () => {
  assert.equal(PROMPT_REFINER_SHADOW_RUN_CONTRACT.shadowAdapterImplemented, true);
  assert.equal(PROMPT_REFINER_SHADOW_RUN_CONTRACT.durableRunWriterReady, false);
  assert.equal(PROMPT_REFINER_SHADOW_RUN_CONTRACT.entryPointReady, false);
  assert.equal(PROMPT_REFINER_SHADOW_RUN_CONTRACT.executionAdmitted, false);
  assert.equal(PROMPT_REFINER_SHADOW_RUN_CONTRACT.productAdapterReady, false);
  assert.match(
    PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST,
    /^sha256:[a-f0-9]{64}$/,
  );
});
