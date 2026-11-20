import "server-only";

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { isCanonicalRepoPath } from "@/lib/agentAuthorityFiles";
import type { TreeEntry } from "@/lib/engineeringAgentTreeVerify";
import { gitObjectId } from "@/lib/engineeringAgentTreeVerify";
import type { WorkflowFile } from "@/lib/agentCredentialReachability";
import { AMUX_V22_FILE_MAX_BYTES } from "@/lib/amux/v22PatchLimit";

// Source, data and documents, and the text gates the slice reads (shell,
// container and deploy configuration).
const ANALYSIS_TEXT = /(?:\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json|ya?ml|md|sh|ps1|toml)|(?:^|\/)Dockerfile[^/]*)$/;
// One file up to GitHub's file limit (lib/amux/v22PatchLimit.ts). There is
// no total: until 2026-11-15 a 128 MiB cap stood here, and the texts this
// reads had grown to about 122 MiB, past which every tier read would have
// failed. The base repository bounds the total.
const MAX_FILE_BYTES = AMUX_V22_FILE_MAX_BYTES;
// Production runs `main`, not the `develop` base, so some image files differ
// from the base tree, and the test helpers the image leaves out are not in it
// at all. Those come from GitHub by OID, as many as differ (1,000 until
// 2026-11-15). A read GitHub refuses -- its rate limit, say -- throws, so the
// tier round tries again later rather than settling for T2.
// Test code that is not a test body: helpers and fixtures a gate script may
// import, so the slice must read them (policy v6 item 2).
const TEST_HELPER_CODE = /^(?!.*\.(?:test|spec)\.[A-Za-z]+$).*\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const READ_CONCURRENCY = 16;

type ReadFile = (path: string) => Promise<Uint8Array>;
type FileStat = (path: string) => Promise<{ isFile(): boolean }>;
type FetchBlob = (oid: string, maxBytes: number) => Promise<Uint8Array>;

/** Which paths the base commit's own build leaves out of its image (owner
 * decision 2026-10-27, replacing the operator-pasted image proof). The
 * commit's `.dockerignore` is read in order, last matching rule winning, a
 * rule on a directory covering everything below it -- as Docker applies it.
 * Only test sources and the admin Playwright config count as left out. Of
 * those the evidence still reads the code that is not a test body (helpers,
 * fixtures, that config), which a gate may import; test bodies and test data
 * stay unread. A missing file or a rule this reader does not fully understand
 * is null: the tier is T2. */
export function engineeringAgentV22DeployExclusion(dockerIgnore: string | null,
  paths: readonly string[]): string[] | null {
  if (dockerIgnore === null) return null;
  const rules: { negate: boolean; path: string; below: boolean }[] = [];
  for (const raw of dockerIgnore.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    let path = (negate ? line.slice(1) : line).replace(/^\/+/, "");
    const below = path.endsWith("/*");
    path = below ? path.slice(0, -2) : path.replace(/\/$/, "");
    // Whitespace inside a rule (`! tests/x`) is read differently by Docker
    // versions; such a rule is not understood, so the tier is T2.
    if (path === "" || /[*?[\]\\\s]/.test(path) ||
        path.split("/").some((part) => part === "" || part === "." ||
          part === "..")) return null;
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

/** Which of `paths` the evidence passes with no text: what the base build
 * leaves out of its image other than test helpers, and the vendored AMUX
 * tree. Null when the `.dockerignore` cannot be read. The tier report reads
 * the same set. */
export function engineeringAgentV22UnreadText(dockerIgnore: string | null,
  paths: readonly string[]): Set<string> | null {
  const excluded = engineeringAgentV22DeployExclusion(dockerIgnore, paths);
  if (excluded === null) return null;
  return new Set([...excluded.filter((path) => !TEST_HELPER_CODE.test(path)),
    ...paths.filter((path) => path.startsWith("vendor/amux/"))]);
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
  policyDocuments: string[];
  /** Names the `.dockerignore` blob the exclusion was read from. */
  exclusionDigest: string;
} | null> {
  const root = resolve(input.root ?? process.cwd());
  const read = input.read ?? readFile;
  const stat = input.stat ?? lstat;
  const baseFiles: { path: string; text: string }[] = [];
  const workflows: WorkflowFile[] = [];
  const policyDocuments: string[] = [];
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
    if (!input.fetchBlob) return null;
    const bytes = await input.fetchBlob(entry.oid, MAX_FILE_BYTES);
    return gitObjectId("blob", bytes) === entry.oid ? bytes : null;
  };
  const decode = (bytes: Uint8Array) => {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return null; }
  };
  const ignoreEntry = input.tree.find((entry) =>
    entry.path === ".dockerignore" && entry.type === "blob");
  const ignoreBytes = ignoreEntry ? await baseBytes(ignoreEntry) : null;
  const ignoreText = ignoreBytes && decode(ignoreBytes);
  // Left out of the image and not read: test bodies and test data.
  const excluded = engineeringAgentV22UnreadText(ignoreText,
    input.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path));
  if (!ignoreEntry || excluded === null) return null;
  // The texts the loop below reads, read ahead in parallel: a few hundred
  // sequential GitHub blob reads took most of a minute (2026-10-28).
  const toRead = input.tree.filter((entry) => entry.type === "blob" &&
    isCanonicalRepoPath(entry.path) &&
    (entry.mode === "100644" || entry.mode === "100755") &&
    !excluded.has(entry.path) && !entry.path.startsWith("vendor/amux/") &&
    ANALYSIS_TEXT.test(entry.path));
  // Any missing text fails the whole read, so the first stops new reads.
  const texts = new Map<string, Uint8Array>();
  let next = 0;
  let stopped = false;
  await Promise.all(Array.from({ length: READ_CONCURRENCY }, async () => {
    while (!stopped && next < toRead.length) {
      const entry = toRead[next++];
      // A read that throws stops the others too, then fails the whole read.
      const bytes = await baseBytes(entry).catch((error: unknown) => {
        stopped = true;
        throw error;
      });
      if (!bytes) stopped = true;
      else texts.set(entry.path, bytes);
    }
  }));
  if (stopped) return null;
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
    // Non-analysis blobs are represented by path; the pinned base tree, not
    // the image, says they exist. Source text is read only for the
    // analyser's known extensions and policy inputs.
    if (!ANALYSIS_TEXT.test(entry.path)) {
      baseFiles.push({ path: entry.path, text: "" });
      continue;
    }
    const bytes = texts.get(entry.path);
    if (!bytes) return null;
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
  }
  if (!baseFiles.some((file) => file.path === "tsconfig.json")) return null;
  return { baseFiles, workflows, policyDocuments,
    exclusionDigest: createHash("sha256").update(JSON.stringify({
      // v2: test helpers the image leaves out are read (gate slice, 2026-10-29).
      format: "engineering-agent-v22-deploy-exclusion-v2",
      dockerIgnoreOid: ignoreEntry.oid,
    })).digest("hex"),
  };
}
