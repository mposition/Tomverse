import assert from "node:assert/strict";
import test from "node:test";

import {
  StorageObjectMissingError,
  StorageUnavailableError,
  classifyStorageError,
  isPermanentStorageLoss,
  isStorageObjectMissing,
  storageErrorStatus,
  storageFailureTelemetry,
  toStorageError,
} from "../lib/storageObjectErrors.ts";

/*
  The production shape this module was written for.

  A HeadObject against a key R2 no longer holds throws exactly this: the name
  `NotFound`, no `status`, no `statusCode`, and the HTTP status only under
  `$metadata`. safeErrorMetadata did not read `$metadata`, so the failure
  reached provider classification with no status at all and fell through to
  "count it against the provider".
*/
const awsNotFound = () =>
  Object.assign(new Error("NotFound"), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404, requestId: "abc" },
  });

test("a 404 from object storage is permanent loss and nothing else", () => {
  const error = awsNotFound();
  assert.equal(classifyStorageError(error), "missing");
  assert.equal(isStorageObjectMissing(error), true);
  assert.equal(isPermanentStorageLoss(classifyStorageError(error)), true);
  assert.equal(storageErrorStatus(error), 404);
});

test("NoSuchKey is the same answer as NotFound", () => {
  assert.equal(
    classifyStorageError(Object.assign(new Error("x"), { name: "NoSuchKey" })),
    "missing"
  );
});

/*
  The three cases that must never be reported as loss.

  Each of them means "we do not know whether the object exists". Recording any
  of them as a permanent 404 would, during a five-minute credentials or bucket
  outage, write into the database that an account had lost every file it owns
  -- and nothing clears that afterwards, because the column is only ever set
  from a confirmed answer.
*/
test("a 403 is denied, not missing", () => {
  const error = Object.assign(new Error("denied"), {
    name: "AccessDenied",
    $metadata: { httpStatusCode: 403 },
  });
  assert.equal(classifyStorageError(error), "denied");
  assert.equal(isStorageObjectMissing(error), false);
  assert.equal(isPermanentStorageLoss("denied"), false);
});

test("a 500 is unreachable, not missing", () => {
  const error = Object.assign(new Error("boom"), {
    name: "InternalError",
    $metadata: { httpStatusCode: 500 },
  });
  assert.equal(classifyStorageError(error), "unreachable");
  assert.equal(isStorageObjectMissing(error), false);
});

test("a socket timeout is unreachable, not missing", () => {
  for (const code of ["ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN"]) {
    const error = Object.assign(new Error("net"), { name: "Error", code });
    assert.equal(classifyStorageError(error), "unreachable", code);
    assert.equal(isStorageObjectMissing(error), false, code);
  }
});

test("an unrecognised failure is unknown rather than missing", () => {
  assert.equal(classifyStorageError(new Error("who knows")), "unknown");
  assert.equal(isStorageObjectMissing(new Error("who knows")), false);
});

test("a 429 is a reason to wait, not a reason to declare loss", () => {
  const error = Object.assign(new Error("slow down"), {
    name: "SlowDown",
    $metadata: { httpStatusCode: 429 },
  });
  assert.equal(classifyStorageError(error), "unreachable");
});

test("toStorageError produces the class the boundary matches on", () => {
  assert.ok(toStorageError("head", awsNotFound()) instanceof StorageObjectMissingError);
  assert.ok(
    toStorageError(
      "get",
      Object.assign(new Error("x"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } })
    ) instanceof StorageUnavailableError
  );
});

test("toStorageError is idempotent", () => {
  const first = toStorageError("head", awsNotFound());
  assert.equal(toStorageError("get", first), first);
});

/*
  The telemetry allowlist.

  A storage failure is logged, tagged in Sentry and shown in an admin screen.
  None of those places may receive the object key, the bucket, the endpoint or
  the SDK's own payload -- docs/policy/user-attachment-persistence.md §5 is a
  rule about responses, and a log line is a response the moment somebody reads
  it.
*/
test("telemetry carries a verdict and never the request", () => {
  const error = Object.assign(new Error("NotFound"), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 },
    Key: "attachments/9f2caa/secret-contract.pdf",
    Bucket: "tomverse-prod",
  });
  const telemetry = storageFailureTelemetry(toStorageError("head", error));
  assert.deepEqual(telemetry, {
    storageFailureKind: "missing",
    storageStatus: 404,
    permanent: true,
    storageOperation: "head",
  });
  const serialised = JSON.stringify(telemetry);
  assert.ok(!serialised.includes("attachments/"));
  assert.ok(!serialised.includes("tomverse-prod"));
  assert.ok(!serialised.includes("secret-contract"));
});

test("a storage error's own message names no key", () => {
  const error = toStorageError("head", awsNotFound());
  assert.ok(!error.message.includes("attachments/"));
  assert.equal(error.storageStatus, 404);
});
