import assert from "node:assert/strict";
import test from "node:test";
import { liveModelsAtMinuteRate } from "@/lib/providerModelDocsCore";

test("voice discovery reads versioned models at the exact active-minute rate, independently of standby and token prices", () => {
  const pricing = [
    "| Model | Active rate | Standby rate |", "| --- | --- | --- |",
    "| gpt-live-1.2 | $0.05 / minute | $0.02 / minute |",
    "| gpt-live-1 | $0.050 / minute | $0.02 / minute |",
    "| gpt-live-3 | $0.07 / minute | $0.05 / minute |",
    "| gpt-live-4 | $0.05 / hour | $0.05 / minute |",
    "| other-model | $0.05 / minute | $0.02 / minute |",
    "", "| Model | Input | Output |", "|---|---|---|", "| gpt-live-5 | $0.05 / minute | $1 |",
  ].join("\n");
  assert.deepEqual(liveModelsAtMinuteRate(pricing, 50_000), ["gpt-live-1.2", "gpt-live-1"]);
  assert.equal(liveModelsAtMinuteRate("Service unavailable", 50_000), null);
});
