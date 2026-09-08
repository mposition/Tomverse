// The shape of the two secret-store entries.
//
// Prose left every field optional in practice, which is how a Pending with no
// deployment id becomes a rollback nobody can aim. These cases are the ones
// that shape exists to refuse: a missing field, a field of the wrong form, and
// -- the one that reads as healthy -- an entry that is the other one's
// leftover.
//
// None of this is evidence about a deployment. Every field is written by hand.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MOBILE_STORE_ENTRY_DISCLAIMER,
  mobileStoreEntryProblems,
  mobileStorePairProblems,
} from "../scripts/mobile-auth-store-entry-core.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const active = (overrides = {}) => ({
  kind: "active",
  phase: "deployed",
  rotationId: "rot-2026-09-03-a",
  createdAt: "2026-09-03T10:00:00Z",
  fingerprint: { algorithm: "sha256-of-public-keys", value: "aaaaaaaa" },
  targetSha: SHA_A,
  deploymentId: "11111111-1111-1111-1111-111111111111",
  ...overrides,
});

const pending = (overrides = {}) => ({
  kind: "pending",
  phase: "drafted",
  rotationId: "rot-2026-09-03-b",
  createdAt: "2026-09-03T11:00:00Z",
  fingerprint: { algorithm: "sha256-of-public-keys", value: "bbbbbbbb" },
  targetSha: SHA_B,
  ...overrides,
});

const problems = (entry) => mobileStoreEntryProblems(entry, "e");
const pair = (overrides = {}) =>
  mobileStorePairProblems({ active: active(), pending: pending(), ...overrides });

test("the two shapes in the repository are the shapes the rules describe", () => {
  // The templates are what an operator copies, so they and the rules cannot be
  // allowed to drift. Their fingerprints are placeholders on purpose -- the
  // algorithm is undecided -- and everything else has to hold.
  const loaded = {};
  for (const [slot, path] of [
    ["active", "docs/ops/mobile-auth-store-entries/active.template.json"],
    ["pending", "docs/ops/mobile-auth-store-entries/pending.template.json"],
  ]) {
    loaded[slot] = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(
      mobileStoreEntryProblems(loaded[slot], path, { allowPlaceholders: true }),
      []
    );
  }

  // And as a pair: the two templates must not read as each other's leftovers
  // either, or an operator copying both starts from a state the checker
  // refuses.
  assert.deepEqual(mobileStorePairProblems(loaded), []);
});

test("the placeholders are tolerated by exact text, and only where they belong", () => {
  // The exemption used to be "any problem mentioning the fingerprint", which
  // exempted a missing field as readily as a placeholder, and it applied to a
  // path spelled exactly one way. Both are the same mistake: a rule that
  // approximates what it is excusing.
  for (const path of [
    "docs/ops/mobile-auth-store-entries/active.template.json",
    "docs/ops/mobile-auth-store-entries/pending.template.json",
  ]) {
    const entry = JSON.parse(readFileSync(path, "utf8"));

    // Without the option -- which is every real entry -- a placeholder is a
    // value nobody has computed yet, and it fails.
    assert.match(
      mobileStoreEntryProblems(entry, path).join("\n"),
      /still the template placeholder/
    );

    // And with the option, everything except those exact strings still holds.
    const missing = { ...entry, fingerprint: { value: entry.fingerprint.value } };
    assert.match(
      mobileStoreEntryProblems(missing, path, { allowPlaceholders: true }).join("\n"),
      /fingerprint.algorithm must name/
    );
    // A near miss is not the placeholder. It falls through to the ordinary
    // rule for a value, which refuses it -- the exemption is those exact
    // strings, not "anything in angle brackets".
    const nearly = {
      ...entry,
      fingerprint: { ...entry.fingerprint, value: `${entry.fingerprint.value} ` },
    };
    assert.match(
      mobileStoreEntryProblems(nearly, path, { allowPlaceholders: true }).join("\n"),
      /fingerprint.value must be 8-128 characters/
    );
  }
});

test("every required field is required", () => {
  for (const field of ["kind", "phase", "rotationId", "createdAt", "targetSha", "fingerprint"]) {
    const entry = active();
    delete entry[field];
    assert.ok(
      problems(entry).some((problem) => problem.includes(field)),
      `${field} was not required`
    );
  }
});

