// What the mobile auth key rings look like right now, as a report.
//
//   npm run report:mobile-auth-keyring-health
//   npm run report:mobile-auth-keyring-health -- --json
//
// **A report, not a gate.** `check:mobile-auth-keyring` answers "may this be
// deployed?" and exits non-zero when the answer is no. This answers "what is
// there?" and exits 0 whether the news is good or bad, because a standing
// check that fails is a standing check somebody turns off. The one non-zero
// exit is a configuration this cannot parse at all, which means the report
// itself is not to be believed -- the same rule
// `report:issue-backlog` follows.
//
// The judgement is shared with the pre-deploy check
// (`mobile-auth-keyring-state.mjs`). Two implementations would eventually
// disagree, and an operator reading "healthy" here and "undeclared" there has
// no way to tell which is right.
//
// So is the assembly: `lib/mobileAuthKeyringHealth.ts` turns an environment
// into the report below, and the internal endpoint the standing check calls
// reads the same function. **This file is the rendering and the exit codes,
// and nothing else** -- the day the two callers describe the same ring
// differently is the day neither can be quoted.
//
// ## What it does not do
//
// It reads environment variables and nothing else. It does not reach a vault,
// register itself anywhere, send anything, or change a key. **Who runs it, how
// often, who reads the result and how long it is kept are approved decisions
// now** (S1-S8, 2026-09-10) -- and this file still does none of them: it is
// the operator's copy of the same reading.
//
// Procedure: docs/ops/mobile-auth-key-rotation.md

import { mobileAuthKeyringHealthReport } from "../lib/mobileAuthKeyringHealth.ts";

const asJson = process.argv.includes("--json");

const render = (report) => {
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Mobile auth keyring health (${report.observedAt})`);
  console.log(`  configuration: ${report.configuration.state}`);
  if (report.configuration.missing.length > 0) {
    console.log(`  missing: ${report.configuration.missing.join(", ")}`);
  }
  for (const ring of report.rings) {
    console.log(`\n  ${ring.variable} (grace ${ring.graceSeconds}s)`);
    for (const key of ring.keys) {
      const detail =
        key.state === "retired_in_grace"
          ? ` (${key.remainingSeconds}s left)`
          : key.state === "retirement_in_future"
            ? ` (${new Date(key.retiredAtMs).toISOString()})`
            : "";
      console.log(`    ${key.keyId}  ${key.state}${detail}`);
    }
    if (ring.retirementsNamingNothing > 0) {
      // The ids are not printed: a retirement line's left half is whatever
      // the variable held, and this report is pasted into tickets.
      console.log(
        `    (${ring.retirementsNamingNothing} retirement line(s) name an id that is not in the ring)`
      );
    }
  }
  console.log("");
  for (const line of report.attention) console.log(`  ATTENTION  ${line}`);
  if (report.attention.length === 0) {
    console.log("  Nothing wants attention.");
  }
  console.log(
    "\n  A report, not a gate: this exits 0 either way. What to do about a line\n" +
      "  above is docs/ops/mobile-auth-key-rotation.md."
  );
};

let report;
try {
  report = mobileAuthKeyringHealthReport();
} catch {
  // The one non-zero exit. A ring that will not parse means every line this
  // report could print is about something other than what is deployed.
  //
  // The error is not even bound, let alone printed. `parseRing` quotes the text it found in the
  // *id* position, and material pasted there is exactly what makes an id
  // unusable -- so the one line that would explain the failure is the one
  // that may hold a pepper. The operator has the variables; this says which
  // question to ask of them.
  console.error(
    "FAIL mobile auth keyring health: the rings do not parse.\n" +
      "  The parser's message is not shown: it quotes what it found in the key-id\n" +
      "  position, which is where pasted material ends up. Check that every entry\n" +
      '  is "keyId:secret" and every retirement is "keyId@<ISO 8601 instant>".\n' +
      "  Nothing below would describe what is running. Fix the configuration, or\n" +
      "  read docs/ops/mobile-auth-key-rotation.md."
  );
  process.exit(1);
}

render(report);
process.exit(0);
