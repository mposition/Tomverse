// Guards the PR Fast Gate's @smoke tier against silent coverage loss.
//
// PR Fast Gate runs `test:e2e:smoke` (--grep @smoke) instead of the whole
// desktop-chromium project. That is only safe while the smoke set keeps
// covering the user contracts that must never merge broken -- sign-in,
// billing, the credit preflight, guest chat, model comparison and
// attachments -- and while it stays small enough to be a gate rather than a
// second regression suite.
//
// The manifest below is the source of truth, not a count. A renamed or
// deleted test fails here loudly instead of quietly dropping out of the
// gate, which a plain `grep -c "@smoke"` cannot detect (and which would also
// miscount tags that only appear in comments).
//
// Tags are resolved by Playwright itself via `--list --reporter=json`, so
// this sees exactly what `--grep @smoke` will run. Listing does not launch a
// browser, so the check is cheap enough to run before the smoke tests.

import { spawnSync } from "node:child_process";

const PROJECT = "desktop-chromium";
const TAG = "@smoke";

// Exactly the set PR Fast Gate is allowed to run. `categories` drive the
// per-area minimums below; `mandatory` marks contracts that may never be
// dropped even if some other test could satisfy the same category count.
const MANIFEST = [
  // --- app boot -----------------------------------------------------------
  { file: "smoke.spec.ts", title: "home renders the marketing site", categories: ["appBoot"] },

  // --- guest ---------------------------------------------------------------
  { file: "smoke.spec.ts", title: "guest preview opens a 3-model comparison chat by default", categories: ["guest", "modelSelection"] },
  { file: "guest-flow.spec.ts", title: "guest message appears immediately with mocked response", categories: ["guest"] },
  { file: "guest-flow.spec.ts", title: "guest cannot activate a paid model", categories: ["guest", "payment"], mandatory: true },

  // --- auth / account ------------------------------------------------------
  { file: "smoke.spec.ts", title: "signed-in homepage keeps the page visible and offers one continue action", categories: ["auth"], mandatory: true },
  { file: "account-flow.spec.ts", title: "authenticated user opens settings", categories: ["auth"], mandatory: true },
  { file: "account-flow.spec.ts", title: "billing success modal respects the explicit return language", categories: ["auth", "payment"], mandatory: true },

  // --- payment / credit ledger --------------------------------------------
  { file: "upgrade-discovery.spec.ts", title: "locked paid model opens an actionable plan dialog", categories: ["payment"], mandatory: true },
  { file: "upgrade-discovery.spec.ts", title: "comparison preflight rejection prevents every provider request", categories: ["creditPreflight"], mandatory: true },
  { file: "upgrade-discovery.spec.ts", title: "comparison preflight retries one transient network failure", categories: ["creditPreflight"], mandatory: true },
  { file: "upgrade-discovery.spec.ts", title: "unexpected aggregate preflight failure falls back to authoritative chat checks", categories: ["creditPreflight"], mandatory: true },

  // --- model comparison ----------------------------------------------------
  { file: "comparison-review.spec.ts", title: "AI comparison review with two reviewers shows a tab switcher and agreement summary", categories: ["comparisonReview"] },
  { file: "desktop-flow.spec.ts", title: "guest model selector opens a swap dialog once the 3-model cap is reached", categories: ["modelSelection"] },
  { file: "desktop-flow.spec.ts", title: "model picker prioritizes exact credits and shows the final input estimate", categories: ["modelSelection", "creditEstimate"] },

  // --- attachments ---------------------------------------------------------
  { file: "attachment-flow.spec.ts", title: "selected image previews before and after send", categories: ["attachmentImage"], mandatory: true },
  { file: "attachment-flow.spec.ts", title: "PDF remains a friendly file card and sends successfully", categories: ["attachmentPdf"], mandatory: true },
  { file: "attachment-flow.spec.ts", title: "image attachments disable text-only Llama models and keep Scout available", categories: ["attachmentModelCompat"], mandatory: true },

  // --- UI contracts --------------------------------------------------------
  { file: "ui-contracts.spec.ts", title: "desktop exposes stable QA contracts", categories: ["uiContractDesktop"] },
  { file: "ui-contracts.spec.ts", title: "mobile exposes stable QA contracts", categories: ["uiContractMobile"] },

  // --- deployment integrity ------------------------------------------------
  // The real, unmocked endpoint: proves the route is wired, exposes exactly
  // the public field set with no-store, and never fabricates deployment
  // timestamps. No commit-specific or environment-specific expectations.
  { file: "build-info.spec.ts", title: "GET returns the public shape with a no-store cache header", categories: ["buildInfo"] },
];

const CATEGORY_MINIMUMS = {
  appBoot: 1,
  guest: 2,
  auth: 2,
  payment: 2,
  creditPreflight: 3,
  comparisonReview: 1,
  modelSelection: 2,
  attachmentImage: 1,
  attachmentPdf: 1,
  attachmentModelCompat: 1,
  uiContractDesktop: 1,
  uiContractMobile: 1,
  buildInfo: 1,
};

