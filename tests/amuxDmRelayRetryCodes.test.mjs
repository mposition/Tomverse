/**
 * The DM relay keeps a write owed on a refusal that recorded nothing and sends
 * it again (apps/tomverse-orchestrator/src/dm_relay/owed.rs, refused_for_now).
 * Every 503 code the app's Decision Maker routes answer with is such a
 * refusal; a code the relay did not know would settle the record and lose it
 * (review r-20261116-195913-289714: dm_settings_unreadable, dm_state_unreadable).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");
const owed = readFileSync(join(root, "apps/tomverse-orchestrator/src/dm_relay/owed.rs"), "utf8");
const body = owed.slice(owed.indexOf("pub fn refused_for_now"));
const listed = new Set([...body.slice(0, body.indexOf("\n}\n")).matchAll(/"([a-z_]+)"/g)]
  .map((match) => match[1]));

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

test("every 503 code of the Decision Maker routes keeps the relay's write owed", () => {
  const files = [
    ...sources(join(root, "app/api/internal/amux/decision-maker")),
    ...readdirSync(join(root, "lib/amux")).filter((name) => /^decisionMaker.*\.ts$/.test(name))
      .map((name) => join(root, "lib/amux", name)),
  ];
  const codes = new Set(files.flatMap((file) => {
    const text = readFileSync(file, "utf8");
    return [
      // A literal answer: refused(503, "code").
      ...[...text.matchAll(/refused\(\s*503\s*,\s*"([a-z_]+)"\s*\)/g)].map((match) => match[1]),
      // A returned refusal mapped to 503 (dmReturnedRefusalStatus): every code
      // compared on a line that returns 503 (review r-20261116-200908-ddabe2).
      ...text.split("\n").filter((line) => /return 503\b/.test(line))
        .flatMap((line) => [...line.matchAll(/===\s*"([a-z_]+)"/g)].map((match) => match[1])),
    ];
  }));
  assert.ok(codes.has("digest_key_unavailable"), "the returned-refusal mapping is read");
  assert.ok(codes.size >= 4, `found ${[...codes].join(", ")}`);
  for (const code of codes) assert.ok(listed.has(code), `${code} is not kept owed by the relay`);
});
