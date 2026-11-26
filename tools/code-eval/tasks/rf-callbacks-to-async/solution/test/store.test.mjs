import { test } from "node:test";
import assert from "node:assert/strict";
import { NotFoundError, RecordStore, runCommand, syncRecords } from "../src/index.js";

test("write then read returns a copy", async () => {
    const store = new RecordStore();
    assert.equal(await store.write({ id: "a", n: 1 }), "a");
    assert.deepEqual(await store.read("a"), { id: "a", n: 1 });
});

test("reading a missing record fails with NotFoundError", async () => {
    await assert.rejects(new RecordStore().read("zzz"), NotFoundError);
});

test("syncRecords copies only missing records", async () => {
    const source = new RecordStore();
    const target = new RecordStore();
    await source.write({ id: "a" });
    await source.write({ id: "b" });
    await target.write({ id: "a" });
    assert.deepEqual(await syncRecords(source, target), { copied: ["b"], skipped: ["a"] });
});

test("runCommand reports text", async () => {
    const store = new RecordStore();
    assert.equal(await runCommand(store, ["put", "k", '{"v":1}']), "saved k");
    assert.equal(await runCommand(store, ["get", "k"]), '{"v":1,"id":"k"}');
});
