// The ops-observer Dockerfile, judged instruction by instruction rather than
// by searching its text (docs/policy/sre-ops.md §3 rule 6): one stage, a
// digest-pinned base, no ARG and no secret mount anywhere, no ENV that names a
// runtime secret, the build-environment gate as the first command after FROM,
// and nothing copied ahead of the gate but the gate's own import closure.
// Each rule is also run against a broken variant, so a parser that stopped
// seeing an instruction would fail here instead of passing everything.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SERVICE_VARIABLES,
  isCredentialShaped,
} from "../scripts/ops-observer/runtime-variables-core.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCKERFILE = readFileSync(join(ROOT, "docker", "ops-observer.Dockerfile"), "utf8");
const GATE = "scripts/ops-observer/build-env-gate.mjs";
const EXECUTING = new Set(["RUN", "CMD", "ENTRYPOINT", "SHELL"]);

/** Dockerfile instructions: comments dropped, continuations joined. */
function parseDockerfile(text) {
  const instructions = [];
  let pending = "";
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    if (pending === "" && (line === "" || line.startsWith("#"))) continue;
    if (line.endsWith("\\")) {
      pending += `${line.slice(0, -1)} `;
      continue;
    }
    const full = `${pending}${line}`.replace(/\s+/g, " ").trim();
    pending = "";
    const match = /^([A-Za-z]+)\s*(.*)$/.exec(full);
    if (match) instructions.push({ keyword: match[1].toUpperCase(), args: match[2] });
  }
  if (pending !== "") instructions.push({ keyword: "UNTERMINATED", args: pending });
  return instructions;
}

/** The relative-import closure of a module, as repository paths. */
function importClosure(entry) {
  const seen = new Set();
  const visit = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    const source = readFileSync(join(ROOT, path), "utf8");
    for (const [, specifier] of source.matchAll(/^\s*(?:import|export)\b[^"']*?from\s+["'](\.[^"']+)["']/gm)) {
      visit(normalize(join(dirname(path), specifier)).replaceAll("\\", "/"));
    }
  };
  visit(entry);
  return seen;
}

const SERVICE_NAMES = new Set(Object.values(SERVICE_VARIABLES).flat());

/** Every rule this file is held to; returns the broken rules. */
function problems(text) {
  const found = [];
  const instructions = parseDockerfile(text);
  if (instructions.some((i) => i.keyword === "UNTERMINATED")) found.push("unterminated");

  const froms = instructions.filter((i) => i.keyword === "FROM");
  if (froms.length !== 1 || instructions[0]?.keyword !== "FROM") found.push("single_stage");
  if (!/^[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/.test(froms[0]?.args ?? "")) found.push("base_digest");
  if (instructions.some((i) => i.keyword === "COPY" && /--from\b/.test(i.args))) found.push("single_stage");

  if (instructions.some((i) => i.keyword === "ARG")) found.push("arg");
  if (instructions.some((i) => /--mount=[^\s]*type=secret/.test(i.args))) found.push("secret_mount");
  for (const env of instructions.filter((i) => i.keyword === "ENV")) {
    for (const [, name] of env.args.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)) {
      if (isCredentialShaped(name) || SERVICE_NAMES.has(name)) found.push("env_secret");
    }
  }

  const firstExecuting = instructions.findIndex((i) => EXECUTING.has(i.keyword));
  const gate = instructions[firstExecuting];
  if (!gate || gate.keyword !== "RUN" || gate.args !== `node ${GATE}`) found.push("gate_first");

  const allowed = importClosure(GATE);
  const copiedBefore = instructions
    .slice(0, Math.max(firstExecuting, 0))
    .filter((i) => i.keyword === "COPY" || i.keyword === "ADD");
  const copiedPaths = new Set();
  for (const copy of copiedBefore) {
    const [source, destination, ...rest] = copy.args.split(/\s+/);
    if (copy.keyword !== "COPY" || rest.length > 0 || source !== destination || !allowed.has(source)) {
      found.push("copied_before_gate");
    }
    copiedPaths.add(source);
  }
  if ([...allowed].some((path) => !copiedPaths.has(path))) found.push("gate_closure_incomplete");
  return [...new Set(found)];
}

test("the ops-observer Dockerfile keeps every build rule", () => {
  assert.deepEqual(problems(DOCKERFILE), []);
  // The gate copied ahead of itself is exactly the gate and the module it imports.
  assert.deepEqual([...importClosure(GATE)].sort(), [GATE, "scripts/ops-observer/runtime-variables-core.mjs"]);
});

test("each rule catches its own violation", () => {
  const variant = (from, to) => {
    assert.ok(DOCKERFILE.includes(from), from);
    return DOCKERFILE.replace(from, to);
  };
  const gateLine = `RUN node ${GATE}`;
  const cases = [
    ["single_stage", variant("WORKDIR /observer", "FROM node:22-alpine AS second\nWORKDIR /observer")],
    ["base_digest", variant(/FROM \S+/.exec(DOCKERFILE)[0], "FROM node:22-alpine")],
    ["arg", variant("WORKDIR /observer", "ARG OPS_OBSERVER_SECRET\nWORKDIR /observer")],
    ["secret_mount", variant("RUN printf", "RUN --mount=type=secret,id=x printf")],
    ["env_secret", variant("ENV NODE_ENV=production", "ENV NODE_ENV=production OPS_OBSERVER_SECRET=x")],
    ["env_secret", variant("ENV NODE_ENV=production", "ENV DATABASE_URL=postgres://x")],
    ["gate_first", variant("WORKDIR /observer", "WORKDIR /observer\nRUN echo before")],
    ["gate_first", variant(gateLine, "RUN node scripts/ops-observer/build-env-gate.mjs || true")],
    ["copied_before_gate", variant(gateLine, `COPY package.json package.json\n${gateLine}`)],
    ["copied_before_gate", variant(gateLine, `ADD ${GATE} ${GATE}\n${gateLine}`)],
    ["gate_closure_incomplete", variant("COPY scripts/ops-observer/runtime-variables-core.mjs scripts/ops-observer/runtime-variables-core.mjs\n", "")],
    ["unterminated", `${DOCKERFILE}\nRUN echo \\`],
  ];
  for (const [rule, text] of cases) {
    assert.ok(problems(text).includes(rule), `${rule}: ${problems(text).join(",")}`);
  }
});

test("continuations and comments are read as the instructions they are", () => {
  assert.deepEqual(parseDockerfile("# c\nFROM a\nRUN one \\\n  two\n\n# x\nENV A=1"), [
    { keyword: "FROM", args: "a" },
    { keyword: "RUN", args: "one two" },
    { keyword: "ENV", args: "A=1" },
  ]);
});
