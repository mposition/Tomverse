import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Where the canonical-browser gate is called decides what it costs.
 *
 * `skipUnlessCanonicalVisualBrowser()` exists so a golden judged by a
 * substitute Chromium reports `Not verified` instead of a product failure, and
 * its stated contract is that behavioural assertions in the same spec are
 * untouched. Called from a `beforeEach` it cannot keep that: Playwright skips
 * the whole test before a line of it runs, screenshot or not.
 *
 * `chat-state-visual-regression.spec.ts` did exactly that, on the comment
 * "every test in this file is a golden". 18 of its 81 take no screenshot --
 * attachment failure and retry, the unsupported and oversized file rejections,
 * the 44px touch targets, the 320px clipping check, Deep Research gating,
 * the comparison breakpoints, and the account and guest limit modals. All 18
 * were skipped on any substitute browser, which is precisely the environment
 * the fallback exists to serve. One of them is the credit-pack dialog's focus
 * assertion -- the assertion the nightly used to catch the focus race on
 * 18d1e891.
 *
 * So: the gate is called from the capture choke point, and nowhere else.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const e2e = join(root, "tests/e2e");
const GATE = "skipUnlessCanonicalVisualBrowser";

const specFiles = () =>
  readdirSync(e2e)
    .filter((entry) => entry.endsWith(".spec.ts"))
    .map((entry) => join(e2e, entry));

test("the gate is called from the golden capture", () => {
  const source = readFileSync(
    join(e2e, "support/chat-state-fixtures.ts"),
    "utf8"
  );
  const capture = source.slice(
    source.indexOf("export async function expectStableScreenshot")
  );
  assert.ok(
    capture.includes(`${GATE}()`),
    "expectStableScreenshot must call the gate -- it is the single choke point " +
      "for every golden in this suite, so it is the only place that can gate " +
      "captures without gating behaviour"
  );
  // Ordering matters: a theme that never applied, or an unexpected overlay, is
  // a product fact any browser can establish. Reporting that beats reporting a
  // skip, so those checks come first.
  assert.ok(
    capture.indexOf("expectNoUnexpectedTransientUi") < capture.indexOf(`${GATE}()`),
    "the gate must come after the checks that hold on any browser"
  );
});

test("no spec gates a whole file on the browser", () => {
  // The specific regression: the gate inside a `beforeEach`, which skips
  // screenshot-free tests along with the goldens.
  const offenders = [];
  for (const file of specFiles()) {
    const source = readFileSync(file, "utf8");
    if (!source.includes(`${GATE}(`)) continue;
    for (const match of source.matchAll(
      /test\.beforeEach\(([\s\S]*?)\n\}\);/g
    )) {
      if (match[1].includes(`${GATE}(`)) offenders.push(file.slice(root.length));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "A gate in beforeEach skips every test in the file, including the ones that " +
      "take no screenshot. Call it from the capture instead.\n" +
      offenders.join("\n")
  );
});

test("the visual-regression spec still carries behavioural tests", () => {
  // If this file ever became goldens-only the rule above would be free, and a
  // future reader could reasonably put the gate back in beforeEach. The count
  // is what makes the placement load-bearing, so it is asserted rather than
  // assumed -- and named, so a drop to zero is a decision somebody makes on
  // purpose.
  const source = readFileSync(
    join(e2e, "chat-state-visual-regression.spec.ts"),
    "utf8"
  );
  const blocks = source.split(/\btest\(\s*\n?\s*"/).slice(1);
  const withoutCapture = blocks.filter(
    (block) => !block.slice(0, block.indexOf("\n  });")).includes("expectStableScreenshot")
  );
  assert.ok(
    withoutCapture.length >= 5,
    `Only ${withoutCapture.length} screenshot-free test(s) left in the visual spec. ` +
      "If that is deliberate, say so here; if it is not, behavioural coverage was lost."
  );
});
