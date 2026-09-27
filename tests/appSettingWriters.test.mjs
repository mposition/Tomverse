import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every `AppSetting` key the application reads must be changeable by the
 * application, or be registered as deliberately read-only with the reason.
 *
 * `memoryExtractionRevokedPairs` is why this exists. The import/memory policy
 * §12.1 says emergency pair revocation happens "without a deploy, by an
 * approved operator in the Admin Console, audit-logged, immediately
 * fail-closed" -- and everything except the change was built. The read, the
 * fail-closed parser and the extraction-side check were all wired and tested,
 * so the only way to exercise the control the policy names was a hand-typed
 * `UPDATE` against production: no permission check, no audit record, and a
 * storage format where one typo silently means "revoke everything".
 *
 * Nothing failed. A missing write path never does -- it is not a broken
 * feature, it is a feature that has no way to be used, and the code around it
 * looks complete from every direction except the one nobody stands in.
 *
 * The granularity here is the top-level declaration, not the `upsert` call: a
 * key written through a destructured loop variable is still written by the
 * function that names it. That is coarse on purpose. A finer reading would be
 * defeated by ordinary refactoring, and this only has to answer one question
 * -- is there a code path at all.
 */

const SETTINGS_MODULE = fileURLToPath(
  new URL("../lib/appSettings.ts", import.meta.url)
);

/**
 * Where a write path can be, which is not only `lib/appSettings.ts`.
 *
 * Reading one file was fine while every writer was in it. On 2026-09-23 the
 * marketing switch writer moved to `lib/marketingSwitchWriter.ts` -- it had
 * come to need the branded marketing transaction, and `lib/appSettings.ts`
 * sits inside the Prompt Refiner runtime source closure, a sealed file set a
 * database CHECK is bound to. The sweep then reported four keys as having no
 * write path, which is exactly the false alarm this file exists not to raise.
 *
 * So the scope is behavioural: every `lib/*.ts` that issues an AppSetting
 * write. A writer that moves again is found without anybody remembering to
 * add it here.
 */
const writerModules = () => {
  const directory = fileURLToPath(new URL("../lib/", import.meta.url));
  return readdirSync(directory)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(directory, name))
    .filter((path) => /appSetting\.(upsert|update|create|delete)/u.test(
      readFileSync(path, "utf8")
    ));
};

/**
 * Keys read but deliberately not writable from the application, and why.
 *
 * An entry is a decision that the *absence* is correct, not a note that the
 * work is outstanding. Both of these are the same decision: enabling account
 * memory is the §12.4 human activation procedure -- decision-grade eval, blind
 * review, an independent re-run, a signed approval, a register merge and a
 * staging verification -- and a button that skips to the last step would put
 * the procedure behind it. Revocation is the opposite direction and does have
 * a control, because stopping is always safe to make easy.
 */
const READ_ONLY_KEYS = {
  MEMORY_EXTRACTION_FLAG_KEY: {
    reason:
      "Release B activation is the §12.4 human procedure; the flag is turned on " +
      "as part of it, not from a screen. Stopping extraction is the revocation " +
      "control, which is writable.",
  },
  MEMORY_INJECTION_FLAG_KEY: {
    reason:
      "Same §12.4 procedure, and the last step of it: injection may only be " +
      "enabled after an approved pair, a staging verification and a signed " +
      "approval already exist. A toggle would be the procedure's last step " +
      "without its first five.",
  },
  EMAIL_MARKETING_FLAG_KEY: {
    reason:
      "docs/policy/email-notifications.md §15.2 keeps this off until the legal " +
      "review lands: Q1, Q2 and Q8 are unanswered, the A18 suppression " +
      "boundary is undecided, and `news.tomverse.app` has neither been " +
      "configured nor warmed up. A checkbox would put all of that behind one " +
      "click. The flag exists ahead of the control on purpose -- turning it " +
      "on later is then a settings change against a path that has already " +
      "been reviewed and tested.",
  },
  EMAIL_CAMPAIGNS_FLAG_KEY: {
    reason:
      "Same §15.2 table, different condition: the approval process has to be " +
      "settled first. Much of it now exists, but whether it is settled is an " +
      "organisational judgement recorded by an operator writing the row, not " +
      "something this code may decide by offering a toggle.",
  },
  EMAIL_CONSENT_RECONFIRM_FLAG_KEY: {
    reason:
      "The two-year re-confirmation batch does not exist yet, so there is " +
      "nothing for a control to switch. The key is declared so the name in " +
      "§15.2 resolves to something a reader can find; a writer for a feature " +
      "with no consumer would be a switch that does nothing, which teaches an " +
      "operator that switches do nothing.",
  },
  EMAIL_CONSENT_CONFIRMATION_FLAG_KEY: {
    reason:
      "docs/policy/email-double-opt-in.md: turning this on starts sending " +
      "confirmation mail and needs EMAIL_CONSENT_KEYS deployed first. It is an " +
      "operator step in the marketing activation order, recorded by writing " +
      "the row, not a toggle a screen should offer ahead of that order.",
  },
  MARKETING_EXPERIMENTS_KEY: {
    reason:
      "S2 adds the audited experiment activation route after cache and CSP " +
      "evidence exists; S1 only consumes this default-off value.",
  },
  MARKETING_WEBHOOK_SHADOW_KEY: {
    reason:
      "The staging-only webhook receiver and signed verification workflow are " +
      "S2 work. S1 reads the switch but intentionally provides no writer.",
  },
  MARKETING_WEBHOOK_APPLY_SCOPE_KEY: {
    reason:
      "S2 writes the verified event-type and channel subset with marketing:write, " +
      "step-up and a human audit row; S1 keeps webhook apply always false.",
  },
  VOICE_INPUT_FLAG_KEY: {
    reason:
      "docs/policy/voice-input.md §14: enabling voice input starts paying a " +
      "per-second provider bill whose user-facing price " +
      "docs/policy/voice-input.md §6 has not decided, " +
      "so it is the activation procedure -- the pricing decision, the " +
      "retention confirmation, the on-device verification -- and a toggle " +
      "would offer that procedure's last step without its first three. " +
      "Stopping is the opposite direction and needs no row at all: " +
      "VOICE_INPUT_KILL_SWITCH is an environment variable, so it also works " +
      "when the database is the thing that is unwell.",
  },
  PROMPT_REFINER_FLAG_KEY: {
    reason:
      "Prompt Refiner activation requires an approved paid adapter, fixed " +
      "cost and timeout bounds, PLANNER-03 evidence and rollout disposition. " +
      "Until those exist, an application toggle would expose the final step " +
      "without the safety and quality gates that make it usable. Emergency " +
      "stopping remains available through PROMPT_REFINER_KILL_SWITCH.",
  },
};

