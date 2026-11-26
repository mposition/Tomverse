import { test } from "node:test";
import assert from "node:assert/strict";
import { NotFoundError, RecordStore, runCommand, syncRecords } from "../src/index.js";

test("no function declares a callback any more", () => {
    assert.equal(RecordStore.prototype.read.length, 1);
    assert.equal(RecordStore.prototype.write.length, 1);
    assert.equal(RecordStore.prototype.list.length, 0);
    assert.equal(RecordStore.prototype.remove.length, 1);
    assert.equal(syncRecords.length, 2);
    assert.equal(runCommand.length, 2);
});

test("every operation returns a promise", async () => {
    const store = new RecordStore();
    const results = [store.write({ id: "a" }), store.read("a"), store.list(), store.remove("a"), syncRecords(store, new RecordStore()), runCommand(store, ["list"])];
    for (const result of results) assert.ok(result instanceof Promise);
    await Promise.all(results);
});

test("store semantics", async () => {
    const store = new RecordStore();
    assert.equal(await store.write({ id: "b", v: { deep: 1 } }), "b");
    await store.write({ id: "a" });
    const original = { id: "c", list: [1] };
    await store.write(original);
    original.list.push(2);
    assert.deepEqual((await store.read("c")).list, [1]);
    const read = await store.read("b");
    read.v.deep = 99;
    assert.equal((await store.read("b")).v.deep, 1);
    assert.deepEqual((await store.list()).map((r) => r.id), ["a", "b", "c"]);
    assert.equal(await store.remove("a"), true);
    await assert.rejects(store.remove("a"), (e) => e instanceof NotFoundError && e.id === "a");
    await assert.rejects(store.read("a"), NotFoundError);
    await assert.rejects(store.write({ n: 1 }), TypeError);
    await assert.rejects(store.write(null), TypeError);
});

test("syncRecords copies missing records, keeps existing ones and reports both", async () => {
    const source = new RecordStore();
    const target = new RecordStore();
    for (const id of ["a", "b", "c"]) await source.write({ id, from: "source" });
    await target.write({ id: "b", from: "target" });
    assert.deepEqual(await syncRecords(source, target), { copied: ["a", "c"], skipped: ["b"] });
    assert.equal((await target.read("b")).from, "target");
    assert.equal((await target.read("a")).from, "source");
    assert.deepEqual(await syncRecords(source, target), { copied: [], skipped: ["a", "b", "c"] });
});

test("syncRecords passes on other errors and stops", async () => {
    const source = new RecordStore();
    await source.write({ id: "a" });
    const broken = { read: async () => { throw new Error("disk"); }, write: async () => assert.fail("must not write") };
    await assert.rejects(syncRecords(source, broken), /disk/);
    const failingList = { list: async () => { throw new Error("list failed"); } };
    await assert.rejects(syncRecords(failingList, new RecordStore()), /list failed/);
    const failingWrite = { read: async () => { throw new NotFoundError("a"); }, write: async () => { throw new Error("full"); } };
    await assert.rejects(syncRecords(source, failingWrite), /full/);
});

test("runCommand", async () => {
    const store = new RecordStore();
    assert.equal(await runCommand(store, ["put", "k", '{"v":1}']), "saved k");
    assert.equal(await runCommand(store, ["put", "j", "{}"]), "saved j");
    assert.equal(await runCommand(store, ["get", "k"]), '{"v":1,"id":"k"}');
    assert.equal(await runCommand(store, ["list"]), "j\nk");
    assert.equal(await runCommand(store, ["rm", "j"]), "removed j");
    await assert.rejects(runCommand(store, ["get", "j"]), NotFoundError);
    await assert.rejects(runCommand(store, ["put", "x", "{bad"]), SyntaxError);
    await assert.rejects(runCommand(store, ["frobnicate"]), /unknown command: frobnicate/);
});