test("a field of the wrong form is refused, not accepted as a string", () => {
  const cases = [
    [{ rotationId: "Rot With Spaces" }, /rotationId/],
    [{ rotationId: "no" }, /rotationId/],
    [{ createdAt: "2026-09-03" }, /createdAt/],
    [{ createdAt: "2026-09-03 10:00:00" }, /createdAt/],
    [{ targetSha: "abc123" }, /targetSha/],
    [{ targetSha: SHA_A.toUpperCase() }, /targetSha/],
    [{ deploymentId: "short" }, /deploymentId/],
    [{ fingerprint: "aaaa" }, /fingerprint must be an object/],
    [{ fingerprint: { value: "aaaaaaaa" } }, /algorithm/],
    [{ fingerprint: { algorithm: "sha256", value: "" } }, /value/],
  ];
  for (const [overrides, pattern] of cases) {
    assert.match(problems(active(overrides)).join("\n"), pattern, JSON.stringify(overrides));
  }
});

// --- drafted and deployed are different documents ---------------------------

test("a drafted pending has no deploymentId, and must not fake one", () => {
  assert.deepEqual(problems(pending()), []);

  // An empty string or a placeholder reads as an answer. Absence reads as
  // "not yet", which is what it is.
  for (const value of ["", "TBD", "pending"]) {
    assert.match(
      problems(pending({ deploymentId: value })).join("\n"),
      /must be absent/,
      JSON.stringify(value)
    );
  }
});

test("a deployed pending must name its deployment", () => {
  assert.match(
    problems(pending({ phase: "deployed" })).join("\n"),
    /deploymentId is required/
  );
  assert.deepEqual(
    problems(pending({ phase: "deployed", deploymentId: "22222222-2222-2222-2222-222222222222" })),
    []
  );
});

test("an active entry is deployed by definition and always names its deployment", () => {
  assert.match(problems(active({ phase: "drafted" })).join("\n"), /phase is 'deployed'/);
  const withoutId = active();
  delete withoutId.deploymentId;
  assert.match(problems(withoutId).join("\n"), /deploymentId is required/);
});

test("section 5.1's entry has pending's shape under its own kind", () => {
  assert.deepEqual(problems(pending({ kind: "emergency-pending" })), []);
  assert.match(problems(pending({ kind: "candidate" })).join("\n"), /kind/);
});

// --- one entry being the other's leftover ----------------------------------

test("a pending carrying the deployed rotation is refused", () => {
  // The dangerous one: every field is well formed, and the entry reads as a
  // candidate while being what is already running.
  assert.match(
    pair({ pending: pending({ rotationId: active().rotationId }) }).join("\n"),
    /same rotationId/
  );
});

test("a pending whose material equals the deployed material is refused", () => {
  assert.match(
    pair({ pending: pending({ fingerprint: active().fingerprint }) }).join("\n"),
    /same fingerprint/
  );
});

test("a pending reusing the deployed deployment id is refused", () => {
  assert.match(
    pair({
      pending: pending({ phase: "deployed", deploymentId: active().deploymentId }),
    }).join("\n"),
    /name the same deployment/
  );
});

test("a pending older than active is a leftover, not a candidate", () => {
  assert.match(
    pair({ pending: pending({ createdAt: "2026-09-01T00:00:00Z" }) }).join("\n"),
    /created before Active/
  );
  assert.deepEqual(pair(), []);
});

test("the kinds are checked against the slots they were read from", () => {
  assert.match(pair({ pending: active() }).join("\n"), /declares itself active/);
  assert.match(pair({ active: pending() }).join("\n"), /does not declare kind 'active'/);
});

// --- the document is metadata, not a ring ----------------------------------

