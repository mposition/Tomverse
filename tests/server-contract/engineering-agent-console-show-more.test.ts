// The engineering console's lists end in a next page, not at 50 rows (owner
// decision 2026-11-15: no display cap): a read asks for one page more than it
// shows, says whether more wait, and a page asks for more with `?limit=`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;

let runs: Array<Record<string, unknown>> = [];
const takes: number[] = [];
const run = (index: number) => ({ id: `run-${index}`, cardId: "card", cardKind: "amux", status: "ended", outcome: "succeeded",
  halt: null, modeAtStart: "t1", startedAt: new Date(Date.UTC(2026, 10, 1, 0, 0, index)), endedAt: null });

mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  engineeringAgentRun: { findMany: async (args: { take: number }) => { takes.push(args.take); return runs.slice(0, args.take); } },
} } });

const console = import(mod("lib/engineeringAgentConsoleRead.ts"));

test("a list reads one more row than it shows and says when more wait", async () => {
  const { readEngineeringAgentConsole, ENGINEERING_AGENT_CONSOLE_LIMIT } = await console;
  runs = Array.from({ length: ENGINEERING_AGENT_CONSOLE_LIMIT + 7 }, (_, index) => run(index));
  const first = await readEngineeringAgentConsole("runs", false);
  assert.equal(first.runs.length, ENGINEERING_AGENT_CONSOLE_LIMIT);
  assert.equal(first.more, true);
  assert.equal(takes.at(-1), ENGINEERING_AGENT_CONSOLE_LIMIT + 1);
  const all = await readEngineeringAgentConsole("runs", false, false, 2 * ENGINEERING_AGENT_CONSOLE_LIMIT);
  assert.equal(all.runs.length, ENGINEERING_AGENT_CONSOLE_LIMIT + 7);
  assert.equal(all.more, false);
});

test("a page asks for a whole number of rows from one page up to the maximum, and links the next page", async () => {
  const { engineeringAgentConsoleRequestedLimit, ENGINEERING_AGENT_CONSOLE_LIMIT, ENGINEERING_AGENT_CONSOLE_MAX_LIMIT } = await console;
  assert.equal(engineeringAgentConsoleRequestedLimit(undefined), ENGINEERING_AGENT_CONSOLE_LIMIT);
  assert.equal(engineeringAgentConsoleRequestedLimit("150"), 150);
  assert.equal(engineeringAgentConsoleRequestedLimit("3"), ENGINEERING_AGENT_CONSOLE_LIMIT);
  assert.equal(engineeringAgentConsoleRequestedLimit("99999"), ENGINEERING_AGENT_CONSOLE_MAX_LIMIT);
  for (const bad of ["-1", "1e3", "abc", ["100"]]) assert.equal(engineeringAgentConsoleRequestedLimit(bad), ENGINEERING_AGENT_CONSOLE_LIMIT);
  const page = readFileSync(resolve(root, "app/(site)/(application)/admin/engineering-agent/page.tsx"), "utf8");
  assert.match(page, /engineeringAgentConsoleRequestedLimit\(query\.limit\)/);
  assert.match(page, /<AdminEngineeringAgentPanel key=\{section\} initial=\{initial\} more=\{moreHref\} \/>/);
  const panel = readFileSync(resolve(root, "components/admin/AdminEngineeringAgentPanel.tsx"), "utf8");
  assert.equal((panel.match(/\{more \? <MoreLink /g) ?? []).length, 3, "the queue, the runs and the pull requests");
});
