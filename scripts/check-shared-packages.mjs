// PACKAGE-01: shared chat packages remain framework-neutral.
//
// The gate's metric is `forbidden_nextjs_imports_in_shared_packages = 0` and
// its evidence is "ESLint no-restricted-imports report", so this script does
// not re-implement the scan -- it runs ESLint's own API over `packages/*/src`
// and counts messages from that one rule. The number the gate is measured on
// and the number that fails `npm run lint` are therefore the same number, by
// construction, and a change to the rule cannot make them drift apart.
//
// Two further things are checked here because they are the same property
// arriving by other routes:
//
//  1. Every package type-checks under its OWN tsconfig -- no `dom`, no
//     `types`, no `@/*` alias, no Next.js plugin. ESLint catches a forbidden
//     import; this catches a forbidden *global* (`window`, `process`,
//     `Buffer`), which no import rule can see.
//  2. No package declares a runtime dependency. A dependency block is how a
//     framework gets back in without any source file naming it.
//
// Exits non-zero on any of the three. Prints the metric either way, because a
// gate that is only reported when it fails cannot be used as evidence.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";

const RULE = "no-restricted-imports";
const METRIC = "forbidden_nextjs_imports_in_shared_packages";

const root = fileURLToPath(new URL("..", import.meta.url));
const packagesDir = join(root, "packages");

const packageNames = readdirSync(packagesDir)
  .filter((entry) => statSync(join(packagesDir, entry)).isDirectory())
  .sort();

if (packageNames.length === 0) {
  console.error(
    "\nNo workspace packages found under packages/.\n" +
      "PACKAGE-01 measures a boundary; with nothing behind it the metric would\n" +
      "read 0 for the wrong reason.\n"
  );
  process.exit(1);
}

const problems = [];

// --- 1. The rule the gate is measured on ------------------------------------

const eslint = new ESLint({ cwd: root });
const results = await eslint.lintFiles(
  packageNames.map((name) => `packages/${name}/src/**/*.{ts,tsx,mts,js,jsx,mjs}`)
);

const violations = results.flatMap((result) =>
  result.messages
    .filter((message) => message.ruleId === RULE)
    .map((message) => ({
      file: result.filePath.slice(root.length),
      line: message.line,
      text: message.message,
    }))
);

// A rule that stopped applying reports zero violations exactly like a clean
// package does. Confirm ESLint actually resolved the rule for these files
// before believing the count.
const configuredFor = await Promise.all(
  packageNames.map(async (name) => {
    const config = await eslint.calculateConfigForFile(
      join(packagesDir, name, "src", "index.ts")
    );
    return { name, configured: Boolean(config?.rules?.[RULE]) };
  })
);
for (const { name, configured } of configuredFor) {
  if (!configured) {
    problems.push(
      `packages/${name}: eslint.config.mjs does not apply \`${RULE}\` to this package's ` +
        "source, so the PACKAGE-01 count below means nothing for it."
    );
  }
}

// --- 2. Each package type-checks standalone ---------------------------------

for (const name of packageNames) {
  const tsconfig = join("packages", name, "tsconfig.json");
  const compiled = spawnSync(
    process.execPath,
    [join(root, "node_modules", "typescript", "bin", "tsc"), "--project", tsconfig],
    { cwd: root, encoding: "utf8" }
  );
  if (compiled.status !== 0) {
    problems.push(
      `packages/${name}: does not type-check under its own tsconfig.\n` +
        `${(compiled.stdout || compiled.stderr || "").trim()}`
    );
  }
}

// --- 3. No runtime dependencies ---------------------------------------------

for (const name of packageNames) {
  const manifest = JSON.parse(
    readFileSync(join(packagesDir, name, "package.json"), "utf8")
  );
  for (const field of ["dependencies", "peerDependencies"]) {
    const declared = Object.keys(manifest[field] ?? {});
    if (declared.length > 0) {
      problems.push(
        `packages/${name}: declares ${field} (${declared.join(", ")}). A shared ` +
          "package with runtime dependencies is one import away from carrying a " +
          "framework into every client; add the capability as an injected port."
      );
    }
  }
  if (manifest.type !== "module") {
    problems.push(
      `packages/${name}: package.json must declare "type": "module". The mobile ` +
        "shell bundles ESM only."
    );
  }
}

// --- Report ------------------------------------------------------------------

console.log(`${METRIC} = ${violations.length}`);
console.log(
  `packages checked: ${packageNames.map((name) => `packages/${name}`).join(", ")}`
);

if (violations.length > 0) {
  console.error(
    `\n${violations.length} forbidden import(s) in shared packages:\n` +
      violations
        .map((v) => `  - ${v.file}:${v.line}\n      ${v.text}`)
        .join("\n") +
      "\n"
  );
}

if (problems.length > 0) {
  console.error(
    `\n${problems.length} shared-package boundary problem(s):\n` +
      problems.map((message) => `  - ${message}`).join("\n") +
      "\n"
  );
}

if (violations.length > 0 || problems.length > 0) {
  console.error(
    "PACKAGE-01 requires these packages to run unchanged on the Next.js\n" +
      "server, in a plain browser bundle and inside the Capacitor shell.\n" +
      "See docs/policy/shared-packages.md.\n"
  );
  process.exit(1);
}

console.log("Shared packages are framework-neutral.");
