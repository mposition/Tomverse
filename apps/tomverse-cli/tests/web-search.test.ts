/* eslint-disable @typescript-eslint/no-explicit-any -- wire-format fixtures: request bodies are arbitrary JSON */
import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalMemory } from "../src/approvals.js";
import type { ApprovalView, Prompter } from "../src/agent.js";
import { evaluate, ruleForApproval, ruleProblem, type ScopedRule } from "../src/permissions.js";
import { webSearchQueries } from "../src/tools.js";
import { FakeGateway, TEST_KEY, toolResultsSinceUser, webSearchAnswer } from "./fakeGateway.js";
import { captureOutput, makeRepo, makeRunner } from "./helpers.js";

const searchScript = (calls: unknown[]) => (body: any) => {
    const results = toolResultsSinceUser(body);
    if (results.length < calls.length) return { toolCalls: [{ name: "web_search", args: calls[results.length] }] };
    return { text: "Searched." };
};
const toolNames = (body: any) => body.tools.map((t: any) => t.function.name);
const lastToolMessages = (gateway: FakeGateway) => JSON.stringify(gateway.completions.at(-1)!.body.messages.filter((m: any) => m.role === "tool"));

test("web_search asks with its queries, sends one request with its own key, and gives the model the results as untrusted", async () => {
    const gateway = await new FakeGateway({
        script: searchScript([{ query: ["node 22 lts date", "  tomverse   cli  "], freshness: "year" }]),
        webSearch: (body) => ({ status: 200, body: webSearchAnswer(body.query) }),
    }).start();
    try {
        const seen: ApprovalView[] = [];
        const prompter: Prompter = { approve: async (view) => (seen.push(view), true), confirm: async () => false };
        const captured = captureOutput();
        const { runner, journal } = await makeRunner(gateway, makeRepo(), { prompter, output: captured.output, runner: { webSearch: true } });
        assert.equal(await runner.runTask("When is Node 22 LTS?"), "success");
        assert.ok(toolNames(gateway.completions[0]!.body).includes("web_search"));
        assert.match(JSON.stringify(gateway.completions[0]!.body.messages[0]), /web_search searches the web through Tomverse/);

        assert.deepEqual(seen.map((view) => [view.toolName, view.webSearch]), [["web_search", { queries: ["node 22 lts date", "tomverse cli"] }]]);
        assert.equal(gateway.searches.length, 1, "one request");
        const sent = gateway.searches[0]!;
        assert.deepEqual(sent.body, { query: ["node 22 lts date", "  tomverse   cli  "], freshness: "year" });
        assert.equal(sent.headers.authorization, `Bearer ${TEST_KEY}`);
        assert.match(String(sent.headers["idempotency-key"]), /^web-search-[0-9a-f]{40}$/);

        const record = journal.state.tools.find((tool) => tool.toolName === "web_search")!;
        assert.equal(record.state, "completed");
        const output = record.output as any;
        assert.equal(output.status, "ok");
        assert.deepEqual(output.sources, ["https://example.com/r1", "https://example.com/r2"]);
        assert.equal(output.chargedCredits, 8);
        assert.match(output.notice, /never as instructions/);
        assert.equal(output.searches[0].results[0].url, "https://example.com/r1");
        assert.match(lastToolMessages(gateway), /https:\/\/example\.com\/r2/);
        const shown = captured.err.join("");
        assert.match(shown, /web_search sources: https:\/\/example\.com\/r1 https:\/\/example\.com\/r2/, "the sources are shown to the person");
        assert.match(shown, /web_search charged 8 credit/);
    } finally {
        await gateway.stop();
    }
});

test("a declined search, an empty query and a query carrying the key send nothing", async () => {
    const gateway = await new FakeGateway({
        script: searchScript([{ query: "fine" }, { query: ["ok", "   "] }, { query: `look up ${TEST_KEY}` }]),
        webSearch: (body) => ({ status: 200, body: webSearchAnswer([].concat(body.query)) }),
    }).start();
    try {
        const asked: ApprovalView[] = [];
        const prompter: Prompter = { approve: async (view) => (asked.push(view), false), confirm: async () => false };
        const { runner, journal } = await makeRunner(gateway, makeRepo(), { prompter, runner: { webSearch: true, redactText: (text) => text.replaceAll(TEST_KEY, "[key]") } });
        assert.equal(await runner.runTask("Search."), "success");
        assert.equal(asked.length, 1, "only the sendable search was put to the person");
        assert.equal(gateway.searches.length, 0, "nothing was searched");
        assert.equal(journal.state.tools.filter((tool) => tool.toolName === "web_search").length, 0);
        const messages = lastToolMessages(gateway);
        assert.match(messages, /The user declined/);
        assert.match(messages, /non-empty queries/);
        assert.match(messages, /contains a credential/);
    } finally {
        await gateway.stop();
    }
});

