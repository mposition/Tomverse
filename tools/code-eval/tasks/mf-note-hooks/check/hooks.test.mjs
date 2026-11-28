import { test } from "node:test";
import assert from "node:assert/strict";
import { HookRegistry, MemoryStorage, NotFoundError, NotesService, ValidationError, fixedClock } from "../src/index.js";

const setup = (options = {}) => {
    const hooks = new HookRegistry();
    const storage = new MemoryStorage();
    const notes = new NotesService({ storage, hooks, clock: fixedClock("2024-01-01T00:00:00.000Z"), ...options });
    return { hooks, storage, notes };
};

test("registry: priority order, ties in registration order, awaited", async () => {
    const hooks = new HookRegistry();
    const seen = [];
    hooks.register("beforeCreate", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        seen.push("low");
    }, { priority: -1 });
    hooks.register("beforeCreate", () => seen.push("a"));
    hooks.register("beforeCreate", () => seen.push("high"), { priority: 10 });
    hooks.register("beforeCreate", () => seen.push("b"));
    await hooks.run("beforeCreate", {});
    assert.deepEqual(seen, ["high", "a", "b", "low"]);
});

test("registry: returned objects replace the payload, other values do not", async () => {
    const hooks = new HookRegistry();
    hooks.register("beforeCreate", (p) => ({ ...p, step1: true }), { priority: 3 });
    hooks.register("beforeCreate", () => "ignored", { priority: 2 });
    hooks.register("beforeCreate", () => [1, 2], { priority: 1 });
    hooks.register("beforeCreate", () => null);
    hooks.register("beforeCreate", (p) => ({ ...p, step2: Object.keys(p).join(",") }), { priority: -1 });
    const result = await hooks.run("beforeCreate", { title: "t" });
    assert.deepEqual(result, { title: "t", step1: true, step2: "title,step1" });
    assert.deepEqual(await new HookRegistry().run("afterCreate", { x: 1 }), { x: 1 });
});

test("registry: an error stops the run and is rethrown unchanged", async () => {
    const hooks = new HookRegistry();
    const boom = new Error("boom");
    const seen = [];
    hooks.register("beforeUpdate", () => seen.push(1), { priority: 2 });
    hooks.register("beforeUpdate", async () => {
        throw boom;
    }, { priority: 1 });
    hooks.register("beforeUpdate", () => seen.push(3));
    await assert.rejects(hooks.run("beforeUpdate", {}), (error) => error === boom);
    assert.deepEqual(seen, [1]);
});

test("registry: unregister, unknown names and invalid hooks", async () => {
    const hooks = new HookRegistry();
    const seen = [];
    const off = hooks.register("afterRemove", () => seen.push("x"));
    await hooks.run("afterRemove", {});
    off();
    off();
    await hooks.run("afterRemove", {});
    assert.deepEqual(seen, ["x"]);
    assert.throws(() => hooks.register("beforeSave", () => {}), (e) => e instanceof Error && e.message === "unknown hook: beforeSave");
    assert.throws(() => hooks.register("afterCreate", "nope"), TypeError);
});

test("create: beforeCreate may change the draft and sees the validated input", async () => {
    const { hooks, notes } = setup();
    let seen;
    hooks.register("beforeCreate", (draft) => {
        seen = draft;
        return { title: `${draft.title}!`, body: "from hook" };
    });
    const note = await notes.create({ title: "  Hi ", body: "orig", extra: 1 });
    assert.deepEqual(seen, { title: "Hi", body: "orig" });
    assert.equal(note.title, "Hi!");
    assert.equal(note.body, "from hook");
    assert.equal(note.id, "n1");
    assert.deepEqual(await notes.get("n1"), note);
});

test("create: a replaced draft is validated again", async () => {
    const { hooks, notes, storage } = setup();
    hooks.register("beforeCreate", () => ({ title: "   ", body: "" }));
    await assert.rejects(notes.create({ title: "ok" }), (e) => e instanceof ValidationError && e.field === "title");
    assert.deepEqual(await storage.list(), []);
});

