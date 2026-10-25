import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

/** Include tracked files (even deleted/ignored ones) and new non-ignored work. */
export const repositoryFiles = (root = projectRoot) => [...new Set(execFileSync(
  "git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
).split("\0").filter(Boolean))].sort();

/** A missing tracked SQL file must still fail; an empty draft folder is not SQL. */
export const readMigrationSqlFiles = (root = projectRoot) => repositoryFiles(root)
  .filter((path) => /^prisma\/migrations\/\d{14}_[^/]+\/migration\.sql$/.test(path))
  .map((path) => ({ name: path.split("/")[2], sql: readFileSync(join(root, path), "utf8") }));
