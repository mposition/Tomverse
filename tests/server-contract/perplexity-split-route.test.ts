// Contract: POST /api/imports/external/perplexity-split.
//
// The route answers the split questions a Perplexity Markdown export leaves
// open. What it must hold, whatever the model does:
//
//   * only a signed-in owner of an enabled import can ask;
//   * the switch, when set to "false", closes the route before any spend;
//   * a body that is not the bounded question shape is refused unread by the
//     model; and
//   * a refusal from the model path is a non-2xx the browser treats as "keep
//     the file split", never a hint.
//
// Only the route's collaborators are replaced. The route is real.

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(ROOT, path)).href;
const require = createRequire(import.meta.url);

process.env.E2E_DISABLE_DATABASE = "true";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.NEXTAUTH_SECRET ||= "perplexity-split-contract-2026";

const world = {
    session: null as unknown,
    importEnabled: true,
    outcome: { ok: true, hints: { questionParagraphs: [1], continuesAnswer: [] } } as unknown,
    asked: [] as unknown[],
};

let mocksInstalled = false;
const loadRoute = async () => {
    if (!mocksInstalled) {
        mocksInstalled = true;
        const realApiSecurity = require(resolve(ROOT, "lib/apiSecurity.ts")) as Record<string, unknown>;
        const realAppSettings = require(resolve(ROOT, "lib/appSettings.ts")) as Record<string, unknown> & {
            ExternalImportDisabledError: new (message?: string) => Error;
        };
        const realSplit = require(resolve(ROOT, "lib/perplexitySplitHints.ts")) as Record<string, unknown>;
        mock.module(mod("lib/chatRouteSession.ts"), {
            namedExports: { resolveChatRouteSession: async () => ({ session: world.session }) },
        });
        mock.module(mod("lib/apiSecurity.ts"), {
            namedExports: { ...realApiSecurity, consumeApiRateLimit: async () => undefined },
        });
        mock.module(mod("lib/appSettings.ts"), {
            namedExports: {
                ...realAppSettings,
                assertExternalImportEnabled: async () => {
                    if (!world.importEnabled) {
                        throw new realAppSettings.ExternalImportDisabledError("External conversation import is not enabled.");
                    }
                },
            },
        });
        mock.module(mod("lib/perplexitySplitHints.ts"), {
            namedExports: {
                ...realSplit,
                requestPerplexitySplitHints: async (questions: unknown) => {
                    world.asked.push(questions);
                    return world.outcome;
                },
            },
        });
    }
    return import(mod("app/api/imports/external/perplexity-split/route.ts"));
};

const QUESTIONS = { turns: [{ question: "draft:", paragraphs: ["the draft", "tighten it?"] }], boundaries: [] };

const post = (body: unknown) =>
    new Request("http://127.0.0.1:3100/api/imports/external/perplexity-split", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:3100" },
        body: typeof body === "string" ? body : JSON.stringify(body),
    });

const reset = () => {
    world.session = { user: { id: "user_1" } };
    world.importEnabled = true;
    world.outcome = { ok: true, hints: { questionParagraphs: [1], continuesAnswer: [] } };
    world.asked = [];
    delete process.env.EXTERNAL_IMPORT_PERPLEXITY_LLM_SPLIT;
};

test("an owner gets hints for well-formed questions", async () => {
    reset();
    const { POST } = await loadRoute();
    const response = await POST(post(QUESTIONS));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { hints: { questionParagraphs: [1], continuesAnswer: [] } });
    assert.deepEqual(world.asked, [QUESTIONS]);
    assert.equal(response.headers.get("cache-control"), "no-store");
});

test("no session, no hints and no model call", async () => {
    reset();
    world.session = null;
    const { POST } = await loadRoute();
    const response = await POST(post(QUESTIONS));
    assert.equal(response.status, 401);
    assert.equal(world.asked.length, 0);
});

test("import disabled or the switch off closes the route before any spend", async () => {
    reset();
    world.importEnabled = false;
    const { POST } = await loadRoute();
    assert.equal((await POST(post(QUESTIONS))).status, 403);
    reset();
    process.env.EXTERNAL_IMPORT_PERPLEXITY_LLM_SPLIT = "false";
    const off = await POST(post(QUESTIONS));
    assert.equal(off.status, 404);
    assert.equal((await off.json()).code, "PERPLEXITY_SPLIT_DISABLED");
    assert.equal(world.asked.length, 0);
    reset();
});

test("a body outside the bounded question shape is refused unread", async () => {
    reset();
    const { POST } = await loadRoute();
    for (const body of [
        { turns: [] , boundaries: [] },
        { turns: [{ question: "x".repeat(601), paragraphs: [] }], boundaries: [] },
        { turns: [{ question: "q", paragraphs: ["a", "b", "c", "d"] }], boundaries: [] },
        { turns: [{ question: "q", paragraphs: [], file: "the whole export" }], boundaries: [] },
        { ...QUESTIONS, markdown: "the whole export" },
        "not json",
    ]) {
        const response = await POST(post(body));
        assert.ok(response.status >= 400 && response.status < 500, `${JSON.stringify(body).slice(0, 60)} -> ${response.status}`);
    }
    assert.equal(world.asked.length, 0);
});

test("a refusal from the model path is a non-2xx with its reason, never hints", async () => {
    reset();
    const { POST } = await loadRoute();
    world.outcome = { ok: false, reason: "budget" };
    const budget = await POST(post(QUESTIONS));
    assert.equal(budget.status, 429);
    assert.equal((await budget.json()).code, "PERPLEXITY_SPLIT_BUDGET");
    world.outcome = { ok: false, reason: "invalid_output" };
    const invalid = await POST(post(QUESTIONS));
    assert.equal(invalid.status, 503);
    assert.equal((await invalid.json()).hints, undefined);
});
