// Guards the @review-parity baseline that headless extraction is measured against.
//
// UI-01 says Tomverse Review behaviour must survive the chat-core/chat-ui
// extraction. That promise is only as good as the set of contracts frozen
// before the refactor starts, so this manifest -- not a tag count -- is the
// source of truth. A renamed, deleted, or untagged contract fails here loudly
// instead of quietly shrinking the baseline, which a plain
// `grep -c "@review-parity"` cannot detect.
//
// Parity is a *purpose* tag, not a tier: several entries also carry @smoke
// because they are both "must never merge broken" and "must survive the
// extraction". The overlap is deliberate and recorded in `alsoSmoke` so a
// reviewer can see which contracts the PR gate already runs.
//
// Scope discipline matters as much as coverage. The repository already has
// @smoke, @ui-risk, visual and nightly tiers; parity must not become a second
// copy of them. It freezes the chat *state* contracts an extraction can break
// -- send/stream lifecycle, composer lock and release, failure isolation,
// late-response races, comparison/review wiring, attachment identity -- and
// deliberately leaves layout matrices, the visual snapshot grid, the full IME
// and 320px composer matrix, and ledger/lease invariants to the tiers that
// already own them.
//
// Tags are resolved by Playwright itself via `--list --reporter=json`, so this
// sees exactly what `--grep @review-parity` will run. Listing does not launch
// a browser, so the check is cheap enough to run before the tests.

import { spawnSync } from "node:child_process";

const PROJECT = "desktop-chromium";
const TAG = "@review-parity";

// Exactly the contracts the extraction baseline is allowed to rest on.
// `categories` drive the per-area minimums below; `mandatory` marks contracts
// that may never be dropped even if another test could satisfy the same count.
const MANIFEST = [
  // --- send and stream lifecycle -------------------------------------------
  {
    file: "guest-flow.spec.ts",
    title: "guest message appears immediately with mocked response",
    categories: ["messageStreaming"],
    alsoSmoke: true,
    mandatory: true,
  },
  {
    file: "chat-keyboard-policy.spec.ts",
    title: "Enter sends the message exactly once",
    categories: ["messageStreaming"],
    mandatory: true,
  },
  {
    file: "chat-keyboard-policy.spec.ts",
    title: "repeated Enter while sending does not duplicate the request",
    categories: ["messageStreaming", "composerLock"],
    mandatory: true,
  },
  {
    file: "conversation-switch-during-stream.spec.ts",
    title: "the switch is allowed mid-stream, and the stream does not follow",
    categories: ["messageStreaming"],
    mandatory: true,
  },

  // --- composer lock and release -------------------------------------------
  // Extraction that moves send state into chat-core breaks the composer's
  // lock/release before it breaks layout. Only the conversation-switch release
  // path is covered here: the failure-path release lives in this file's
  // "mobile chat keyboard policy" block, which skips outside mobile-*
  // projects, so it cannot be part of a desktop baseline (see
  // docs/qa/review-parity-baseline.md).
  //
  // Renamed from "the composer is released once the abandoned stream
  // finishes". The contract is the same one and is strictly stronger now: the
  // composer of the conversation arrived at is free *immediately*, not once
  // the run left behind happens to end. It used to hold only at the end
  // because both shells kept the run's status keyed by model id alone, so the
  // lock followed the user out of the conversation that was busy
  // (lib/chatRuntimeStatus.ts). Nothing was dropped from the baseline.
  {
    file: "conversation-switch-during-stream.spec.ts",
    title: "the composer of the conversation arrived at is free at once",
    categories: ["composerLock"],
    mandatory: true,
  },

  // --- failure isolation and retry -----------------------------------------
  {
    file: "chat-failure-recovery.spec.ts",
    title: "one failing model leaves the other panels' answers intact",
    categories: ["failureIsolation"],
    mandatory: true,
  },
  {
    file: "chat-failure-recovery.spec.ts",
    title: "retrying a failed model re-requests only that model and recovers the answer",
    categories: ["failureIsolation"],
    mandatory: true,
  },
  {
    file: "chat-failure-recovery.spec.ts",
    title: "an empty provider response is reported rather than left blank",
    categories: ["failureIsolation"],
    mandatory: true,
  },

  // --- late-response races -------------------------------------------------
  {
    file: "chat-send-history-race.spec.ts",
    title: "a history response that lands after the send does not erase the message",
    categories: ["asyncRace"],
    mandatory: true,
  },
  {
    file: "chat-send-history-race.spec.ts",
    title: "the same race in the narrowed (mobile-layout) window keeps the message",
    categories: ["asyncRace"],
  },

  // --- comparison and review wiring ----------------------------------------
  {
    file: "upgrade-discovery.spec.ts",
    title: "comparison preflight rejection prevents every provider request",
    categories: ["reviewCore"],
    alsoSmoke: true,
    mandatory: true,
  },
  {
    file: "comparison-action-rail.spec.ts",
    title: "three completed answers run against all three",
    categories: ["reviewCore"],
  },
  {
    file: "comparison-action-rail.spec.ts",
    title: "a failed answer is excluded, said so, and does not block the rest",
    categories: ["reviewCore", "failureIsolation"],
    mandatory: true,
  },
  {
    file: "comparison-review.spec.ts",
    title: "AI comparison review with two reviewers shows a tab switcher and agreement summary",
    categories: ["reviewCore"],
    alsoSmoke: true,
    mandatory: true,
  },

  // --- attachment identity -------------------------------------------------
  {
    file: "attachment-flow.spec.ts",
    title: "selected image previews before and after send",
    categories: ["attachment"],
    alsoSmoke: true,
    mandatory: true,
  },
  {
    file: "attachment-flow.spec.ts",
    title: "PDF remains a friendly file card and sends successfully",
    categories: ["attachment"],
    alsoSmoke: true,
  },
  {
    file: "attachment-flow.spec.ts",
    title: "image attachments disable text-only models and keep a vision model available",
    categories: ["attachment"],
    alsoSmoke: true,
    mandatory: true,
  },
];

