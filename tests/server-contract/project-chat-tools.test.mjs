import assert from "node:assert/strict";
import { mock, test } from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * project_search / project_read against an injected source-access layer:
 * every execution re-checks the project scope, a read of a source that moved
 * or was locked is refused (never served from an earlier hit), the result
 * allowance that was reserved is never exceeded, and the flat-budget step
 * guard refuses a call the reservation does not cover.
 */

const mod = (file) => pathToFileURL(path.resolve(file)).href;
let scopeCurrent = true;
let readOutcome = "ok";
const searches = [];

mock.module(mod("lib/projectSourceAccess.ts"), {
    namedExports: {
        projectScopeStillCurrent: async () => scopeCurrent,
        searchProjectSources: async (input) => {
            searches.push(input);
            return {
                status: "partial",
                incomplete: ["imported_sources"],
                hits: [{ ref: "m:msg1", location: { kind: "message", messageId: "msg1", conversationId: "c2" }, title: "Decision log", role: "user", snippet: "deadline is Friday" }],
            };
        },
        readProjectSource: async () => readOutcome === "ok"
            ? { status: "ok", location: { kind: "message", messageId: "msg1", conversationId: "c2" }, title: "Decision log", role: "user", content: "x".repeat(60_000), createdAt: null }
            : { status: "unavailable", reason: "outside_project" },
        decodeProjectRef: (ref) => ref.startsWith("m:") ? { kind: "message", messageId: ref.slice(2), conversationId: "" } : null,
    },
});

const { buildProjectChatTools, PROJECT_TOOL_LIMITS, ProjectToolError } = await import(mod("lib/projectChatTools.ts"));

const project = { projectId: "p-alpha", name: "Alpha", revision: 4, contextEnabled: true, archived: false, memoryScope: "project_only", autoMemoryEnabled: false, instructions: "" };
const tools = () => buildProjectChatTools({ userId: "u1", conversationId: "c1", project, signal: new AbortController().signal });
const exec = (built, name, args) => built.tools[name].execute(args, { toolCallId: "t", messages: [] });

test("search runs in the server's project, excludes the current conversation and reports partial results as partial", async () => {
    scopeCurrent = true;
    searches.length = 0;
    const built = tools();
    const result = await exec(built, "project_search", { queries: ["deadline", "마감"] });
    assert.equal(result.status, "partial");
    assert.deepEqual(result.incomplete, ["imported_sources"]);
    assert.ok(String(result.data).includes("<<<TOMVERSE_PROJECT_SEARCH_RESULT>>>"));
    assert.deepEqual(searches.map((s) => [s.projectId, s.excludeConversationId]), [["p-alpha", "c1"], ["p-alpha", "c1"]]);
    assert.deepEqual(built.sources().map((s) => s.ref), ["m:msg1"]);
});

test("a changed project scope stops the tools; a moved source is refused and dropped from the receipt", async () => {
    scopeCurrent = false;
    const built = tools();
    const refused = await exec(built, "project_search", { queries: ["deadline"] });
    assert.equal(refused.reason, "project_scope_changed");
    scopeCurrent = true;
    await exec(built, "project_search", { queries: ["deadline"] });
    readOutcome = "outside_project";
    const read = await exec(built, "project_read", { ref: "m:msg1" });
    assert.deepEqual(read, { status: "unavailable", reason: "outside_project" });
    assert.equal(built.sources().length, 0);
    readOutcome = "ok";
});

test("a long source is read only up to the reserved allowance and says so", async () => {
    scopeCurrent = true;
    readOutcome = "ok";
    const built = tools();
    const read = await exec(built, "project_read", { ref: "m:msg1" });
    assert.equal(read.status, "partial_read");
    assert.ok(JSON.stringify(read).length <= PROJECT_TOOL_LIMITS.turnCharacters);
    const again = await exec(built, "project_read", { ref: "m:msg1" });
    assert.equal(again.status, "limit_reached");
});

test("the step guard refuses a call past the reserved input, output or steps", () => {
    const built = tools();
    built.setBudget({ inputTokens: 50, outputTokens: 100, instructions: "" });
    assert.throws(() => built.prepareStep({ messages: [{ role: "user", content: "x".repeat(2_000) }], steps: [] }),
        (error) => error instanceof ProjectToolError && error.code === "model_input_budget");
    built.setBudget({ inputTokens: 1_000_000, outputTokens: 100, instructions: "" });
    assert.throws(() => built.prepareStep({ messages: [], steps: [{ usage: { inputTokens: 10, outputTokens: 100 } }] }),
        (error) => error instanceof ProjectToolError && error.code === "model_output_limit");
    const step = built.prepareStep({ messages: [], steps: [{ usage: { inputTokens: 10, outputTokens: 10 } }, { usage: { inputTokens: 10, outputTokens: 10 } }, { usage: { inputTokens: 10, outputTokens: 10 } }] });
    assert.equal(step.toolChoice, "none", "the last reserved call must answer");
    assert.throws(() => built.prepareStep({ messages: [], steps: Array(4).fill({ usage: { inputTokens: 1, outputTokens: 1 } }) }),
        (error) => error instanceof ProjectToolError && error.code === "model_step_limit");
    assert.ok(built.definitionTokens > 0);
    assert.equal(built.resultInputAllowance, PROJECT_TOOL_LIMITS.turnCharacters);
});
