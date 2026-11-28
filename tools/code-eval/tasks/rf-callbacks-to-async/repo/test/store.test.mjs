import { test } from "node:test";
import assert from "node:assert/strict";
import { NotFoundError, RecordStore, runCommand, syncRecords } from "../src/index.js";

const call = (fn, ...args) => new Promise((resolve, reject) => fn(...args, (error, value) => (error ? reject(error) : resolve(value))));

test("write then read returns a copy", async () => {
    const store = new RecordStore();
    const id = await call(store.write.bind(store), { id: "a", n: 1 });
    assert.equal(id, "a");
    const record = await call(store.read.bind(store), "a");
    assert.deepEqual(record, { id: "a", n: 1 });
});

test("reading a missing record fails with NotFoundError", async () => {
    const store = new RecordStore();
    await assert.rejects(call(store.read.bind(store), "zzz"), NotFoundError);
});

test("syncRecords copies only missing records", async () => {
    const source = new RecordStore();
    const target = new RecordStore();
    await call(source.write.bind(source), { id: "a" });
    await call(source.write.bind(source), { id: "b" });
    await call(target.write.bind(target), { id: "a" });
    assert.deepEqual(await call(syncRecords, source, target), { copied: ["b"], skipped: ["a"] });
});

test("runCommand reports text", async () => {
    const store = new RecordStore();
    assert.equal(await call(runCommand, store, ["put", "k", '{"v":1}']), "saved k");
    assert.equal(await call(runCommand, store, ["get", "k"]), '{"v":1,"id":"k"}');
});
