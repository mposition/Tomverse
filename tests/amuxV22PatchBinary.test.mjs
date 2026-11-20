import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { v22PatchBinaryPayloads } from "../lib/amux/v22PatchBinary.ts";
import { encodeV22PatchEvidence } from "../lib/amux/v22PatchEvidence.ts";

// A binary file travels in a patch as base85 text of deflated data, so a
// secret inside it never shows in the patch text. Every check that must see
// what a patch publishes before it is stored reads these bytes
// (docs/policy/engineering-agent.md §11; independent review
// r-20261115-110149-a6ba38).

// Built at run time, so no scanner reads a credential-shaped literal here.
const token = ["gh", "p_", "Q".repeat(36)].join("");

const noise = (seed, length) => {
  const out = Buffer.alloc(length);
  let block = Buffer.alloc(0);
  for (let i = 0; i < length; i++) {
    if (i % 32 === 0) block = createHash("sha256").update(`${seed}:${i}`).digest();
    out[i] = block[i % 32];
  }
  out[0] = 0;
  return out;
};

/** The patch git writes for these checkout changes against `base`. */
const diffOf = (base, next) => {
  const dir = mkdtempSync(join(tmpdir(), "v22-binary-"));
  const git = (...args) => execFileSync("git", ["-c", "core.autocrlf=false",
    "-c", "user.name=t", "-c", "user.email=t@example.invalid",
    "-c", "commit.gpgsign=false", "-C", dir, ...args],
  { maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  try {
    git("init", "-q");
    for (const [path, bytes] of Object.entries(base)) writeFileSync(join(dir, path), bytes);
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    for (const [path, bytes] of Object.entries(next)) writeFileSync(join(dir, path), bytes);
    git("add", "-A");
    return git("diff", "--binary", "--cached", "HEAD").toString("utf8");
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

const image = noise("image", 64 * 1024);

test("a secret in a new binary file is found in its literal bytes", () => {
  const patch = diffOf({ "keep.bin": image }, { "new.bin":
    Buffer.concat([noise("a", 300), Buffer.from(token), noise("b", 300)]) });
  assert.match(patch, /^literal \d+$/m);
  assert.doesNotMatch(patch, new RegExp(token), "the text shows none of it");
  const payloads = v22PatchBinaryPayloads(patch);
  assert.ok(payloads.some((bytes) => bytes.includes(Buffer.from(token))));
  assert.throws(() => encodeV22PatchEvidence(patch), /invalid_patch_evidence/);
});

test("a secret a small edit inserts into a binary file is found in its delta", () => {
  const edited = Buffer.concat([image.subarray(0, 30_000), Buffer.from(token),
    image.subarray(30_000)]);
  const patch = diffOf({ "image.bin": image }, { "image.bin": edited });
  assert.match(patch, /^delta \d+$/m, "git writes the edit as a delta");
  assert.doesNotMatch(patch, new RegExp(token));
  assert.ok(v22PatchBinaryPayloads(patch).some((bytes) =>
    bytes.includes(Buffer.from(token))));
  assert.throws(() => encodeV22PatchEvidence(patch), /invalid_patch_evidence/);
});

test("a clean binary patch is stored, and one that cannot be read is not", () => {
  const clean = diffOf({ "image.bin": image }, { "image.bin":
    Buffer.concat([image, noise("tail", 100)]), "other.bin": noise("other", 500) });
  assert.ok(v22PatchBinaryPayloads(clean).length >= 2);
  assert.ok(encodeV22PatchEvidence(clean).length > 0);
  // A hunk whose stated size is not what it inflates to, or a bad base85 line.
  const broken = clean.replace(/^(literal|delta) (\d+)$/m,
    (_, kind, size) => `${kind} ${Number(size) + 1}`);
  assert.equal(v22PatchBinaryPayloads(broken), null);
  assert.throws(() => encodeV22PatchEvidence(broken), /invalid_patch_evidence/);
  const garbled = clean.replace(/^(GIT binary patch\n(?:literal|delta) \d+\n)./m, "$1~");
  assert.equal(v22PatchBinaryPayloads(garbled), null);
  // A text patch carries no binary section.
  assert.deepEqual(v22PatchBinaryPayloads("diff --git a/a b/a\n"), []);
});
