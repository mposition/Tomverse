/**
 * Tree listing verification: how the app learns what a patch changes without
 * ever applying it.
 *
 * docs/policy/engineering-agent.md §11 is the rule, stated there once: the app
 * never applies or executes a patch. It reads the base tree listing from
 * GitHub itself, takes the result listing the drafting service submits,
 * recomputes the result's tree hash from that listing, checks every new blob
 * against its content, and diffs the two listings. The publisher later applies
 * the patch for real and refuses to push unless its tree hash equals the one
 * decided here -- which is why a drafting service that lies about its listing
 * gains nothing: the lie is either inconsistent (and refused here) or
 * consistent with a tree that is not what the patch produces (and refused by
 * the publisher).
 *
 * Only the runtime is imported: hashing uses `node:crypto`, nothing else.
 * Callers run this in a worker thread they can terminate (policy §11).
 */

import { createHash } from "node:crypto";

import { isCanonicalRepoPath } from "./agentAuthorityFiles.ts";
import { PUSH_LIMITS, type ChangedEntry } from "./agentPushPolicy.ts";

export const TREE_MODES = {
  blob: "100644",
  executable: "100755",
  symlink: "120000",
  gitlink: "160000",
  tree: "040000",
} as const;

export type TreeEntry = {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  oid: string;
};

/** Proposed ceilings on what one verification will look at. */
export const TREE_LIMITS = {
  maxEntries: 20_000,
  maxChangedBlobs: 50,
  maxChangedBlobBytes: 2 * 1024 * 1024,
} as const;

const OID = /^[0-9a-f]{40}$/;

const MODE_TYPE: Readonly<Record<string, TreeEntry["type"]>> = {
  [TREE_MODES.blob]: "blob",
  [TREE_MODES.executable]: "blob",
  [TREE_MODES.symlink]: "blob",
  [TREE_MODES.gitlink]: "commit",
  [TREE_MODES.tree]: "tree",
};

/** The id Git gives an object: SHA-1 over `<type> <length>\0<content>`. */
export const gitObjectId = (type: "blob" | "tree" | "commit", content: Uint8Array) =>
  createHash("sha1")
    .update(`${type} ${content.byteLength}\0`)
    .update(content)
    .digest("hex");

export type ListingProblem =
  | "too_many_entries"
  | "path_not_canonical"
  | "mode_unknown"
  | "mode_type_mismatch"
  | "oid_invalid"
  | "duplicate_path"
  | "parent_missing"
  | "parent_not_tree"
  | "empty_tree"
  | "tree_oid_mismatch";

export type ListingCheck =
  | { ok: true; rootTreeId: string }
  | { ok: false; problems: Array<{ problem: ListingProblem; path: string | null }> };

type Node = { entry: TreeEntry | null; children: Map<string, Node> };

const byteCompare = (a: Uint8Array, b: Uint8Array) => {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
};

const encoder = new TextEncoder();

/**
 * Git orders tree entries by name bytes, comparing a subtree's name as if it
 * ended in `/`.
 */
const sortKey = (name: string, isTree: boolean) => encoder.encode(isTree ? `${name}/` : name);

