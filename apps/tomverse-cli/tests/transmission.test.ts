import assert from "node:assert/strict";
import test from "node:test";
import { requestTransmission } from "../src/transmission";

test("transmission is derived from the sent tool result and does not retain message or file text", () => {
    const body = JSON.stringify({ model: "my-model", messages: [
        { role: "system", content: "prefix\n<project-instructions>\nPrivate project rules" },
        { role: "user", content: "Private user text" },
        { role: "assistant", tool_calls: [{ id: "read", function: { name: "read_file" } }, { id: "search", function: { name: "search_text" } }, { id: "list", function: { name: "list_files" } }] },
        { role: "tool", tool_call_id: "read", content: JSON.stringify({ status: "ok", path: "project-secret.ts", text: "Private source", truncated: true }) },
        { role: "tool", tool_call_id: "search", content: JSON.stringify({ status: "ok", path: "search-result", text: "Private source" }) },
        { role: "tool", tool_call_id: "list", content: JSON.stringify({ status: "ok", files: ["a.ts", "b.ts"], truncated: true }) },
    ] });
    assert.deepEqual(requestTransmission(body, (value) => value.replace("secret", "[redacted]")), {
        model: "my-model", projectInstructions: true, messageCount: 6, toolResultCount: 3, listedPathCount: 2, truncatedListingCount: 1,
        fileReads: [{ path: "project-[redacted].ts", truncated: true }], moreFileReads: 0,
    });
    assert.equal(requestTransmission("{broken", (value) => value), undefined);
});

test("command transmission records output and truncation without copying the command stream", () => {
    const sent = JSON.stringify({ messages: [
        { role: "assistant", tool_calls: ["sent", "denied", "truncated"].map((id) => ({ id, function: { name: "run_command" } })) },
        { role: "tool", tool_call_id: "sent", content: JSON.stringify({ status: "exited", stdout: "private command output" }) },
        { role: "tool", tool_call_id: "denied", content: JSON.stringify({ status: "denied" }) },
        { role: "tool", tool_call_id: "truncated", content: JSON.stringify({ status: "exited", stderr: "private error", omittedBytes: { stderr: 120 } }) },
    ] });
    const evidence = requestTransmission(sent, (value) => value);
    assert.deepEqual(evidence?.commandOutput, { results: 2, truncated: 1 });
    assert.doesNotMatch(JSON.stringify(evidence), /private command output|private error/);
});

test("file evidence bounds the recorded paths while counting additional reads", () => {
    const paths = Array.from({ length: 30 }, (_, index) => ({ id: String(index), path: `folder/${index}/${"a".repeat(310)}.txt` }));
    const sent = JSON.stringify({ messages: [
        { role: "assistant", tool_calls: paths.map(({ id }) => ({ id, function: { name: "read_file" } })) },
        ...paths.map(({ id, path }) => ({ role: "tool", tool_call_id: id,
            content: JSON.stringify({ status: "ok", path, text: "Private file contents" }) })),
    ] });
    const evidence = requestTransmission(sent, (value) => value);
    assert.equal(evidence?.fileReads.length, 24);
    assert.equal(evidence?.fileReads[0]?.path.length, 300);
    assert.equal(evidence?.moreFileReads, 6);
    assert.doesNotMatch(JSON.stringify(evidence), /Private file contents/);
});
