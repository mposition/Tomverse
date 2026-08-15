import assert from "node:assert/strict";
import test from "node:test";

import {
  MANIFEST_CONTENT_VERSION,
  buildManifestSourceRefs,
  effectiveRequestHash,
  manifestSourceBytes,
} from "../lib/routingManifestContent.ts";

// The manifest proves what was sent without keeping it. These tests are mostly
// about the second half of that sentence: the policy says not to duplicate the
// prompt, and a digest that a dictionary attack reverses is a duplicate with
// extra steps.

const SECRET = "test-secret-not-a-real-one";

const messages = [
  { role: "system", parts: [{ type: "text", text: "You are Tomverse." }] },
  {
    role: "user",
    parts: [
      { type: "text", text: "이 계약서 요약해 줘" },
      { type: "file", mediaType: "application/pdf", bytes: 1_100_000 },
    ],
  },
];

const request = (overrides = {}) => ({
  modelId: "gpt-5-6-luna",
  provider: "openai",
  maxOutputTokens: 4_000,
  settings: { temperature: 0.7, topP: 1 },
  toolConfig: null,
  sourceRefs: buildManifestSourceRefs(messages, SECRET),
  ...overrides,
});

test("source references carry shape and position, never text", () => {
  const refs = buildManifestSourceRefs(messages, SECRET);
  const serialised = JSON.stringify(refs);

  assert.equal(serialised.includes("You are Tomverse"), false);
  assert.equal(serialised.includes("계약서"), false);
  assert.equal(serialised.includes("요약"), false);

  assert.equal(refs.length, 2);
  assert.equal(refs[1].role, "user");
  assert.equal(refs[1].index, 1);
  assert.equal(refs[1].parts[0].kind, "text");
  assert.equal(refs[1].parts[1].kind, "file");
  assert.equal(refs[1].parts[1].mediaType, "application/pdf");
  assert.equal(refs[1].parts[1].bytes, 1_100_000);
});

// A filename is content: "2026-급여명세서-홍길동.pdf" says who and what before
// the file is opened. The type and the size are the shape the manifest needs.
test("a file's name never reaches the reference, only its type and size", () => {
  const refs = buildManifestSourceRefs(
    [
      {
        role: "user",
        parts: [
          { type: "file", mediaType: "application/pdf", bytes: 900, name: "급여명세서-홍길동.pdf" },
        ],
      },
    ],
    SECRET
  );
  const serialised = JSON.stringify(refs);
  assert.equal(serialised.includes("홍길동"), false);
  assert.equal(serialised.includes("급여명세서"), false);
  assert.equal(serialised.includes(".pdf"), false);
  assert.equal(refs[0].parts[0].mediaType, "application/pdf");
});

// The reason the digest is keyed. A bare SHA-256 of "네" or of a phone number
// is a dictionary away from the plaintext, which would make a leaked manifest
// table a copy of the conversations it describes.
test("digests are keyed, so a leaked table is not a lookup away from the text", () => {
  const refs = buildManifestSourceRefs(messages, SECRET);
  const other = buildManifestSourceRefs(messages, "a-different-secret");

  assert.notEqual(refs[0].parts[0].digest, other[0].parts[0].digest);
  assert.match(refs[0].parts[0].digest, /^[0-9a-f]{64}$/);

  // Same secret, same input: the proof has to be repeatable or it proves
  // nothing about a later copy.
  assert.deepEqual(refs, buildManifestSourceRefs(messages, SECRET));
});

// Per part rather than per message: an unchanged question with a different
// attachment is a different request, and hashing them together hides that.
// Type and size alone collided: two different documents of the same kind and
// length produced one reference, so the manifest could not distinguish a
// resend from a substitution -- the distinction it exists to make.
test("two different files of the same type and size do not share a reference", () => {
  const withOne = buildManifestSourceRefs(
    [{ role: "user", parts: [{ type: "file", mediaType: "application/pdf", bytes: 900, content: "AAAA" }] }],
    SECRET
  );
  const withOther = buildManifestSourceRefs(
    [{ role: "user", parts: [{ type: "file", mediaType: "application/pdf", bytes: 900, content: "BBBB" }] }],
    SECRET
  );
  assert.notEqual(withOne[0].parts[0].digest, withOther[0].parts[0].digest);

  // The same document twice is the same reference, or a resend would look
  // like a different request.
  assert.equal(
    withOne[0].parts[0].digest,
    buildManifestSourceRefs(
      [{ role: "user", parts: [{ type: "file", mediaType: "application/pdf", bytes: 900, content: "AAAA" }] }],
      SECRET
    )[0].parts[0].digest
  );
});

