import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { chatgptAdapter } from "../lib/externalImportAdapters/chatgpt.ts";

/**
 * The memory launch staging checklist imports these two files on Test. Each
 * must be something the real ChatGPT adapter accepts, with every turn kept, or
 * the run would be checking the importer instead of extraction.
 */
const DIR = "docs/ops/memory-launch-staging-verification-records/fixtures";

for (const [file, userTurns] of [["durable-facts-ko.json", 3], ["critical-shapes-ko.json", 3]]) {
    test(`${file} parses with every turn kept`, () => {
        const parsed = JSON.parse(readFileSync(`${DIR}/${file}`, "utf8"));
        assert.ok(chatgptAdapter.detect(parsed), "the ChatGPT adapter recognises the file");
        const conversation = chatgptAdapter.parseConversation(parsed[0]);
        assert.ok(conversation, "the adapter parses the conversation");
        assert.equal(conversation.messages.length, userTurns * 2);
        assert.equal(conversation.messages.filter((m) => m.role === "user").length, userTurns);
    });
}
