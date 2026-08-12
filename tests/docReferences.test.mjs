import { strict as assert } from "node:assert";
import test from "node:test";

import {
  auditDocumentReferences,
  documentReferences,
  PLANNED_REFERENCES,
} from "../scripts/check-doc-references-core.mjs";

/**
 * The guard over the paths AGENTS.md and the documents under it name.
 *
 * Six were broken when it was written, each for an ordinary reason: a root
 * layout that moved into route groups, a hook that moved into a neighbouring
 * module, an archived migration, two `.test.mjs` paths that are `.test.ts`,
 * and one module planned and never built. Nothing failed because of any of
 * them -- they just sent readers to empty paths.
 */

const audit = (paths, exists) =>
  auditDocumentReferences({
    references: new Map(
      paths.map((path) => [path, new Set(["docs/policy/example.md"])])
    ),
    exists: (path) => exists.includes(path),
  });

test("a reference to a missing file is an error, and names who made it", () => {
  const { errors } = audit(["lib/gone.ts"], []);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /lib\/gone\.ts/);
  assert.match(errors[0], /docs\/policy\/example\.md/);
});

test("a reference that resolves is not reported", () => {
  const { errors } = audit(["lib/here.ts"], ["lib/here.ts"]);
  assert.deepEqual(errors, []);
});

test("a planned reference stops being exempt once it exists", () => {
  // Otherwise the exemption outlives its reason and the path it covers stops
  // being checked -- the same failure mode as a stale allowlist entry.
  const planned = Object.keys(PLANNED_REFERENCES);
  assert.ok(planned.length > 0, "this test needs at least one planned entry");
  const { errors } = auditDocumentReferences({
    references: new Map(),
    exists: (path) => path === planned[0],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /listed as planned but now exists/);
});

test("every planned entry says which document marks it unbuilt, and why", () => {
  // The exemption is only legitimate when the reader has already been told.
  for (const [path, entry] of Object.entries(PLANNED_REFERENCES)) {
    assert.ok(entry.document, `${path} names no document`);
    assert.ok(
      entry.reason && entry.reason.length > 60,
      `${path} needs a reason a reviewer can check, not a note`
    );
  }
});

test("paths are read from code spans and links, not from bare prose", () => {
  const found = documentReferences(
    [
      "Read `docs/policy/credit-and-cost-limits.md` first.",
      "See (lib/modelPricing.ts) for the profiles.",
      "The app/api directory is not a file reference.",
      "Nor is some plain sentence about tests in general.",
    ].join("\n")
  );
  assert.deepEqual(
    [...found].sort(),
    ["docs/policy/credit-and-cost-limits.md", "lib/modelPricing.ts"]
  );
});

test("route-group and dynamic-segment paths are recognised", () => {
  // `app/(site)/(application)/chat/ChatPageClient.tsx` and
  // `app/[locale]/layout.tsx` are both real paths in this repository, and a
  // pattern that could not match them would silently stop checking the
  // directories most likely to be reorganised.
  const found = documentReferences(
    "`app/(site)/(application)/chat/ChatPageClient.tsx` and `app/[locale]/layout.tsx`"
  );
  assert.equal(found.size, 2);
});
