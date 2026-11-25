import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatCsv, formatJson, formatText } from "../src/index.js";
import { buildRows } from "../src/rows.js";

const columns = [
    { key: "name", label: "Name" },
    { key: "joined", label: "Joined", type: "date" },
    { key: "active", label: "Active", type: "boolean" },
    { key: "score" },
    { key: "note", label: "Note" },
];
const records = [
    { name: "Ann", joined: new Date("2024-03-05T10:00:00Z"), active: true, score: 12, note: "likes, commas" },
    { name: "Bartholomew", joined: "2023-12-31T23:59:59Z", active: false, score: 0, note: 'says "hi"' },
    { name: "Cy", joined: null, active: undefined, score: null, note: "line\nbreak" },
];

test("formatters use rows.js and no longer format cells themselves", () => {
    for (const file of ["format-text.js", "format-csv.js", "format-json.js"]) {
        const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
        assert.match(source, /from "\.\/rows\.js"/, file);
        assert.doesNotMatch(source, /toISOString|"yes"/, file);
    }
});

test("buildRows contract", () => {
    assert.deepEqual(buildRows(records, columns), {
        headers: ["Name", "Joined", "Active", "score", "Note"],
        rows: [
            ["Ann", "2024-03-05", "yes", "12", "likes, commas"],
            ["Bartholomew", "2023-12-31", "no", "0", 'says "hi"'],
            ["Cy", "", "", "", "line\nbreak"],
        ],
    });
    assert.deepEqual(buildRows([], columns), { headers: ["Name", "Joined", "Active", "score", "Note"], rows: [] });
});

test("text output is byte for byte unchanged", () => {
    assert.equal(formatText(records, columns), "Name         Joined      Active  score  Note\n-----------  ----------  ------  -----  -------------\nAnn          2024-03-05  yes     12     likes, commas\nBartholomew  2023-12-31  no      0      says \"hi\"\nCy                                      line\nbreak");
    assert.equal(formatText([], columns), "Name  Joined  Active  score  Note\n----  ------  ------  -----  ----");
});

test("csv output is byte for byte unchanged", () => {
    assert.equal(formatCsv(records, columns), "Name,Joined,Active,score,Note\nAnn,2024-03-05,yes,12,\"likes, commas\"\nBartholomew,2023-12-31,no,0,\"says \"\"hi\"\"\"\nCy,,,,\"line\nbreak\"");
    assert.equal(formatCsv([], columns), "Name,Joined,Active,score,Note");
});

test("json output is byte for byte unchanged", () => {
    assert.equal(formatJson(records, columns), "[\n  {\n    \"Name\": \"Ann\",\n    \"Joined\": \"2024-03-05\",\n    \"Active\": \"yes\",\n    \"score\": \"12\",\n    \"Note\": \"likes, commas\"\n  },\n  {\n    \"Name\": \"Bartholomew\",\n    \"Joined\": \"2023-12-31\",\n    \"Active\": \"no\",\n    \"score\": \"0\",\n    \"Note\": \"says \\\"hi\\\"\"\n  },\n  {\n    \"Name\": \"Cy\",\n    \"Joined\": \"\",\n    \"Active\": \"\",\n    \"score\": \"\",\n    \"Note\": \"line\\nbreak\"\n  }\n]");
    assert.equal(formatJson([], columns), "[]");
});
