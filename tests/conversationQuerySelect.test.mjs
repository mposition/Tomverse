import assert from "node:assert/strict";
import test from "node:test";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { MAX_SHARE_SNAPSHOT_BYTES } from "../lib/shareSnapshot.ts";

// Why a Conversation read has to name its columns.
//
// The row carries two things no caller wants by accident:
//
//   * `shareSnapshot`, a full serialised copy of a shared conversation, which
//     the share endpoint is allowed to grow to MAX_SHARE_SNAPSHOT_BYTES; and
//   * `password`, the conversation lock hash.
//
// `GET /api/conversations` returned the account's whole list and read it with
// `include`, so both came back for every conversation the account had ever had.
// Neither reached the client -- the snapshot was dropped on the floor and the
// hash was blanked at the response layer with `password: undefined` -- but an
// account with a hundred shared conversations pulled hundreds of megabytes into
// the process to answer a request that sends back a title and a count, and the
// hash sat one edit away from being emitted.
//
// Withholding a column is a property of the query, not of the mapping over its
// result. Every other Conversation read in the repository already worked that
// way; this pins that the one that did not cannot come back, and that a new
// one cannot arrive.

const READ_PATTERN =
  /\b(?:prisma|tx|client|db)\.conversation\.(findUnique|findFirst|findMany|findUniqueOrThrow|findFirstOrThrow)\s*\(\s*\{([\s\S]{0,1500}?)\n(\s*)\}\s*\)/g;

const sourceFiles = () =>
  execSync("git ls-files 'app/**/*.ts' 'app/**/*.tsx' 'lib/*.ts' 'scripts/*.mjs'", {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);

/**
 * The option keys of the call, ignoring anything nested inside them.
 *
 * Matching `select:` anywhere in the body is not enough, and the shape this
 * rule exists for is exactly why: `include: { _count: { select: { ... } } }`
 * contains the word `select` while selecting nothing at the top level. Top-level
 * keys are the ones at the shallowest indentation in the body.
 */
const topLevelKeys = (body) => {
  const lines = body
    .split("\n")
    .filter((line) => /^\s*\w+\s*:/.test(line));
  if (lines.length === 0) return [];
  const indent = Math.min(...lines.map((line) => line.match(/^\s*/)[0].length));
  return lines
    .filter((line) => line.match(/^\s*/)[0].length === indent)
    .map((line) => line.trim().match(/^(\w+)\s*:/)[1]);
};

test("the snapshot a Conversation row can carry is big enough for this to matter", () => {
  // If this ever shrinks to something trivial the rule below is still right,
  // but the reason stated in its comment would no longer be.
  assert.ok(
    MAX_SHARE_SNAPSHOT_BYTES >= 1024 * 1024,
    `a share snapshot is capped at ${MAX_SHARE_SNAPSHOT_BYTES} bytes`
  );
});

test("every Conversation read names the columns it wants", () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(READ_PATTERN)) {
      const keys = topLevelKeys(match[2]);
      if (keys.includes("select")) continue;
      const line = source.slice(0, match.index).split("\n").length;
      offenders.push(
        `${file}:${line} (conversation.${match[1]}, options: ${keys.join(", ") || "none"})`
      );
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "these read every column, including shareSnapshot and password:\n  " +
      offenders.join("\n  ")
  );
});

// The specific route the rule exists for, asserted by name so a rewrite that
// drops the select is not merely caught by the sweep above but pointed at.
test("the conversation list route selects rather than includes", () => {
  const source = readFileSync("app/api/conversations/route.ts", "utf8");
  const listQuery = source.slice(
    source.indexOf("prisma.conversation.findMany"),
    source.indexOf("const runtimeModels")
  );

  assert.ok(listQuery.includes("select:"), "the list query does not name its columns");
  assert.equal(
    listQuery.includes("include:"),
    false,
    "the list query is back to include, which fetches every column"
  );
  assert.equal(
    listQuery.includes("shareSnapshot"),
    false,
    "the list query selects the share snapshot it never returns"
  );
  // The lock hash is still read -- `isLocked` is derived from it -- so the rule
  // is "name it", not "never fetch it". Naming it is what makes the decision
  // reviewable.
  assert.ok(listQuery.includes("password: true"));
  assert.ok(listQuery.includes("_count:"), "the message count is no longer fetched");
});
