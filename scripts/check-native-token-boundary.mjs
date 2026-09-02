// Fails when the mobile app's JavaScript could hold a refresh token.
//
//   npm run check:native-token-boundary
//
// The rule comes from the approved mobile auth design (D19,
// .github/audits/2026-08-31-native-mobile-auth-n2-design-approval.md):
//
//   `exchange`, `refresh` and `logout` are called by the Capacitor native
//   layer. The refresh token in those responses goes straight into the
//   platform secure store and is never returned to the WebView. What JS
//   receives across the bridge is `{ accessToken, expiresAt }` and nothing
//   more.
//
// The requirement is an **absence**, and an absence is what review is worst at
// seeing. Nobody adds "return the refresh token to JS" on purpose; what happens
// is that somebody needs a signed-in browser for local work, writes a web
// fallback that calls `/api/auth/mobile/refresh` directly, and the policy
// sentence becomes false in the build a developer looks at most.
//
// So the scan is for the three endpoint paths and for the field name itself, in
// everything `apps/mobile` ships. Textual rather than a type check, for the
// same reason `check:capacitor-local-bundle` is textual: a path assembled from
// a variable would evaluate to nothing here and pass, and "the URL comes from a
// constant" is exactly the shape this is meant to catch.
//
// What this does *not* establish: that a real device keeps the refresh token
// out of the WebView. That is `AUTH-03`'s evidence, it is a physical check
// (approved decision 16), and no script in this repository can stand in for it.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const APP_ROOT = join(root, "apps", "mobile");

/** Directories that hold no source of ours. */
const SKIPPED = new Set(["node_modules", "dist", "ios", "android", ".vite"]);

const SCANNED_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".html"];

/**
 * The three endpoints whose responses carry a refresh token.
 *
 * `devices` and `login-grant` are deliberately absent: the first returns no
 * credential at all, and the second is a browser call made by the signed-in web
 * app, not by this bundle.
 */
const FORBIDDEN_ENDPOINTS = [
  "/api/auth/mobile/exchange",
  "/api/auth/mobile/refresh",
  "/api/auth/mobile/logout",
];

/**
 * Names that would mean a refresh token had reached this side.
 *
 * `refreshToken` is the field the three endpoints return. The others are the
 * shapes a well-meaning workaround takes: storing it under another name, or
 * reaching for browser storage to keep it between loads.
 */
const FORBIDDEN_IDENTIFIERS = [
  "refreshToken",
  "refresh_token",
  "secretDigest",
];

/** Comments explain why these names are absent; that is not a use of them. */
const stripComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const walk = (directory) => {
  const found = [];
  for (const entry of readdirSync(directory)) {
    if (SKIPPED.has(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...walk(path));
    } else if (SCANNED_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
      found.push(path);
    }
  }
  return found;
};

const findings = [];
const files = walk(APP_ROOT);

for (const path of files) {
  const relativePath = relative(root, path);
  const source = stripComments(readFileSync(path, "utf8"));

  for (const endpoint of FORBIDDEN_ENDPOINTS) {
    if (source.includes(endpoint)) {
      findings.push(
        `${relativePath} names ${endpoint}. Its response carries a refresh ` +
          "token, so it is the native layer's to call -- not this bundle's (D19)."
      );
    }
  }
  for (const identifier of FORBIDDEN_IDENTIFIERS) {
    if (new RegExp(`\\b${identifier}\\b`).test(source)) {
      findings.push(
        `${relativePath} names ${identifier}. The bridge hands JavaScript an ` +
          "access token and an expiry; a refresh token has no route into this context."
      );
    }
  }
}

// A scan that matched nothing because it looked at nothing would pass silently,
// which is the failure mode of every check like this one.
if (files.length === 0) {
  console.error(
    "FAIL apps/mobile: no source files were scanned, so this check proved nothing."
  );
  process.exit(1);
}

if (findings.length > 0) {
  console.error(
    `FAIL native token boundary (${findings.length} finding${findings.length === 1 ? "" : "s"})`
  );
  for (const finding of findings) console.error(`  - ${finding}`);
  process.exit(1);
}

console.log(
  `OK native token boundary: ${files.length} file(s) in apps/mobile, none able to hold a refresh token.\n` +
    "   Device evidence for AUTH-03 is a separate, physical check."
);