test("create: a throwing beforeCreate saves nothing and the id is not used up", async () => {
    const { hooks, notes, storage } = setup();
    const boom = new Error("veto");
    const off = hooks.register("beforeCreate", () => {
        throw boom;
    });
    await assert.rejects(notes.create({ title: "x" }), (error) => error === boom);
    assert.deepEqual(await storage.list(), []);
    off();
    assert.equal((await notes.create({ title: "x" })).id, "n1");
});

test("afterCreate receives the saved note; its errors go to onHookError", async () => {
    const errors = [];
    const { hooks, notes } = setup({ onHookError: (error, name) => errors.push([error.message, name]) });
    const seen = [];
    hooks.register("afterCreate", (note) => seen.push(note.id), { priority: 2 });
    hooks.register("afterCreate", () => {
        throw new Error("after failed");
    }, { priority: 1 });
    hooks.register("afterCreate", () => seen.push("never"), { priority: 0 });
    const note = await notes.create({ title: "x" });
    assert.equal(note.id, "n1");
    assert.deepEqual(seen, ["n1"]);
    assert.deepEqual(errors, [["after failed", "afterCreate"]]);
});

test("after hook errors are ignored without onHookError", async () => {
    const { hooks, notes } = setup();
    hooks.register("afterCreate", () => {
        throw new Error("ignored");
    });
    assert.equal((await notes.create({ title: "x" })).title, "x");
});

test("update hooks", async () => {
    const { hooks, notes } = setup();
    await notes.create({ title: "first", body: "b" });
    let seen;
    hooks.register("beforeUpdate", (payload) => {
        seen = payload;
        return { changes: { ...payload.changes, body: "hooked" } };
    });
    const afterSeen = [];
    hooks.register("afterUpdate", (note) => afterSeen.push(note.body));
    const updated = await notes.update("n1", { title: "second", ignored: true });
    assert.deepEqual(seen, { changes: { title: "second" } });
    assert.equal(updated.title, "second");
    assert.equal(updated.body, "hooked");
    assert.deepEqual(afterSeen, ["hooked"]);
});

test("update: unknown ids do not run hooks; a throwing hook keeps the note unchanged", async () => {
    const { hooks, notes } = setup();
    let calls = 0;
    const off = hooks.register("beforeUpdate", () => {
        calls += 1;
    });
    await assert.rejects(notes.update("zzz", { title: "x" }), NotFoundError);
    assert.equal(calls, 0);
    off();
    await notes.create({ title: "keep" });
    hooks.register("beforeUpdate", () => {
        throw new Error("no");
    });
    await assert.rejects(notes.update("n1", { title: "changed" }), /no/);
    assert.equal((await notes.get("n1")).title, "keep");
});

test("remove hooks", async () => {
    const { hooks, notes } = setup();
    await notes.create({ title: "a" });
    await notes.create({ title: "b" });
    const seen = [];
    const off = hooks.register("beforeRemove", (note) => {
        seen.push(`before ${note.id}`);
        throw new Error("protected");
    });
    await assert.rejects(notes.remove("n1"), /protected/);
    assert.ok(await notes.get("n1"));
    off();
    hooks.register("beforeRemove", (note) => (seen.push(`before ${note.id}`), { id: "other" }));
    hooks.register("afterRemove", (note) => seen.push(`after ${note.id} ${note.title}`));
    await notes.remove("n2");
    assert.equal(await notes.get("n2"), undefined);
    assert.ok(await notes.get("n1"));
    assert.deepEqual(seen, ["before n1", "before n2", "after n2 b"]);
    await assert.rejects(notes.remove("n2"), NotFoundError);
});

test("without hooks everything works as before", async () => {
    const notes = new NotesService({ storage: new MemoryStorage(), clock: fixedClock("2024-01-01T00:00:00.000Z") });
    const note = await notes.create({ title: "plain" });
    assert.equal(note.id, "n1");
    assert.equal((await notes.update("n1", { body: "x" })).body, "x");
    await notes.remove("n1");
    assert.deepEqual(await notes.list(), []);
});
