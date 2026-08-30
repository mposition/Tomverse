// Fails when a Capacitor configuration would load the app from somewhere other
// than its own bundle.
//
//   npm run check:capacitor-local-bundle
//
// Two documents state the rule, and neither leaves room for a staging
// exception in a committed config:
//
//   docs/policy/tomverse-chat-delivery-plan.md §2 -- "Locally bundled
//   Capacitor apps for iOS and Android; production must not depend on a remote
//   `server.url`."
//
//   docs/policy/tomverse-chat-mobile-authentication.md, "Deliberately
//   excluded" -- "No remote `server.url`. The app ships a local bundle; a
//   production app pointing at a hosted URL is both a store-review risk and an
//   origin the token policy above cannot reason about."
//
// Capacitor's own configuration reference agrees, marking `server.url`,
// `server.cleartext` and `server.allowNavigation` "not intended for use in
// production" -- they exist for live-reload servers. All three are checked,
// not just `url`: `allowNavigation` widens what the WebView itself may load,
// and `cleartext` re-enables the plaintext HTTP that Android has disabled by
// default since API 28. A config carrying either would ship an app that can
// leave its bundle even with no `url` set.
//
// The scan is textual rather than an import of the config, because a
// TypeScript config that reads an environment variable would evaluate to
// nothing here and pass -- and "server.url comes from an env var" is exactly
// the shape this is meant to catch. A key that appears at all is a finding.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const CONFIG_BASENAMES = new Set([
  "capacitor.config.ts",
  "capacitor.config.js",
  "capacitor.config.json",
]);

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  "build",
  "out",
  "ios",
  "android",
]);

// Matched against the file with comments stripped, so the explanation of why a
// key is absent does not read as the key being present.
const FORBIDDEN_KEYS = [
  {
    key: "url",
    pattern: /\burl\s*:/,
    why: "loads the app from a remote origin instead of its own bundle",
  },
  {
    key: "cleartext",
    pattern: /\bcleartext\s*:/,
    why: "re-enables plaintext HTTP, which Android disables by default from API 28",
  },
  {
    key: "allowNavigation",
    pattern: /\ballowNavigation\s*:/,
    why: "lets the WebView navigate outside the bundle",
  },
];

const stripComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/**
 * The body of the `server` object, or null when the config declares none.
 * Brace-matched rather than regex-matched so a nested object inside `server`
 * does not end the block early, and so a `url:` belonging to some other key
 * (a plugin's endpoint, say) is not reported as a server URL.
 */
const serverBlock = (text) => {
  const match = /(^|[\s,{])server\s*:\s*\{/m.exec(text);
  if (!match) return null;

  const start = match.index + match[0].length;
  let depth = 1;
  for (let i = start; i < text.length; i += 1) {
    const character = text[i];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i);
    }
  }
  // An unbalanced config is not a pass: it is a file this check cannot read.
  return text.slice(start);
};

const walk = (directory, found = []) => {
  let entries;
  try {
    entries = readdirSync(join(root, directory));
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = directory ? join(directory, entry) : entry;
    if (statSync(join(root, full)).isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry) || entry.startsWith(".")) continue;
      walk(full, found);
    } else if (CONFIG_BASENAMES.has(entry)) {
      found.push(full);
    }
  }
  return found;
};

const configs = walk("").map((path) => relative(".", path));
const findings = [];

for (const path of configs) {
  const text = stripComments(readFileSync(join(root, path), "utf8"));
  const block = serverBlock(text);
  if (block === null) continue;
  for (const { key, pattern, why } of FORBIDDEN_KEYS) {
    if (pattern.test(block)) {
      findings.push({ path, key, why });
    }
  }
}

console.log(
  `capacitor_configs_scanned = ${configs.length}`,
  configs.length ? `(${configs.join(", ")})` : "(none)"
);
console.log(`remote_server_config_findings = ${findings.length}`);

if (findings.length > 0) {
  for (const finding of findings) {
    console.error(`  ${finding.path}: server.${finding.key} -- ${finding.why}`);
  }
  console.error(
    "\nA locally bundled app is a release requirement, not a preference:\n" +
      "  docs/policy/tomverse-chat-delivery-plan.md §2\n" +
      "  docs/policy/tomverse-chat-mobile-authentication.md, \"Deliberately excluded\"\n" +
      "Use a separate, uncommitted config for live reload during development."
  );
  process.exit(1);
}