// The PR tier is a gate, not a second regression suite. Growing past this
// means the tier is drifting back toward the full run that made PR Fast Gate
// a ~20 minute check.
const MAX_SMOKE_TESTS = 25;

// Screenshot-diff suites are maintained on main/nightly, never in the PR
// gate: they are the slowest tests here and the least able to distinguish a
// real regression from a rendering difference.
const FORBIDDEN_FILES = ["chat-state-visual-regression.spec.ts"];

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
};

const listed = spawnSync(
  process.execPath,
  [
    "node_modules/@playwright/test/cli.js",
    "test",
    `--project=${PROJECT}`,
    "--list",
    "--reporter=json",
  ],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
);

if (listed.status !== 0) {
  console.error(listed.stderr || listed.stdout);
  throw new Error(`Failed to list Playwright tests for project ${PROJECT}.`);
}

// The JSON reporter emits tags without the leading "@" ("smoke"), while the
// source and --grep both use "@smoke". Normalise so this check can never
// silently match nothing because of that asymmetry.
const normaliseTag = (tag) => (tag.startsWith("@") ? tag.slice(1) : tag);

const collectSpecs = (suite, specs = []) => {
  for (const spec of suite.specs ?? []) {
    specs.push({
      file: spec.file,
      title: spec.title,
      tags: (spec.tags ?? []).map(normaliseTag),
    });
  }
  for (const child of suite.suites ?? []) collectSpecs(child, specs);
  return specs;
};

const allSpecs = collectSpecs({ suites: JSON.parse(listed.stdout).suites ?? [] });
if (allSpecs.length === 0) {
  throw new Error(`Listed zero tests for project ${PROJECT}; refusing to validate an empty suite.`);
}

const tagged = allSpecs.filter((spec) => spec.tags.includes(normaliseTag(TAG)));
const key = (spec) => `${spec.file} ${spec.title}`;
const taggedKeys = new Set(tagged.map(key));

console.log(
  `${PROJECT}: ${allSpecs.length} tests total, ${tagged.length} tagged ${TAG}, manifest expects ${MANIFEST.length}.`
);

// 1. An empty or shrunken smoke set must never pass silently.
if (tagged.length === 0) {
  fail(`No test carries the ${TAG} tag. PR Fast Gate would run zero E2E coverage.`);
}
if (tagged.length !== MANIFEST.length) {
  fail(`Expected exactly ${MANIFEST.length} ${TAG} tests, found ${tagged.length}.`);
}
if (tagged.length > MAX_SMOKE_TESTS) {
  fail(`${tagged.length} ${TAG} tests exceeds the PR-tier cap of ${MAX_SMOKE_TESTS}.`);
}

// 2. Every manifest contract must still exist and still be tagged. A rename
//    surfaces here rather than silently reducing the gate.
const categoryCounts = {};
for (const entry of MANIFEST) {
  const exists = allSpecs.some((spec) => spec.file === entry.file && spec.title === entry.title);
  const isTagged = taggedKeys.has(key(entry));
  if (!exists) {
    fail(
      `Required contract is gone from ${entry.file}: "${entry.title}". ` +
        `If it was renamed, update scripts/verify-smoke-coverage.mjs to the new title -- do not drop the coverage.`
    );
    continue;
  }
  if (!isTagged) {
    fail(`Required contract lost its ${TAG} tag: ${entry.file} :: "${entry.title}".`);
    continue;
  }
  for (const category of entry.categories) {
    categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
  }
}

// 3. Mandatory security/payment/credit/auth contracts are named individually
//    so a category quota can never be satisfied by swapping one of them out.
for (const entry of MANIFEST.filter((item) => item.mandatory)) {
  if (!taggedKeys.has(key(entry))) {
    fail(`Mandatory ${entry.categories.join("/")} contract missing from the smoke set: "${entry.title}".`);
  }
}

// 4. Per-area minimums.
for (const [category, minimum] of Object.entries(CATEGORY_MINIMUMS)) {
  const count = categoryCounts[category] ?? 0;
  if (count < minimum) {
    fail(`Smoke coverage for "${category}" is ${count}, below the required minimum of ${minimum}.`);
  }
}

// 5. Nothing tagged outside the manifest, and nothing tagged in a suite that
//    belongs to the main/nightly tier.
for (const spec of tagged) {
  if (FORBIDDEN_FILES.includes(spec.file)) {
    fail(`${spec.file} must not carry ${TAG} (it runs on main/nightly): "${spec.title}".`);
  }
  if (!MANIFEST.some((entry) => entry.file === spec.file && entry.title === spec.title)) {
    fail(
      `Untracked ${TAG} test: ${spec.file} :: "${spec.title}". ` +
        `Add it to the manifest in scripts/verify-smoke-coverage.mjs so the PR tier stays reviewed.`
    );
  }
}

if (process.exitCode) {
  console.error("\nSmoke coverage verification failed. PR Fast Gate would not gate what it claims to gate.");
} else {
  console.log(
    `OK: ${tagged.length} smoke tests cover ${Object.keys(CATEGORY_MINIMUMS).length} required areas ` +
      `(${allSpecs.length - tagged.length} further ${PROJECT} tests run on main push and nightly).`
  );
}
