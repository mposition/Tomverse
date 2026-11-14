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
let enabled = true, unlocked = true, deleted = false;
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
    externalMessage: { findMany: async (args: { where?: { ordinal?: { in: number[] } } }) => {
        queries.push({ table: "message", args });
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
