import { test } from "node:test";
import assert from "node:assert/strict";
import { TodoApi, ValidationError, deserialize, fixedClock, formatList, formatTodo, serialize, validateTodoInput } from "../src/index.js";

const api = () => new TodoApi({ clock: fixedClock("2024-05-01T12:00:00.000Z") });
const badDate = (fn) => assert.throws(fn, (e) => e instanceof ValidationError && e.field === "dueDate" && e.message === "dueDate must be a valid date (YYYY-MM-DD)");

test("add stores a due date or null", () => {
    const todos = api();
    assert.equal(todos.add({ title: "a", dueDate: "2024-05-10" }).dueDate, "2024-05-10");
    for (const none of [undefined, null, "", "   "]) assert.equal(todos.add({ title: "b", dueDate: none }).dueDate, null);
    assert.equal(todos.add({ title: "c" }).dueDate, null);
    assert.equal(todos.add({ title: "leap", dueDate: "2024-02-29" }).dueDate, "2024-02-29");
});

test("invalid due dates are rejected", () => {
    for (const bad of ["2024-5-1", "tomorrow", "2024-02-30", "2023-02-29", "2024-13-01", "2024-00-10", "24-05-01", "2024-05-01T10:00:00Z", 20240501, {}]) {
        badDate(() => api().add({ title: "x", dueDate: bad }));
    }
});

test("validateTodoInput returns title and dueDate", () => {
    assert.deepEqual(validateTodoInput({ title: " x ", dueDate: "2024-01-31" }), { title: "x", dueDate: "2024-01-31" });
    assert.deepEqual(validateTodoInput({ title: "x" }), { title: "x", dueDate: null });
    assert.throws(() => validateTodoInput({ title: "" }), (e) => e.field === "title");
});

test("due dates survive save and load", () => {
    const a = api();
    a.add({ title: "with", dueDate: "2024-06-01" });
    a.add({ title: "without" });
    const b = api();
    b.load(a.save());
    assert.deepEqual(b.list().map((t) => t.dueDate), ["2024-06-01", null]);
    assert.equal(b.add({ title: "next" }).id, 3);
});

test("old saved data loads with dueDate null", () => {
    const legacy = '[{"id":4,"title":"old","done":true,"createdAt":"2023-01-01T00:00:00.000Z"}]';
    const todos = deserialize(legacy);
    assert.deepEqual(todos, [{ id: 4, title: "old", done: true, dueDate: null, createdAt: "2023-01-01T00:00:00.000Z" }]);
    assert.equal(JSON.parse(serialize(todos))[0].dueDate, null);
});

test("saved data with an invalid dueDate is rejected", () => {
    const text = '[{"id":1,"title":"x","done":false,"dueDate":"garbage","createdAt":"c"}]';
    badDate(() => deserialize(text));
    badDate(() => api().load(text));
});

test("formatTodo", () => {
    const todo = { id: 1, title: "Pay rent", done: false, dueDate: "2024-05-01" };
    assert.equal(formatTodo({ ...todo, dueDate: null }), "[ ] Pay rent");
    assert.equal(formatTodo(todo), "[ ] Pay rent (due 2024-05-01)");
    assert.equal(formatTodo(todo, "2024-05-01"), "[ ] Pay rent (due 2024-05-01)");
    assert.equal(formatTodo(todo, "2024-05-02"), "[ ] Pay rent (due 2024-05-01) OVERDUE");
    assert.equal(formatTodo({ ...todo, done: true }, "2024-05-02"), "[x] Pay rent (due 2024-05-01)");
    assert.equal(formatTodo({ ...todo, dueDate: null }, "2024-05-02"), "[ ] Pay rent");
    assert.equal(formatList([todo, { ...todo, title: "B", dueDate: null }], "2024-06-01"), "[ ] Pay rent (due 2024-05-01) OVERDUE\n[ ] B");
});

test("list filters and sorts", () => {
    const todos = api();
    todos.add({ title: "late", dueDate: "2024-04-01" });
    todos.add({ title: "soon", dueDate: "2024-05-02" });
    todos.add({ title: "none" });
    todos.add({ title: "later still", dueDate: "2024-04-01" });
    todos.add({ title: "done late", dueDate: "2024-01-01" });
    todos.complete(5);
    todos.add({ title: "today", dueDate: "2024-05-01" });
    const titles = (options) => todos.list(options).map((t) => t.title);
    assert.deepEqual(titles({ filter: "overdue" }), ["late", "later still"]);
    assert.deepEqual(titles({ filter: "open", sort: "due" }), ["late", "later still", "today", "soon", "none"]);
    assert.deepEqual(titles({ sort: "due" }), ["done late", "late", "later still", "today", "soon", "none"]);
    assert.deepEqual(titles({ filter: "done" }), ["done late"]);
    assert.deepEqual(titles(), ["late", "soon", "none", "later still", "done late", "today"]);
    assert.throws(() => todos.list({ filter: "weird" }), RangeError);
});

test("render marks overdue todos using the clock", () => {
    const todos = api();
    todos.add({ title: "old", dueDate: "2024-04-30" });
    todos.add({ title: "fine", dueDate: "2024-05-01" });
    todos.add({ title: "plain" });
    assert.equal(todos.render(), "[ ] old (due 2024-04-30) OVERDUE\n[ ] fine (due 2024-05-01)\n[ ] plain");
});
