import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { ciAdmissionArrival, verifyCiAdmissionWebhookSignature } from "../lib/ciAdmissionWebhookCore.ts";

const REPO = "mposition/Tomverse";
const pr = (action, pull = {}) => ({ action, repository: { full_name: REPO }, pull_request: { number: 12, draft: false, ...pull } });

test("ready for review, or opened or reopened ready, is an arrival", () => {
  assert.deepEqual(ciAdmissionArrival("pull_request", pr("ready_for_review"), REPO), { kind: "round", arrival: 12 });
  assert.deepEqual(ciAdmissionArrival("pull_request", pr("opened"), REPO), { kind: "round", arrival: 12 });
  assert.deepEqual(ciAdmissionArrival("pull_request", pr("reopened"), REPO), { kind: "round", arrival: 12 });
  assert.deepEqual(ciAdmissionArrival("pull_request", pr("opened", { draft: true }), REPO), { kind: "round", arrival: null });
  // New commits on a ready pull request ask for CI again; on a draft they run nothing.
  assert.deepEqual(ciAdmissionArrival("pull_request", pr("synchronize"), REPO), { kind: "round", arrival: 12 });
  assert.deepEqual(ciAdmissionArrival("pull_request", pr("synchronize", { draft: true }), REPO), { kind: "round", arrival: null });
});

test("other pull request changes and workflow runs start a round without an arrival", () => {
  for (const action of ["converted_to_draft", "closed", "edited"]) {
    assert.deepEqual(ciAdmissionArrival("pull_request", pr(action), REPO), { kind: "round", arrival: null }, action);
  }
  for (const action of ["completed", "requested", "in_progress"]) {
    assert.deepEqual(ciAdmissionArrival("workflow_run", { action, repository: { full_name: REPO } }, REPO), { kind: "round", arrival: null });
  }
  assert.deepEqual(ciAdmissionArrival("workflow_run", { action: "unknown", repository: { full_name: REPO } }, REPO), { kind: "ignore", reason: "action" });
});

test("anything else is ignored", () => {
  assert.equal(ciAdmissionArrival("push", pr("opened"), REPO).kind, "ignore");
  assert.deepEqual(ciAdmissionArrival("pull_request", pr("labeled"), REPO), { kind: "ignore", reason: "action" });
  assert.deepEqual(ciAdmissionArrival("pull_request", { ...pr("opened"), repository: { full_name: "x/y" } }, REPO), { kind: "ignore", reason: "repository" });
  assert.deepEqual(ciAdmissionArrival("pull_request", { action: "opened", repository: { full_name: REPO } }, REPO), { kind: "ignore", reason: "shape" });
  assert.deepEqual(ciAdmissionArrival("pull_request", null, REPO), { kind: "ignore", reason: "shape" });
});

test("the signature check accepts only GitHub's sha256 HMAC of the exact body", () => {
  const body = JSON.stringify(pr("opened"));
  const signature = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
  assert.equal(verifyCiAdmissionWebhookSignature(body, signature, "s3cret"), true);
  assert.equal(verifyCiAdmissionWebhookSignature(`${body} `, signature, "s3cret"), false);
  assert.equal(verifyCiAdmissionWebhookSignature(body, signature, "other"), false);
  assert.equal(verifyCiAdmissionWebhookSignature(body, signature.replace("sha256=", "sha1="), "s3cret"), false);
  assert.equal(verifyCiAdmissionWebhookSignature(body, null, "s3cret"), false);
  assert.equal(verifyCiAdmissionWebhookSignature(body, signature, undefined), false);
  assert.equal(verifyCiAdmissionWebhookSignature(body, signature, ""), false);
});