const hexToBytes = (hex: string) => {
  const bytes = new Uint8Array(20);
  for (let i = 0; i < 20; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
};

const concat = (parts: Uint8Array[]) => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/**
 * Validates a flat recursive listing (blobs, gitlinks and the trees that hold
 * them) and recomputes its root tree id. Every listed tree's id must equal the
 * id its children produce, so a listing cannot claim one subtree and describe
 * another.
 */
export const checkListing = (entries: readonly TreeEntry[]): ListingCheck => {
  const problems: Array<{ problem: ListingProblem; path: string | null }> = [];
  if (entries.length > TREE_LIMITS.maxEntries) {
    return { ok: false, problems: [{ problem: "too_many_entries", path: null }] };
  }

  const byPath = new Map<string, TreeEntry>();
  for (const entry of entries) {
    if (!isCanonicalRepoPath(entry.path)) {
      problems.push({ problem: "path_not_canonical", path: entry.path });
      continue;
    }
    const expectedType = MODE_TYPE[entry.mode];
    if (expectedType === undefined) problems.push({ problem: "mode_unknown", path: entry.path });
    else if (expectedType !== entry.type) {
      problems.push({ problem: "mode_type_mismatch", path: entry.path });
    }
    if (!OID.test(entry.oid)) problems.push({ problem: "oid_invalid", path: entry.path });
    if (byPath.has(entry.path)) problems.push({ problem: "duplicate_path", path: entry.path });
    byPath.set(entry.path, entry);
  }
  if (problems.length > 0) return { ok: false, problems };

  const root: Node = { entry: null, children: new Map() };
  const nodes = new Map<string, Node>([["", root]]);
  const sorted = [...byPath.values()].sort((a, b) => a.path.length - b.path.length);
  for (const entry of sorted) {
    const slash = entry.path.lastIndexOf("/");
    const parentPath = slash === -1 ? "" : entry.path.slice(0, slash);
    const parent = nodes.get(parentPath);
    if (parent === undefined) {
      problems.push({ problem: "parent_missing", path: entry.path });
      continue;
    }
    if (parent.entry !== null && parent.entry.type !== "tree") {
      problems.push({ problem: "parent_not_tree", path: entry.path });
      continue;
    }
    const node: Node = { entry, children: new Map() };
    parent.children.set(entry.path.slice(slash + 1), node);
    if (entry.type === "tree") nodes.set(entry.path, node);
  }
  if (problems.length > 0) return { ok: false, problems };

  const hashTree = (node: Node, path: string | null): string | null => {
    if (node.children.size === 0) {
      problems.push({ problem: "empty_tree", path });
      return null;
    }
    const items = [...node.children.entries()].map(([name, child]) => ({
      name,
      child,
      key: sortKey(name, child.entry?.type === "tree"),
    }));
    items.sort((a, b) => byteCompare(a.key, b.key));
    const parts: Uint8Array[] = [];
    for (const { name, child } of items) {
      const entry = child.entry as TreeEntry;
      let oid = entry.oid;
      if (entry.type === "tree") {
        const computed = hashTree(child, entry.path);
        if (computed === null) return null;
        if (computed !== entry.oid) {
          problems.push({ problem: "tree_oid_mismatch", path: entry.path });
          return null;
        }
        oid = computed;
      }
      // A tree's mode is written without its leading zero inside a tree object.
      const mode = entry.type === "tree" ? "40000" : entry.mode;
      parts.push(encoder.encode(`${mode} ${name}\0`), hexToBytes(oid));
    }
    return gitObjectId("tree", concat(parts));
  };

  const rootTreeId = hashTree(root, null);
  if (rootTreeId === null || problems.length > 0) return { ok: false, problems };
  return { ok: true, rootTreeId };
};

/** v22's bounded sparse transport: compute a result listing from app-read
 * GitHub base entries and complete replacement bytes for existing regular
 * files. This never parses or applies the worker's patch. The Publisher must
 * still apply that patch independently and match this exact root before push. */
export const resultListingFromModifiedBlobs = (input: {
  base: readonly TreeEntry[];
  baseRootTreeId: string;
  files: readonly { path: string; mode: "100644"; bytes: Uint8Array }[];
}): { ok: true; result: TreeEntry[]; rootTreeId: string;
  changedBlobs: ReadonlyMap<string, Uint8Array> } |
  { ok: false; reason: "base_invalid" | "files_invalid" | "result_invalid" } => {
  const checked = checkListing(input.base);
  if (!checked.ok || checked.rootTreeId !== input.baseRootTreeId)
    return { ok: false, reason: "base_invalid" };
  if (input.files.length < 1 || input.files.length > PUSH_LIMITS.maxFiles)
    return { ok: false, reason: "files_invalid" };
  const entries = new Map(input.base.map((entry) => [entry.path, { ...entry }]));
  const seen = new Set<string>();
  const baseBlobIds = new Set(input.base.filter((entry) =>
    entry.type === "blob").map((entry) => entry.oid));
  const changedBlobs = new Map<string, Uint8Array>();
  for (const file of input.files) {
    const old = entries.get(file.path);
    if (!isCanonicalRepoPath(file.path) || seen.has(file.path) ||
        file.mode !== "100644" || old?.type !== "blob" ||
        old.mode !== file.mode || !(file.bytes instanceof Uint8Array) ||
        file.bytes.byteLength > PUSH_LIMITS.maxFileBytes) {
      return { ok: false, reason: "files_invalid" };
    }
    seen.add(file.path);
    const oid = gitObjectId("blob", file.bytes);
    if (oid === old.oid) return { ok: false, reason: "files_invalid" };
    entries.set(file.path, { ...old, oid });
    if (!baseBlobIds.has(oid)) changedBlobs.set(oid, file.bytes);
  }
  const children = new Map<string, TreeEntry[]>();
  for (const entry of entries.values()) {
    const slash = entry.path.lastIndexOf("/");
    const parent = slash < 0 ? "" : entry.path.slice(0, slash);
    const group = children.get(parent) ?? [];
    group.push(entry);
    children.set(parent, group);
  }
  const treeHash = (path: string): string | null => {
    const group = children.get(path);
    if (!group?.length) return null;
    const sorted = group.map((entry) => ({ entry,
      name: entry.path.slice(path ? path.length + 1 : 0),
    })).sort((a, b) => byteCompare(
      sortKey(a.name, a.entry.type === "tree"),
      sortKey(b.name, b.entry.type === "tree")));
    const parts: Uint8Array[] = [];
    for (const { entry, name } of sorted) {
      const oid = entry.type === "tree" ? treeHash(entry.path) : entry.oid;
      if (oid === null) return null;
      if (entry.type === "tree") entries.set(entry.path, { ...entry,
        oid });
      parts.push(encoder.encode(`${entry.type === "tree" ? "40000" :
        entry.mode} ${name}\0`), hexToBytes(oid));
    }
    return gitObjectId("tree", concat(parts));
  };
  const rootTreeId = treeHash("");
  if (rootTreeId === null) return { ok: false, reason: "result_invalid" };
  const result = [...entries.values()];
  const confirmed = checkListing(result);
  return confirmed.ok && confirmed.rootTreeId === rootTreeId ?
    { ok: true, result, rootTreeId, changedBlobs } :
    { ok: false, reason: "result_invalid" };
};

/* ------------------------------------------------------------------------- */
/* .gitattributes                                                             */
/* ------------------------------------------------------------------------- */

/**
 * Compiles one `.gitattributes` pattern, gitignore style: a leading `/` or any
 * inner `/` anchors it to the root; otherwise it matches a basename at any
 * depth. `**` spans directories, `*` and `?` stay within one segment.
 */
export const compileAttributesPattern = (raw: string): RegExp => {
  const anchored = raw.startsWith("/") || raw.slice(0, -1).includes("/");
  const pattern = raw.startsWith("/") ? raw.slice(1) : raw;
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern.startsWith("**/", i)) {
      source += "(?:.*/)?";
      i += 2;
    } else if (pattern.startsWith("/**", i) && i + 3 === pattern.length) {
      source += "/.*";
      i += 2;
    } else if (pattern[i] === "*") source += "[^/]*";
    else if (pattern[i] === "?") source += "[^/]";
    else source += pattern[i].replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(anchored ? `^${source}$` : `(?:^|/)${source}$`);
};

