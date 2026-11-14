import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL = "postgresql://e2e:e2e@127.0.0.1:1/e2e";
const root = resolve(import.meta.dirname, "../..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const require = createRequire(import.meta.url);
let enabled = true, unlocked = true, deleted = false, revokeOnHistory = false;
const queries: Array<{ table: string; args: unknown }> = [];
const rows = [
    { role: "user", ordinal: 0, content: "Selected past budget AUD100.", truncated: false },
    { role: "user", ordinal: 250, content: "Recent correction budget AUD70.", truncated: false },
];
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
    conversationContinuationBridge: { findFirst: async (args: unknown) => {
        queries.push({ table: "bridge", args });
        return { externalConversationId: "source", provider: "chatgpt", sourceImportedAt: null };
    } },
    externalConversation: { findFirst: async (args: unknown) => {
        queries.push({ table: "source", args });
        return deleted ? null : { id: "source", messageCount: 251, password: "locked-hash" };
    } },
    externalMessage: { findMany: async (args: { where?: { ordinal?: { in: number[] }; OR?: unknown[] } }) => {
        queries.push({ table: "message", args });
        if (args.where?.OR) {
            if (revokeOnHistory) unlocked = false;
            return rows.slice(0, 1);
        }
        return args.where?.ordinal ? rows.filter(row => args.where!.ordinal!.in.includes(row.ordinal)) : rows.slice(1);
    } },
} } });
const settings = require(resolve(root, "lib/appSettings.ts"));
mock.module(mod("lib/appSettings.ts"), { namedExports: { ...settings, isExternalContinuationEnabled: async () => enabled } });
const locks = require(resolve(root, "lib/conversationLock.ts"));
mock.module(mod("lib/conversationLock.ts"), { namedExports: { ...locks, hasResourceUnlockGrant: () => unlocked } });
const load = async (header?: string, prepared?: import("../../lib/externalContinuationService").ContinuationTurnSeed) => {
    const { loadContinuationTurnSeed } = await import(mod("lib/externalContinuationService.ts"));
    return loadContinuationTurnSeed({ userId: "owner", conversationId: "chat", prepared,
    request: new Request("http://localhost/chat", { headers: header === undefined ? {} : { "x-tomverse-source-passages": header } }) });
};

test("the real loader reads selected coordinates and recent rows only under owned finalized source access", async () => {
    queries.length = 0;
    const result = await load("0:0:27");
    assert.equal(result.outcome, "seeded");
    assert.match(result.seed.prompt.transcriptText, /AUD100/);
    assert.match(result.seed.prompt.transcriptText, /AUD70/);
    const bridge = queries.find(query => query.table === "bridge")!.args as { where: unknown };
    assert.deepEqual(bridge.where, { conversationId: "chat", userId: "owner" });
    const source = queries.find(query => query.table === "source")!.args as { where: unknown };
    assert.deepEqual(source.where, { id: "source", userId: "owner", finalized: true });
    assert.equal(result.seed.plan.turns.length, 2);
});

test("source deletion, locking and uncached flag off prevent all source-text reads", async () => {
    for (const outcome of ["source_deleted", "locked", "flag_off_stale_cache"]) {
        deleted = outcome === "source_deleted"; unlocked = outcome !== "locked"; enabled = outcome !== "flag_off_stale_cache";
        queries.length = 0;
        const result = await load("0:0:27");
        assert.equal(result.seed, null);
        assert.equal(result.outcome, outcome);
        assert.equal(queries.filter(query => query.table === "message").length, 0);
    }
    deleted = false; unlocked = true; enabled = true;
});

test("empty, invalid and stale selection stay empty while an absent header retains automatic v2", async () => {
    for (const header of ["", "invalid", "0:0:500", "9:0:1"]) {
        const result = await load(header);
        assert.equal(result.seed, null);
        assert.equal(result.outcome, "empty_selection");
    }
    const automatic = await load();
    assert.equal(automatic.seed.plan.seedVersion, "ext-seed-v2");
    assert.match(automatic.seed.prompt.transcriptText, /AUD70/);
});

test("prepared source text is reused without another scan only after current access gates pass", async () => {
    const first = await load("0:0:27");
    queries.length = 0;
    const checked = await load("0:0:27", first.seed);
    assert.equal(checked.seed, first.seed);
    assert.equal(queries.filter(query => query.table === "message").length, 0);
    for (const reason of ["locked", "source_deleted", "flag_off_stale_cache"]) {
        unlocked = reason !== "locked"; deleted = reason === "source_deleted"; enabled = reason !== "flag_off_stale_cache";
        assert.equal((await load("0:0:27", first.seed)).seed, null);
    }
    enabled = true; unlocked = true; deleted = false;
});


test("history lookup searches owned full ordinals, composes recent text, and rechecks after the database read", async () => {
    const { searchContinuationHistory } = await import(mod("lib/externalContinuationService.ts"));
    const prepared = (await load()).seed;
    const request = new Request("http://localhost/chat");
    queries.length = 0;
    const input = { userId: "owner", conversationId: "chat", request, prepared, queries: ["AUD100"], enabled: () => true };
    const result = await searchContinuationHistory(input);
    assert.match(result.seed.prompt.transcriptText, /AUD100/);
    assert.match(result.seed.prompt.transcriptText, /AUD70/);
    assert.equal(result.seed.plan.historyOutcome, "matched");
    type Lookup = { where: { OR?: unknown[]; userId: string; externalConversationId: string; ordinal?: unknown; role: unknown }; take: number };
    const lookup = queries.find(q => q.table === "message" && (q.args as Lookup).where?.OR)!.args as Lookup;
    assert.equal(lookup.where.userId, "owner"); assert.equal(lookup.where.externalConversationId, "source");
    assert.equal(lookup.where.ordinal, undefined, "the query must not be restricted to the recent 200");
    assert.equal(lookup.take, 9);
    assert.deepEqual(lookup.where.role, { in: ["user", "assistant"] });
    revokeOnHistory = true;
    const refused = await searchContinuationHistory(input);
    assert.equal(refused.seed, null); assert.equal(refused.outcome, "locked");
    revokeOnHistory = false; unlocked = true;
});

test("history disabled, missing terms, and invalid selection cannot silently report a successful selection", async () => {
    const { searchContinuationHistory } = await import(mod("lib/externalContinuationService.ts"));
    const prepared = (await load()).seed;
    const base = { userId: "owner", conversationId: "chat", request: new Request("http://localhost/chat"),
        prepared, queries: ["AUD100"], enabled: () => false };
    queries.length = 0;
    assert.equal((await searchContinuationHistory(base)).seed, null);
    assert.equal(queries.length, 0);
    const noQuery = await searchContinuationHistory({ ...base, enabled: () => true, queries: [] });
    assert.equal(noQuery.seed.plan.historyOutcome, "no_query");
    assert.equal(queries.filter(q => q.table === "message").length, 0);
    assert.equal((await searchContinuationHistory({ ...base, enabled: () => true, queries: ["missing"] })).seed.plan.historyOutcome, "no_match");
    const invalid = await searchContinuationHistory({ ...base, enabled: () => true,
        request: new Request("http://localhost/chat", { headers: { "x-tomverse-source-passages": "" } }) });
    assert.equal(invalid.seed, null); assert.equal(invalid.outcome, "empty_selection");
});