const CATEGORY_MINIMUMS = {
  messageStreaming: 4,
  composerLock: 2,
  failureIsolation: 4,
  asyncRace: 2,
  reviewCore: 4,
  attachment: 3,
};

// Parity is a pre-refactor baseline, not a second regression suite. Growing
// past this means it is drifting into territory @smoke, @ui-risk, visual and
// nightly already cover.
const MAX_PARITY_TESTS = 24;

// Suites that belong to other tiers and must never carry the parity tag:
// screenshot diffs and the mobile composer matrix are the slowest and the
// least able to separate a real regression from a rendering difference, and
// marketing/analytics/pricing surfaces are not chat state at all.
const FORBIDDEN_FILES = [
  "chat-state-visual-regression.spec.ts",
  "mobile-composer-contract.spec.ts",
  "mobile-composer-banner-reflow.spec.ts",
];
const FORBIDDEN_FILE_PREFIXES = ["marketing-", "pricing-", "analytics-", "signin-analytics"];

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

// The JSON reporter emits tags without the leading "@" ("review-parity"),
// while the source and --grep both use "@review-parity". Normalise so this
// check can never silently match nothing because of that asymmetry.
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

// 1. An empty or shrunken parity baseline must never pass silently.
if (tagged.length === 0) {
  fail(`No test carries the ${TAG} tag. The extraction baseline would be empty.`);
}
if (tagged.length !== MANIFEST.length) {
  fail(`Expected exactly ${MANIFEST.length} ${TAG} tests, found ${tagged.length}.`);
}
if (tagged.length > MAX_PARITY_TESTS) {
  fail(`${tagged.length} ${TAG} tests exceeds the baseline cap of ${MAX_PARITY_TESTS}.`);
}

// 2. Every manifest contract must still exist and still be tagged. A rename
//    surfaces here rather than silently reducing the baseline.
const categoryCounts = {};
for (const entry of MANIFEST) {
  const exists = allSpecs.some((spec) => spec.file === entry.file && spec.title === entry.title);
  if (!exists) {
    fail(
      `Required parity contract is gone from ${entry.file}: "${entry.title}". ` +
        `If it was renamed, update scripts/verify-review-parity-coverage.mjs to the new title -- do not drop the coverage.`
    );
    continue;
  }
  if (!taggedKeys.has(key(entry))) {
    fail(`Required parity contract lost its ${TAG} tag: ${entry.file} :: "${entry.title}".`);
    continue;
  }
  for (const category of entry.categories) {
    categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
  }
}

// 3. Mandatory contracts are named individually so a category quota can never
//    be satisfied by swapping one of them out for something cheaper.
for (const entry of MANIFEST.filter((item) => item.mandatory)) {
  if (!taggedKeys.has(key(entry))) {
    fail(`Mandatory ${entry.categories.join("/")} parity contract is missing: "${entry.title}".`);
  }
}

// 4. Per-area minimums.
for (const [category, minimum] of Object.entries(CATEGORY_MINIMUMS)) {
  const count = categoryCounts[category] ?? 0;
  if (count < minimum) {
    fail(`Parity coverage for "${category}" is ${count}, below the required minimum of ${minimum}.`);
  }
}

// 5. Nothing tagged outside the manifest, and nothing tagged in a suite that
//    another tier owns.
for (const spec of tagged) {
  if (
    FORBIDDEN_FILES.includes(spec.file) ||
    FORBIDDEN_FILE_PREFIXES.some((prefix) => spec.file.startsWith(prefix))
  ) {
    fail(`${spec.file} must not carry ${TAG} (another tier owns it): "${spec.title}".`);
  }
  if (!MANIFEST.some((entry) => entry.file === spec.file && entry.title === spec.title)) {
    fail(
      `Untracked ${TAG} test: ${spec.file} :: "${spec.title}". ` +
        `Add it to the manifest in scripts/verify-review-parity-coverage.mjs so the baseline stays reviewed.`
    );
  }
}

// 6. The @smoke overlap is deliberate, so it is recorded rather than inferred:
//    a contract that silently gains or loses @smoke changes which gate runs it.
for (const entry of MANIFEST) {
  const spec = allSpecs.find((item) => item.file === entry.file && item.title === entry.title);
  if (!spec) continue;
  const isSmoke = spec.tags.includes("smoke");
  if (Boolean(entry.alsoSmoke) !== isSmoke) {
    fail(
      `${entry.file} :: "${entry.title}" is ${isSmoke ? "now" : "no longer"} @smoke, ` +
        `but the manifest records alsoSmoke: ${Boolean(entry.alsoSmoke)}. Update the manifest deliberately.`
    );
  }
}

if (process.exitCode) {
  console.error("\nReview parity verification failed. The extraction baseline is not what it claims to be.");
} else {
  const smokeOverlap = MANIFEST.filter((entry) => entry.alsoSmoke).length;
  console.log(
    `OK: ${tagged.length} parity contracts cover ${Object.keys(CATEGORY_MINIMUMS).length} required areas ` +
      `(${smokeOverlap} also run in the @smoke PR tier).`
  );
}
