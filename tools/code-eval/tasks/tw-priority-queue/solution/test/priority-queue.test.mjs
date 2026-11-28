import { test } from "node:test";
import assert from "node:assert/strict";
import { PriorityQueue } from "../src/index.js";

test("smallest priority number leaves first", () => {
    const q = new PriorityQueue();
    q.push("c", 3).push("a", 1).push("b", 2);
    assert.equal(q.pop(), "a");
    assert.equal(q.pop(), "b");
    assert.equal(q.pop(), "c");
});

test("equal priorities leave in insertion order", () => {
    const q = new PriorityQueue();
    for (const name of ["a", "b", "c", "d", "e", "f"]) q.push(name, 1);
    assert.deepEqual(q.drain(), ["a", "b", "c", "d", "e", "f"]);
    q.push("x", 2).push("y", 1).push("z", 2).push("w", 1);
    assert.deepEqual(q.drain(), ["y", "w", "x", "z"]);
});

test("a smaller priority pushed later overtakes", () => {
    const q = new PriorityQueue();
    q.push("late", 5);
    q.push("early", 3);
    assert.equal(q.peek(), "early");
    assert.equal(q.pop(), "early");
});

test("many items come out sorted", () => {
    const q = new PriorityQueue();
    const priorities = [9, 4, 7, 1, 8, 2, 6, 3, 5, 0, 12, 11, 10, 15, 14, 13];
    for (const p of priorities) q.push(`p${p}`, p);
    assert.deepEqual(q.drain(), [...priorities].sort((a, b) => a - b).map((p) => `p${p}`));
});

test("works with negative and fractional priorities", () => {
    const q = new PriorityQueue();
    q.push("a", 0.5).push("b", -1).push("c", 0).push("d", -1.5);
    assert.deepEqual(q.drain(), ["d", "b", "c", "a"]);
});

test("default priority is 0", () => {
    const q = new PriorityQueue();
    q.push("neg", -1).push("none").push("pos", 1);
    assert.deepEqual(q.drain(), ["neg", "none", "pos"]);
});

test("peek does not remove", () => {
    const q = new PriorityQueue();
    q.push("a", 1).push("b", 2);
    assert.equal(q.peek(), "a");
    assert.equal(q.peek(), "a");
    assert.equal(q.size, 2);
    assert.equal(q.pop(), "a");
});

test("empty queue", () => {
    const q = new PriorityQueue();
    assert.equal(q.pop(), undefined);
    assert.equal(q.peek(), undefined);
    assert.equal(q.size, 0);
    assert.equal(q.isEmpty(), true);
    assert.deepEqual(q.drain(), []);
});

test("size and isEmpty follow pushes and pops", () => {
    const q = new PriorityQueue();
    q.push("a", 1);
    assert.equal(q.size, 1);
    assert.equal(q.isEmpty(), false);
    q.push("b", 2);
    assert.equal(q.size, 2);
    q.pop();
    assert.equal(q.size, 1);
    assert.equal(q.isEmpty(), false);
    q.pop();
    assert.equal(q.size, 0);
    assert.equal(q.isEmpty(), true);
});

test("push is chainable and returns the queue", () => {
    const q = new PriorityQueue();
    assert.equal(q.push("a", 1), q);
});

test("drain empties the queue", () => {
    const q = new PriorityQueue();
    q.push("a", 2).push("b", 1).push("c", 3);
    assert.deepEqual(q.drain(), ["b", "a", "c"]);
    assert.equal(q.size, 0);
    assert.equal(q.isEmpty(), true);
});

test("invalid priorities throw TypeError and leave the queue unchanged", () => {
    const q = new PriorityQueue();
    for (const bad of ["1", NaN, null, {}, true]) assert.throws(() => q.push("x", bad), TypeError, String(bad));
    assert.equal(q.size, 0);
});

test("the same item may be queued twice", () => {
    const q = new PriorityQueue();
    q.push("dup", 2).push("dup", 1);
    assert.deepEqual(q.drain(), ["dup", "dup"]);
});
