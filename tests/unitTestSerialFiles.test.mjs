import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { SERIAL_UNIT_TEST_FILES } from "../scripts/unit-test-serial-files.mjs";

// Unit test files run concurrently, so a file that writes into the checkout is
// visible to every file running beside it. On 2026-09-05 a test that appended
// "(drift)" to a real dataset case and restored it in a `finally` made other
// processes compute digests their manifests never recorded -- a stable wrong
// value that looked like a stale cache, not a race. Such files either work on
// a temporary copy or are listed in scripts/unit-test-serial-files.mjs, which
// the runner executes alone after the concurrent pass.

const ROOT = new URL("..", import.meta.url);
const TEST_DIRECTORIES = ["tests", "tests/client"];
const TEST_SUFFIXES = [".test.mjs", ".test.ts", ".test.tsx"];

// A file that names a filesystem write. Deliberately broad: a false positive
// costs one line below, a false negative is a race nobody can reproduce.
const WRITES = /\b(writeFileSync|appendFileSync|rmSync|unlinkSync|renameSync|cpSync|mkdirSync|writeFile|appendFile|rename|unlink)\s*\(/;
// A file that creates its own scratch directory. Writes there are private to
// the process, so the file may run concurrently.
const OWN_SCRATCH = /\bmkdtemp(Sync)?\s*\(|\btmpdir\s*\(/;

// Files that match WRITES without writing to the tree. Each needs a reason.
const REVIEWED_NOT_TREE_WRITERS = new Map([
  [
    "tests/stampPromotionMetadataCore.test.mjs",
    "searches a script's source text for its writeFileSync call; writes nothing",
  ],
  [
    "tests/amuxV4SystemServiceInstall.test.mjs",
    "reads installer source to assert its writeFileSync ordering and calls only the pure environment parser; never runs installation or writes files",
  ],
  [
    "tests/issueBacklogShaMode.test.mjs",
    "writes only inside the temporary repository tests/support/issueBacklogFixtureRepo.mjs creates with mkdtempSync; the mkdtemp call is in the helper, so this file's own source does not show one",
  ],
]);

function testFiles() {
  return TEST_DIRECTORIES.flatMap((directory) => {
    let names;
    try {
      names = readdirSync(new URL(`${directory}/`, ROOT));
    } catch {
      return [];
    }
    return names
      .filter((name) => TEST_SUFFIXES.some((suffix) => name.endsWith(suffix)))
      .map((name) => `${directory}/${name}`);
  });
}

test("every serial file still exists in tests/", () => {
  const present = new Set(readdirSync(new URL("tests/", ROOT)));
  for (const name of SERIAL_UNIT_TEST_FILES) {
    assert.ok(present.has(name), `${name} is listed as serial but does not exist`);
  }
});

test("the unit runner reads the serial list", () => {
  const runner = readFileSync(new URL("scripts/run-unit-tests.mjs", ROOT), "utf8");
  assert.match(runner, /from "\.\/unit-test-serial-files\.mjs"/);
});

test("a test that writes without its own scratch directory is serial or reviewed", () => {
  const serial = new Set(SERIAL_UNIT_TEST_FILES.map((name) => join("tests", name).replaceAll("\\", "/")));
  const unaccounted = testFiles().filter((path) => {
    if (serial.has(path) || REVIEWED_NOT_TREE_WRITERS.has(path)) return false;
    const source = readFileSync(new URL(path, ROOT), "utf8");
    return WRITES.test(source) && !OWN_SCRATCH.test(source);
  });
  assert.deepEqual(
    unaccounted,
    [],
    "These files write to the filesystem without creating a temporary directory. " +
      "If they write into the checkout, add them to scripts/unit-test-serial-files.mjs " +
      "(or make them use mkdtemp); if they do not, add them to REVIEWED_NOT_TREE_WRITERS with the reason."
  );
});

test("a reviewed entry still matches the write heuristic", () => {
  // Otherwise the exemption outlives the reason it was granted.
  for (const path of REVIEWED_NOT_TREE_WRITERS.keys()) {
    const source = readFileSync(new URL(path, ROOT), "utf8");
    assert.ok(WRITES.test(source), `${path} no longer matches; remove its exemption`);
  }
});
