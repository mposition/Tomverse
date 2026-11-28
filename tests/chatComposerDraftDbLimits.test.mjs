// The Chat tables' CHECK bounds hold at least what the app lets through.
//
// 2026-11-24, production: a signed-in account could not send a question longer
// than 50,000 characters or carrying more than 5 files. The app had raised both
// limits (operator decisions 2026-11-18, #4068) and the draft table, which every
// send writes first, had not: 15 saves failed with check_violation (23514) and
// the user only saw "could not save the question". Nothing failed before
// production, because nothing compared the two.
//
// So this reads the bound each CHECK has after the newest migration that
// defines it, and compares values. The next app limit raised past a bound fails
// here, in CI. A migration that names one of these constraints in a form this
// cannot read also fails here, rather than being skipped.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import { CHAT_MAX_ATTACHMENTS_PER_MESSAGE } from "../lib/chatAttachmentLimits.ts";
import { chatComposerDraftPutSchema } from "../lib/chatComposerDraftCore.ts";
import { CHAT_DURABLE_PARTIAL_MAX_CHARACTERS } from "../lib/chatDurableAttemptStream.ts";
import {
  CHAT_MAX_MESSAGE_BODY_BYTES,
  CHAT_MAX_MESSAGE_CHARACTERS,
} from "../lib/chatRequestLimits.ts";

const MIGRATIONS = resolve(import.meta.dirname, "..", "prisma/migrations");

const migrations = () =>
  readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      name,
      // Line comments go: a header may mention a constraint by name.
      sql: readFileSync(join(MIGRATIONS, name, "migration.sql"), "utf8").replace(/--[^\n]*/g, ""),
    }));

/**
 * The bound the newest migration naming `constraint` gives it, read with
 * `definition` (whose one group is the number). A migration that names the
 * constraint without a definition this can read fails the test: the bound may
 * have moved, or been dropped, and a skipped file would hide that.
 */
const latestBound = (constraint, definition) => {
  let found;
  for (const { name, sql } of migrations()) {
    if (!sql.includes(`"${constraint}"`)) continue;
    const pattern = new RegExp(
      `CONSTRAINT\\s+"${constraint}"\\s+CHECK\\s*\\(\\s*${definition}\\s*\\)`,
      "g"
    );
    const bounds = [...sql.matchAll(pattern)].map((match) => Number(match[1]));
    assert.equal(
      bounds.length,
      1,
      `${name} names ${constraint} but this test cannot read one bound from it; ` +
        "update the definition pattern here together with the migration"
    );
    assert.ok(Number.isSafeInteger(bounds[0]) && bounds[0] > 0, `${name}: ${constraint}`);
    found = { name, bound: bounds[0] };
  }
  assert.ok(found, `no migration defines ${constraint}`);
  return found;
};

const draftText = () =>
  latestBound("ChatComposerDraft_text_length_check", String.raw`char_length\("text"\)\s*<=\s*(\d+)`);

const draftReferences = () =>
  latestBound(
    "ChatComposerDraft_attachment_references_check",
    String.raw`jsonb_typeof\("attachmentReferences"\)\s*=\s*'array'\s+AND\s+` +
      String.raw`jsonb_array_length\("attachmentReferences"\)\s*<=\s*(\d+)`
  );

const attemptPartial = () =>
  latestBound(
    "ChatResponseAttempt_partial_length_check",
    String.raw`char_length\("partialContent"\)\s*<=\s*(\d+)`
  );

test("the draft table holds the longest message text the app accepts", () => {
  const { name, bound } = draftText();
  assert.ok(
    CHAT_MAX_MESSAGE_CHARACTERS <= bound,
    `CHAT_MAX_MESSAGE_CHARACTERS is ${CHAT_MAX_MESSAGE_CHARACTERS}, but ${name} ` +
      `bounds ChatComposerDraft.text at ${bound}: raise the CHECK in a new migration first`
  );
  // The draft route reads at most this many bytes, and a character costs at
  // least one, so no body it accepts can carry more text than the table holds.
  assert.ok(
    CHAT_MAX_MESSAGE_BODY_BYTES <= bound,
    `CHAT_MAX_MESSAGE_BODY_BYTES is ${CHAT_MAX_MESSAGE_BODY_BYTES}, past the ${bound} ` +
      `characters ${name} lets ChatComposerDraft.text hold`
  );
});

test("the draft table holds as many attachments as one message may carry", () => {
  const { name, bound } = draftReferences();
  assert.ok(
    CHAT_MAX_ATTACHMENTS_PER_MESSAGE <= bound,
    `CHAT_MAX_ATTACHMENTS_PER_MESSAGE is ${CHAT_MAX_ATTACHMENTS_PER_MESSAGE}, but ${name} ` +
      `bounds ChatComposerDraft.attachmentReferences at ${bound}: raise the CHECK in a new migration first`
  );
});

test("the draft schema admits exactly the app limits the table is compared with", () => {
  // Ties the comparison above to what the route really lets through: a schema
  // moved to another constant would otherwise pass a check of the old one.
  const references = (count) =>
    Array.from({ length: count }, (_, index) => ({ uploadId: `upload_${index}` }));
  const draft = (text, count) =>
    chatComposerDraftPutSchema.safeParse({
      expectedRevision: 0,
      text,
      attachmentReferences: references(count),
    }).success;
  const longest = "x".repeat(CHAT_MAX_MESSAGE_CHARACTERS);
  assert.equal(draft(longest, CHAT_MAX_ATTACHMENTS_PER_MESSAGE), true);
  assert.equal(draft(`${longest}x`, 0), false);
  assert.equal(draft("", CHAT_MAX_ATTACHMENTS_PER_MESSAGE + 1), false);
});

test("the attempt table holds the longest answer checkpoint the app writes", () => {
  const { name, bound } = attemptPartial();
  assert.ok(
    CHAT_DURABLE_PARTIAL_MAX_CHARACTERS <= bound,
    `CHAT_DURABLE_PARTIAL_MAX_CHARACTERS is ${CHAT_DURABLE_PARTIAL_MAX_CHARACTERS}, but ${name} ` +
      `bounds ChatResponseAttempt.partialContent at ${bound}`
  );
});
