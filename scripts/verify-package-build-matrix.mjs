// PACKAGE-01's second piece of evidence: the Vite half of the build matrix.
//
//   npm run verify:package-build-matrix
//
// `next build` already proves the shared packages compile inside this app --
// that is the Next.js half, and it runs on every PR. What it cannot prove is
// the part PACKAGE-01 is actually about: that the same source builds when
// Next.js is not the thing building it. A package can import `next/*`, use a
// Node builtin, or read a variable the app injects, and `next build` will
// happily resolve all three.
//
// So this bundles the packages with Vite -- no Next.js plugin, no Next config,
// no app -- into a browser target, then *runs* the result and checks the
// values are right. Building is not enough on its own: a bundler will
// cheerfully emit a module whose behaviour depends on something that was never
// there.
//
// What this does NOT do is claim the gate is met. PACKAGE-01 is approved by a
// person against recorded evidence; this produces one piece of it.
//
// Deliberately not a Vite *app*: `apps/mobile` is a Phase 3 deliverable with
// its own scope, and the delivery plan §4 names the build matrix as one of the
// three enforcement mechanisms for the packages themselves, alongside ESLint
// and `transpilePackages`. Waiting for an app would leave the packages
// unenforced in the meantime.

import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

import { build } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const packagesDir = join(root, "packages");

const packageNames = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const failures = [];
// Inside the repository, not in the OS temp directory: the entry has to
// resolve `@tomverse/*` the same way the app does, by walking up to the
// workspace symlinks in ./node_modules. From /tmp there is nothing to walk up
// to, and the matrix would fail for a reason that has nothing to do with the
// packages. Removed at the end, and .gitignore'd in case a run is interrupted.
const scratch = mkdtempSync(join(root, ".package-build-matrix-"));

/**
 * The entry Vite bundles. It imports every package by the specifier the app
 * uses -- the workspace symlink is what resolves it, exactly as in the app --
 * and re-exports enough to be executed afterwards.
 *
 * Written here rather than committed as a fixture so it cannot drift from the
 * package list: a new package under packages/ joins the matrix by existing.
 */
/** A package's `exports` map, flattened to (subpath, target) pairs. */
const declaredExports = (name) => {
  let manifest;
  try {
    manifest = JSON.parse(
      readFileSync(join(packagesDir, name, "package.json"), "utf8")
    );
  } catch (error) {
    failures.push(
      `packages/${name} has no readable package.json, so nothing here knows ` +
        `what to bundle from it: ${error?.message ?? String(error)}`
    );
    return [];
  }
  const field = manifest.exports;
  if (!field || typeof field !== "object" || Array.isArray(field)) return [];
  return Object.entries(field).map(([subpath, target]) => ({
    subpath,
    target:
      typeof target === "string"
        ? target
        : (target?.import ?? target?.default ?? null),
  }));
};

/** `chat-core` -> `chatCore`, so the generated entry can name it. */
const identifierFor = (value) =>
  value
    .replace(/[^A-Za-z0-9]+([A-Za-z0-9])/g, (_, character) => character.toUpperCase())
    .replace(/[^A-Za-z0-9_$]/g, "");

