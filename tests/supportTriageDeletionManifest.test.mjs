import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SUPPORT_TRIAGE_DELETION_MANIFEST,
  auditDeletionManifest,
  parsePrismaSchema,
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
    models.get("A").fields.map((f) => [f.name, f.relation]),
    [["id", false], ["tags", false], ["colour", false], ["b", true], ["bId", false]]
  );
  assert.deepEqual(models.get("A").unreadable, []);
});
