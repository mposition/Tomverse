import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_FAILURE_LAYERS,
  ChatLocalFailure,
  LOCAL_FAILURE_DIAGNOSTIC_ROOTS,
  ProviderCallRecord,
  ProviderRequestFailure,
  beginProviderCall,
  isChatLocalFailure,
  isProviderFailureLayer,
  isProviderRequestFailure,
  localDiagnosticCode,
  runLocalStage,
} from "../lib/chatFailureLayer.ts";
import {
  PROVIDER_CALL_DIAGNOSTIC_ROOTS,
  classifyProviderFailure,
  isProviderCallDiagnosticCode,
  providerDiagnosticCode,
  safeErrorMetadata,
} from "../lib/providerErrorClassification.ts";

/*
  The incident this file is the regression test for.

  A signed-in user's attachment was deleted from R2 by a bucket lifecycle rule.
  Every later turn re-read it, HeadObject threw `NotFound`, and the chat route's
  outermost catch -- which by then had a provider in hand -- built
  `AI_REQUEST_FAILED.NotFound` and recorded it against that provider's health.
  Two unrelated providers were charged with an outage, and switching models
  could not help because the failure was on this side of the network.
*/

test("a local failure's diagnostic root is not a provider-call root", () => {
  for (const root of LOCAL_FAILURE_DIAGNOSTIC_ROOTS) {
    assert.ok(
      !PROVIDER_CALL_DIAGNOSTIC_ROOTS.includes(root),
      `${root} must never be a provider-call root`
    );
    assert.equal(isProviderCallDiagnosticCode(root), false);
  }
});

test("a storage 404 classifies as a local rejection with no health scope", () => {
  const code = localDiagnosticCode("storage", "MISSING", 404);
  assert.equal(code, "CHAT_STORAGE_FAILED.MISSING.HTTP_404");
  const verdict = classifyProviderFailure({ diagnosticCode: code, httpStatus: 404 });
  assert.equal(verdict.category, "LOCAL_REJECTION");
  // "none" is the whole point: `provider` would move the provider's 24-hour
  // success rate, and `model` would move the model's five-minute bucket.
  assert.equal(verdict.scope, "none");
});

test("the old shape of this failure did count against the provider", () => {
  // Kept as a test so the regression is legible: this is what the route used
  // to build for the very same error, and what it must never build again.
  const asProviderCode = providerDiagnosticCode(
    "AI_REQUEST_FAILED",
    Object.assign(new Error("NotFound"), {
      name: "NotFound",
      $metadata: { httpStatusCode: 404 },
    })
  );
  assert.equal(asProviderCode, "AI_REQUEST_FAILED.NotFound.HTTP_404");
  const verdict = classifyProviderFailure({
    diagnosticCode: asProviderCode,
    httpStatus: 404,
  });
  assert.equal(verdict.scope, "model");
  assert.equal(verdict.category, "MODEL_NOT_FOUND");
});

test("safeErrorMetadata now reads the AWS SDK's own status field", () => {
  const metadata = safeErrorMetadata(
    Object.assign(new Error("NotFound"), {
      name: "NotFound",
      $metadata: { httpStatusCode: 404 },
    })
  );
  assert.equal(metadata.statusCode, 404);
});

test("only the two provider layers are provider evidence", () => {
  assert.deepEqual(CHAT_FAILURE_LAYERS.filter(isProviderFailureLayer), [
    "provider_request",
    "provider_stream",
  ]);
});

test("runLocalStage wraps an ordinary throw with its layer and phase", async () => {
  await assert.rejects(
    runLocalStage(
      { layer: "storage", phase: "attachment_read", describe: () => ({ detail: "MISSING", storageStatus: 404 }) },
      () => false,
      async () => {
        throw new Error("HeadObject failed");
      }
    ),
    (error) => {
      assert.ok(isChatLocalFailure(error));
      assert.equal(error.layer, "storage");
      assert.equal(error.phase, "attachment_read");
      assert.equal(error.storageStatus, 404);
      assert.equal(error.diagnosticCode, "CHAT_STORAGE_FAILED.MISSING.HTTP_404");
      return true;
    }
  );
});

test("runLocalStage lets a deliberate refusal through untouched", async () => {
  class Refusal extends Error {}
  const refusal = new Refusal("no");
  await assert.rejects(
    runLocalStage(
      { layer: "application", phase: "context_build" },
      (error) => error instanceof Refusal,
      async () => {
        throw refusal;
      }
    ),
    (error) => error === refusal
  );
});

/*
  Why `providerCall` is an object and not a boolean.

  A boolean is a claim any branch can forget to make, and its absence is
  indistinguishable from its `false`. This record can only exist because the
  wrapper constructed one, so the outer catch asks a structural question.
*/
test("beginProviderCall hands back a record before the call runs", async () => {
  let record = null;
  await beginProviderCall("openai", "gpt-5-4-mini", (value) => {
    record = value;
  }, async () => "ok");
  assert.ok(record instanceof ProviderCallRecord);
  assert.equal(record.provider, "openai");
  assert.equal(record.modelId, "gpt-5-4-mini");
});

test("beginProviderCall marks a failure inside the call as the provider's", async () => {
  let record = null;
  await assert.rejects(
    beginProviderCall("anthropic", "claude-sonnet-5", (value) => {
      record = value;
    }, async () => {
      throw new Error("upstream 503");
    }),
    (error) => {
      assert.ok(isProviderRequestFailure(error));
      assert.ok(error instanceof ProviderRequestFailure);
      assert.equal(error.call.provider, "anthropic");
      return true;
    }
  );
  // The record still exists after the failure: the attempt happened.
  assert.ok(record instanceof ProviderCallRecord);
});

test("a local failure raised inside the boundary stays local", async () => {
  const local = new ChatLocalFailure("storage", "attachment_read", "CHAT_STORAGE_FAILED");
  await assert.rejects(
    beginProviderCall("openai", "gpt-5-6-luna", () => {}, async () => {
      throw local;
    }),
    (error) => error === local
  );
});

test("beginProviderCall accepts a synchronous call, because streamText is one", async () => {
  const result = await beginProviderCall("openai", "m", () => {}, () => "sync-result");
  assert.equal(result, "sync-result");
});
