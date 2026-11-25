import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, tokenize } from "../src/index.js";

test("numbers and whitespace", () => {
    assert.equal(evaluate("42"), 42);
    assert.equal(evaluate("  1+   2  "), 3);
    assert.equal(evaluate("1.5 + 1"), 2.5);
    assert.equal(evaluate(".5 * 4"), 2);
    assert.equal(evaluate("5. + 1"), 6);
});

test("tokenizer", () => {
    assert.deepEqual(tokenize("12 + (3.5*-4)"), [12, "+", "(", 3.5, "*", "-", 4, ")"]);
    assert.deepEqual(tokenize("   "), []);
    assert.throws(() => tokenize("2 $ 3"), SyntaxError);
});

test("precedence", () => {
    assert.equal(evaluate("2 + 3 * 4"), 14);
    assert.equal(evaluate("(2 + 3) * 4"), 20);
    assert.equal(evaluate("2 * 3 + 4 * 5"), 26);
    assert.equal(evaluate("10 - 6 / 2"), 7);
});

test("left associativity", () => {
    assert.equal(evaluate("10 - 3 - 2"), 5);
    assert.equal(evaluate("100 / 10 / 5"), 2);
    assert.equal(evaluate("2 - 3 + 4"), 3);
    assert.equal(evaluate("20 % 7 % 4"), 2);
});

test("division and remainder", () => {
    assert.equal(evaluate("7 / 2"), 3.5);
    assert.equal(evaluate("7 % 4"), 3);
    assert.equal(evaluate("-7 % 4"), -3);
});

test("unary operators", () => {
    assert.equal(evaluate("-3 + 5"), 2);
    assert.equal(evaluate("--3"), 3);
    assert.equal(evaluate("2 * -3"), -6);
    assert.equal(evaluate("+4"), 4);
    assert.equal(evaluate("-(2 + 3)"), -5);
});

test("division or remainder by zero", () => {
    assert.throws(() => evaluate("1 / 0"), (e) => e instanceof RangeError && e.message === "division by zero");
    assert.throws(() => evaluate("1 % 0"), RangeError);
    assert.throws(() => evaluate("5 / (2 - 2)"), RangeError);
});

test("syntax errors", () => {
    for (const bad of ["(1 + 2", "1 +", "1 2", "2 $ 3", "", "   ", ")", "(1 + 2))", "* 3", "1 + * 2", "()"]) {
        assert.throws(() => evaluate(bad), SyntaxError, JSON.stringify(bad));
    }
});
