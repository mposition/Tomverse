import { existsSync, readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { SERIAL_UNIT_TEST_FILES } from "./unit-test-serial-files.mjs";

/**
 * Test files reach `node --test` as glob patterns rather than as a list of
 * paths, because the list stopped fitting on the command line.
 *
 * Windows caps a command line at 32,767 characters. This suite passed that
 * mark: 518 absolute paths join to roughly 52,000, so `spawnSync` returned
 * `{ status: null, error: ENAMETOOLONG }` without starting node at all, and
 * `npm run test:unit` exited 1 having printed nothing. Linux's limit is far
 * higher, so CI never saw it -- the effect was that a Windows contributor
 * could not run the mandatory gate, and nothing on screen said why.
 *
 * Batching the paths over several spawns would also clear the limit, but each
 * batch is a separate run with its own `spec` summary, and having that summary
 * in one place at the end of the run is the reason the reporter was chosen
 * (see the comment above `run()`). A glob keeps one process per lane, so the
 * file count stops mattering at any size. Node 22 documents positional
 * arguments to `--test` as glob patterns; they are passed literally here
 * because `spawnSync` starts node directly, with no shell to expand them.
 *
 * The patterns have to select exactly what the explicit lists selected -- the
 * two lanes below differ in how modules resolve, so a file reaching the wrong
 * one does not merely run twice, it runs under the wrong resolver. `*` matches
 * within a single path segment, so `tests/*.test.mjs` reaches direct children
 * of `tests/` and nothing under `tests/integration/`, `tests/client/` or any
 * other subdirectory, which is what the `readdirSync` filter did.
 */

const LANES = [
  {
    label: "server",
    directory: "tests",
    suffixes: [".test.mjs", ".test.ts"],
    /**
     * Most of what is tested here is server code, and loading it the way the
     * server loads it is the point.
     */
    conditions: ["--conditions=react-server"],
    required: true,
  },
  {
    /**
     * Client components get their own process, without `--conditions=react-server`.
     *
     * Under that condition `react.createContext` does not exist, so anything
     * that pulls in `lucide-react` -- which is every icon-bearing component in
     * this app -- throws on import before a single assertion runs.
     *
     * A second process rather than dropping the condition for everything, and
     * rather than a mock: `scripts/run-db-integration-tests.mjs` already splits
     * processes for exactly this reason -- a flag that changes how modules
     * resolve is process-global, so one lane's needs would silently become the
     * other's.
     *
     * This lane exists because the Auto model selection contract
     * (docs/ui-contracts/auto-model-selection.md §1) says what two components
     * must render and nothing could execute that claim: there was no way to
     * load a client component in a test at all.
     */
    label: "client",
    directory: "tests/client",
    suffixes: [".test.tsx", ".test.ts"],
    conditions: [],
    required: false,
  },
];

/**
 * A glob and a `readdirSync` filter agree only for ordinary names. `*`, `?`,
 * `[` and `{` make a name mean something other than itself, and a leading dot
 * is skipped by a glob but not by `readdirSync`. Either way the lane would run
 * a different set of files than this script believes it is running, so an
 * unusual name is refused here rather than becoming a test that silently
 * stopped being executed.
 */
const GLOB_SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function discover(lane) {
  const directory = join(process.cwd(), lane.directory);
  if (!existsSync(directory)) return [];

  const names = readdirSync(directory)
    .filter((name) => lane.suffixes.some((suffix) => name.endsWith(suffix)))
    .sort();

  const unsafe = names.filter((name) => !GLOB_SAFE_NAME.test(name));
  if (unsafe.length > 0) {
    console.error(
      `Cannot run the ${lane.label} unit tests: ${unsafe.length} file name(s) in ` +
        `${lane.directory}/ contain characters that a glob pattern reads as ` +
        `wildcards, so the run would not cover them:`
    );
    for (const name of unsafe) console.error(`  ${name}`);
    console.error(
      "Rename them using letters, digits, '.', '_' and '-', or teach this " +
        "runner how to pass them safely."
    );
    process.exit(1);
  }

  return names;
}

/**
 * `spec` rather than the default non-TTY `tap` reporter, for one reason: it
 * repeats every failure in a summary block at the *end* of the run.
 *
 * TAP prints "not ok" inline, wherever the test happened to run. With ~1000
 * tests that is thousands of lines up, and the GitHub Actions log API only
 * serves a bounded tail -- so a red CI run showed "# fail 1" with no way to
 * learn which test, and the file order is not even stable between machines
 * (node runs test files concurrently, so numbering shifts run to run). The
 * summary makes a truncated log enough to diagnose from.
 *
 * Nothing parses this output: the workflows and this script only use the exit
 * code, which is unchanged.
 */
function run(lane, patterns, concurrency) {
  const result = spawnSync(
    process.execPath,
    [
      ...lane.conditions,
      "--import",
      "tsx",
      "--test",
      `--test-concurrency=${concurrency}`,
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      ...patterns,
    ],
    { stdio: "inherit", env: process.env }
  );

  // A spawn that never started reports `status: null` and sets `error`. Left
  // unread, `status ?? 1` turns that into a bare exit code 1 with nothing
  // printed at all, which is what made the Windows failure above cost a
  // verification pass to diagnose. Say what happened before leaving.
  if (result.error) {
    const code = result.error.code ?? "unknown";
    console.error(`\nThe ${lane.label} unit tests never started (${code}).`);
    if (code === "ENAMETOOLONG") {
      console.error(
        "The command line built for node exceeded the operating system limit " +
          "(32,767 characters on Windows). It carried " +
          `${patterns.length} pattern(s): ${patterns.join(" ")}`
      );
    } else if (code === "ENOENT") {
      console.error(`No node binary could be executed at ${process.execPath}.`);
    }
    console.error(result.error.message);
    process.exit(1);
  }

  if (result.signal) {
    console.error(
      `\nThe ${lane.label} unit tests were terminated by signal ${result.signal}.`
    );
    process.exit(1);
  }

  return result.status ?? 1;
}

/**
 * How many test files run at once.
 *
 * Files ran one at a time from 2026-08-03 (#283) because PDF worker tests,
 * which spawn their own parser process, were intermittently terminated when
 * every file ran concurrently on high-core *Windows* hosts. The setting applied
 * everywhere, so CI's Linux runners also ran serially; at ~90 files that cost
 * little, at ~940 it was 14 of the PR gate's 20 minutes.
 *
 * Windows keeps the serial behaviour that fixed it. Elsewhere files run one per
 * available core. `UNIT_TEST_CONCURRENCY` overrides both, for reproducing a
 * suspected ordering problem (`=1`) or for stress-testing isolation on Windows.
 */
function fileConcurrency() {
  const override = process.env.UNIT_TEST_CONCURRENCY;
  if (override !== undefined && override !== "") {
    if (!/^[1-9][0-9]*$/.test(override)) {
      console.error(
        `UNIT_TEST_CONCURRENCY must be a positive integer; received "${override}".`
      );
      process.exit(1);
    }
    return Number(override);
  }
  return process.platform === "win32" ? 1 : availableParallelism();
}

/**
 * The lane's patterns with the serial files cut out, using an extglob
 * (`tests/!(a|b).test.mjs`). `discover()` has already refused any name outside
 * GLOB_SAFE_NAME, so a stem cannot carry `|`, `(` or `)` into the pattern.
 */
function concurrentPatterns(lane, serialNames) {
  return lane.suffixes.map((suffix) => {
    const stems = serialNames
      .filter((name) => name.endsWith(suffix))
      .map((name) => name.slice(0, -suffix.length));
    return stems.length === 0
      ? `${lane.directory}/*${suffix}`
      : `${lane.directory}/!(${stems.join("|")})${suffix}`;
  });
}

const concurrency = fileConcurrency();

for (const lane of LANES) {
  const names = discover(lane);

  if (names.length === 0) {
    if (lane.required) throw new Error("No unit tests were found.");
    continue;
  }

  // Only the server lane lives in `tests/` itself, which is where the list's
  // bare names point. A listed name that no longer exists fails
  // tests/unitTestSerialFiles.test.mjs rather than being silently dropped here.
  const serialNames =
    lane.directory === "tests"
      ? names.filter((name) => SERIAL_UNIT_TEST_FILES.includes(name))
      : [];

  // Built from the same fields `discover()` read, so the pattern and the count
  // printed next to it cannot drift apart. A suffix that matches nothing --
  // `tests/client/*.test.ts` today -- is harmless: node ignores a pattern with
  // no matches as long as the run has files overall, which the guard above
  // establishes.
  const patterns = concurrentPatterns(lane, serialNames);

  console.log(
    `Running ${names.length - serialNames.length} ${lane.label} unit test file(s), ` +
      `${concurrency} at a time.`
  );

  const status = run(lane, patterns, concurrency);
  if (status !== 0) process.exit(status);

  // After the concurrent pass, so nothing else is running while these files
  // touch the working tree. A handful of explicit paths fits any command line.
  if (serialNames.length > 0) {
    console.log(
      `Running ${serialNames.length} ${lane.label} unit test file(s) that write ` +
        "to the working tree, one at a time."
    );
    const serialStatus = run(
      lane,
      serialNames.map((name) => `${lane.directory}/${name}`),
      1
    );
    if (serialStatus !== 0) process.exit(serialStatus);
  }
}

process.exit(0);
