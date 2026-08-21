import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

/**
 * Cron Auto-Fix is off until someone says it is on, and says so in one place.
 *
 * Runs #1 (2026-07-22) through #31 (2026-08-21) failed identically, six
 * seconds in, every single day: AUTO_FIX_SYNC_SECRET was never set in Actions,
 * the poll endpoint answers 404 to an unauthenticated request, and `curl -f`
 * turned that into exit 22. A month of red runs that all meant "not
 * configured" is how a repository learns to ignore this workflow's alarm.
 *
 * The fix is not a guard that skips when the secret is empty. That would make
 * a rotated, mistyped or expired secret look exactly like a deliberate
 * decision not to run, and the pipeline would fall silent at the moment it
 * most needs to shout. Activation is its own signal -- a repository variable
 * -- and once it says yes, a missing credential is an error.
 *
 * These tests pin that separation, because the tempting shortcut is one line
 * away and reads as harmless.
 */

const WORKFLOW = readFileSync(
  new URL("../.github/workflows/cron-auto-fix.yml", import.meta.url),
  "utf8"
);

test("activation is an explicit repository variable, not an inferred state", () => {
  assert.match(
    WORKFLOW,
    /CRON_AUTO_FIX_ENABLED: \$\{\{ vars\.CRON_AUTO_FIX_ENABLED \}\}/,
    "the workflow must read its activation from a repository variable"
  );
  assert.match(
    WORKFLOW,
    /\[ "\$CRON_AUTO_FIX_ENABLED" = "true" \]/,
    "only the exact string 'true' may enable the pipeline"
  );
});

test("an absent secret never stands in for the activation decision", () => {
  // Any `if:` that consults a secret is the shortcut this file exists to stop:
  // it would silently downgrade a broken credential to a quiet skip.
  for (const line of WORKFLOW.split("\n")) {
    if (!/^\s*if:/.test(line)) continue;
    assert.doesNotMatch(
      line,
      /secrets\./,
      `a step condition must not branch on a secret: ${line.trim()}`
    );
  }
});

test("every credential the pipeline needs is checked, and before anything is claimed", () => {
  const preflight = WORKFLOW.indexOf("Verify required credentials are present");
  const poll = WORKFLOW.indexOf("Poll for unattempted auto-fix-eligible failures");
  assert.ok(preflight > 0, "the credential preflight must exist");
  assert.ok(
    preflight < poll,
    "the preflight must run before the poll, which claims the incidents it returns"
  );

  const step = WORKFLOW.slice(preflight, poll);
  for (const secret of [
    "AUTO_FIX_SYNC_SECRET",
    "ANTHROPIC_API_KEY",
    "GH_AUTOMATION_PAT",
  ]) {
    assert.match(
      step,
      new RegExp(`secrets\\.${secret} != ''`),
      `${secret} must be checked for presence; the sync secret alone is not enough to run a fix`
    );
    assert.match(step, new RegExp(`missing ${secret}`), `${secret} must be named in the failure`);
  }
  assert.match(step, /exit 1/, "a missing credential under an enabled pipeline is an error, not a skip");
});

test("the preflight counts secrets without handling them", () => {
  const preflight = WORKFLOW.indexOf("Verify required credentials are present");
  assert.ok(preflight > 0, "the credential preflight must exist");
  const step = WORKFLOW.slice(preflight, WORKFLOW.indexOf("Poll for unattempted"));
  // `secrets.X != ''` is resolved by Actions, so the step's environment gets a
  // boolean. Binding the value itself would put three credentials into a step
  // that only needs to know whether they exist.
  assert.doesNotMatch(
    step,
    /: \$\{\{ secrets\.[A-Z_]+ \}\}/,
    "the presence check must not bind secret values into its environment"
  );
});

test("the poll reports what actually happened instead of one exit code", () => {
  const poll = WORKFLOW.slice(WORKFLOW.indexOf("Poll for unattempted"));
  assert.doesNotMatch(
    poll,
    /curl -sS -f \\\n\s+-H "Authorization: Bearer \$\{AUTO_FIX_SYNC_SECRET\}"/,
    "`curl -f` collapses 404, 5xx and a network failure into exit 22"
  );
  assert.match(poll, /-w '%\{http_code\}'/, "the poll must read the status code");
  for (const status of ["200", "404", "000"]) {
    assert.match(poll, new RegExp(`^\\s{12}${status}\\)`, "m"), `HTTP ${status} needs its own message`);
  }
  // A 404 here does not identify its cause, and saying "disabled" would be a
  // guess: the same code covers a wrong secret, a secret missing server-side,
  // and a missing route.
  const notFound = poll.slice(poll.indexOf("            404)"), poll.indexOf("            000)"));
  assert.match(notFound, /not authenticated, or the route is absent/);
});

test("a 200 is validated before it becomes a build matrix", () => {
  const poll = WORKFLOW.slice(WORKFLOW.indexOf("Poll for unattempted"));
  assert.match(
    poll,
    /jq -e '\.runs \| arrays'/,
    "`.runs` on an unexpected body yields null, which jq would count as zero pending runs"
  );
  assert.match(
    poll,
    /autoFixAttemptedAt is stamped on read/,
    "the failure must say that the incidents are already claimed and need releasing"
  );
});
