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
// Production runs `main`, not the `develop` base, so some image files differ
// from the base tree. Those come from GitHub by OID, up to this many.
const MAX_FETCHED_BLOBS = 500;

type ReadFile = (path: string) => Promise<Uint8Array>;
type FileStat = (path: string) => Promise<{ isFile(): boolean }>;
type FetchBlob = (oid: string, maxBytes: number) => Promise<Uint8Array>;

/** An excluded prefix stands only when the base commit's own build leaves it
 * out of the image, not merely the image this process happens to run. */
function dockerIgnoreExcludes(text: string, prefixes: readonly string[]) {
  const lines = new Set(text.split(/\r?\n/).map((line) => line.trim()));
  return prefixes.every((prefix) =>
    lines.has(`${prefix}/`) || lines.has(`/${prefix}/`)) &&
    (!prefixes.includes("tests") ||
      lines.has("playwright.admin.config.ts") ||
      lines.has("/playwright.admin.config.ts"));
}

/** The GitHub tree is already bound to the current develop commit. A file is
 * accepted only when its bytes match that tree's Git blob OID: the image copy
 * when it matches, otherwise the blob read from GitHub by that OID. Excluded
 * tests are represented by paths but never assumed to contain source text. */
export async function loadEngineeringAgentV22BaseEvidence(input: {
  tree: readonly TreeEntry[];
  excludedPrefixes: readonly string[];
  root?: string;
  read?: ReadFile;
  stat?: FileStat;
  fetchBlob?: FetchBlob;
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
  let dockerIgnoreText: string | null = null;
  let totalBytes = 0;
  let fetched = 0;
  const baseBytes = async (entry: TreeEntry): Promise<Uint8Array | null> => {
    const path = resolve(root, entry.path);
    if (!path.startsWith(`${root}${sep}`)) return null;
    try {
      if ((await stat(path)).isFile()) {
        const bytes = await read(path);
        if (bytes.byteLength <= MAX_FILE_BYTES &&
            gitObjectId("blob", bytes) === entry.oid) return bytes;
      }
    } catch { /* not in the image: read the base blob instead */ }
    if (!input.fetchBlob || fetched >= MAX_FETCHED_BLOBS) return null;
    fetched += 1;
    try {
      const bytes = await input.fetchBlob(entry.oid, MAX_FILE_BYTES);
      return gitObjectId("blob", bytes) === entry.oid ? bytes : null;
    } catch { return null; }
  };
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
    if (entry.path === ".dockerignore") {
      const bytes = await baseBytes(entry);
      if (!bytes) return null;
      try { dockerIgnoreText = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { return null; }
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
    const bytes = await baseBytes(entry);
    if (!bytes) return null;
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) return null;
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return null; }
    baseFiles.push({ path: entry.path, text });
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(entry.path))
      workflows.push({ path: entry.path, blobSha: entry.oid, text });
    if (entry.path === "AGENTS.md" ||
        entry.path === "docs/agents/machine-index.md" ||
        entry.path === "scripts/security-regression-check.mjs" ||
        /^docs\/(?:policy|ui-contracts)\//.test(entry.path))
      policyDocuments.push(text);
    if (entry.path === "package-lock.json") lockText = text;
  }
  if (lockText === null || !baseFiles.some((file) =>
    file.path === "tsconfig.json")) return null;
  if (input.excludedPrefixes.length > 0 && (dockerIgnoreText === null ||
      !dockerIgnoreExcludes(dockerIgnoreText, input.excludedPrefixes)))
    return null;
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
