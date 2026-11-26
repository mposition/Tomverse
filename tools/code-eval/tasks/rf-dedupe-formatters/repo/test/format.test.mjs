import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCsv, formatJson, formatText } from "../src/index.js";

const columns = [{ key: "name", label: "Name" }, { key: "on", label: "On", type: "boolean" }];
const records = [{ name: "Ann", on: true }, { name: "Bo, Jr", on: false }];

test("text table", () => {
    assert.equal(formatText(records, columns), "Name    On\n------  ---\nAnn     yes\nBo, Jr  no");
});

test("csv quotes cells with commas", () => {
    assert.equal(formatCsv(records, columns), 'Name,On\nAnn,yes\n"Bo, Jr",no');
});

test("json keys are labels", () => {
    assert.deepEqual(JSON.parse(formatJson(records, columns)), [{ Name: "Ann", On: "yes" }, { Name: "Bo, Jr", On: "no" }]);
});
