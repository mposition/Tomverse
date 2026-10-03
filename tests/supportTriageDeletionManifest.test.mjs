import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SUPPORT_TRIAGE_DELETION_MANIFEST,
  auditDeletionManifest,
  parsePrismaSchema,
  stripPrismaComments,
} from "../lib/supportTriageDeletionManifest.ts";

// docs/policy/support-triage.md §5: the manifest is the single list of what
// support-triage writes, and it must match prisma/schema.prisma exactly.

const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

test("the manifest matches the schema exactly", () => {
  assert.deepEqual(auditDeletionManifest(schema), []);
});

// Negative controls: each edit below must be caught. They work on a copy of
// the real schema with one line added to the SupportTriageRun model.
const withRunField = (line) =>
  schema.replace(/^(model SupportTriageRun \{\n)/m, `$1  ${line}\n`);

for (const [label, line, expected] of [
  ["an unclassified optional String", "note String?", /SupportTriageRun\.note: no classification/],
  ["an unclassified String list", "tags String[]", /SupportTriageRun\.tags: no classification/],
  ["an unclassified Json column", "payload Json?", /SupportTriageRun\.payload: no classification/],
  ["a person's account by name", "decidedByUserId String?", /decidedByUserId: names a person's account/],
  ["a person's account by relation", "owner User @relation(fields: [id], references: [id])", /owner: names a person's account/],
  ["a type the parser does not know", "mystery Unsupported(\"tsvector\")", /unreadable schema line/],
]) {
  test(`negative control: ${label} fails`, () => {
    const failures = auditDeletionManifest(withRunField(line));
    assert.ok(failures.some((failure) => expected.test(failure)), JSON.stringify(failures));
  });
}

test("negative control: an unclassified enum column fails", () => {
  const edited = withRunField("mood RunMood?") + "\nenum RunMood {\n  calm\n}\n";
  const failures = auditDeletionManifest(edited);
  assert.ok(failures.some((failure) => /SupportTriageRun\.mood: no classification/.test(failure)), JSON.stringify(failures));
});

test("negative control: a classified column the schema does not have fails", () => {
  const manifest = [
    {
      ...SUPPORT_TRIAGE_DELETION_MANIFEST[0],
      columns: { ...SUPPORT_TRIAGE_DELETION_MANIFEST[0].columns, ghost: "lifecycle" },
    },
  ];
  assert.ok(auditDeletionManifest(schema, manifest).some((f) => /ghost: classified but not in the schema/.test(f)));
});

test("negative control: a link-none model cannot hold report content or a foreign identifier", () => {
  const manifest = [
    {
      ...SUPPORT_TRIAGE_DELETION_MANIFEST[0],
      columns: { ...SUPPORT_TRIAGE_DELETION_MANIFEST[0].columns, kind: "report_derived", outcome: "identifier" },
    },
  ];
  const failures = auditDeletionManifest(schema, manifest);
  assert.ok(failures.some((f) => /kind: a link-none model cannot hold report_derived/.test(f)));
  assert.ok(failures.some((f) => /outcome: a link-none model's only identifier is its own id/.test(f)));
});

test("negative control: a new model that reaches Feedback by relation must be in the manifest", () => {
  const edited =
    schema +
    "\nmodel ShadowFeedbackNote {\n  id String @id\n  feedback Feedback @relation(fields: [noteOf], references: [id])\n  noteOf String\n}\n";
  // Prisma also needs the back-relation; the audit reads only the forward field.
  assert.ok(
    auditDeletionManifest(edited).some((f) => /ShadowFeedbackNote: reaches Feedback/.test(f))
  );
});

test("negative control: a feedbackId column without a relation still counts", () => {
  const edited = schema + "\nmodel LooseNote {\n  id String @id\n  feedbackId String\n}\n";
  assert.ok(auditDeletionManifest(edited).some((f) => /LooseNote: reaches Feedback/.test(f)));
});

test("negative control: a SupportTriage model missing from the manifest fails", () => {
  const edited = schema + "\nmodel SupportTriageGhost {\n  id String @id\n}\n";
  assert.ok(auditDeletionManifest(edited).some((f) => /SupportTriageGhost: a support-triage model missing/.test(f)));
});

test("the parser reads list, optional, enum and relation fields", () => {
  const models = parsePrismaSchema(
    "enum Colour {\n  red\n}\nmodel A {\n  id String @id\n  tags String[]\n  colour Colour?\n  b B? @relation(fields: [bId], references: [id])\n  bId String?\n  @@index([bId])\n}\nmodel B {\n  id String @id\n  as A[]\n}\n"
  );
  assert.deepEqual(
    models.models.get("A").fields.map((f) => [f.name, f.relation]),
    [["id", false], ["tags", false], ["colour", false], ["b", true], ["bId", false]]
  );
  assert.deepEqual(models.models.get("A").unreadable, []);
  assert.deepEqual(models.unreadable, []);
});

test("block comments are skipped without hiding the lines around them", () => {
  const parsed = parsePrismaSchema("model A {\n  /**\n   * a note\n   */\n  id String @id\n}\n");
  assert.deepEqual(parsed.models.get("A").fields.map((f) => f.name), ["id"]);
  assert.deepEqual(parsed.models.get("A").unreadable, []);
});

test("negative control: a comment after the opening brace cannot hide a model", () => {
  const edited = schema + "\nmodel SupportTriageGhost { // looks harmless\n  id String @id\n  feedbackId String\n}\n";
  const failures = auditDeletionManifest(edited);
  assert.ok(failures.some((f) => /SupportTriageGhost: a support-triage model missing/.test(f)), JSON.stringify(failures));
  assert.ok(failures.some((f) => /SupportTriageGhost: reaches Feedback/.test(f)), JSON.stringify(failures));
});

test("negative control: text after an opening brace is reported", () => {
  const edited = schema + "\nmodel Odd { id String @id\n}\n";
  assert.ok(auditDeletionManifest(edited).some((f) => /text after the opening brace/.test(f)));
});

test("negative control: an unreadable line in a model outside the manifest still fails", () => {
  const edited = schema.replace(/^(model User \{\n)/m, '$1  weird Unsupported("x")\n');
  assert.ok(auditDeletionManifest(edited).some((f) => /^User: unreadable schema line/.test(f)));
});

test("negative control: a view or type block is reported, not skipped", () => {
  assert.ok(auditDeletionManifest(schema + "\nview FeedbackView {\n  feedbackId String\n}\n").some((f) => /view FeedbackView/.test(f)));
  assert.ok(auditDeletionManifest(schema + "\ntype Shape {\n  feedbackId String\n}\n").some((f) => /type Shape/.test(f)));
});

test("negative control: a link to Feedback from either side contradicts link none", () => {
  const edited = schema
    .replace(/^(model SupportTriageRun \{\n)/m, "$1  reports Feedback[]\n")
    .replace(/^(model Feedback \{\n)/m, "$1  triageRun SupportTriageRun? @relation(fields: [triageRunId], references: [id])\n  triageRunId String?\n");
  assert.ok(
    auditDeletionManifest(edited).some((f) => /SupportTriageRun: declared link none but the schema connects it to Feedback/.test(f))
  );
});

test("negative control: a linked model must delete on account deletion and link through an identifier", () => {
  const manifest = [
    {
      ...SUPPORT_TRIAGE_DELETION_MANIFEST[0],
      link: { kind: "feedback_id", column: "kind" },
      onAccountDeletion: "none",
    },
  ];
  const failures = auditDeletionManifest(schema, manifest);
  assert.ok(failures.some((f) => /link column kind must be an identifier/.test(f)));
  assert.ok(failures.some((f) => /linked to a report but does nothing on account deletion/.test(f)));
});

test("negative control: an unknown retention key fails", () => {
  const manifest = [{ ...SUPPORT_TRIAGE_DELETION_MANIFEST[0], retentionKey: "run_31_days" }];
  assert.ok(auditDeletionManifest(schema, manifest).some((f) => /unknown retention key run_31_days/.test(f)));
});

test("negative control: other person-account columns and relations fail", () => {
  for (const line of ["adminId String?", "authorId String", "operatorId String?", "session Session? @relation(fields: [id], references: [id])"]) {
    const failures = auditDeletionManifest(withRunField(line));
    assert.ok(failures.some((f) => /names a person's account/.test(f)), line);
  }
});

test("negative control: a block-comment opener inside a line comment hides nothing", () => {
  const edited = withRunField("// example /*\n  note String?\n  // example */");
  assert.ok(
    auditDeletionManifest(edited).some((f) => /SupportTriageRun\.note: no classification/.test(f)),
    "the column between the two line comments is real"
  );
});

test("comment openers inside strings are text", () => {
  const stripped = stripPrismaComments('a String @default("http://x/*y*/") // gone\nb Int');
  assert.equal(stripped, 'a String @default("http://x/*y*/") \nb Int');
  const block = stripPrismaComments("x /* one\ntwo */ y");
  assert.equal(block, "x \n y");
});

test("negative control: a typed link must be the foreign key of a relation to its target", () => {
  const selfId = [{ ...SUPPORT_TRIAGE_DELETION_MANIFEST[0], link: { kind: "feedback_id", column: "id" }, onAccountDeletion: "delete" }];
  assert.ok(
    auditDeletionManifest(schema, selfId).some((f) => /link column id is not the foreign key of a relation to Feedback/.test(f))
  );
  const viaWrong = [
    { ...SUPPORT_TRIAGE_DELETION_MANIFEST[0], link: { kind: "via_model", model: "SupportTriageRun", column: "id" }, onAccountDeletion: "cascade_from_group" },
  ];
  assert.ok(
    auditDeletionManifest(schema, viaWrong).some((f) => /link column id is not the foreign key of a relation to SupportTriageRun/.test(f))
  );
});

test("a correctly declared feedback link passes", () => {
  const edited = schema
    .replace(/^(model SupportTriageRun \{\n)/m, "$1  feedback Feedback @relation(fields: [feedbackId], references: [id])\n  feedbackId String\n")
    .replace(/^(model Feedback \{\n)/m, "$1  triageRuns SupportTriageRun[]\n");
  const manifest = [
    {
      ...SUPPORT_TRIAGE_DELETION_MANIFEST[0],
      link: { kind: "feedback_id", column: "feedbackId" },
      onAccountDeletion: "delete",
      columns: { ...SUPPORT_TRIAGE_DELETION_MANIFEST[0].columns, feedbackId: "identifier" },
    },
  ];
  assert.deepEqual(auditDeletionManifest(edited, manifest), []);
});

test("negative control: an untyped link backed by a relation, or not named feedbackId, fails", () => {
  const edited = schema
    .replace(/^(model SupportTriageRun \{\n)/m, "$1  feedback Feedback @relation(fields: [feedbackId], references: [id])\n  feedbackId String\n")
    .replace(/^(model Feedback \{\n)/m, "$1  triageRuns SupportTriageRun[]\n");
  const manifest = [
    {
      ...SUPPORT_TRIAGE_DELETION_MANIFEST[0],
      link: { kind: "untyped", column: "feedbackId" },
      onAccountDeletion: "delete",
      columns: { ...SUPPORT_TRIAGE_DELETION_MANIFEST[0].columns, feedbackId: "identifier" },
    },
  ];
  assert.ok(auditDeletionManifest(edited, manifest).some((f) => /backed by a relation; declare it typed/.test(f)));
});
