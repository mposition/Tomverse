import assert from "node:assert/strict";

import {
  enqueueRefused,
  type StandardEnqueueResult,
} from "@/lib/standardEmailLane";

/**
 * Narrows an enqueue result to the row it created, failing the test if it did
 * not create one.
 *
 * `enqueueStandardEmail` used to return the row or a bare `null`, so a test
 * reading `result.deliveryId` was reading through an optional and saying
 * nothing about which case it expected. Now that a refusal carries a reason
 * (EM-05), a test that wanted a row has to say so — and when the enqueue is
 * refused, the failure names the reason instead of a `TypeError` about
 * `undefined`.
 */
export const enqueuedRow = (result: StandardEnqueueResult) => {
  if (enqueueRefused(result)) {
    assert.fail(
      `Expected the message to be queued, but the lane refused it: ${result.refused} — ${result.message}`
    );
  }
  return result;
};
