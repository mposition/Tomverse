// Fails when browser-capable code leaves an `/api/*` response body unread.
//
//   npm run check:unconsumed-response-bodies
//
// The scope, and the reasons for each edge of it, are in
// check-unconsumed-response-bodies-core.mjs. In short: browser-capable code
// (`browser` and `either`), the one request target the Chromium measurement
// covers, plus any file this cannot parse — because a gate that reads no
// findings as clean is not fail-closed.
//
// `npm run report:unconsumed-response-bodies` is the wider view: it prints
// every call site the question can be asked of, including the server-side ones
// this deliberately does not block on.

import {
  BLOCKING_TARGET,
  BROWSER_CAPABLE_RUNTIMES,
  selectBlocking,
  waiverProblems,
} from "./check-unconsumed-response-bodies-core.mjs";
import { scanRepository } from "./scan-unconsumed-response-bodies.mjs";

const malformed = waiverProblems();
if (malformed.length > 0) {
  console.error(
    `\n${malformed.length} malformed waiver(s) in ` +
      "scripts/check-unconsumed-response-bodies-core.mjs:\n" +
      malformed.map((problem) => `  - ${problem}`).join("\n") +
      "\n\nA waiver without a reason and an approver is an exemption nobody " +
      "agreed to.\n"
  );
  process.exit(1);
}

const { filesScanned, findings } = scanRepository();
const { blocking, waived, staleWaivers } = selectBlocking(findings);

console.log(
  `Unconsumed response body check over ${filesScanned} source file(s): ` +
    `${findings.length} fetch call site(s).`
);
console.log(
  `Blocking scope: runtime in [${BROWSER_CAPABLE_RUNTIMES.join(", ")}], ` +
    `target ${BLOCKING_TARGET}, plus any unparsed file in that scope.`
);

if (waived.length > 0) {
  console.log(`\n${waived.length} finding(s) excused by a waiver:`);
  for (const { finding, waiver } of waived) {
    console.log(
      `  ${finding.file}:${finding.line}  ${finding.request}\n` +
        `    ${waiver.reason} (${waiver.approvedBy}, ${waiver.approvedAt})`
    );
  }
}

if (staleWaivers.length > 0) {
  console.error(
    `\n${staleWaivers.length} waiver(s) matched nothing:\n` +
      staleWaivers
        .map((waiver) => `  - ${waiver.file}  ${waiver.request}`)
        .join("\n") +
      "\n\nThe code they excused is gone or has changed shape. Remove them: a " +
      "gate whose exception list has drifted off its targets is checking less " +
      "than it says it checks.\n"
  );
  process.exit(1);
}

if (blocking.length > 0) {
  console.error(
    `\n${blocking.length} response body that browser code never reads:\n` +
      blocking
        .map(
          (finding) =>
            `  - ${finding.file}:${finding.line}  ${finding.request}\n` +
            `      ${finding.note}`
        )
        .join("\n") +
      "\n\n`/api/*` answers `private, no-store`, and a response whose body is " +
      "never consumed\ndid not reach `requestfinished` under that directive on " +
      "Chromium at Next 16.3.0.\nConsume or cancel the body on every path: " +
      "`lib/discardResponseBody.ts` is the helper,\nand " +
      "lib/apiCacheControlPolicy.ts records what was measured and what it does " +
      "not\nestablish.\n"
  );
  process.exit(1);
}

console.log(
  "\nNo browser-capable call site leaves an `/api/*` body unread." +
    (waived.length > 0 ? ` ${waived.length} waived.` : "") +
    "\n"
);