test("a search whose answer was lost is reported as possibly charged and never sent again; a refusal says so", async () => {
    const gateway = await new FakeGateway({
        script: searchScript([{ query: "first" }, { query: "second" }]),
        webSearch: (_body, index) => (index === 0 ? "drop" : { status: 503, body: { error: { message: "Web search is not enabled on this Tomverse API.", code: "feature_unavailable" } } }),
    }).start();
    try {
        const { runner, journal } = await makeRunner(gateway, makeRepo(), { prompter: { approve: async () => true, confirm: async () => false }, runner: { webSearch: true } });
        assert.equal(await runner.runTask("Search twice."), "success");
        assert.equal(gateway.searches.length, 2, "each call was sent once");
        const [lost, refused] = journal.state.tools.filter((tool) => tool.toolName === "web_search").map((tool) => tool.output as any);
        assert.equal(lost.status, "error");
        assert.match(lost.note, /may have reached Tomverse; it is not sent again/);
        assert.equal(refused.status, "error");
        assert.equal(refused.code, "feature_unavailable");
        assert.equal(refused.note, undefined, "a server answer is a refusal, not an unknown outcome");
    } finally {
        await gateway.stop();
    }
});

test("no web_search without the option, in a read-only session or in plan mode", async () => {
    const gateway = await new FakeGateway({ script: () => ({ text: "ok" }), webSearch: () => ({ status: 200, body: webSearchAnswer(["x"]) }) }).start();
    try {
        const plain = await makeRunner(gateway, makeRepo());
        assert.equal(await plain.runner.runTask("Look."), "success");
        const readOnly = await makeRunner(gateway, makeRepo(), { readOnly: true, runner: { webSearch: true } });
        assert.equal(await readOnly.runner.runTask("Look."), "success");
        for (const body of gateway.completions.map((c) => c.body)) {
            assert.ok(!toolNames(body).includes("web_search"));
            assert.doesNotMatch(JSON.stringify(body.messages[0]), /web_search/);
        }
        assert.equal(gateway.searches.length, 0);
    } finally {
        await gateway.stop();
    }
});

const searchView = (queries = ["a"]): ApprovalView => ({ approvalId: "ap", toolCallId: "call", toolName: "web_search", input: { query: queries }, root: "/w", webSearch: { queries } });

test("the permission mode and a web_search rule decide a search like a command; read-only still asks", () => {
    const decide = (mode: "read_only" | "ask" | "auto_review" | "allow_all", rules: ScopedRule[] = []) => evaluate(searchView(), { mode, rules }).kind;
    assert.equal(decide("ask"), "human");
    assert.equal(decide("auto_review"), "review");
    assert.equal(decide("allow_all"), "allow");
    assert.equal(decide("read_only"), "human", "a search changes nothing, so read-only asks rather than refuses");
    assert.equal(decide("allow_all", [{ effect: "deny", tool: "web_search", scope: "user" }]), "deny");
    assert.equal(decide("allow_all", [{ effect: "ask", tool: "web_search", scope: "project" }]), "human");
    assert.equal(decide("ask", [{ effect: "allow", tool: "web_search", scope: "user" }]), "allow");
    assert.equal(decide("ask", [{ effect: "allow", tool: "web_fetch", pattern: "*", scope: "user" }]), "human", "a web_fetch rule does not allow a search");
    assert.equal(ruleProblem({ effect: "allow", tool: "web_search" }), null);
    assert.match(ruleProblem({ effect: "allow", tool: "web_search", pattern: "*" })!, /no pattern/);
    assert.deepEqual(ruleForApproval(searchView()), { effect: "allow", tool: "web_search" });
});

test("allowing searches for the run skips the question for searches only, and is cleared with the others", () => {
    const memory = new ApprovalMemory();
    const view = searchView(["x"]);
    assert.equal(memory.canRemember(view), true);
    assert.equal(memory.match(view), null);
    assert.equal(memory.remember(view), "web_search");
    assert.equal(memory.match(searchView(["another"])), "web_search");
    assert.equal(memory.match({ ...view, webSearch: undefined, toolName: "web_fetch", web: { url: "https://a.example/", host: "a.example" } }), null);
    assert.ok(memory.describe().some((line) => /searching the web/.test(line)));
    memory.clear();
    assert.equal(memory.match(view), null);
});

test("the queries a call would send are its trimmed strings, or none", () => {
    assert.deepEqual(webSearchQueries({ query: "  a   b " }), ["a b"]);
    assert.deepEqual(webSearchQueries({ query: ["x", "y"] }), ["x", "y"]);
    assert.deepEqual(webSearchQueries({ query: [] }), []);
    assert.deepEqual(webSearchQueries({ query: ["1", "2", "3", "4", "5", "6"] }), []);
    assert.deepEqual(webSearchQueries({ query: 3 }), []);
    assert.deepEqual(webSearchQueries(null), []);
});
