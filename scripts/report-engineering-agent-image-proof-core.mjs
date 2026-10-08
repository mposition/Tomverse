import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const MAX_PATHS = 200_000;
const MAX_PATH_BYTES = 32 * 1024 * 1024;

/** Read the actual deployed filesystem, never a source-tree ignore rule.
 * Symlinks are listed but not traversed, so the manifest is finite. */
export async function listEngineeringAgentImagePaths(root) {
  const absolute = resolve(root);
  const pending = [absolute];
  const entries = [];
  let pathBytes = 0;
  while (pending.length > 0) {
    const dir = pending.pop();
    for (const name of await readdir(dir)) {
      const full = resolve(dir, name);
      const path = relative(absolute, full).split(sep).join("/");
      if (path.startsWith("../") || path === "..")
        throw new Error("image_path_outside_root");
      const stat = await lstat(full);
      const type = stat.isDirectory() ? "directory" :
        stat.isSymbolicLink() ? "symlink" :
          stat.isFile() ? "file" : "other";
      pathBytes += Buffer.byteLength(path, "utf8");
      if (entries.length + 1 > MAX_PATHS || pathBytes > MAX_PATH_BYTES)
        throw new Error("image_manifest_too_large");
      entries.push({ path, type });
      if (type === "directory") pending.push(full);
    }
  }
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return entries;
}

export function summarizeEngineeringAgentImagePaths(entries) {
  const canonical = entries.map((entry) =>
    `${entry.type}\t${entry.path}\n`).join("");
  const count = (prefix) => entries.filter((entry) =>
    entry.path === prefix || entry.path.startsWith(`${prefix}/`)).length;
  return {
    format: "engineering-agent-image-proof-v1",
    completePathCount: entries.length,
    completePathListSha256: createHash("sha256").update(canonical).digest("hex"),
    testsPathCount: count("tests"),
    docsPathCount: count("docs"),
    docsOpsPathCount: count("docs/ops"),
    libPathCount: count("lib"),
  };
}
