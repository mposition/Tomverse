/**
 * Proves that every card the Chat starter catalogue can show is still true.
 *
 *   npm run check:starter-catalog
 *
 * Contract: docs/ui-contracts/chat-starter-catalog.md.
 *
 * ## Why this exists
 *
 * The starter gallery is the first screen a new account sees, and every card
 * on it is a claim about what this product does. The way that goes wrong is
 * not a crash: a feature is switched off, or renamed, or removed, and its card
 * stays behind promising something the build no longer does. Nothing fails,
 * nobody is paged, and the product lies on the one screen where it is being
 * introduced.
 *
 * So every claim has to be answerable from the repository, and this is where
 * it is answered. It is fail-closed by construction: a card whose flag key,
 * capability, evidence path or locale string cannot be resolved fails the
 * build rather than being assumed fine.
 *
 * ## What it deliberately does not claim
 *
 * That the feature works. No static check can say that. What it says is that
 * somebody had to name a real flag constant, a real capability resolver, a
 * real file and seven real translations, and that all four are still there.
 * That is the part the gate can hold, and it is the part that rots.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  CHAT_STARTER_CATALOG,
  STARTER_CAPABILITIES,
  STARTER_ACCENT_ROLES,
} from "../lib/chatStarterCatalog.ts";
import { CHAT_STARTER_MAX_VISIBLE } from "../lib/chatStarterAvailability.ts";

const LOCALES = ["en", "ko", "zh", "fr", "de", "es", "pt"];

const failures = [];
const fail = (message) => failures.push(message);

// --- 1. Flag keys are real constants, not string literals written out again.
//
// The rule the catalogue states is that `requires.flagKeys` holds imported
// constants. An import cannot be verified from the resolved value alone -- by
// the time this script reads the table, a literal and a constant are the same
// string. So both halves are checked: the value has to match a constant some
// module in `lib/` actually exports, and the catalogue source has to contain
// no `feature.` literal of its own.

const libFiles = readdirSync("lib")
  .filter((name) => name.endsWith(".ts"))
  .map((name) => join("lib", name));

const declaredFlagKeys = new Map();
const FLAG_CONSTANT = /export const ([A-Z0-9_]+)\s*(?::[^=]+)?=\s*\n?\s*"(feature\.[A-Za-z0-9.]+)"/g;
for (const file of libFiles) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(FLAG_CONSTANT)) {
    declaredFlagKeys.set(match[2], { file, constant: match[1] });
  }
}

const catalogSource = readFileSync("lib/chatStarterCatalog.ts", "utf8");
// Comments explain which flags exist and why one is absent; they are prose,
// not a requirement, so only code lines are read for the literal ban.
const catalogCodeLines = catalogSource
  .split("\n")
  .filter((line) => {
    const trimmed = line.trim();
    return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
  })
  .join("\n");
for (const match of catalogCodeLines.matchAll(/"(feature\.[A-Za-z0-9.]+)"/g)) {
  fail(
    `lib/chatStarterCatalog.ts writes the flag key "${match[1]}" as a string literal. ` +
      "Import the constant that owns it, so a typo is a type error rather than a card that is hidden forever."
  );
}

// --- 2. Every named capability resolves to a real export in a real module.

for (const [capability, descriptor] of Object.entries(STARTER_CAPABILITIES)) {
  if (!existsSync(descriptor.resolvedBy)) {
    fail(
      `capability "${capability}" names ${descriptor.resolvedBy}, which does not exist`
    );
    continue;
  }
  const source = readFileSync(descriptor.resolvedBy, "utf8");
  const exported = new RegExp(
    `export (?:const|function|type|class) ${descriptor.resolvedByExport}\\b`
  );
  if (!exported.test(source)) {
    fail(
      `capability "${capability}" names ${descriptor.resolvedBy} export ` +
        `"${descriptor.resolvedByExport}", which that module does not export`
    );
  }
}

// --- 3. Locale coverage, in all seven locales, for both strings of every card.

const readKey = (bundle, key) =>
  key.split(".").reduce((node, segment) => {
    if (node === undefined || node === null) return undefined;
    return node[segment];
  }, bundle);

const bundles = {};
for (const locale of LOCALES) {
  const bundle = await import(`../locales/${locale}.ts`);
  bundles[locale] = bundle[locale];
}

// --- 4. Copy rules. Both are rules the repository already enforces elsewhere;
// they are repeated here because this table is a new place for copy to live.
//
// The superlative list is `tests/autoRoutingUi.test.mjs`'s, for the same
// reason: the product measures non-inferiority, which is a far weaker claim
// than "the best model", and a card is not the place to make the stronger one.
const FORBIDDEN_CLAIMS = [
  "best",
  "optimal",
  "smartest",
  "most powerful",
  "최적",
  "가장 좋은",
  "최고",
  "最佳",
  "最好",
  "meilleur",
  "beste",
  "mejor",
  "melhor",
];
// components/marketing/landingContent.ts: no customer-facing string in this
// product uses an em dash or an en dash.
const FORBIDDEN_DASHES = [
  ["—", "em dash"],
  ["–", "en dash"],
];

const checkCopy = (locale, key, value) => {
  const lowered = value.toLowerCase();
  for (const claim of FORBIDDEN_CLAIMS) {
    if (lowered.includes(claim.toLowerCase())) {
      fail(`${locale}.${key} promises "${claim}"`);
    }
  }
  for (const [character, name] of FORBIDDEN_DASHES) {
    if (value.includes(character)) {
      fail(`${locale}.${key} contains an ${name}`);
    }
  }
};

// --- 5. The entries themselves.

const seenIds = new Set();
for (const entry of CHAT_STARTER_CATALOG) {
  if (seenIds.has(entry.id)) fail(`duplicate entry id "${entry.id}"`);
  seenIds.add(entry.id);

  for (const flagKey of entry.requires.flagKeys ?? []) {
    if (!declaredFlagKeys.has(flagKey)) {
      fail(
        `entry "${entry.id}" requires flag "${flagKey}", which no module in lib/ declares. ` +
          "A card may not be gated on a flag nothing in this repository can answer."
      );
    }
  }

  for (const capability of entry.requires.capabilities ?? []) {
    if (!Object.prototype.hasOwnProperty.call(STARTER_CAPABILITIES, capability)) {
      fail(
        `entry "${entry.id}" requires capability "${capability}", which STARTER_CAPABILITIES does not define`
      );
    }
  }

  if (!STARTER_ACCENT_ROLES.includes(entry.accentRole)) {
    fail(`entry "${entry.id}" has unknown accent role "${entry.accentRole}"`);
  }

  if (!existsSync(entry.evidence)) {
    fail(
      `entry "${entry.id}" names evidence ${entry.evidence}, which does not exist. ` +
        "A card whose implementation was deleted has to fail here rather than stay on screen."
    );
  }

  // The short label is the promise wherever the full sentence is not on
  // screen, so it is held to the same rules as the sentence.
  for (const [label, key] of [
    ["labelKey", entry.labelKey],
    ["outcomeKey", entry.outcomeKey],
    ["promptSeedKey", entry.seed.promptSeedKey],
  ]) {
    for (const locale of LOCALES) {
      const value = readKey(bundles[locale], key);
      if (typeof value !== "string" || value.trim().length === 0) {
        fail(`entry "${entry.id}" ${label} "${key}" is missing in locale ${locale}`);
        continue;
      }
      checkCopy(locale, key, value);
    }
  }
}

// The gallery's own chrome is copy too, and it is the one string that names a
// plan, so it is read by the same rules.
for (const key of [
  "chatStarter.title",
  "chatStarter.hint",
  "chatStarter.lockedSignIn",
  "chatStarter.lockedPlan",
  "chatStarter.lockedSignInShort",
  "chatStarter.lockedPlanShort",
]) {
  for (const locale of LOCALES) {
    const value = readKey(bundles[locale], key);
    if (typeof value !== "string" || value.trim().length === 0) {
      fail(`"${key}" is missing in locale ${locale}`);
      continue;
    }
    checkCopy(locale, key, value);
  }
}

// --- 6. The registry may outgrow the screen; the screen may not outgrow
// itself. A cap that quietly became larger than the catalogue would stop being
// a cap, and nothing on screen would say so.

if (CHAT_STARTER_MAX_VISIBLE < 4 || CHAT_STARTER_MAX_VISIBLE > 6) {
  fail(
    `CHAT_STARTER_MAX_VISIBLE is ${CHAT_STARTER_MAX_VISIBLE}; the contract fixes the on-screen ceiling at 4 to 6`
  );
}

if (failures.length > 0) {
  console.error("Chat starter catalogue check failed:\n");
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(
    `\n${failures.length} problem(s). Every card is a promise about what this ` +
      "product does; see docs/ui-contracts/chat-starter-catalog.md.\n"
  );
  process.exit(1);
}

console.log(
  `Chat starter catalogue check passed: ${CHAT_STARTER_CATALOG.length} entr(y/ies), ` +
    `${Object.keys(STARTER_CAPABILITIES).length} capabilit(y/ies), ${LOCALES.length} locales, ` +
    `screen cap ${CHAT_STARTER_MAX_VISIBLE}.`
);
