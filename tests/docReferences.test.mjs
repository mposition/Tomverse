import { strict as assert } from "node:assert";
import test from "node:test";

import {
  auditDocumentReferences,
  auditSourceCommentReferences,
  documentReferences,
  extractCommentText,
  HISTORICAL_SOURCE_REFERENCES,
  PLANNED_REFERENCES,
  sourceCommentReferences,
} from "../scripts/check-doc-references-core.mjs";

/**
 * The guard over the paths AGENTS.md and the documents under it name, and over
 * the paths the source comments name.
 *
 * Six documents were broken when it was written, each for an ordinary reason: a
 * root layout that moved into route groups, a hook that moved into a
 * neighbouring module, an archived migration, two `.test.mjs` paths that are
 * `.test.ts`, and one module planned and never built. Nothing failed because of
 * any of them -- they just sent readers to empty paths.
 *
 * Eleven comments were broken when the sweep was widened to cover them, and one
 * of those was a different kind of claim: lib/scheduledJobsCore.ts said a named
 * test asserted its cadences against the Railway config files, and no file of
 * that name existed. A comment naming a module misdirects a reader; a comment
 * naming a test asserts that something is covered, and is believed without
 * being opened.
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
  //
  // The registry it passes is synthetic on purpose. Reading the live one made
  // this test depend on there being something unbuilt, so it went from proving
  // the rule to asserting the backlog was non-empty -- and it broke the moment
  // the last planned file was written, which is the one moment the rule works.
  const { errors } = auditDocumentReferences({
    references: new Map(),
    exists: (path) => path === "lib/nowBuilt.ts",
    planned: {
      "lib/nowBuilt.ts": { document: "docs/somewhere.md", reason: "planned" },
    },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /listed as planned but now exists/);
});

test("nothing is exempt unless the registry says so", () => {
  const { errors } = auditDocumentReferences({
    references: new Map([["lib/missing.ts", new Set(["AGENTS.md"])]]),
    exists: () => false,
    planned: {},
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /does not exist/);
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

test("a path is a path however the prose punctuates it", () => {
  // Bare paths count because comments write them that way. What keeps that from
  // reading half a sentence as a filename is the extension and the leading
  // directory, not the backticks.
  const found = documentReferences(
    [
      "Read `docs/policy/credit-and-cost-limits.md` first.",
      "See (lib/modelPricing.ts) for the profiles.",
      "Asserted by tests/scheduledJobsCore.test.mjs, which reads the crons.",
      "The app/api directory is not a file reference.",
      "Nor is some plain sentence about tests in general.",
    ].join("\n")
  );
  assert.deepEqual(
    [...found].sort(),
    [
      "docs/policy/credit-and-cost-limits.md",
      "lib/modelPricing.ts",
      "tests/scheduledJobsCore.test.mjs",
    ]
  );
});

test("only comments are read, so an import or a filename argument is not", () => {
  // An import is checked by the compiler and a `readFileSync` argument by the
  // run itself. Reading them here would add nothing and would report a path
  // built at runtime as broken.
  const found = sourceCommentReferences(
    [
      'import { thing } from "@/lib/realModule.ts";',
      'const raw = readFileSync("scripts/definitelyMissing.mjs", "utf8");',
      "// See lib/namedByAComment.ts for the reason.",
      "/** And tests/namedByABlockComment.test.mjs proves it. */",
    ].join("\n")
  );
  assert.deepEqual(
    [...found].sort(),
    ["lib/namedByAComment.ts", "tests/namedByABlockComment.test.mjs"]
  );
});

test("a URL inside a string is not mistaken for a comment", () => {
  const found = sourceCommentReferences(
    [
      'const url = "https://example.com//lib/notAComment.ts";',
      "// But lib/thisOne.ts is.",
    ].join("\n")
  );
  assert.deepEqual([...found], ["lib/thisOne.ts"]);
});

test("an unterminated block comment is still read", () => {
  // Otherwise the last comment in a file could escape the sweep by being
  // malformed, which is the opposite of what a check should reward.
  assert.match(
    extractCommentText("/* trailing note about lib/tail.ts"),
    /lib\/tail\.ts/
  );
});

test("a comment pointing at a missing file names the comment's own file", () => {
  const { errors } = auditSourceCommentReferences({
    references: new Map([["tests/neverWritten.test.mjs", new Set(["lib/a.ts"])]]),
    exists: () => false,
    historical: {},
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /tests\/neverWritten\.test\.mjs/);
  assert.match(errors[0], /lib\/a\.ts/);
});

test("a historical reference is exempt only for the file that registered it", () => {
  // The exemption is a statement about one sentence, not about a path. Another
  // file naming the same removed path is a different claim and stays reported.
  const { errors } = auditSourceCommentReferences({
    references: new Map([["app/gone.tsx", new Set(["lib/explains.ts", "lib/points.ts"])]]),
    exists: () => false,
    historical: { "lib/explains.ts -> app/gone.tsx": { reason: "explains the removal" } },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /lib\/points\.ts/);
});

test("a historical entry stops being exempt once the path exists again", () => {
  const { errors } = auditSourceCommentReferences({
    references: new Map([["app/back.tsx", new Set(["lib/explains.ts"])]]),
    exists: () => true,
    historical: { "lib/explains.ts -> app/back.tsx": { reason: "explains the removal" } },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /exists again/);
});

test("a historical entry no comment makes any more is reported as dead", () => {
  const { errors } = auditSourceCommentReferences({
    references: new Map(),
    exists: () => false,
    historical: { "lib/rewritten.ts -> app/gone.tsx": { reason: "explains the removal" } },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no comment makes that reference any more/);
});

test("every historical entry says why the absence is deliberate", () => {
  for (const [key, entry] of Object.entries(HISTORICAL_SOURCE_REFERENCES)) {
    assert.match(key, / -> /, `${key} must name the commenting file and the path`);
    assert.ok(
      entry.reason && entry.reason.length > 60,
      `${key} needs a reason a reviewer can check, not a note`
    );
  }
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
