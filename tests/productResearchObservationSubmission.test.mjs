// What the submission route accepts.
//
// The failures these hold shut: a failed slot carrying an earlier success's
// content, a submitter attesting to its own payload with its own digest, a run
// answering for a slot that is not the one it was scheduled for, and a body
// with a key this contract never agreed to store.

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildObservationPayload,
  summariseObservation,
} from "../lib/productResearchObservationCore.mjs";
import {
  admitObservationSubmission,
  observationPayloadDigest,
} from "../lib/productResearchObservationSubmission.ts";

const NOW = Date.parse("2026-10-02T21:31:00.000Z");
const SLOT = "2026-10-02T21:30:00.000Z";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const payload = () => {
  const built = buildObservationPayload({
    classified: [
      {
        number: 42,
        title: "Something observable",
        verdict: "open_work",
        signals: [],
      },
    ],
  });
  assert.ok(built.payload, JSON.stringify(built));
  return built.payload;
};

const submit = (overrides = {}, options = {}) =>
  admitObservationSubmission(
    {
      schemaVersion: 1,
      slot: SLOT,
      outcome: "ok",
      developSha: SHA_A,
      mainSha: SHA_B,
      payload: payload(),
      ...overrides,
    },
    { now: NOW, id: "obs-2026-10-02", ...options }
  );

test("a complete successful submission becomes the row the table expects", () => {
  const result = submit();
  assert.equal(result.accepted, true);
  assert.deepEqual(Object.keys(result.row).sort(), [
    "developSha",
    "failureStage",
    "id",
    "issueCount",
    "mainSha",
    "outcome",
    "payload",
    "payloadDigest",
    "schemaVersion",
    "slot",
  ]);
  assert.equal(result.row.outcome, "ok");
  assert.equal(result.row.failureStage, null);
  assert.equal(result.row.issueCount, 1);
  assert.equal(result.row.slot.toISOString(), SLOT);
  assert.match(result.row.payloadDigest, /^[0-9a-f]{64}$/);
});

test("the digest is the server's, computed from what it is about to store", () => {
  const body = {
    schemaVersion: 1,
    slot: SLOT,
    outcome: "ok",
    developSha: SHA_A,
    mainSha: SHA_B,
    payload: payload(),
  };
  const accepted = admitObservationSubmission(body, { now: NOW, id: "obs-1" });
  assert.equal(accepted.row.payloadDigest, observationPayloadDigest(body.payload));

  // A submitted digest is not a key this contract knows, so a body carrying one
  // is refused rather than quietly having it ignored -- a submitter whose digest
  // was dropped would believe the server checked it.
  const withDigest = admitObservationSubmission(
    { ...body, payloadDigest: "0".repeat(64) },
    { now: NOW, id: "obs-1" }
  );
  assert.equal(withDigest.accepted, false);
  assert.equal(withDigest.code, "invalid_request");
});

test("the digest does not depend on the order the runner built its objects in", () => {
  const original = payload();
  // Same content, keys inserted in the opposite order.
  const reordered = {
    blindSpots: original.blindSpots,
    counts: original.counts,
    issues: original.issues.map((row) => {
      const flipped = {};
      for (const key of Object.keys(row).reverse()) flipped[key] = row[key];
      return flipped;
    }),
    schemaVersion: original.schemaVersion,
  };
  assert.equal(observationPayloadDigest(reordered), observationPayloadDigest(original));

  // But the row order is part of what was observed, so it does change it.
  const twoRows = buildObservationPayload({
    classified: [
      { number: 1, title: "First", verdict: "open_work", signals: [] },
      { number: 2, title: "Second", verdict: "open_work", signals: [] },
    ],
  }).payload;
  const swapped = { ...twoRows, issues: [...twoRows.issues].reverse() };
  assert.notEqual(observationPayloadDigest(swapped), observationPayloadDigest(twoRows));
});

test("a failed slot has nowhere to put content, and must name a known stage", () => {
  const failed = admitObservationSubmission(
    { schemaVersion: 1, slot: SLOT, outcome: "failed", failureStage: "clone_failed" },
    { now: NOW, id: "obs-1" }
  );
  assert.equal(failed.accepted, true);
  assert.equal(failed.row.payload, null);
  assert.equal(failed.row.payloadDigest, null);
  assert.equal(failed.row.issueCount, null);
  assert.equal(failed.row.developSha, null);

  for (const extra of [
    { payload: payload() },
    { developSha: SHA_A },
    { mainSha: SHA_B },
  ]) {
    const result = admitObservationSubmission(
      { schemaVersion: 1, slot: SLOT, outcome: "failed", failureStage: "timeout", ...extra },
      { now: NOW, id: "obs-1" }
    );
    assert.equal(result.accepted, false, JSON.stringify(Object.keys(extra)));
    assert.equal(result.code, "outcome_shape_invalid");
  }

  for (const stage of [undefined, "", "exploded", "CLONE_FAILED", 1]) {
    const result = admitObservationSubmission(
      { schemaVersion: 1, slot: SLOT, outcome: "failed", failureStage: stage },
      { now: NOW, id: "obs-1" }
    );
    assert.equal(result.accepted, false, String(stage));
    assert.equal(result.code, "unknown_failure_stage");
  }
});

