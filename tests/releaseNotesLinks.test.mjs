// The fixed link table a release-notes email chooses from.
//
// Contract: docs/policy/email-product-news-redesign-draft.md section 8.

import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMERCIAL_PATH_PREFIXES,
  RELEASE_NOTES_APPROVED_LINKS,
  RELEASE_NOTES_LINK_IDS,
  commercialLinkIdsInReleaseNotes,
  isCommercialPath,
  isReleaseNotesLinkId,
  releaseNotesLinkPath,
  unservedReleaseNotesLinkIds,
} from "../lib/releaseNotesLinks.ts";
import {
  MARKETING_APPROVED_LINKS,
  MARKETING_LINK_IDS,
} from "../lib/marketingApprovedLinks.ts";

test("no approved destination is a commercial one", () => {
  // The rule section 8 states, and the one the table exists for.
  assert.deepEqual(commercialLinkIdsInReleaseNotes(), []);
});

test("every approved path is a route this app serves", () => {
  // A renamed or withdrawn page becomes a link to a 404 in an email nobody
  // can recall, so it breaks the build instead.
  assert.deepEqual(unservedReleaseNotesLinkIds(), []);
});

test("the table is not empty and every id resolves", () => {
  assert.ok(RELEASE_NOTES_LINK_IDS.length > 0);
  for (const id of RELEASE_NOTES_LINK_IDS) {
    const path = releaseNotesLinkPath(id);
    assert.equal(typeof path, "string");
    assert.ok(path.startsWith("/"), `${id} is not a path`);
    assert.ok(isReleaseNotesLinkId(id));
  }
});

test("an id nobody approved resolves to nothing", () => {
  for (const value of [
    "release.pricing",
    "link.pricing",
    "https://tomverse.app/pricing",
    "/pricing",
    "",
    null,
    undefined,
    42,
    { id: "release.home" },
  ]) {
    assert.equal(isReleaseNotesLinkId(value), false, String(value));
  }
  assert.equal(releaseNotesLinkPath("release.pricing"), null);
});

test("a commercial path is one whatever follows it", () => {
  // `/pricing`, `/pricing/annual` and `/pricing/` are one decision.
  for (const prefix of COMMERCIAL_PATH_PREFIXES) {
    assert.ok(isCommercialPath(prefix), prefix);
    assert.ok(isCommercialPath(`${prefix}/annual`), `${prefix}/annual`);
  }
  // And a path that merely begins with the same letters is not.
  assert.equal(isCommercialPath("/pricing-guide"), false);
  assert.equal(isCommercialPath("/upgrades-explained"), false);
  assert.equal(isCommercialPath("/models"), false);
});

test("this table is its own, not a slice of the marketing one", () => {
  // They agree on most entries and that is fine. What must not happen is this
  // table being derived from that one: a subset expression would make it
  // follow every future addition there, and the next commercial page somebody
  // adds for a social post would appear in an email without a decision.
  //
  // So the check is the opposite of "is it a subset": it is that the marketing
  // table contains something this one refuses, which is what makes them two
  // tables rather than one written twice.
  const marketingPaths = new Set(Object.values(MARKETING_APPROVED_LINKS));
  const releasePaths = new Set(Object.values(RELEASE_NOTES_APPROVED_LINKS));

  const refusedHere = [...marketingPaths].filter(
    (path) => !releasePaths.has(path)
  );
  assert.ok(
    refusedHere.some((path) => isCommercialPath(path)),
    "the marketing table holds no commercial path, so this table's whole reason is untested"
  );

  // The ids are namespaced apart too, so one table's id cannot be passed to
  // the other's resolver and quietly work.
  for (const id of RELEASE_NOTES_LINK_IDS) {
    assert.ok(id.startsWith("release."), id);
  }
  for (const id of MARKETING_LINK_IDS) {
    assert.ok(id.startsWith("link."), id);
    assert.equal(isReleaseNotesLinkId(id), false, id);
  }
});

test("the table is frozen", () => {
  // `as const` is a compile-time claim. An assignment at runtime would be a
  // destination nobody approved.
  assert.throws(() => {
    RELEASE_NOTES_APPROVED_LINKS["release.home"] = "/pricing";
  });
  assert.equal(RELEASE_NOTES_APPROVED_LINKS["release.home"], "/");
});
