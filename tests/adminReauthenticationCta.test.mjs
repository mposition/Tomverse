// A step-up refusal has to offer the way back.
//
// docs/ui-contracts/admin-console-ia.md.
//
// The bug this exists to stop has now happened three times, and it looks the
// same each time: an admin control refuses with "sign in again", says so in a
// toast, and stops there. The operator is told the remedy and given no way to
// reach it -- the screen reads as broken rather than gated, and the only exit
// anyone finds is guessing a URL.
//
// The remedy is one helper. `adminRecentAuthenticationHref()` builds the
// step-up URL with a callback back to the screen the operator was on, so the
// console session is kept and the sign-in returns them where they were. Any
// panel that can see a step-up refusal must be able to render a link to it.
//
// A source scan rather than a render test, for the same reason
// `appSettingWriters` is one: the question is whether a path exists at all,
// and a missing path never fails a render test that does not know to look for
// it. Coarse on purpose -- it cannot tell a link that is drawn from one that
// is merely importable, and it does not try. It answers the one question that
// was answered wrong three times.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PANEL_DIR = fileURLToPath(new URL("../components/admin/", import.meta.url));

/** How a component learns it was refused for a stale step-up window. */
const REFUSAL_MARKERS = [
  "ADMIN_REAUTHENTICATION_REQUIRED",
  "requiresReauthentication",
  "reauthenticationRequired",
];

/** The one helper that produces a URL back into the step-up flow. */
const CTA_MARKER = "adminRecentAuthenticationHref";

const panels = readdirSync(PANEL_DIR)
  .filter((name) => name.endsWith(".tsx"))
  .map((name) => ({ name, source: readFileSync(`${PANEL_DIR}${name}`, "utf8") }));

test("the sweep sees the panels it is meant to, so a silent pass is impossible", () => {
  // Without this the file passes vacuously the day the markers are renamed.
  const seen = panels.filter((panel) =>
    REFUSAL_MARKERS.some((marker) => panel.source.includes(marker))
  );
  assert.ok(
    seen.length >= 3,
    `only ${seen.length} admin panel(s) handle a step-up refusal; the markers have probably drifted`
  );
});

test("every admin panel that can be refused offers the way back", () => {
  const missing = panels
    .filter(
      (panel) =>
        REFUSAL_MARKERS.some((marker) => panel.source.includes(marker)) &&
        !panel.source.includes(CTA_MARKER)
    )
    .map((panel) => panel.name);

  assert.deepEqual(
    missing,
    [],
    `${missing.join(", ")} can be refused for a stale step-up window and offers no link to renew it. ` +
      `A toast naming the remedy without a way to reach it is the defect this test exists for: ` +
      `render the step-up link with ${CTA_MARKER}(<this screen's path>).`
  );
});
