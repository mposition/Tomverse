import assert from "node:assert/strict";
import test from "node:test";
import {
  changeManifestDigest,
  changeManifestProblems,
  isApprovedChange,
  mainAcceptsApprovedChange,
  parseStoredChangeManifest,
  type ChangeManifestEntry,
} from "../lib/feedbackAutoFixChangeManifest";

/**
 * The approved-change identity (independent review round 1, N1). What must
 * hold:
 *   - the same lines changed at a different place in a file are a different
 *     change -- whole-file blobs, not added/removed lines;
 *   - main receives the change only where main still has the approved base;
 *   - the promotion PR is accepted only with exactly the approved paths and
 *     after-blobs;
 *   - order and case never matter; invalid manifests never match anything.
 */

const blob = (char: string) => char.repeat(40);

const approved: ChangeManifestEntry[] = [
  { path: "lib/a.ts", baseBlob: blob("1"), headBlob: blob("2") },
  { path: "tests/a.test.ts", baseBlob: null, headBlob: blob("3") },
];

test("equal manifests digest equal regardless of order and case", () => {
  const reordered = [
    { ...approved[1], headBlob: blob("3").toUpperCase() },
    approved[0],
  ];
  assert.ok(changeManifestDigest(approved));
  assert.equal(changeManifestDigest(approved), changeManifestDigest(reordered));
});

test("the same edit at another place in the file is a different change", () => {
  // Flipping a different one of two identical blocks produces the same
  // added/removed lines but a different resulting file -- a different blob.
  const elsewhere = [
    { path: "lib/a.ts", baseBlob: blob("1"), headBlob: blob("9") },
    approved[1],
  ];
  const verdict = isApprovedChange(approved, elsewhere);
  assert.equal(verdict.ok, false);
  assert.match(!verdict.ok ? verdict.reason : "", /contents differ/);
});

test("an extra or missing file is not the approved change", () => {
  const extra = [
    ...approved,
    { path: "lib/b.ts", baseBlob: blob("4"), headBlob: blob("5") },
  ];
  const missing = [approved[0]];
  assert.match(
    (isApprovedChange(approved, extra) as { reason: string }).reason,
    /set of changed files/
  );
  assert.equal(isApprovedChange(approved, missing).ok, false);
  assert.equal(isApprovedChange(approved, [...approved]).ok, true);
});

test("main accepts the change only where it still has the approved base", () => {
  const same = new Map<string, string | null>([
    ["lib/a.ts", blob("1")],
    ["tests/a.test.ts", null],
  ]);
  assert.equal(mainAcceptsApprovedChange(approved, same).ok, true);

  const drifted = new Map(same).set("lib/a.ts", blob("7"));
  assert.equal(mainAcceptsApprovedChange(approved, drifted).ok, false);

  const alreadyHasTest = new Map(same).set("tests/a.test.ts", blob("3"));
  assert.equal(mainAcceptsApprovedChange(approved, alreadyHasTest).ok, false);

  const unknown = new Map(same);
  unknown.delete("lib/a.ts");
  assert.equal(mainAcceptsApprovedChange(approved, unknown).ok, false);
});

test("invalid manifests have no digest and never match", () => {
  const cases: ChangeManifestEntry[][] = [
    [],
    [{ path: "lib/a.ts", baseBlob: "short", headBlob: blob("2") }],
    [{ path: "lib/a.ts", baseBlob: null, headBlob: null }],
    [{ path: "lib/a.ts", baseBlob: blob("1"), headBlob: blob("1") }],
    [approved[0], approved[0]],
    [{ path: "/etc/passwd", baseBlob: null, headBlob: blob("2") }],
  ];
  for (const manifest of cases) {
    assert.ok(changeManifestProblems(manifest).length > 0);
    assert.equal(changeManifestDigest(manifest), null);
    assert.equal(isApprovedChange(manifest, manifest).ok, false);
  }
});

test("a stored manifest is re-validated when read", () => {
  assert.deepEqual(parseStoredChangeManifest(approved), approved);
  assert.equal(parseStoredChangeManifest({ path: "x" }), null);
  assert.equal(
    parseStoredChangeManifest([{ path: "lib/a.ts", baseBlob: 1, headBlob: null }]),
    null
  );
  assert.equal(parseStoredChangeManifest([]), null);
});
