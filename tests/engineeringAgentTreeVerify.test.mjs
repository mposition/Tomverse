import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  attributedPathMatcher,
  checkListing,
  diffLines,
  gitObjectId,
  toPolicyChanges,
  verifyResultListing,
} from "../lib/engineeringAgentTreeVerify.ts";

const bytes = (text) => new TextEncoder().encode(text);

/**
 * A throwaway repository driven through the index, so modes Git would refuse
 * to create on this filesystem (symlinks, gitlinks, executable bits on
 * Windows) are still exercised against Git's own hashing.
 */
const withRepo = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "engineering-agent-tree-"));
  const git = (args, input) =>
    execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
      cwd: dir,
      input,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir },
    });
  try {
    git(["init", "-q"]);
    return fn({
      git,
      put: (path, content, mode = "100644") => {
        const oid = git(["hash-object", "-w", "--stdin"], content).trim();
        git(["update-index", "--add", "--cacheinfo", `${mode},${oid},${path}`]);
        return oid;
      },
      remove: (path) => git(["update-index", "--force-remove", path]),
      gitlink: (path, oid) =>
        git(["update-index", "--add", "--cacheinfo", `160000,${oid},${path}`]),
      snapshot: () => {
        const root = git(["write-tree"]).trim();
        const listing = git(["ls-tree", "-r", "-t", "-z", "--full-tree", root])
          .split("\0")
          .filter(Boolean)
          .map((line) => {
            const [meta, path] = line.split("\t");
            const [mode, type, oid] = meta.split(" ");
            return { path, mode, type, oid };
          });
        return { root, listing };
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("object ids match Git's", () => {
  withRepo(({ git }) => {
    for (const text of ["", "hello\n", "é\u0000binary"]) {
      assert.equal(gitObjectId("blob", bytes(text)), git(["hash-object", "--stdin"], text).trim());
    }
  });
});

test("the recomputed root tree id equals Git's, across modes, depth and ordering", () => {
  withRepo(({ put, gitlink, snapshot }) => {
    put("a.ts", "export const a = 1;\n");
    put("a-b.ts", "x\n");
    put("a/b.ts", "nested\n");
    put("a/b/c/d.md", "deep\n");
    put("a.b/x.ts", "dot dir\n");
    put("bin/run.sh", "#!/bin/sh\n", "100755");
    put("link", "a.ts", "120000");
    put("é/ü.ts", "unicode\n");
    gitlink("vendor/sub", "1".repeat(40));
    const { root, listing } = snapshot();
    assert.deepEqual(checkListing(listing), { ok: true, rootTreeId: root });
  });
});

test("a listing that is inconsistent in itself is refused", () => {
  withRepo(({ put, snapshot }) => {
    put("lib/a.ts", "a\n");
    put("lib/b.ts", "b\n");
    const { listing } = snapshot();

    const lyingTree = listing.map((entry) =>
      entry.type === "tree" ? { ...entry, oid: "f".repeat(40) } : entry,
    );
    assert.equal(checkListing(lyingTree).ok, false);

    const orphan = listing.filter((entry) => entry.type !== "tree");
    assert.deepEqual(
      checkListing(orphan).problems.map((p) => p.problem),
      ["parent_missing", "parent_missing"],
    );

    const cases = [
      [...listing, listing[listing.length - 1]],
      listing.map((e) => (e.type === "blob" ? { ...e, mode: "100664" } : e)),
      listing.map((e) => (e.type === "blob" ? { ...e, type: "commit" } : e)),
      listing.map((e) => (e.type === "blob" ? { ...e, oid: "XYZ" } : e)),
      listing.map((e) => (e.type === "blob" ? { ...e, path: `../${e.path}` } : e)),
      [...listing, { path: "lib/a.ts/inner.ts", mode: "100644", type: "blob", oid: "1".repeat(40) }],
      [{ path: "empty", mode: "040000", type: "tree", oid: gitObjectId("tree", new Uint8Array()) }],
    ];
    for (const entries of cases) assert.equal(checkListing(entries).ok, false);
  });
});

/** Builds a base and a result in one repository and the verification input for them. */
const scenario = (build) =>
  withRepo((repo) => {
    build.base(repo);
    const base = repo.snapshot();
    const blobs = new Map();
    build.result({
      ...repo,
      put: (path, content, mode) => {
        const oid = repo.put(path, content, mode);
        blobs.set(oid, bytes(content));
        return oid;
      },
    });
    const result = repo.snapshot();
    const baseOids = new Set(base.listing.map((entry) => entry.oid));
    const changedBlobs = new Map([...blobs].filter(([oid]) => !baseOids.has(oid)));
    return {
      input: {
        base: base.listing,
        baseTruncated: false,
        baseRootTreeId: base.root,
        result: result.listing,
        claimedResultRootTreeId: result.root,
        changedBlobs,
        baseGitattributes: build.gitattributes ?? null,
      },
      base,
      result,
      changedBlobs,
    };
  });

test("an honest result verifies and yields exactly its changed paths, modes included", () => {
  const { input } = scenario({
    base: ({ put }) => {
      put("lib/a.ts", "a\n");
      put("lib/b.ts", "b\n");
      put("lib/c.sh", "c\n");
    },
    result: ({ put, remove }) => {
      put("lib/a.ts", "a2\n");
      remove("lib/b.ts");
      put("lib/new.ts", "n\n");
      put("lib/c.sh", "c\n", "100755");
    },
  });
  const verdict = verifyResultListing(input);
  assert.equal(verdict.ok, true);
  assert.deepEqual(
    verdict.changes.map((c) => [c.path, c.status, c.oldMode, c.newMode]),
    [
      ["lib/a.ts", "modified", "100644", "100644"],
      ["lib/b.ts", "deleted", "100644", null],
      ["lib/c.sh", "modified", "100644", "100755"],
      ["lib/new.ts", "added", null, "100644"],
    ],
  );
  assert.deepEqual(verdict.unsupported, []);
});

test("a result that claims another root, omits a blob, forges a blob or smuggles one is schema_invalid", () => {
  const { input } = scenario({
    base: ({ put }) => put("lib/a.ts", "a\n"),
    result: ({ put }) => put("lib/a.ts", "a2\n"),
  });
  const [[oid, content]] = [...input.changedBlobs];

  const reasons = (overrides) => {
    const verdict = verifyResultListing({ ...input, ...overrides });
    return verdict.ok ? [] : verdict.problems.map((p) => p.problem);
  };
  assert.deepEqual(reasons({ claimedResultRootTreeId: "0".repeat(40) }), ["result_root_mismatch"]);
  assert.deepEqual(reasons({ baseRootTreeId: "0".repeat(40) }), ["base_root_mismatch"]);
  assert.deepEqual(reasons({ changedBlobs: new Map() }), ["blob_missing"]);
  assert.deepEqual(reasons({ changedBlobs: new Map([[oid, bytes("something else\n")]]) }), [
    "blob_oid_mismatch",
  ]);
  assert.deepEqual(
    reasons({ changedBlobs: new Map([[oid, content], ["9".repeat(40), bytes("x")]]) }),
    ["blob_unexpected"],
  );
});

test("a listing whose hash is self-consistent but whose content differs from the patch cannot change what is judged", () => {
  // The drafting service can build any consistent listing; what it cannot do is
  // make the publisher's real application produce it. Here the lie is simply a
  // different consistent tree -- verification accepts it as that tree, and the
  // changed-path set it yields is that tree's, so the judgement and the
  // publisher's hash comparison both see the same thing.
  const honest = scenario({
    base: ({ put }) => put("lib/a.ts", "a\n"),
    result: ({ put }) => put("lib/a.ts", "a2\n"),
  });
  const lying = scenario({
    base: ({ put }) => put("lib/a.ts", "a\n"),
    result: ({ put }) => put("lib/a.ts", "harmless\n"),
  });
  const honestVerdict = verifyResultListing(honest.input);
  const lyingVerdict = verifyResultListing(lying.input);
  assert.equal(lyingVerdict.ok, true);
  assert.notEqual(lyingVerdict.resultRootTreeId, honestVerdict.resultRootTreeId);
});

test("unsupported shapes are reported so the tier becomes T2", () => {
  const truncated = scenario({
    base: ({ put }) => put("lib/a.ts", "a\n"),
    result: ({ put }) => put("lib/a.ts", "b\n"),
  });
  const verdict = verifyResultListing({ ...truncated.input, baseTruncated: true });
  assert.deepEqual(verdict.unsupported, [{ reason: "base_listing_truncated", path: null }]);

  const nested = scenario({
    base: ({ put }) => put("lib/a.ts", "a\n"),
    result: ({ put }) => put("lib/.gitattributes", "*.ts text\n"),
  });
  assert.ok(
    verifyResultListing(nested.input).unsupported.some((u) => u.reason === "nested_gitattributes"),
  );

  const attributed = scenario({
    base: ({ put }) => put("tests/fixtures/providerModelDocs/a.md", "a\n"),
    result: ({ put }) => put("tests/fixtures/providerModelDocs/a.md", "b\n"),
    gitattributes: "tests/fixtures/providerModelDocs/*.md text eol=lf\n",
  });
  assert.ok(
    verifyResultListing(attributed.input).unsupported.some(
      (u) => u.reason === "gitattributes_applies",
    ),
  );

  const gitlinkChange = scenario({
    base: ({ put }) => put("lib/a.ts", "a\n"),
    result: ({ gitlink }) => gitlink("lib/sub", "2".repeat(40)),
  });
  assert.ok(
    verifyResultListing(gitlinkChange.input).unsupported.some((u) => u.reason === "gitlink_changed"),
  );
});

test("gitattributes patterns follow Git's anchoring rules", () => {
  const real = attributedPathMatcher(
    [
      "# comment",
      "docs/ops/ai-review-evaluation-records/** text eol=lf",
      "/package.json text eol=lf",
      "*.bin binary",
      "no-attributes-here",
    ].join("\n"),
  );
  assert.equal(real("docs/ops/ai-review-evaluation-records/a/b.json"), true);
  assert.equal(real("package.json"), true);
  assert.equal(real("lib/package.json"), false);
  assert.equal(real("deep/dir/x.bin"), true);
  assert.equal(real("no-attributes-here"), false);
  assert.equal(real("lib/chatInput.ts"), false);
});

test("the repository's own .gitattributes leaves ordinary product files alone", async () => {
  const { readFileSync } = await import("node:fs");
  const matcher = attributedPathMatcher(
    readFileSync(new URL("../.gitattributes", import.meta.url), "utf8"),
  );
  assert.equal(matcher("lib/chatInput.ts"), false);
  assert.equal(matcher("components/chat/ChatInput.tsx"), false);
  assert.equal(matcher("lib/promptRefinerSuggestion.ts"), true);
  assert.equal(matcher("tests/fixtures/providerModelDocs/openai.md"), true);
});

/* Line counting -------------------------------------------------------- */

const lcsCounts = (before, after) => {
  const split = (t) => (t === "" ? [] : t.split("\n").filter((_, i, all) => i < all.length - 1 || all[i] !== ""));
  const a = split(before);
  const b = split(after);
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return { addedLines: b.length - dp[0][0], removedLines: a.length - dp[0][0] };
};

test("line counts equal the minimal edit, on fixed and random inputs", () => {
  const fixed = [
    ["", ""],
    ["", "a\nb\n"],
    ["a\nb\n", ""],
    ["a\nb\nc\n", "a\nx\nc\n"],
    ["a\na\na\n", "a\n"],
    ["x\ny\n", "y\nx\n"],
  ];
  for (const [before, after] of fixed) {
    const { addedLines, removedLines } = diffLines(before, after);
    assert.deepEqual({ addedLines, removedLines }, lcsCounts(before, after), JSON.stringify([before, after]));
  }
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let round = 0; round < 200; round += 1) {
    const make = () =>
      Array.from({ length: 1 + Math.floor(random() * 12) }, () => "abc"[Math.floor(random() * 3)]).join("\n") +
      "\n";
    const before = make();
    const after = make();
    const { addedLines, removedLines, addedText } = diffLines(before, after);
    assert.deepEqual({ addedLines, removedLines }, lcsCounts(before, after), JSON.stringify([before, after]));
    assert.equal(addedText === "" ? 0 : addedText.split("\n").length, addedLines);
  }
});

test("added text is exactly the added lines, for the content rules to read", () => {
  assert.equal(
    diffLines("keep\nold\n", "keep\nconst m = await import(name);\n").addedText,
    "const m = await import(name);",
  );
});

test("verified changes become the push policy's input, with non-text marked", () => {
  const changes = [
    { path: "lib/a.ts", status: "modified", oldMode: "100644", newMode: "100644", oldType: "blob", newType: "blob", oldOid: "1".repeat(40), newOid: "2".repeat(40) },
    { path: "lib/img.ts", status: "added", oldMode: null, newMode: "100644", oldType: null, newType: "blob", oldOid: null, newOid: "3".repeat(40) },
  ];
  const baseBlobs = new Map([["1".repeat(40), bytes("a\nb\n")]]);
  const newBlobs = new Map([
    ["2".repeat(40), bytes("a\nc\n")],
    ["3".repeat(40), new Uint8Array([0x89, 0x50, 0x00, 0x47])],
  ]);
  const [modified, binary] = toPolicyChanges(changes, baseBlobs, newBlobs);
  assert.equal(modified.isText, true);
  assert.equal(modified.addedLines, 1);
  assert.equal(modified.removedLines, 1);
  assert.equal(modified.addedText, "c");
  assert.equal(binary.isText, false);
  assert.equal(binary.sizeBytes, 4);
});
