import assert from "node:assert/strict";
import test from "node:test";
import { dailyImplementationLookup, implementationCoversTask, taskImplementation } from "../lib/dailyProductImplementationCore.ts";
const pull = (number, task, extra = {}) => ({ number, html_url: `https://github.com/mposition/Tomverse/pull/${number}`,
  base: { ref: "develop", repo: { full_name: "mposition/Tomverse" } }, head: { repo: { full_name: "mposition/Tomverse" } },
  state: "open", merged_at: null, body: `Recovery\n\nGoal-Step: daily-product-improvements/${task}\n`, ...extra });
test("exact task markers connect recovery PRs without rewriting the original result or claiming deployment", () => {
  const lookup = dailyImplementationLookup([pull(4041, "cycle:4", { state: "closed", merged_at: "2026-11-16T01:00:00Z" }), pull(4057, "scout.one")]);
  assert.deepEqual(taskImplementation(lookup, "cycle:4"), { prUrl: "https://github.com/mposition/Tomverse/pull/4041", state: "merged" });
  assert.equal(implementationCoversTask(taskImplementation(lookup, "cycle:4")), true);
  assert.equal(taskImplementation(lookup, "scout.one").state, "open");
  assert.equal(taskImplementation(lookup, "other", "https://github.com/mposition/Tomverse/pull/4041").state, "merged");
  assert.equal(taskImplementation(lookup, "missing"), undefined);
});
test("forks, other bases, forged links and partial or malformed task markers cannot suppress work", () => {
  const values = [pull(1, "cycle:4", { head: { repo: { full_name: "attacker/fork" } } }),
    pull(2, "cycle:4", { base: { ref: "main" } }), pull(3, "cycle:4", { html_url: "https://attacker.test" }),
    pull(4, "cycle:4", { body: "prefix Goal-Step: daily-product-improvements/cycle:4" }),
    pull(5, "cycle:4", { body: "Goal-Step: daily-product-improvements/cycle:4 extra" }), pull(6, "../../bad"), null];
  assert.deepEqual(dailyImplementationLookup(values).byTask, {});
});
test("closed attempts do not hide useful prior work, and closed without merge is not coverage", () => {
  const lookup = dailyImplementationLookup([pull(3, "cycle:0", { state: "closed" }), pull(1, "cycle:0"),
    pull(2, "scout.one", { state: "closed", merged_at: "2026-11-16T00:00:00Z" }), pull(4, "scout.one"),
    pull(5, "scout.closed", { state: "closed", body: "Goal-Step: daily-product-improvements/scout.closed completes\r\n" })]);
  assert.equal(taskImplementation(lookup, "cycle:0").state, "open");
  assert.deepEqual(taskImplementation(lookup, "scout.one"), { prUrl: "https://github.com/mposition/Tomverse/pull/4", state: "open" });
  assert.equal(implementationCoversTask(taskImplementation(lookup, "scout.closed")), false);
});

test("a newer recovery PR supersedes an older merged partial implementation of the same task", () => {
  const lookup = dailyImplementationLookup([pull(4029, "cycle:5", { state: "closed", merged_at: "2026-11-16T00:00:00Z" }), pull(4057, "cycle:5")]);
  assert.deepEqual(taskImplementation(lookup, "cycle:5"), { prUrl: "https://github.com/mposition/Tomverse/pull/4057", state: "open" });
});
