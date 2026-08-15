// Fails the build at `prebuild` when the native SWC binding this platform
// needs was silently dropped by the install.
//
// See scripts/check-native-swc-core.mjs for what happened and why the check
// exists. This file only gathers the facts the core reasons over: the
// platform, the libc, what `next` publishes, and what is actually on disk.
//
// It lives in `prebuild` rather than in each workflow so that every build --
// six CI workflows and every developer machine -- is covered by one line, and
// so the check runs in the same place the misleading error would have come
// from.
//
// Usage:
//   node scripts/check-native-swc.mjs

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkNativeSwc,
  detectLibc,
  VERDICTS,
} from "./check-native-swc-core.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

const nextManifest = readJson(join(root, "node_modules/next/package.json"));
if (!nextManifest) {
  // No `next` at all is a different problem, and one the very next command
  // reports clearly. Staying quiet keeps this check to its one subject.
  process.exit(0);
}

const publishedPackages = Object.keys(
  nextManifest.optionalDependencies ?? {}
).filter((name) => name.startsWith("@next/swc-"));

/**
 * Installed means the binary is on disk, not that the directory exists. npm
 * can leave a partially unpacked optional dependency behind, and a manifest
 * without its `.node` file loads no faster than no package at all.
 */
const isInstalled = (name) => {
  let manifestPath;
  try {
    manifestPath = require.resolve(`${name}/package.json`, { paths: [root] });
  } catch {
    return false;
  }
  const manifest = readJson(manifestPath);
  if (!manifest?.main) return false;
  return existsSync(join(manifestPath, "..", manifest.main));
};

const result = checkNativeSwc({
  platform: process.platform,
  arch: process.arch,
  libc: detectLibc(process.report.getReport()),
  publishedPackages,
  isInstalled,
});

if (result.failing) {
  console.error(`[check-native-swc] ${result.message}`);
  process.exit(1);
}

// Anything other than a plain pass is worth a line: a platform with no
// published binding is a real constraint on how it can build, and silence
// would leave that to be discovered by the build failing.
if (result.verdict !== VERDICTS.ok) {
  console.warn(`[check-native-swc] ${result.message}`);
}
