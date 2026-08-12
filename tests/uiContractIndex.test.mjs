import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

/**
 * Every UI contract is reachable from the always-loaded instructions.
 *
 * `scripts/check-doc-references.mjs` asks whether a path a document names
 * exists. This asks the opposite question, and it is the one that actually
 * failed: `docs/ui-contracts/` gained `admin-console-ia.md` — seventeen admin
 * routes and a redirect table whose breach the contract itself calls a release
 * blocker — while AGENTS.md, the file every agent and every new reader starts
 * from, said nothing about it. Seven of the eight contracts were indexed
 * there; the newest was not, and nothing noticed, because a contract nobody
 * references breaks no link.
 *
 * Being written down is not the same as being findable. A contract only
 * governs the change that reads it first, so "is it indexed" is a different
 * question from "does it exist" and needs its own answer.
 *
 * What this deliberately does not check is the shape or the prose. Most
 * contracts get their own `<!-- BEGIN:…-invariant -->` section, but
 * `account-model-settings.md` is pointed to from inside the default-model
 * policy section instead, and that is a reasonable place for it. Asserting a
 * uniform shape would be inventing a rule the repository does not follow and
 * forcing a rewrite to satisfy a test. Reachability is the invariant;
 * everything past it is review judgement.
 */

const CONTRACT_DIR = new URL("../docs/ui-contracts/", import.meta.url);
const AGENTS = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");

const contracts = readdirSync(CONTRACT_DIR)
    .filter((name) => name.endsWith(".md"))
    .map((name) => `docs/ui-contracts/${name}`);

test("there is at least one UI contract to index", () => {
    // Otherwise an empty directory would make every assertion below vacuous.
    assert.ok(contracts.length > 0, "no UI contracts were found");
});

test("AGENTS.md names every UI contract", () => {
    const missing = contracts.filter((path) => !AGENTS.includes(path));
    assert.deepEqual(
        missing,
        [],
        `AGENTS.md never names ${missing.join(", ")}. A contract nobody is ` +
            `sent to is one nobody reads before the change it governs.`
    );
});
