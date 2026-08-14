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

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import {
  classifyFile,
  classifyRequestTarget,
  FINDING_KINDS,
  runtimeFor,
  summarise,
} from "./report-unconsumed-response-bodies-core.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const runtimeFilter = args
  .find((argument) => argument.startsWith("--runtime="))
  ?.slice("--runtime=".length);
const kindFilter = args
  .find((argument) => argument.startsWith("--kind="))
  ?.slice("--kind=".length);

// Read from the policy module rather than copied, so the five exceptions here
// are the same five the proxy honours. A copy would drift and the report would
// then describe a header the application does not send.
const EXCEPTION_PATHS = [
  ...readFileSync(
    join(root, "lib", "apiCacheControlPolicy.ts"),
    "utf8"
  ).matchAll(/pathname:\s*"([^"]+)"/g),
].map((match) => match[1]);
if (EXCEPTION_PATHS.length === 0) {
  console.error(
    "lib/apiCacheControlPolicy.ts named no exception pathnames. Either the " +
      "list moved or this stopped reading it; either way the target column " +
      "below would be wrong, so nothing is reported."
  );
  process.exit(1);
}

const SEARCH_ROOTS = ["app", "components", "hooks", "lib", "packages", "scripts"];
const SKIP_DIRECTORIES = new Set(["node_modules", ".next", "dist", "build"]);

const files = [];
const walk = (directory) => {
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
    } else if (/\.(ts|tsx|mts|mjs)$/.test(entry) && !/\.d\.ts$/.test(entry)) {
      files.push(full);
    }
  }
};
for (const searchRoot of SEARCH_ROOTS) {
  try {
    walk(join(root, searchRoot));
  } catch {
    // A root that does not exist in this checkout is not an error; the report
    // says what it read.
  }
}

const findings = [];
for (const file of files.sort()) {
  const repoPath = relative(root, file).split(sep).join("/");
  const source = readFileSync(file, "utf8");
  if (!source.includes("fetch(")) continue;
  try {
    findings.push(
      ...classifyFile(ts, repoPath, source).map((finding) => ({
        ...finding,
        target: classifyRequestTarget(finding.request, EXCEPTION_PATHS),
      }))
    );
  } catch (error) {
    // A file this cannot parse is reported as such rather than skipped: a
    // silent skip is how a scanner comes to under-report and still look clean.
    findings.push({
      file: repoPath,
      line: 0,
      kind: "unparsed",
      runtime: runtimeFor(repoPath, source),
      target: "unresolved",
      note: error?.message ?? String(error),
      request: "",
    });
  }
}

const selected = findings.filter(
  (finding) =>
    (!runtimeFilter || finding.runtime === runtimeFilter) &&
    (!kindFilter || finding.kind === kindFilter)
);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        filesScanned: files.length,
        findings: selected,
      },
      null,
      2
    )
  );
  process.exit(0);
}

const { total, byKind, byRuntime } = summarise(findings);
console.log(
  `Scanned ${files.length} source file(s); ${total} fetch call site(s).\n`
);
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
