import "server-only";

import { lstat, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { CONVENTION_VERSIONS, isCanonicalRepoPath } from
  "@/lib/agentAuthorityFiles";
import type { TreeEntry } from "@/lib/engineeringAgentTreeVerify";
import { gitObjectId } from "@/lib/engineeringAgentTreeVerify";
import type { WorkflowFile } from "@/lib/agentCredentialReachability";

const ANALYSIS_TEXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json|ya?ml|md)$/;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;

type ReadFile = (path: string) => Promise<Uint8Array>;
type FileStat = (path: string) => Promise<{ isFile(): boolean }>;

/** The GitHub tree is already bound to the current develop commit. Image
 * files are accepted only when their Git blob OIDs match that tree; excluded
 * tests are represented by paths but never assumed to contain source text. */
export async function loadEngineeringAgentV22BaseEvidence(input: {
  tree: readonly TreeEntry[];
  excludedPrefixes: readonly string[];
  root?: string;
  read?: ReadFile;
  stat?: FileStat;
}): Promise<{
  baseFiles: { path: string; text: string }[];
  workflows: WorkflowFile[];
  installedVersions: Record<keyof typeof CONVENTION_VERSIONS,
    string | null>;
  policyDocuments: string[];
} | null> {
  const root = resolve(input.root ?? process.cwd());
  const read = input.read ?? readFile;
  const stat = input.stat ?? lstat;
  const baseFiles: { path: string; text: string }[] = [];
  const workflows: WorkflowFile[] = [];
  const policyDocuments: string[] = [];
  let lockText: string | null = null;
  let totalBytes = 0;
  for (const entry of input.tree) {
    if (entry.type === "tree") continue;
    if (!isCanonicalRepoPath(entry.path) ||
        entry.type !== "blob" ||
        (entry.mode !== "100644" && entry.mode !== "100755")) return null;
    const excluded = input.excludedPrefixes.some((prefix) =>
      entry.path.startsWith(`${prefix}/`));
    const absentConfig = input.excludedPrefixes.includes("tests") &&
      entry.path === "playwright.admin.config.ts";
    if (excluded || absentConfig) {
      baseFiles.push({ path: entry.path, text: "" });
      continue;
    }
    // The entire vendored AMUX tree is control-plane by the authority
    // manifest. Its paths remain in the resolver/slice, but it is not app
    // runtime code and cannot feed appRuntimeSlice or environment-name
    // harvesting. Decoding its generated assets would only exhaust limits.
    if (entry.path.startsWith("vendor/amux/")) {
      baseFiles.push({ path: entry.path, text: "" });
      continue;
    }
    // Non-analysis blobs still need their image presence checked by the
    // complete image manifest, not re-read here. Source text is read only for
    // the analyser's known extensions and policy inputs.
    if (!ANALYSIS_TEXT.test(entry.path)) {
      baseFiles.push({ path: entry.path, text: "" });
      continue;
    }
    const path = resolve(root, entry.path);
    if (!path.startsWith(`${root}${sep}`)) return null;
    let bytes: Uint8Array;
    try {
      if (!(await stat(path)).isFile()) return null;
      bytes = await read(path);
    } catch { return null; }
    totalBytes += bytes.byteLength;
    if (bytes.byteLength > MAX_FILE_BYTES || totalBytes > MAX_TOTAL_BYTES ||
        gitObjectId("blob", bytes) !== entry.oid) return null;
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return null; }
    baseFiles.push({ path: entry.path, text });
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(entry.path))
      workflows.push({ path: entry.path, blobSha: entry.oid, text });
    if (entry.path === "AGENTS.md" ||
        entry.path === "scripts/security-regression-check.mjs" ||
        /^docs\/(?:policy|ui-contracts)\//.test(entry.path))
      policyDocuments.push(text);
    if (entry.path === "package-lock.json") lockText = text;
  }
  if (lockText === null || !baseFiles.some((file) =>
    file.path === "tsconfig.json")) return null;
  let lock: { packages?: Record<string, { version?: string }> };
  try { lock = JSON.parse(lockText); }
  catch { return null; }
  return { baseFiles, workflows, policyDocuments,
    installedVersions: Object.fromEntries(
      Object.keys(CONVENTION_VERSIONS).map((name) => [name,
        lock.packages?.[`node_modules/${name}`]?.version ?? null]),
    ) as Record<keyof typeof CONVENTION_VERSIONS, string | null>,
  };
}
