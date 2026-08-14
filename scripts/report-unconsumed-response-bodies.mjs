// Where in this repository a `fetch()` response body may never be consumed.
//
//   npm run report:unconsumed-response-bodies
//   npm run report:unconsumed-response-bodies -- --json
//   npm run report:unconsumed-response-bodies -- --runtime=browser --kind=leaks
//
// Report-only, and exits 0 whatever it finds. `leaks` says a path through the
// syntax reaches the end of the response's scope without reading the body;
// whether that path can be taken, and whether it matters, is for a person. See
// report-unconsumed-response-bodies-core.mjs for what the walk does and does
// not cover.
//
// The merge gate is its narrower sibling, `npm run
// check:unconsumed-response-bodies` — same scan, and only the combination the
// Chromium measurement actually covers.

import {
  FINDING_KINDS,
  summarise,
} from "./report-unconsumed-response-bodies-core.mjs";
import { scanRepository } from "./scan-unconsumed-response-bodies.mjs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const runtimeFilter = args
  .find((argument) => argument.startsWith("--runtime="))
  ?.slice("--runtime=".length);
const kindFilter = args
  .find((argument) => argument.startsWith("--kind="))
  ?.slice("--kind=".length);

const { filesScanned, findings } = scanRepository();

const selected = findings.filter(
  (finding) =>
    (!runtimeFilter || finding.runtime === runtimeFilter) &&
    (!kindFilter || finding.kind === kindFilter)
);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        filesScanned,
        findings: selected,
      },
      null,
      2
    )
  );
  process.exit(0);
}

const { total, byKind, byRuntime } = summarise(findings);
console.log(`Scanned ${filesScanned} source file(s); ${total} fetch call site(s).\n`);
console.log("By classification:");
for (const kind of [...FINDING_KINDS, "unparsed"]) {
  const count = byKind.get(kind) ?? 0;
  if (count > 0) console.log(`  ${kind.padEnd(12)} ${count}`);
}
console.log(
  "\nBy runtime (`server-only` and `use client` are read from the source;\n" +
    "otherwise the directory decides, and lib/ with neither is `either`):"
);
for (const [runtime, bucket] of [...byRuntime].sort()) {
  const parts = [...bucket]
    .sort()
    .map(([kind, count]) => `${kind}=${count}`)
    .join(" ");
  console.log(`  ${runtime.padEnd(8)} ${parts}`);
}

const listed = selected.filter(
  (finding) => finding.kind === "leaks" || finding.kind === "escapes"
);
console.log(
  `\n${listed.length} site(s) to review` +
    `${runtimeFilter || kindFilter ? " (filtered)" : ""}:`
);
for (const finding of listed) {
  console.log(
    `  ${finding.kind.padEnd(8)} ${(finding.target ?? "").padEnd(20)} ` +
      `${finding.file}:${finding.line}  ${finding.request}` +
      (finding.note ? `  [${finding.note}]` : "")
  );
}
console.log(
  "\n`leaks` means a path through the syntax reaches the end of the scope\n" +
    "without reading the body. Whether that path can be taken is a question for\n" +
    "a person; so is whether it matters. `escapes` means the response left this\n" +
    "scope and its consumer is elsewhere. See lib/apiCacheControlPolicy.ts for\n" +
    "what was measured, on which browser, and what it does not establish.\n"
);