const buildEntry = () => {
  const lines = [];
  for (const name of packageNames) {
    const entries = declaredExports(name);
    if (entries.length === 0) {
      // The blind spot this replaced: the entry named two packages, so a third
      // was discovered by readdir, counted in the summary, and never imported
      // -- bundled by nothing, verified by nothing, and reported as covered.
      // A package that cannot be wired now fails instead of passing quietly.
      failures.push(
        `packages/${name} declares no exports, so the matrix has no specifier ` +
          `to import and cannot say anything about whether it builds outside Next.js.`
      );
      continue;
    }
    for (const { subpath, target } of entries) {
      const specifier =
        subpath === "." ? `@tomverse/${name}` : `@tomverse/${name}${subpath.slice(1)}`;
      if (!target) {
        failures.push(
          `packages/${name} exports ${subpath} with no import or default target.`
        );
        continue;
      }
      if (target.endsWith(".css")) {
        lines.push(`import "${specifier}";`);
        continue;
      }
      // `export *`, not a named import list.
      //
      // Entry exports are bundle roots, so this pins every export of the
      // package into the build. A named list looked equivalent and was not: an
      // export the list did not mention was tree-shaken away, and an import
      // that has been shaken away is never resolved -- so a `node:crypto` or a
      // `next/server` added to the package built perfectly green. The matrix
      // was reporting on the two functions it happened to name.
      //
      // Two packages exporting the same name would make the star exports
      // ambiguous and fail the build. That is the right outcome rather than a
      // reason to weaken this: shared packages the app imports side by side
      // cannot both own a public name.
      const identifier =
        identifierFor(name) +
        (subpath === "." ? "" : identifierFor(subpath.replace(/^\.\//, "-")));
      lines.push(
        `export * from "${specifier}";`,
        `import * as ${identifier}Namespace from "${specifier}";`,
        `export const ${identifier} = ${identifier}Namespace;`
      );
    }
  }
  lines.push("export const packages = " + JSON.stringify(packageNames) + ";");
  return lines.join("\n") + "\n";
};

const entryPath = join(scratch, "entry.js");
writeFileSync(entryPath, buildEntry(), "utf8");

// Vite does not fail a browser build on a Node builtin -- it externalizes it
// and warns. The build then "succeeds" while shipping an import the browser
// cannot resolve, which is exactly the defect this matrix exists to catch, so
// the warnings are collected and judged rather than printed and forgotten.
const warnings = [];
const collectingLogger = {
  info() {},
  warn(message) {
    warnings.push(message);
  },
  warnOnce(message) {
    warnings.push(message);
  },
  error(message) {
    warnings.push(message);
  },
  clearScreen() {},
  hasErrorLogged: () => false,
  hasWarned: false,
};

let output;
try {
  const result = await build({
    root: scratch,
    customLogger: collectingLogger,
    // No plugins at all. A plugin is how a framework gets to rewrite an
    // import, and the whole question here is whether the source needs one.
    plugins: [],
    logLevel: "warn",
    resolve: {
      // Resolve from the repository, where the workspace symlinks live.
      preserveSymlinks: false,
    },
    build: {
      outDir: join(scratch, "dist"),
      emptyOutDir: true,
      // Browser target: a Node builtin that slipped in has nowhere to resolve
      // to and the build fails, which is the answer we want.
      target: "es2022",
      minify: false,
      lib: {
        entry: entryPath,
        formats: ["es"],
        fileName: "bundle",
      },
      rollupOptions: {
        // Nothing is external. An unresolved import is a build failure rather
        // than a runtime surprise in whichever client loads it.
        external: [],
      },
    },
  });
  output = Array.isArray(result) ? result[0] : result;
} catch (error) {
  failures.push(
    `Vite could not build the packages without Next.js:\n${
      error?.message ?? String(error)
    }`
  );
}

// A build that had to externalize something, or could not resolve something,
// did not build these packages for a browser -- whatever it wrote out.
for (const message of warnings) {
  if (/externalized for browser compatibility/i.test(message)) {
    failures.push(
      `Vite externalized a module to keep the build alive: ${message
        .replace(/\s+/g, " ")
        .trim()}`
    );
  } else if (/failed to resolve|could not resolve|unresolved/i.test(message)) {
    failures.push(
      `Vite could not resolve an import: ${message.replace(/\s+/g, " ").trim()}`
    );
  }
}

if (output) {
  const bundlePath = join(scratch, "dist", "bundle.mjs");
  let bundleSource = "";
  try {
    bundleSource = readFileSync(bundlePath, "utf8");
  } catch {
    failures.push(
      `Vite reported success but emitted no ${bundlePath}. The matrix proves ` +
        "nothing without an artefact to inspect."
    );
  }

  if (bundleSource) {
    // Nothing framework- or Node-shaped may survive into the bundle. Rollup
    // would have failed on an unresolvable import, but an import that
    // *resolves* to a stub is the case this catches.
    for (const marker of [
      "next/",
      "node:",
      "require(",
      "server-only",
      "@capacitor/",
    ]) {
      if (bundleSource.includes(marker)) {
        failures.push(
          `The Vite bundle contains "${marker}". The packages pulled something ` +
            "into a browser build that only exists in the Next.js app."
        );
      }
    }

    // Built is not the same as working. Import the artefact and check the
    // behaviour, so a bundle that resolved everything and then did the wrong
    // thing still fails here.
    try {
      const bundle = await import(pathToFileURL(bundlePath).href);
      if (packageNames.includes("chat-core")) {
        const outcome = bundle.chatCore.resolveChatCompletionOutcome({
          finishReason: "length",
        });
        if (
          outcome?.status !== "incomplete" ||
          outcome?.incompleteReason !== "length"
        ) {
          failures.push(
            "chat-core built but behaved differently outside Next.js: " +
              `resolveChatCompletionOutcome returned ${JSON.stringify(outcome)}`
          );
        }
        if (bundle.chatCore.isChatCompletionStatus("nonsense") !== false) {
          failures.push("chat-core's status guard did not narrow in the bundle");
        }
      }
    } catch (error) {
      failures.push(
        `The Vite bundle does not run outside Next.js:\n${
          error?.message ?? String(error)
        }`
      );
    }
  }

  if (packageNames.includes("ui-tokens")) {
    const cssFiles = readdirSync(join(scratch, "dist")).filter((file) =>
      file.endsWith(".css")
    );
    if (cssFiles.length === 0) {
      failures.push(
        "ui-tokens emitted no CSS from the Vite build, so the tokens the " +
          "mobile client would load were never produced."
      );
    } else {
      const css = cssFiles
        .map((file) => readFileSync(join(scratch, "dist", file), "utf8"))
        .join("\n");
      // The values, not merely the file: a stylesheet that built to nothing
      // would satisfy a file-exists check.
      for (const expected of ["--background", "--tomverse-accent-start"]) {
        if (!css.includes(expected)) {
          failures.push(`the Vite CSS output is missing ${expected}`);
        }
      }
      if (!/prefers-color-scheme\s*:\s*dark/.test(css)) {
        failures.push(
          "the Vite CSS output has no prefers-color-scheme block, so a client " +
            "outside Next.js would have no system-dark palette"
        );
      }
    }
  }
}

rmSync(scratch, { recursive: true, force: true });

console.log(
  `Vite build matrix over ${packageNames.length} package(s): ` +
    packageNames.map((name) => `packages/${name}`).join(", ")
);

if (failures.length > 0) {
  console.error(
    `\n${failures.length} build-matrix failure(s):\n` +
      failures.map((message) => `  - ${message}`).join("\n") +
      "\n\nPACKAGE-01 requires these packages to build and run where Next.js " +
      "is not doing the building.\nSee docs/policy/shared-packages.md.\n"
  );
  process.exit(1);
}

// Names what actually ran. A fixed sentence would claim the CSS half even on
// a checkout where no package ships any, which is the kind of report that gets
// quoted as gate evidence.
//
// Every package reaches the bundle through its own `exports` map, so the count
// above is a coverage claim rather than a directory listing. These two lines
// are the extra, package-specific assertions on top of that -- behaviour for
// chat-core, token values for ui-tokens -- and they stay named because they
// assert things only those packages have.
const covered = [
  packageNames.includes("chat-core") ? "executed the bundle" : null,
  packageNames.includes("ui-tokens") ? "checked the emitted CSS" : null,
].filter(Boolean);
console.log(
  `The packages build with Vite outside Next.js${
    covered.length > 0 ? `, and this run ${covered.join(" and ")}` : ""
  }.`
);