test("a ring pasted into the metadata is refused, and not echoed back", () => {
  const ring = `sign-2:${"A".repeat(64)}`;
  for (const entry of [
    active({ note: ring }),
    active({ signingRing: "anything" }),
    active({ secret: "anything" }),
  ]) {
    const found = problems(entry).join("\n");
    assert.match(found, /vault's secret fields/);
    assert.equal(found.includes(ring), false, "the refusal repeated the material");
  }
});

test("a ring reached through a nested field is refused too", () => {
  // The scan used to read top-level strings only, so a ring one level down --
  // in the fingerprint, or in a field somebody added -- passed with no
  // problems at all. Two rules answer that: the shape is closed, and every
  // string inside it is read.
  const ring = `sign-2:${"A".repeat(64)}`;

  const inFingerprint = problems(active({ fingerprint: { algorithm: "sha256", value: ring } })).join("\n");
  assert.match(inFingerprint, /looks like key material/);
  assert.equal(inFingerprint.includes(ring), false);

  const inExtra = problems(active({ note: { signingKeys: ring } })).join("\n");
  assert.match(inExtra, /looks like key material/);
  assert.match(inExtra, /not part of an entry/);
  assert.equal(inExtra.includes(ring), false);

  // The closed shape is what makes the scan complete: there is no third place
  // to put an object.
  assert.match(problems(active({ targetSha: { nested: SHA_A } })).join("\n"), /must be a string/);
  assert.match(
    problems(active({ fingerprint: { algorithm: "sha256", value: "aaaaaaaa", extra: ring } })).join("\n"),
    /not part of its shape/
  );
  assert.match(problems(active({ $comment: [ring] })).join("\n"), /looks like key material/);
});

test("no refusal quotes the value it is refusing", () => {
  // The reason a value is suspect is usually that it might be key material,
  // and `kind` is as good a place to paste one as any other. A checker that
  // serialises the input into its own error does the disclosure it exists to
  // prevent.
  const ring = `sign-2:${"A".repeat(64)}`;
  for (const field of ["kind", "phase", "rotationId", "createdAt", "targetSha", "deploymentId"]) {
    const found = problems(active({ [field]: ring })).join("\n");
    assert.ok(found.length > 0, `${field} accepted a ring`);
    assert.equal(found.includes(ring), false, `the refusal for ${field} repeated the material`);
  }

  // Including the pair diagnostics, which run whatever the entries hold.
  const both = mobileStorePairProblems({
    active: active({ rotationId: ring, deploymentId: ring }),
    pending: pending({ rotationId: ring, deploymentId: ring, phase: "deployed" }),
  }).join("\n");
  assert.ok(both.length > 0);
  assert.equal(both.includes(ring), false);
});

test("a field name is printed only when the shape declares it", () => {
  // A shape that looks harmless says nothing about what the text is: a
  // 32-character alphanumeric pepper is an ordinary-looking identifier, and it
  // can be a JSON key as easily as a value. Only declared names are quoted.
  const pepper = "K7pQ2mZx9Lb4Vn6Rt8Wy1Cs3Df5Gh0J";
  const found = problems(active({ [pepper]: "x" })).join("\n");
  assert.match(found, /not part of an entry/);
  assert.match(found, /position \d+/);
  assert.equal(found.includes(pepper), false, "the refusal printed the key");

  // A declared name is quoted, because naming it is how the operator finds it.
  assert.match(problems(active({ targetSha: 5 })).join("\n"), /"targetSha"/);

  // Including a forbidden name, which is declared by the rings themselves.
  assert.match(problems(active({ signingKeys: "x" })).join("\n"), /"signingKeys"/);
});

test("the fingerprint's comment is read like every other string", () => {
  // `fingerprint.$comment` was the corner the walk stopped one level short of:
  // an array inside it was never read, and the shape check accepted it because
  // only algorithm and value were being judged.
  const ring = `pep-1:${"B".repeat(40)}`;
  const inComment = problems(
    active({ fingerprint: { algorithm: "sha256", value: "aaaaaaaa", $comment: [ring] } })
  ).join("\n");
  assert.match(inComment, /looks like key material/);
  assert.equal(inComment.includes(ring), false);

  // And its type is checked, so there is no deeper structure to hide in.
  assert.match(
    problems(
      active({ fingerprint: { algorithm: "sha256", value: "aaaaaaaa", $comment: { a: [ring] } } })
    ).join("\n"),
    /\$comment must be a string or an array of strings/
  );

  // The weaker ring test belongs to `fingerprint.value` alone: an algorithm
  // name and a comment are prose and get the ordinary rule, which is the one
  // that catches a long base64 run.
  const base64 = "C".repeat(72);
  assert.match(
    problems(active({ fingerprint: { algorithm: base64, value: "aaaaaaaa" } })).join("\n"),
    /looks like key material/
  );
  assert.match(
    problems(
      active({ fingerprint: { algorithm: "sha256", value: "aaaaaaaa", $comment: base64 } })
    ).join("\n"),
    /looks like key material/
  );
  // ... and only there: a real digest of that shape is a value, not a ring.
  assert.deepEqual(problems(active({ fingerprint: { algorithm: "sha256", value: "d".repeat(64) } })), []);
});

test("the whole command says nothing about the values it read", () => {
  // The unit assertions above read the messages; this one reads what an
  // operator's terminal reads -- every stream of the real script, on a file
  // whose fields hold synthetic material.
  const directory = mkdtempSync(join(tmpdir(), "mobile-store-entry-"));
  try {
    const ring = `sign-2:${"A".repeat(64)}`;
    const activePath = join(directory, "active.json");
    const pendingPath = join(directory, "pending.json");
    writeFileSync(activePath, JSON.stringify({ ...active(), kind: ring, note: { signingKeys: ring } }));
    writeFileSync(pendingPath, JSON.stringify({ ...pending(), rotationId: ring }));

    const run = spawnSync(
      process.execPath,
      ["scripts/check-mobile-auth-store-entries.mjs", "--active", activePath, "--pending", pendingPath],
      { encoding: "utf8" }
    );

    assert.equal(run.status, 1, "the synthetic entries were accepted");
    const output = `${run.stdout}${run.stderr}`;
    assert.match(output, /FAIL mobile auth store entries/);
    assert.equal(output.includes(ring), false, "the command printed the material");
    assert.equal(output.includes("A".repeat(24)), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// --- what the pair check can and cannot compare ----------------------------

test("fingerprints computed by different rules are not compared", () => {
  // Two values from different algorithms are not the same measurement:
  // equality between them means nothing. Saying so is not the same as passing,
  // so it is still a problem -- it just is not the "you renamed instead of
  // rotating" one, which would be a false accusation.
  const found = pair({
    active: active({ fingerprint: { algorithm: "sha256", value: "samesame" } }),
    pending: pending({ fingerprint: { algorithm: "blake3", value: "samesame" } }),
  }).join("\n");
  assert.match(found, /different fingerprint algorithms/);
  assert.match(found, /undetermined/);
  assert.doesNotMatch(found, /renaming is not rotating/);

  // Under one rule the identity check is meaningful again.
  assert.match(
    pair({
      active: active({ fingerprint: { algorithm: "sha256", value: "samesame" } }),
      pending: pending({ fingerprint: { algorithm: "sha256", value: "samesame" } }),
    }).join("\n"),
    /renaming is not rotating/
  );

  // An entry that names no algorithm has its own problem; the pair does not
  // add a claim about material on top of it.
  assert.doesNotMatch(
    pair({ active: active({ fingerprint: { value: "samesame" } }) }).join("\n"),
    /same fingerprint|different fingerprint algorithms/
  );
});

// --- a date has to be a date -----------------------------------------------

test("an instant-shaped string that is not an instant is refused", () => {
  // The pattern alone accepts 2026-13-40T99:99:99Z, and `Date.parse` alone
  // rolls 2026-02-31 into March. Both then reach the pair check, where a NaN
  // or a silently moved day makes the ordering rule say nothing at all.
  for (const value of [
    "2026-13-40T99:99:99Z",
    "2026-02-31T00:00:00Z",
    "2026-00-10T00:00:00Z",
    "2026-09-31T00:00:00Z",
    "2026-09-03T24:00:00Z",
    "2026-09-03T10:60:00Z",
  ]) {
    assert.match(problems(active({ createdAt: value })).join("\n"), /real UTC instant/, value);
  }
  for (const value of ["2028-02-29T00:00:00Z", "2026-09-03T10:00:00.500Z"]) {
    assert.deepEqual(problems(active({ createdAt: value })), [], value);
  }

  // A fraction the shape accepts is a fraction the comparison has to carry:
  // truncating to the second makes these two the same moment, and the ordering
  // rule then holds a Pending written first to have been written second.
  assert.match(
    pair({
      active: active({ createdAt: "2026-09-03T10:00:00.900Z" }),
      pending: pending({ createdAt: "2026-09-03T10:00:00.100Z" }),
    }).join("\n"),
    /created before Active/
  );
  assert.deepEqual(
    pair({
      active: active({ createdAt: "2026-09-03T10:00:00.100Z" }),
      pending: pending({ createdAt: "2026-09-03T10:00:00.900Z" }),
    }),
    []
  );
  // `.5` is five hundred milliseconds, not five.
  assert.match(
    pair({
      active: active({ createdAt: "2026-09-03T10:00:00.5Z" }),
      pending: pending({ createdAt: "2026-09-03T10:00:00.050Z" }),
    }).join("\n"),
    /created before Active/
  );

  // And the ordering rule reads the same validated instant, so an impossible
  // date can no longer walk past it.
  assert.match(
    pair({
      active: active({ createdAt: "2026-09-03T10:00:00Z" }),
      pending: pending({ createdAt: "2026-09-02T10:00:00Z" }),
    }).join("\n"),
    /created before Active/
  );
});

test("the disclaimer says what a pass does not mean", () => {
  // It travels with the judgement rather than being a sentence somebody
  // remembers to add: a structural pass is not evidence about a deployment.
  assert.match(MOBILE_STORE_ENTRY_DISCLAIMER, /not evidence that anything was deployed/);
});
