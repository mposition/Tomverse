import { test } from "node:test";
import assert from "node:assert/strict";
import { NotFoundError, TodoApi, ValidationError, fixedClock } from "../src/index.js";

const api = () => new TodoApi({ clock: fixedClock("2024-05-01T12:00:00.000Z") });

test("adds, completes and lists", () => {
    const todos = api();
    const first = todos.add({ title: " Buy milk " });
    todos.add({ title: "Call Ann" });
    todos.complete(first.id);
    assert.deepEqual(todos.list({ filter: "open" }).map((t) => t.title), ["Call Ann"]);
    assert.equal(todos.render(), "[x] Buy milk\n[ ] Call Ann");
    assert.throws(() => todos.complete(99), NotFoundError);
});

test("validates titles", () => {
    assert.throws(() => api().add({ title: "  " }), ValidationError);
});

test("saves and loads", () => {
    const a = api();
    a.add({ title: "x" });
    const b = api();
    b.load(a.save());
    assert.equal(b.add({ title: "y" }).id, 2);
});