/**
 * A file's top-level declarations, each with the text that belongs to it.
 * Splitting on column-zero `export`/`const` is enough: these modules are flat
 * lists of exported functions and module constants.
 */
const declarations = (source) => {
  const blocks = [];
  let current = { header: "(module scope)", body: "" };
  for (const line of source.split("\n")) {
    if (/^(export )?(async )?(function|const|class) /.test(line)) {
      blocks.push(current);
      current = { header: line.trim(), body: "" };
    }
    current.body += `${line}\n`;
  }
  blocks.push(current);
  return blocks;
};

const KEY_IDENTIFIER = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_KEYS?\b/g;

const keysUsedWith = (predicate, paths) => {
  const keys = new Set();
  for (const path of paths) {
    for (const block of declarations(readFileSync(path, "utf8"))) {
      if (!predicate(block.body)) continue;
      // The import statement at the top names every key; it is module scope
      // and touches no Prisma call, so it never matches either predicate.
      for (const match of block.body.matchAll(KEY_IDENTIFIER)) keys.add(match[0]);
    }
  }
  return keys;
};

/**
 * `tx` as well as `prisma`, because a write can be inside a transaction.
 *
 * `setAssistantPackageImportEnabled()` is: the flag change and its audit row
 * share one transaction on purpose, so a failed audit write takes the change
 * with it. Matching only `prisma.` would have read that as no write path at
 * all -- the sweep would have reported the very control the policy asked for
 * as missing, which is the opposite of the mistake this file exists to catch.
 */
const CLIENT = String.raw`(?:prisma|tx|client)`;
// Reads are asked of the settings module, which is the one that reads; writes
// are asked of every module that writes.
const readKeys = keysUsedWith(
  (body) =>
    new RegExp(`${CLIENT}\\.appSetting\\.(findUnique|findMany|findFirst|count)`).test(
      body
    ),
  [SETTINGS_MODULE]
);
const writtenKeys = keysUsedWith(
  (body) =>
    new RegExp(`${CLIENT}\\.appSetting\\.(upsert|update|create|delete)`).test(body),
  writerModules()
);

test("the sweep finds the keys it is meant to, so a silent zero is impossible", () => {
  // Without this the whole file passes vacuously the day the module is
  // restructured and the regexes stop matching anything.
  assert.ok(readKeys.size >= 5, `only ${readKeys.size} read key(s) found`);
  assert.ok(writtenKeys.size >= 3, `only ${writtenKeys.size} written key(s) found`);
  // More than the settings module, or the behavioural scope has silently
  // collapsed back to one file and a moved writer would read as missing again.
  assert.ok(
    writerModules().length >= 2,
    `only ${writerModules().length} module(s) write an AppSetting`
  );
  for (const key of Object.keys(READ_ONLY_KEYS)) {
    assert.ok(readKeys.has(key), `${key} is registered but nothing reads it`);
  }
});

test("every AppSetting key the app reads can be changed by the app", () => {
  const unwritable = [...readKeys].filter(
    (key) => !writtenKeys.has(key) && !(key in READ_ONLY_KEYS)
  );
  assert.deepEqual(
    unwritable,
    [],
    `${unwritable.join(", ")} can be read but not written. Add the write path, ` +
      `or register the key as deliberately read-only with the reason.`
  );
});

test("a registered read-only key that grew a writer is reported", () => {
  // The exemption outliving its reason is the failure mode a registry has.
  const nowWritable = Object.keys(READ_ONLY_KEYS).filter((key) =>
    writtenKeys.has(key)
  );
  assert.deepEqual(
    nowWritable,
    [],
    `${nowWritable.join(", ")} is registered as read-only but now has a write ` +
      `path. Remove the entry, or remove the writer.`
  );
});

test("the revocation key is writable, which is what §12.1 requires", () => {
  // Named rather than left to the sweep: this is the one the policy states in
  // so many words, and it is the reason the sweep exists.
  assert.ok(readKeys.has("MEMORY_EXTRACTION_REVOKED_PAIRS_KEY"));
  assert.ok(writtenKeys.has("MEMORY_EXTRACTION_REVOKED_PAIRS_KEY"));
});

test("every read-only entry carries a reason a reviewer can check", () => {
  for (const [key, entry] of Object.entries(READ_ONLY_KEYS)) {
    assert.ok(
      entry.reason && entry.reason.length > 60,
      `${key} needs a reason, not a note`
    );
  }
});
