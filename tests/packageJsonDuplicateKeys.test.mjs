// Duplicate keys in a tracked package.json
// (scripts/check-package-json-duplicate-keys-core.mjs).
//
// `npm run check:package-json-duplicate-keys` reports a count over the files
// that exist today. What it cannot say is whether the scan would still catch a
// duplicate -- a scanner that quietly stopped working reports the same clean
// zero as a clean tree, and this one guards a defect that is invisible by
// construction, so nothing else would notice. These cases feed it the shapes
// that a naive line-based scan gets wrong, and the real regression that
// prompted the check.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  describeDuplicate,
  duplicateJsonKeys,
} from "../scripts/check-package-json-duplicate-keys-core.mjs";

test("a clean document has no duplicates", () => {
  const source = JSON.stringify(
    { name: "x", scripts: { a: "1", b: "2" }, nested: { a: "3" } },
    null,
    2
  );
  assert.deepEqual(duplicateJsonKeys(source), []);
});

test("a key repeated in the same object is reported with both lines", () => {
  const source = [
    "{",
    '  "scripts": {',
    '    "report:a": "node a.mjs",',
    '    "report:b": "node b.mjs",',
    '    "report:a": "node a.mjs"',
    "  }",
    "}",
  ].join("\n");

  assert.deepEqual(duplicateJsonKeys(source), [
    { path: "scripts", key: "report:a", lines: [3, 5] },
  ]);
});

// The case that makes this worth catching at all. When the two values agree,
// the file is merely redundant; when they differ, it states one thing and
// every reader does the other, and no amount of reading the parsed object can
// tell you so.
test("a repeated key with a DIFFERENT value is reported", () => {
  const source = [
    "{",
    '  "scripts": {',
    '    "build": "next build",',
    '    "build": "echo nope"',
    "  }",
    "}",
  ].join("\n");

  const [duplicate] = duplicateJsonKeys(source);
  assert.equal(duplicate.key, "build");
  // JSON.parse keeps the last; the first is what the file still appears to say.
  assert.equal(JSON.parse(source).scripts.build, "echo nope");
});

// A line-based regex reads `":` inside this value as a key separator.
test("a colon-quote sequence inside a string value is not read as a key", () => {
  const source = [
    "{",
    '  "scripts": {',
    '    "a": "echo \\"key\\": not a key",',
    '    "b": "echo ok"',
    "  }",
    "}",
  ].join("\n");

  assert.deepEqual(duplicateJsonKeys(source), []);
});

// ...and a line-based regex sees only one key per line here.
test("two declarations on one line are both counted", () => {
  const source = '{ "scripts": { "a": "1", "a": "2" } }';

  assert.deepEqual(duplicateJsonKeys(source), [
    { path: "scripts", key: "a", lines: [1, 1] },
  ]);
});

test("the same key in two different objects is not a duplicate", () => {
  const source = [
    "{",
    '  "scripts": { "build": "1" },',
    '  "devDependencies": { "build": "2" }',
    "}",
  ].join("\n");

  assert.deepEqual(duplicateJsonKeys(source), []);
});

test("duplicates inside objects in an array are found", () => {
  const source = [
    "{",
    '  "workspaces": [',
    '    { "name": "a", "name": "b" }',
    "  ]",
    "}",
  ].join("\n");

  assert.deepEqual(duplicateJsonKeys(source), [
    { path: "workspaces[0]", key: "name", lines: [3, 3] },
  ]);
});

test("a nested duplicate is reported before the object containing it", () => {
  const source = [
    "{",
    '  "a": { "x": 1, "x": 2 },',
    '  "a": { "y": 3 }',
    "}",
  ].join("\n");

  assert.deepEqual(
    duplicateJsonKeys(source).map((duplicate) => duplicate.path),
    ["a", ""]
  );
});

// An escaped key and a literal one denote the same property, and JSON.parse
// would merge them -- so comparing raw bytes would miss it.
test("an escaped key matches the same key written literally", () => {
  const source = '{ "o": { "a\\u0062c": 1, "abc": 2 } }';

  assert.deepEqual(duplicateJsonKeys(source), [
    { path: "o", key: "abc", lines: [1, 1] },
  ]);
});

test("the message names the file, the path and every line", () => {
  const message = describeDuplicate("package.json", {
    path: "scripts",
    key: "report:a",
    lines: [173, 230],
  });

  assert.match(message, /package\.json/);
  assert.match(message, /scripts\.report:a/);
  assert.match(message, /173, 230/);
});

// The regression itself. package.json carried `report:provider-data-destinations`
// twice; this is the shape of those two lines.
test("the package.json regression that prompted this check is caught", () => {
  const source = [
    "{",
    '  "scripts": {',
    '    "report:provider-data-destinations": "node scripts/report-provider-data-destinations.mjs",',
    '    "report:other": "node scripts/report-other.mjs",',
    '    "report:provider-data-destinations": "node scripts/report-provider-data-destinations.mjs"',
    "  }",
    "}",
  ].join("\n");

  assert.deepEqual(duplicateJsonKeys(source), [
    {
      path: "scripts",
      key: "report:provider-data-destinations",
      lines: [3, 5],
    },
  ]);
});

// The check runs over the tree, so the tree has to be clean for the count it
// prints to mean anything. This is the assertion that fails if someone adds a
// duplicate back.
test("the repository's own package.json has no duplicate keys", () => {
  assert.deepEqual(
    duplicateJsonKeys(readFileSync(new URL("../package.json", import.meta.url), "utf8")),
    []
  );
});

test("every script key in package.json survives parsing", () => {
  const source = readFileSync(
    new URL("../package.json", import.meta.url),
    "utf8"
  );
  // The symptom the duplicate produced: more keys in the bytes than in the
  // object any reader gets. Counted here independently of the scanner, so the
  // two would have to fail the same way to agree wrongly.
  const declared = [
    ...source
      .slice(
        source.indexOf('"scripts"'),
        source.indexOf("\n  }", source.indexOf('"scripts"'))
      )
      .matchAll(/^\s{4}"((?:[^"\\]|\\.)*)"\s*:/gm),
  ].map((match) => match[1]);

  const parsed = Object.keys(JSON.parse(source).scripts);
  assert.equal(
    declared.length,
    parsed.length,
    `${declared.length} script keys in the file, ${parsed.length} after parsing`
  );
  // Guards the slicing above: a regex that matched nothing would make the
  // comparison 0 === 0 and pass for the wrong reason.
  assert.ok(declared.length > 100, `only ${declared.length} keys matched`);
});
