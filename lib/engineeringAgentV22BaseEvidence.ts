import "server-only";

import { createHash } from "node:crypto";
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

/** Which base-tree paths the base commit's own build leaves out of its image
 * (owner decision 2026-10-27, replacing the operator-pasted image proof).
 * The commit's `.dockerignore` is read in order, last matching rule winning,
 * a rule on a directory covering everything below it -- as Docker applies it.
 * Only test sources and the admin Playwright config may leave the runtime
 * slice (§4). A rule this reader does not fully understand excludes nothing. */
export function engineeringAgentV22DeployExclusion(dockerIgnore: string | null,
  paths: readonly string[]): string[] {
  if (dockerIgnore === null) return [];
  const rules: { negate: boolean; path: string; below: boolean }[] = [];
  for (const raw of dockerIgnore.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    let path = (negate ? line.slice(1) : line).replace(/^\/+/, "");
    const below = path.endsWith("/*");
    path = below ? path.slice(0, -2) : path.replace(/\/$/, "");
    if (path === "" || /[*?[\]\\]/.test(path) ||
        path.split("/").some((part) => part === "" || part === "." ||
          part === "..")) return [];
    rules.push({ negate, path, below });
  }
  return paths.filter((path) => {
    if (!path.startsWith("tests/") && path !== "playwright.admin.config.ts")
      return false;
    let excluded = false;
    for (const rule of rules) {
      if (path.startsWith(`${rule.path}/`) ||
          (!rule.below && path === rule.path)) excluded = !rule.negate;
    }
    return excluded;
  });
}

/** The GitHub tree is already bound to the current develop commit. A file is
 * accepted only when its bytes match that tree's Git blob OID: the image copy
 * when it matches, otherwise the blob read from GitHub by that OID. Paths the
 * base commit's build excludes are represented by paths but never assumed to
 * contain source text. */
export async function loadEngineeringAgentV22BaseEvidence(input: {
  tree: readonly TreeEntry[];
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
  deployExcludedPaths: string[];
  /** Names the exclusion the tier used; null when nothing is excluded. */
  exclusionDigest: string | null;
} | null> {
  const root = resolve(input.root ?? process.cwd());
  const read = input.read ?? readFile;
  const stat = input.stat ?? lstat;
  const baseFiles: { path: string; text: string }[] = [];
  const workflows: WorkflowFile[] = [];
  const policyDocuments: string[] = [];
  let lockText: string | null = null;
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
  const decode = (bytes: Uint8Array) => {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return null; }
  };
  const ignoreEntry = input.tree.find((entry) =>
    entry.path === ".dockerignore" && entry.type === "blob");
  let ignoreText: string | null = null;
  if (ignoreEntry) {
    const bytes = await baseBytes(ignoreEntry);
    ignoreText = bytes && decode(bytes);
    if (ignoreText === null) return null;
  }
  const excluded = new Set(engineeringAgentV22DeployExclusion(ignoreText,
    input.tree.filter((entry) => entry.type === "blob")
      .map((entry) => entry.path)));
  for (const entry of input.tree) {
    if (entry.type === "tree") continue;
    if (!isCanonicalRepoPath(entry.path) ||
        entry.type !== "blob" ||
        (entry.mode !== "100644" && entry.mode !== "100755")) return null;
    if (excluded.has(entry.path)) {
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
    const text = decode(bytes);
    if (text === null) return null;
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
  let lock: { packages?: Record<string, { version?: string }> };
  try { lock = JSON.parse(lockText); }
  catch { return null; }
  const deployExcludedPaths = [...excluded].sort();
  return { baseFiles, workflows, policyDocuments, deployExcludedPaths,
    exclusionDigest: deployExcludedPaths.length === 0 ? null :
      createHash("sha256").update(JSON.stringify({
        format: "engineering-agent-v22-deploy-exclusion-v1",
        dockerIgnoreOid: ignoreEntry!.oid, deployExcludedPaths,
      })).digest("hex"),
    installedVersions: Object.fromEntries(
      Object.keys(CONVENTION_VERSIONS).map((name) => [name,
        lock.packages?.[`node_modules/${name}`]?.version ?? null]),
    ) as Record<keyof typeof CONVENTION_VERSIONS, string | null>,
  };
}
