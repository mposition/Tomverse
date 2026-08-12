// PUSH-01: push-notification infrastructure stays out of v1.
//
// The gate's metric is `unapproved_push_infrastructure_components_in_v1 = 0`,
// and it is inverted: it is met by something being absent. An absence is the
// easiest thing in a repository to lose without noticing -- nobody reviews the
// arrival of a dependency against a scope decision made months earlier, and by
// the time push exists the cost the gate was protecting against has already
// been paid. So the absence is measured, the way check-shared-packages
// measures forbidden imports rather than trusting that nobody wrote one.
//
// What counts as push infrastructure: a transport that wakes a device or a
// browser when the app is not open, and the backend that feeds it. Email is
// not push -- lib/notificationDeliveries.ts is a retry queue over
// transactional email and is deliberately untouched by this. Neither is an
// in-page toast.
//
// Exits non-zero on any finding. Prints the metric either way: a gate that is
// only reported when it fails cannot be cited as evidence that it passed.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const METRIC = "unapproved_push_infrastructure_components_in_v1";
const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * Components a human has approved into v1 despite the gate.
 *
 * Empty, and adding a row is the point at which the scope decision gets made
 * rather than inherited: a row must name what was approved, who approved it
 * and when, the way PENDING_VERIFIED_PRICE_REGISTER does for prices. An empty
 * array is the current answer, not a placeholder.
 */
const APPROVED_PUSH_COMPONENTS = [];

/**
 * Package names that exist to deliver push. Matched against the dependency
 * blocks rather than against import statements, because the dependency is the
 * commitment -- a package can sit in the tree for a release before anything
 * imports it, and that is exactly the window this gate is about.
 */
const PUSH_PACKAGES = [
  /^web-push$/,
  /^firebase(-admin)?$/,
  /^@firebase\//,
  /^@react-native-firebase\//,
  /^onesignal(-node)?$/,
  /^@onesignal\//,
  /^expo-notifications$/,
  /^@capacitor\/push-notifications$/,
  /^@capacitor-firebase\/messaging$/,
  /^node-apn$/,
  /^apn$/,
  /^@parse\/node-apn$/,
  /^pusher(-js)?$/,
];

/**
 * Source-level signatures of the same thing. Each names an API that only
 * exists to register for, store or send push.
 */
const PUSH_SOURCE_PATTERNS = [
  { name: "browser push subscription", pattern: /\bpushManager\b/ },
  { name: "browser push subscription", pattern: /\bPushSubscription\b/ },
  { name: "push permission prompt", pattern: /Notification\.requestPermission\s*\(/ },
  { name: "service worker registration", pattern: /serviceWorker\s*\.\s*register\s*\(/ },
  { name: "VAPID key material", pattern: /\bVAPID_(PUBLIC|PRIVATE)_KEY\b/ },
  { name: "FCM device token", pattern: /\bgetMessaging\s*\(/ },
  { name: "FCM device token", pattern: /\bFCM_SERVER_KEY\b/ },
  { name: "APNs credentials", pattern: /\bAPNS_(KEY_ID|TEAM_ID|BUNDLE_ID)\b/ },
  { name: "stored device token", pattern: /\bmodel\s+PushSubscription\b/ },
  { name: "stored device token", pattern: /\bmodel\s+DeviceToken\b/ },
];

const SOURCE_ROOTS = ["app", "components", "lib", "packages", "proxy.ts", "instrumentation.ts"];
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mjs", ".js"];

// This file names every pattern it looks for, and a test for it has to build
// fixtures out of them. Neither ships push; scanning them would only ever
// report themselves.
const SELF = "scripts/check-push-scope.mjs";

/**
 * Comments are stripped before matching, the way tests/goLiveSecurityFixes
 * does it. A scope rule is the kind of thing code explains in prose -- this
 * file's own header names `pushManager` twice -- and a check that a comment
 * can trip is a check people delete.
 */
const withoutComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const walk = (path, out = []) => {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return out;
  }
  if (stats.isFile()) {
    if (SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension))) out.push(path);
    return out;
  }
  for (const entry of readdirSync(path)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    walk(join(path, entry), out);
  }
  return out;
};

const findings = [];

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
for (const block of ["dependencies", "devDependencies", "optionalDependencies"]) {
  for (const name of Object.keys(manifest[block] || {})) {
    if (PUSH_PACKAGES.some((pattern) => pattern.test(name))) {
      findings.push({ where: `package.json (${block})`, what: name });
    }
  }
}

const files = SOURCE_ROOTS.flatMap((entry) => walk(join(root, entry)));
files.push(join(root, "prisma", "schema.prisma"));

for (const file of files) {
  const relativePath = relative(root, file).split("\\").join("/");
  if (relativePath === SELF) continue;
  let source;
  try {
    source = withoutComments(readFileSync(file, "utf8"));
  } catch {
    continue;
  }
  for (const { name, pattern } of PUSH_SOURCE_PATTERNS) {
    if (pattern.test(source)) findings.push({ where: relativePath, what: name });
  }
}

const unapproved = findings.filter(
  (finding) => !APPROVED_PUSH_COMPONENTS.includes(finding.what)
);

console.log(`${METRIC}=${unapproved.length}`);
console.log(
  `Scanned ${files.length} source file(s) and ${
    Object.keys(manifest.dependencies || {}).length +
    Object.keys(manifest.devDependencies || {}).length
  } declared dependencies.`
);

if (unapproved.length > 0) {
  console.error("\nPush infrastructure found in a release that excludes it:");
  for (const finding of unapproved) {
    console.error(`- ${finding.what}  (${finding.where})`);
  }
  console.error(
    "\nPUSH-01 keeps push out of v1 until a concrete use case is approved." +
      "\nIf this component was approved, record it in APPROVED_PUSH_COMPONENTS" +
      "\nwith who approved it and when -- the gate measures *unapproved*" +
      "\ncomponents, and an approval that is not written down is not one."
  );
  process.exit(1);
}

console.log("Push scope check passed: no push infrastructure in the tree.");
