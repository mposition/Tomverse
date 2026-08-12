// PACKAGE-01: shared chat packages remain framework-neutral.
//
// The gate's metric is `forbidden_nextjs_imports_in_shared_packages = 0` and
// its evidence is "ESLint no-restricted-imports report", so this script does
// not re-implement the scan -- it runs ESLint's own API over `packages/*/src`
// and counts messages from that one rule. The number the gate is measured on
// and the number that fails `npm run lint` are therefore the same number, by
// construction, and a change to the rule cannot make them drift apart.
//
// Further things are checked here because they are the same property arriving
// by other routes:
//
//  1. Every package with TypeScript sources type-checks under its OWN
//     tsconfig -- no `dom`, no `types`, no `@/*` alias, no Next.js plugin.
//     ESLint catches a forbidden import; this catches a forbidden *global*
//     (`window`, `process`, `Buffer`), which no import rule can see.
//  2. No package declares a runtime dependency. A dependency block is how a
//     framework gets back in without any source file naming it.
//  3. CSS assets are held to the same boundary, by rules that fit CSS. A
//     package can ship no TypeScript at all -- `ui-tokens` does -- and the
//     ESLint rule and the tsconfig then say nothing about it, so without this
//     the metric would read a confident 0 over a package nothing had looked
//     at. A stylesheet is framework-neutral when it uses no Tailwind at-rule,
//     imports nothing outside itself, and reads no custom property it does
//     not define; the last one is what catches an app-injected value such as
//     a `next/font` variable.
//  4. Every exported asset is actually consumed by the app, and the app does
//     not redefine what it consumes. An extracted token that no stylesheet
//     imports is not shared -- it is dead -- and a second definition in the
//     app would decide the page by import order while every check here still
//     passed.
//
// Exits non-zero on any of them. Prints the metric either way, because a gate
// that is only reported when it fails cannot be used as evidence.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

/** Every file under a directory, recursively. */
const filesUnder = (dir) => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) =>
    entry.isDirectory()
      ? filesUnder(join(dir, entry.name))
      : [join(dir, entry.name)]
  );
};

const SCRIPT_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"];

const packages = packageNames.map((name) => {
  const sourceDir = join(packagesDir, name, "src");
  const files = filesUnder(sourceDir);
  return {
    name,
    sourceDir,
    scripts: files.filter((file) =>
      SCRIPT_EXTENSIONS.some((extension) => file.endsWith(extension))
    ),
    styles: files.filter((file) => file.endsWith(".css")),
  };
});

for (const entry of packages) {
  if (entry.scripts.length === 0 && entry.styles.length === 0) {
    problems.push(
      `packages/${entry.name}: src/ holds nothing this check knows how to ` +
        "read. A package whose contents no rule covers reports clean for the " +
        "wrong reason."
    );
  }
}

// --- 1. The rule the gate is measured on ------------------------------------