test("a successful slot carries no failure stage", () => {
  const result = submit({ failureStage: "timeout" });
  assert.equal(result.accepted, false);
  assert.equal(result.code, "outcome_shape_invalid");
});

test("the slot has to be the one a run of this moment answers for", () => {
  // Answering for yesterday, or reserving tomorrow.
  for (const slot of ["2026-10-01T21:30:00.000Z", "2026-10-03T21:30:00.000Z"]) {
    const result = submit({ slot });
    assert.equal(result.accepted, false, slot);
    assert.equal(result.code, "slot_not_current");
  }
  // And it has to be a scheduled instant rather than one the submitter read off
  // its own clock: a slot with seconds would make "one row per slot" meaningless.
  for (const slot of [
    "2026-10-02T21:30:00.123Z",
    "2026-10-02T21:30:30.000Z",
    "2026-10-02T21:30:00Z",
    "2026-10-02 21:30:00.000Z",
    1_760_000_000_000,
  ]) {
    const result = submit({ slot });
    assert.equal(result.accepted, false, String(slot));
    assert.equal(result.code, "slot_not_canonical");
  }
});

test("an unknown key, an unknown schema version and an unusable id are each refused", () => {
  assert.equal(submit({ recommendation: "do this next" }).code, "invalid_request");
  // The one field this agent must never have: the policy says the payload
  // schema has no recommendation, ranking or priority, and `.strict()` here is
  // what makes that true of the wire format too.
  assert.equal(submit({ priority: 1 }).code, "invalid_request");
  assert.equal(submit({ schemaVersion: 2 }).code, "unknown_schema_version");
  assert.equal(submit({ schemaVersion: "1" }).code, "unknown_schema_version");
  for (const id of ["", "Obs/1", "a".repeat(65), undefined, null, 7]) {
    assert.equal(submit({}, { id }).code, "invalid_request", String(id));
  }
});

test("a payload whose counts cannot be rederived is refused, not stored", () => {
  const original = payload();
  const tampered = {
    ...original,
    counts: { byVerdict: { ...original.counts.byVerdict, open_work: 99 } },
  };
  const result = submit({ payload: tampered });
  assert.equal(result.accepted, false);
  assert.equal(result.code, "payload_invalid");

  // The summary the validator compares against is the one recomputed from the
  // rows, so the honest payload passes.
  assert.deepEqual(summariseObservation(original.issues).counts, original.counts);
  assert.equal(submit({ payload: original }).accepted, true);
});

test("a commit that is not a full sha cannot be stored as one", () => {
  for (const sha of ["", "abc1234", SHA_A.toUpperCase(), `${SHA_A}0`, 1, null]) {
    assert.equal(submit({ developSha: sha }).code, "outcome_shape_invalid", String(sha));
    assert.equal(submit({ mainSha: sha }).code, "outcome_shape_invalid", String(sha));
  }
});

test("a credential in an issue title refuses the whole slot", () => {
  // Public issue titles are external text: the agent reads whatever anyone
  // opened an issue about. A title holding a token is unlikely, and the cost of
  // storing one is a credential sitting in a table an operator reads every
  // morning (docs/policy/product-research-agent.md §2, condition 7).
  //
  // Synthetic values, shaped to match the rules and belonging to nothing.
  for (const [label, title] of [
    ["github token", `Fix the token ${"ghp_"}${"A".repeat(36)}`],
    ["github fine-grained", `See ${"github_pat_"}${"B".repeat(45)}`],
    ["aws key id", `Rotate AKIA${"CDEFGHIJKLMNOPQR"}`],
    ["private key block", "Paste of -----BEGIN RSA PRIVATE KEY----- in the logs"],
    ["connection string", "Repro with postgresql://user:hunter22@db.example/app"],
    ["jwt", `Token eyJ${"a".repeat(10)}.${"b".repeat(10)}.${"c".repeat(10)} expired`],
  ]) {
    const tainted = buildObservationPayload({
      classified: [{ number: 7, title, verdict: "open_work", signals: [] }],
    }).payload;
    assert.ok(tainted, label);
    const result = submit({ payload: tainted });
    assert.equal(result.accepted, false, label);
    assert.equal(result.code, "secret_detected", label);
    // Only the rule ids: a record about a secret that quotes the secret has
    // leaked it.
    assert.equal(result.detail.includes("ghp_"), false, label);
    assert.equal(result.detail.includes("hunter22"), false, label);
    assert.match(result.detail, /^[a-z0-9-]+(,[a-z0-9-]+)*$/, label);
  }

  // The whole slot goes, not the row. Dropping the row would make the stored
  // observation disagree with the backlog it claims to describe, and nothing on
  // the screen would say a row was missing.
  const mixed = buildObservationPayload({
    classified: [
      { number: 1, title: "An ordinary title", verdict: "open_work", signals: [] },
      { number: 2, title: `key ${"ghp_"}${"Z".repeat(36)}`, verdict: "open_work", signals: [] },
    ],
  }).payload;
  assert.equal(submit({ payload: mixed }).code, "secret_detected");

  // And an ordinary title that merely mentions the word is not a hit.
  const ordinary = buildObservationPayload({
    classified: [
      { number: 3, title: "Rotate the GitHub token in staging", verdict: "open_work", signals: [] },
    ],
  }).payload;
  assert.equal(submit({ payload: ordinary }).accepted, true);
});
