import assert from "node:assert/strict";
import test from "node:test";
import { MAX_TERMINAL_INPUT_CHARACTERS, terminalCommand } from "../src/terminal-contract";

const id = "7f0e2c1a-5b1d-4d55-8a58-0d3b8e9a6f10";

test("the window can only name a task or a terminal, never a folder, shell or program", () => {
  for (const command of [
    { type: "list", task: "s-20261126-101010-abcdef" },
    { type: "open", task: "s-20261126-101010-abcdef", cols: 80, rows: 24 },
    { type: "attach", terminal: id },
    { type: "input", terminal: id, data: "echo hi\r" },
    { type: "resize", terminal: id, cols: 120, rows: 40 },
    { type: "share", terminal: id, shared: false },
    { type: "close", terminal: id },
    { type: "set-enabled", enabled: true },
  ]) assert.deepEqual(terminalCommand.parse(command), command);
  for (const extra of ["cwd", "shell", "file", "args", "env", "path"]) {
    assert.throws(() => terminalCommand.parse({ type: "open", task: "s-1", cols: 80, rows: 24, [extra]: "C:/Windows" }), /./, extra);
  }
});

test("task ids, terminal ids, sizes and input are bounded", () => {
  for (const bad of [
    { type: "open", task: "../../etc", cols: 80, rows: 24 },
    { type: "open", task: "a b", cols: 80, rows: 24 },
    { type: "open", task: "t", cols: 5, rows: 24 },
    { type: "open", task: "t", cols: 80, rows: 1000 },
    { type: "open", task: "t", cols: 80.5, rows: 24 },
    { type: "attach", terminal: "not-a-uuid" },
    { type: "input", terminal: id, data: "" },
    { type: "input", terminal: id, data: "x".repeat(MAX_TERMINAL_INPUT_CHARACTERS + 1) },
    { type: "share", terminal: id, shared: "yes" },
    { type: "spawn", task: "t" },
  ]) assert.throws(() => terminalCommand.parse(bad), /./s, JSON.stringify(bad).slice(0, 60));
});