const eslint = new ESLint({ cwd: root });
const scriptPackages = packages.filter((entry) => entry.scripts.length > 0);
const results =
  scriptPackages.length > 0
    ? await eslint.lintFiles(scriptPackages.flatMap((entry) => entry.scripts))
    : [];

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
  scriptPackages.map(async (entry) => {
    const config = await eslint.calculateConfigForFile(entry.scripts[0]);
    return { name: entry.name, configured: Boolean(config?.rules?.[RULE]) };
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

// --- 2. Each package with TypeScript type-checks standalone -----------------

for (const entry of scriptPackages) {
  const tsconfig = join("packages", entry.name, "tsconfig.json");
  if (!existsSync(join(root, tsconfig))) {
    problems.push(
      `packages/${entry.name}: has TypeScript sources but no tsconfig.json of ` +
        "its own, so nothing proves it compiles without the app's DOM lib, " +
        "types and path aliases."
    );
    continue;
  }
  const compiled = spawnSync(
    process.execPath,
    [join(root, "node_modules", "typescript", "bin", "tsc"), "--project", tsconfig],
    { cwd: root, encoding: "utf8" }
  );
  if (compiled.status !== 0) {
    problems.push(
      `packages/${entry.name}: does not type-check under its own tsconfig.\n` +
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

// --- 4. CSS assets are held to the same boundary ----------------------------

/**
 * Tailwind at-rules. Each one only means anything inside a Tailwind build, so
 * a stylesheet using one is not a shared asset -- it is a fragment of this
 * app's build that happens to live in packages/.
 */
const TAILWIND_AT_RULES = [
  "@theme",
  "@apply",
  "@utility",
  "@variant",
  "@custom-variant",
  "@source",
  "@plugin",
  "@config",
  "@reference",
  "@tailwind",
];

/** `/* ... *\/` removed, so a rule quoted in prose is not a finding. */
const withoutComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

for (const entry of packages) {
  for (const file of entry.styles) {
    const relative = file.slice(root.length);
    const css = withoutComments(readFileSync(file, "utf8"));

    for (const atRule of TAILWIND_AT_RULES) {
      if (new RegExp(`${atRule}\\b`).test(css)) {
        problems.push(
          `${relative}: uses \`${atRule}\`, which only resolves inside a Tailwind ` +
            "build. Shared CSS has to load unchanged in a plain browser bundle."
        );
      }
    }

    for (const match of css.matchAll(/@import\s+(?:url\()?["']([^"']+)["']/g)) {
      if (!match[1].startsWith(".")) {
        problems.push(
          `${relative}: imports "${match[1]}". A shared stylesheet resolves ` +
            "nothing outside its own package -- the importing app owns what " +
            "else is on the page."
        );
      }
    }

    // Every custom property it reads, it must also define. This is the CSS
    // equivalent of the forbidden-global check the tsconfig does: a
    // `var(--font-geist-sans)` here would compile fine and then render as
    // nothing outside the Next.js app that injects it.
    const defined = new Set(
      [...css.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1])
    );
    const referenced = new Set(
      // A `var(--x, fallback)` states its own answer when --x is absent, so
      // only the fallback-less form is a dependency on someone else.
      [...css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((match) => match[1])
    );
    for (const token of referenced) {
      if (!defined.has(token)) {
        problems.push(
          `${relative}: reads ${token} without defining it and without a ` +
            "fallback, so its value comes from whatever app is around it."
        );
      }
    }
  }
}

// --- 5. Exported assets are consumed, and not restated ----------------------

const appStyles = filesUnder(join(root, "app")).filter((file) =>
  file.endsWith(".css")
);

for (const entry of packages) {
  const manifest = JSON.parse(
    readFileSync(join(packagesDir, entry.name, "package.json"), "utf8")
  );
  const cssExports = Object.entries(manifest.exports ?? {}).filter(
    ([, target]) => typeof target === "string" && target.endsWith(".css")
  );

  for (const [subpath, target] of cssExports) {
    const specifier = `${manifest.name}${subpath.replace(/^\./, "")}`;
    const importers = appStyles.filter((file) =>
      readFileSync(file, "utf8").includes(specifier)
    );
    if (importers.length === 0) {
      problems.push(
        `packages/${entry.name}: nothing under app/ imports "${specifier}". ` +
          "An extracted asset no client loads is not shared, it is dead, and " +
          "every other check here would still pass."
      );
      continue;
    }

    // The app must not also define what it imports. A second definition wins
    // or loses by import order, which is a difference no check above can see.
    // Resolved from the export's target, not its subpath: the two differ
    // (`./tokens.css` is served by `./src/tokens.css`) and reading the subpath
    // as a path is how this check silently measured nothing.
    const targetPath = join(
      packagesDir,
      entry.name,
      target.replace(/^\.\//, "")
    );
    const owned = new Set(
      [
        ...withoutComments(readFileSync(targetPath, "utf8")).matchAll(
          /(--[\w-]+)\s*:/g
        ),
      ].map((match) => match[1])
    );
    for (const file of importers) {
      const css = withoutComments(readFileSync(file, "utf8"));
      // Collected the same way the package's own set is, rather than by
      // matching each name at the start of a line: `:root { --background: … }`
      // written on one line is the same redefinition and was invisible to the
      // line-anchored form. `var(--x)` is not matched -- a use has no colon
      // after the name -- so only definitions are compared.
      const redefined = new Set(
        [...css.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1])
      );
      for (const token of owned) {
        if (redefined.has(token)) {
          problems.push(
            `${file.slice(root.length)}: redefines ${token}, which belongs to ` +
              `${specifier}. Two definitions are decided by import order.`
          );
        }
      }
    }
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
