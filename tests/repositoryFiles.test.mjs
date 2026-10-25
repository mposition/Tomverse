import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { readMigrationSqlFiles, repositoryFiles } from "./support/repositoryFiles.mjs";

const fixture = (t) => {
  const root = mkdtempSync(join(tmpdir(), "tomverse-repository-files-"));
  execFileSync("git", ["init", "--quiet", root]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value);
  };
  const track = (path) => execFileSync("git", ["add", "--force", "--", path], { cwd: root });
  return { root, write, track };
};

test("source inventory includes new work and tracked ignored files, but excludes local backups", (t) => {
  const { root, write, track } = fixture(t);
  write(".gitignore", "backups/\n");
  write("backups/tracked.ts", "tracked source"); track("backups/tracked.ts");
  write("backups/local.ts", "local backup");
  write("lib/new.ts", "new source");
  const files = repositoryFiles(root);
  assert.ok(files.includes("backups/tracked.ts"));
  assert.ok(files.includes("lib/new.ts"));
  assert.ok(!files.includes("backups/local.ts"));
});

test("migration inventory includes new SQL and ignores empty draft directories", (t) => {
  const { root, write } = fixture(t);
  write("prisma/migrations/20261025000000_new/migration.sql", "SELECT 1;");
  mkdirSync(join(root, "prisma/migrations/20261025010000_draft"));
  assert.deepEqual(readMigrationSqlFiles(root), [{ name: "20261025000000_new", sql: "SELECT 1;" }]);
});

test("deleting a tracked SQL file cannot hide it from the migration guards", (t) => {
  const { root, write, track } = fixture(t);
  const path = "prisma/migrations/20261025000000_existing/migration.sql";
  write(path, "SELECT 1;"); track(path); unlinkSync(join(root, path));
  assert.ok(repositoryFiles(root).includes(path));
  assert.throws(() => readMigrationSqlFiles(root), { code: "ENOENT" });
});

test("a source archive without Git metadata reports the missing inventory boundary", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tomverse-no-git-inventory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => repositoryFiles(root), /requires a readable Git checkout and the Git executable/);
});
