import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

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
function run(lane, patterns) {
  const result = spawnSync(
    process.execPath,
    [
      ...lane.conditions,
      "--import",
      "tsx",
      "--test",
      // PDF worker tests spawn their own parser process. On high-core Windows
      // hosts, running every test file concurrently intermittently terminates
      // that file before it can report an assertion. Serial file execution
      // keeps the mandatory gate deterministic; individual tests inside each
      // file are still free to exercise their own concurrency.
      "--test-concurrency=1",
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

for (const lane of LANES) {
  const names = discover(lane);

  if (names.length === 0) {
    if (lane.required) throw new Error("No unit tests were found.");
    continue;
  }

  // Built from the same fields `discover()` read, so the pattern and the count
  // printed next to it cannot drift apart. A suffix that matches nothing --
  // `tests/client/*.test.ts` today -- is harmless: node ignores a pattern with
  // no matches as long as the run has files overall, which the guard above
  // establishes.
  const patterns = lane.suffixes.map((suffix) => `${lane.directory}/*${suffix}`);

  console.log(`Running ${names.length} ${lane.label} unit test file(s).`);

  const status = run(lane, patterns);
  if (status !== 0) process.exit(status);
}

process.exit(0);
