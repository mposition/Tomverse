import assert from "node:assert/strict";
import test from "node:test";
import { driveNotice, statusAfterPhase } from "../src/attachment-status";

const id = "7b0c4f6e-3f0a-4a3b-9a55-2f2f5a7d9b11";

test("A Drive import moves from the picker window to uploading only when the host says so for that request", () => {
  assert.equal(statusAfterPhase("driveSelecting", id, { requestId: id, phase: "uploading" }), "uploading");
  assert.equal(statusAfterPhase("driveSelecting", id, { requestId: "00000000-0000-4000-8000-000000000000", phase: "uploading" }), "driveSelecting");
  assert.equal(statusAfterPhase("driveSelecting", undefined, { requestId: id, phase: "uploading" }), "driveSelecting");
});

test("A message that arrives after the person cancelled, or for a plain upload, does not bring the status back", () => {
  assert.equal(statusAfterPhase(null, id, { requestId: id, phase: "uploading" }), null);
  assert.equal(statusAfterPhase("uploading", id, { requestId: id, phase: "uploading" }), "uploading");
});

test("The composer tells the person about a Drive selection that timed out, and about files that could not be attached", () => {
  assert.equal(driveNotice({ incomplete: false, timedOut: true }), "driveTimeout");
  assert.equal(driveNotice({ incomplete: true }), "googleDriveError");
  assert.equal(driveNotice({ incomplete: false }), null);
});