/**
 * The pattern grammar this matcher understands: plain path characters, `*`,
 * `?`, `**` and a leading `/`. Anything else -- a negation, a character class,
 * an attribute macro, an escape or a quoted pattern -- is grammar Git has and
 * this does not, so the whole file is reported unsupported rather than
 * guessed at.
 */
const SUPPORTED_ATTRIBUTE_PATTERN = /^\/?[A-Za-z0-9._\-/*?@+]+$/;

export type AttributesMatcher =
  | { supported: true; matches: (path: string) => boolean }
  | { supported: false };

/**
 * Paths the root `.gitattributes` gives any attribute to. Every attribute
 * counts, not only EOL and filters: an attribute is a way for the checkout to
 * differ from the blob, and the policy sends those paths to T2 rather than
 * reason about which attributes are harmless.
 */
export const attributedPathMatcher = (gitattributes: string): AttributesMatcher => {
  const patterns: RegExp[] = [];
  for (const line of gitattributes.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const [pattern, ...attributes] = trimmed.split(/\s+/);
    if (!SUPPORTED_ATTRIBUTE_PATTERN.test(pattern)) return { supported: false };
    if (attributes.length === 0) continue;
    patterns.push(compileAttributesPattern(pattern));
  }
  return { supported: true, matches: (path) => patterns.some((pattern) => pattern.test(path)) };
};

/* ------------------------------------------------------------------------- */
/* Verification                                                               */
/* ------------------------------------------------------------------------- */

export type UnsupportedReason =
  | "base_listing_truncated"
  | "nested_gitattributes"
  | "gitattributes_applies"
  | "gitattributes_unsupported"
  | "gitlink_changed";

export type VerificationInput = {
  /** Read by the app from GitHub; never taken from the drafting service. */
  base: readonly TreeEntry[];
  baseTruncated: boolean;
  /** The base commit's tree id, read from GitHub with the listing. */
  baseRootTreeId: string;
  /** Submitted by the drafting service. */
  result: readonly TreeEntry[];
  claimedResultRootTreeId: string;
  /** The content of every blob the result has and the base does not, keyed by oid. */
  changedBlobs: ReadonlyMap<string, Uint8Array>;
  /** The base commit's root `.gitattributes`, or null if it has none. */
  baseGitattributes: string | null;
};

export type ChangedPath = {
  path: string;
  status: "added" | "modified" | "deleted";
  oldMode: string | null;
  newMode: string | null;
  oldType: TreeEntry["type"] | null;
  newType: TreeEntry["type"] | null;
  oldOid: string | null;
  newOid: string | null;
};

export type VerificationResult =
  | {
      ok: false;
      reason: "schema_invalid";
      problems: Array<{ problem: string; path: string | null }>;
    }
  | {
      ok: true;
      resultRootTreeId: string;
      changes: ChangedPath[];
      /** Anything here sends the whole patch to T2. */
      unsupported: Array<{ reason: UnsupportedReason; path: string | null }>;
      /** The submitted blobs, each already checked against its id. */
      verifiedBlobs: ReadonlyMap<string, Uint8Array>;
    };

/**
 * The whole check. A result that is inconsistent in itself is
 * `schema_invalid`; a consistent result is diffed against the base, and
 * anything the policy does not support is reported so the tier becomes T2.
 */
export const verifyResultListing = (input: VerificationInput): VerificationResult => {
  const base = checkListing(input.base);
  if (!base.ok) {
    return { ok: false, reason: "schema_invalid", problems: base.problems.map(label("base")) };
  }
  if (base.rootTreeId !== input.baseRootTreeId) {
    return {
      ok: false,
      reason: "schema_invalid",
      problems: [{ problem: "base_root_mismatch", path: null }],
    };
  }
  const result = checkListing(input.result);
  if (!result.ok) {
    return { ok: false, reason: "schema_invalid", problems: result.problems.map(label("result")) };
  }
  if (result.rootTreeId !== input.claimedResultRootTreeId) {
    return {
      ok: false,
      reason: "schema_invalid",
      problems: [{ problem: "result_root_mismatch", path: null }],
    };
  }

  const baseLeaves = leaves(input.base);
  const resultLeaves = leaves(input.result);
  const changes: ChangedPath[] = [];
  for (const [path, next] of resultLeaves) {
    const previous = baseLeaves.get(path);
    if (previous === undefined) changes.push(changed(path, "added", null, next));
    else if (previous.oid !== next.oid || previous.mode !== next.mode) {
      changes.push(changed(path, "modified", previous, next));
    }
  }
  for (const [path, previous] of baseLeaves) {
    if (!resultLeaves.has(path)) changes.push(changed(path, "deleted", previous, null));
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Every blob the result introduces must be submitted, match its id, and be
  // needed; nothing extra rides along. A blob the base already has -- a mode
  // change, a copy, a revert to an earlier line -- is read from GitHub by the
  // app like any other base content, so it is not submitted.
  const problems: Array<{ problem: string; path: string | null }> = [];
  const baseBlobOids = new Set(
    [...baseLeaves.values()].filter((entry) => entry.type === "blob").map((entry) => entry.oid),
  );
  const needed = new Set(
    changes
      .filter(
        (change) =>
          change.newType === "blob" &&
          change.newOid !== null &&
          !baseBlobOids.has(change.newOid),
      )
      .map((change) => change.newOid as string),
  );
  if (needed.size > TREE_LIMITS.maxChangedBlobs) {
    problems.push({ problem: "too_many_changed_blobs", path: null });
  }
  for (const oid of needed) {
    const content = input.changedBlobs.get(oid);
    if (content === undefined) problems.push({ problem: "blob_missing", path: oid });
    else if (content.byteLength > TREE_LIMITS.maxChangedBlobBytes) {
      problems.push({ problem: "blob_too_large", path: oid });
    } else if (gitObjectId("blob", content) !== oid) {
      problems.push({ problem: "blob_oid_mismatch", path: oid });
    }
  }
  for (const oid of input.changedBlobs.keys()) {
    if (!needed.has(oid)) problems.push({ problem: "blob_unexpected", path: oid });
  }
  if (problems.length > 0) return { ok: false, reason: "schema_invalid", problems };

  const unsupported = unsupportedTreeChanges({
    baseTruncated: input.baseTruncated,
    basePaths: baseLeaves.keys(),
    resultPaths: resultLeaves.keys(),
    baseGitattributes: input.baseGitattributes,
    changes,
  });

  const verifiedBlobs = new Map([...needed].map((oid) => [oid, input.changedBlobs.get(oid) as Uint8Array]));
  return {
    ok: true,
    resultRootTreeId: result.rootTreeId,
    changes,
    unsupported,
    verifiedBlobs,
  };
};

/**
 * What the policy does not support in a consistent pair of trees; anything
 * here sends the whole patch to T2. The app's verification and the tier report
 * over real commits both call this, so the two cannot disagree.
 */
export const unsupportedTreeChanges = (input: {
  baseTruncated: boolean;
  basePaths: Iterable<string>;
  resultPaths: Iterable<string>;
  baseGitattributes: string | null;
  changes: ReadonlyArray<Pick<ChangedPath, "path" | "oldType" | "newType">>;
}): Array<{ reason: UnsupportedReason; path: string | null }> => {
  const unsupported: Array<{ reason: UnsupportedReason; path: string | null }> = [];
  if (input.baseTruncated) unsupported.push({ reason: "base_listing_truncated", path: null });
  for (const paths of [input.basePaths, input.resultPaths]) {
    for (const path of paths) {
      if (path.endsWith("/.gitattributes")) {
        unsupported.push({ reason: "nested_gitattributes", path });
      }
    }
  }
  const attributes = attributedPathMatcher(input.baseGitattributes ?? "");
  if (!attributes.supported) unsupported.push({ reason: "gitattributes_unsupported", path: null });
  for (const change of input.changes) {
    if (attributes.supported && attributes.matches(change.path)) {
      unsupported.push({ reason: "gitattributes_applies", path: change.path });
    }
    if (change.oldType === "commit" || change.newType === "commit") {
      unsupported.push({ reason: "gitlink_changed", path: change.path });
    }
  }
  return unsupported;
};

const label =
  (side: "base" | "result") =>
  ({ problem, path }: { problem: string; path: string | null }) => ({
    problem: `${side}_${problem}`,
    path,
  });

const leaves = (entries: readonly TreeEntry[]) =>
  new Map(entries.filter((entry) => entry.type !== "tree").map((entry) => [entry.path, entry]));

const changed = (
  path: string,
  status: ChangedPath["status"],
  previous: TreeEntry | null,
  next: TreeEntry | null,
): ChangedPath => ({
  path,
  status,
  oldMode: previous?.mode ?? null,
  newMode: next?.mode ?? null,
  oldType: previous?.type ?? null,
  newType: next?.type ?? null,
  oldOid: previous?.oid ?? null,
  newOid: next?.oid ?? null,
});

/* ------------------------------------------------------------------------- */
/* From verified changes to the push policy's input                           */
/* ------------------------------------------------------------------------- */

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Text the policy can read: valid UTF-8 with no NUL. */
export const decodeText = (content: Uint8Array): string | null => {
  if (content.includes(0)) return null;
  try {
    return utf8.decode(content);
  } catch {
    return null;
  }
};

const splitLines = (text: string) => {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/**
 * Lines added and removed between two texts, by Myers' shortest edit script,
 * computed only up to `maxEdits`. The count is exact within that bound, so the
 * size limit cannot be dodged by a diff that looks smaller than it is. Past the
 * bound the answer is simply "exceeded" -- the change is T2 by size whatever
 * the exact number, and memory stays proportional to the bound rather than to
 * the files, so a 200 KB file of unrelated lines costs nothing unbounded.
 */
export const diffLines = (
  before: string,
  after: string,
  maxEdits: number = Number.POSITIVE_INFINITY,
):
  | { exceeded: false; addedLines: number; removedLines: number; addedText: string }
  | { exceeded: true } => {
  const a = splitLines(before);
  const b = splitLines(after);
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, maxEdits);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= limit && !found; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  if (!found) return { exceeded: true };

  // Walk the trace back to collect the added lines.
  const added: string[] = [];
  let removed = 0;
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d -= 1) {
    const previous = trace[d];
    const k = x - y;
    const prevK =
      k === -d || (k !== d && previous[offset + k - 1] < previous[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = previous[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
    }
    if (x === prevX) {
      y -= 1;
      added.push(b[y]);
    } else {
      x -= 1;
      removed += 1;
    }
  }
  added.reverse();
  return {
    exceeded: false,
    addedLines: added.length,
    removedLines: removed,
    addedText: added.join("\n"),
  };
};

export type PolicyChangesResult =
  | { ok: true; entries: ChangedEntry[] }
  | { ok: false; problems: Array<{ problem: "blob_missing" | "blob_content_mismatch"; oid: string }> };

/**
 * Builds the push policy's input from a verification that succeeded. Content
 * comes from two places only: the blobs the verification already checked, and
 * base blobs the app read from GitHub by id. Every piece used here is hashed
 * again against the id the change names, so the text the tier is decided on is
 * the text of the tree that will be published -- a map that pairs an id with
 * other content is refused, not believed.
 *
 * A path that is not text is reported as such (the policy sends it to T2) with
 * zero lines rather than a guess; a diff past the size limit is reported just
 * over the limit, which is T2 whatever the exact number.
 */
export const toPolicyChanges = (
  verification: Extract<VerificationResult, { ok: true }>,
  baseBlobs: ReadonlyMap<string, Uint8Array>,
): PolicyChangesResult => {
  const problems: Array<{ problem: "blob_missing" | "blob_content_mismatch"; oid: string }> = [];
  const contentOf = (oid: string | null, type: TreeEntry["type"] | null) => {
    if (oid === null) return new Uint8Array();
    // A gitlink names a commit in another repository; there is no content.
    if (type === "commit") return null;
    const content = verification.verifiedBlobs.get(oid) ?? baseBlobs.get(oid);
    if (content === undefined) {
      problems.push({ problem: "blob_missing", oid });
      return null;
    }
    if (gitObjectId("blob", content) !== oid) {
      problems.push({ problem: "blob_content_mismatch", oid });
      return null;
    }
    return content;
  };

  const entries = verification.changes.map((change): ChangedEntry => {
    const before = contentOf(change.oldOid, change.oldType);
    const after = contentOf(change.newOid, change.newType);
    const beforeText = before === null ? null : decodeText(before);
    const afterText = after === null ? null : decodeText(after);
    const isText =
      change.status === "deleted"
        ? beforeText !== null
        : afterText !== null && (change.status === "added" || beforeText !== null);
    const diff =
      beforeText !== null && afterText !== null
        ? diffLines(beforeText, afterText, PUSH_LIMITS.maxChangedLines + 1)
        : null;
    const lines =
      diff === null
        ? { addedLines: 0, removedLines: 0, addedText: "" }
        : diff.exceeded
          ? { addedLines: PUSH_LIMITS.maxChangedLines + 1, removedLines: 0, addedText: "" }
          : diff;
    return {
      path: change.path,
      status: change.status,
      oldMode: change.oldMode,
      newMode: change.newMode,
      newType: change.newType,
      sizeBytes: after?.byteLength ?? 0,
      isText,
      addedLines: lines.addedLines,
      removedLines: lines.removedLines,
      addedText: lines.addedText,
      newText: change.status === "deleted" ? "" : (afterText ?? ""),
    };
  });

  return problems.length > 0 ? { ok: false, problems } : { ok: true, entries };
};
