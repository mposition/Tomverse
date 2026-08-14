// The one walk behind both the report and the check.
//
// Two scripts asking the same question of the same tree must not each keep
// their own idea of which files that is. A gate that scanned a slightly
// narrower set than the report would pass on a finding the report prints,
// which is the kind of disagreement nobody thinks to look for.
//
// The exception pathnames are read out of `lib/apiCacheControlPolicy.ts`
// rather than copied, for the same reason: the five routes this names have to
// be the five the proxy honours, or the `target` column describes a header the
// application does not send.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import {
  classifyFile,
  classifyRequestTarget,
  runtimeFor,
} from "./report-unconsumed-response-bodies-core.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

const SEARCH_ROOTS = ["app", "components", "hooks", "lib", "packages", "scripts"];
const SKIP_DIRECTORIES = new Set(["node_modules", ".next", "dist", "build"]);

const readExceptionPaths = () => {
  const source = readFileSync(
    join(root, "lib", "apiCacheControlPolicy.ts"),
    "utf8"
  );
  const paths = [...source.matchAll(/pathname:\s*"([^"]+)"/g)].map((m) => m[1]);
  if (paths.length === 0) {
    throw new Error(
      "lib/apiCacheControlPolicy.ts named no exception pathnames. Either the " +
        "list moved or this stopped reading it; either way every finding's " +
        "target would be wrong, so nothing is reported."
    );
  }
  return paths;
};

const collectFiles = () => {
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
      // A root that does not exist in this checkout is not an error; the
      // caller reports the count it actually read.
    }
  }
  return files.sort();
};

/** Every `fetch()` call site in the tree, classified. */
export function scanRepository() {
  const exceptionPaths = readExceptionPaths();
  const files = collectFiles();
  const findings = [];
  for (const file of files) {
    const repoPath = relative(root, file).split(sep).join("/");
    const source = readFileSync(file, "utf8");
    if (!source.includes("fetch(")) continue;
    try {
      findings.push(
        ...classifyFile(ts, repoPath, source).map((finding) => ({
          ...finding,
          target: classifyRequestTarget(finding.request, exceptionPaths),
        }))
      );
    } catch (error) {
      // Reported rather than skipped. A silent skip is how a scanner comes to
      // under-report and still look clean, and the check treats `unparsed` in
      // browser-capable code as a failure for exactly that reason.
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
  return { filesScanned: files.length, findings };
}