test("the file's own bytes never reach the reference, only their digest", () => {
  const refs = buildManifestSourceRefs(
    [{ role: "user", parts: [{ type: "file", mediaType: "application/pdf", bytes: 9, content: "SECRETBYTES" }] }],
    SECRET
  );
  assert.equal(JSON.stringify(refs).includes("SECRETBYTES"), false);
});

test("a changed attachment is visible even when the text is identical", () => {
  const withPdf = buildManifestSourceRefs(messages, SECRET);
  const withBigger = buildManifestSourceRefs(
    [
      messages[0],
      {
        role: "user",
        parts: [
          { type: "text", text: "이 계약서 요약해 줘" },
          { type: "file", mediaType: "application/pdf", bytes: 2_200_000 },
        ],
      },
    ],
    SECRET
  );

  assert.equal(withPdf[1].parts[0].digest, withBigger[1].parts[0].digest, "the text is unchanged");
  assert.notEqual(withPdf[1].parts[1].digest, withBigger[1].parts[1].digest);
});

test("the effective-request hash carries no part of the request", () => {
  const hash = effectiveRequestHash(request(), SECRET);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash.includes("gpt-5-6-luna"), false);
});

test("the same request hashes the same way twice", () => {
  assert.equal(effectiveRequestHash(request(), SECRET), effectiveRequestHash(request(), SECRET));
});

// Insertion order differs between two objects assembled by different code
// paths. A hash that changed when nothing did would make every comparison
// meaningless.
test("settings assembled in a different order hash the same", () => {
  const forward = effectiveRequestHash(
    request({ settings: { temperature: 0.7, topP: 1 } }),
    SECRET
  );
  const backward = effectiveRequestHash(
    request({ settings: { topP: 1, temperature: 0.7 } }),
    SECRET
  );
  assert.equal(forward, backward);
});

// Everything that decides what the provider receives has to move the hash, or
// the manifest proves less than it claims.
test("anything that changes what the provider receives changes the hash", () => {
  const base = effectiveRequestHash(request(), SECRET);

  for (const [label, overrides] of [
    ["model", { modelId: "deepseek-v4-flash" }],
    ["provider", { provider: "deepseek" }],
    ["output cap", { maxOutputTokens: 8_000 }],
    ["settings", { settings: { temperature: 0.2 } }],
    ["tool config", { toolConfig: { tools: { web_search: {} } } }],
    [
      "messages",
      {
        sourceRefs: buildManifestSourceRefs(
          [...messages, { role: "user", parts: [{ type: "text", text: "and also" }] }],
          SECRET
        ),
      },
    ],
  ]) {
    assert.notEqual(
      effectiveRequestHash(request(overrides), SECRET),
      base,
      `${label} did not change the effective-request hash`
    );
  }
});

test("an absent setting and an explicitly undefined one hash the same", () => {
  assert.equal(
    effectiveRequestHash(request({ settings: { temperature: 0.7, topP: 1 } }), SECRET),
    effectiveRequestHash(
      request({ settings: { temperature: 0.7, topP: 1, seed: undefined } }),
      SECRET
    )
  );
});

test("the version is part of every digest, so a change of scheme is visible", () => {
  assert.match(MANIFEST_CONTENT_VERSION, /-v\d+$/);
});

test("source bytes total the shape that was sent", () => {
  const refs = buildManifestSourceRefs(messages, SECRET);
  const expected =
    Buffer.byteLength("You are Tomverse.", "utf8") +
    Buffer.byteLength("이 계약서 요약해 줘", "utf8") +
    1_100_000;
  assert.equal(manifestSourceBytes(refs), expected);
});

test("an empty request is a valid shape, not an error", () => {
  assert.deepEqual(buildManifestSourceRefs([], SECRET), []);
  assert.equal(manifestSourceBytes([]), 0);
});
