import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
const migration = readFileSync(new URL(
  "../prisma/migrations/20261005010000_amux_v4_story_kind/migration.sql",
  import.meta.url), "utf8");

test("v4 Story subtype is a dedicated canonical column with a guarded shape", () => {
  assert.match(schema, /model AmuxWorkItem \{[^}]*?storyKind\s+String\?/s);
  assert.match(migration, /ADD COLUMN "storyKind" TEXT/);
  assert.match(migration, /AmuxWorkItem_v4_story_kind_check/);
  assert.match(migration, /"sourceSystem" IS DISTINCT FROM 'admin-idea-v4' AND "storyKind" IS NULL/);
  assert.match(migration, /"cardType" = 'story' AND "storyKind" IN \('general', 'bug'\)/);
  assert.match(migration, /"cardType" = 'task' AND "storyKind" IS NULL/);
});
