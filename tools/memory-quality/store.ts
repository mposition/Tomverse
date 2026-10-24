import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Event, RunStore } from "./runner";
import { QualityStop } from "./runner";

export function runPath(output: string, id: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new QualityStop("invalid_run_id");
  return join(resolve(output), id);
}
const missing = (error: unknown) => (error as { code?: string }).code === "ENOENT";
export async function readEvents(directory: string): Promise<Event[]> {
  const source = await readFile(join(directory, "events.jsonl"), "utf8");
  return source.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
export async function createRunStore(output: string): Promise<RunStore & { id: string; directory: string }> {
  await mkdir(resolve(output), { recursive: true });
  const id = new Date().toISOString().replace(/[^0-9TZ]/g, "") + "-" + randomUUID();
  const directory = runPath(output, id);
  await mkdir(directory);
  await writeFile(join(directory, "events.jsonl"), "", { flag: "wx" });
  let sequence = 0, finished = false;
  return {
    id, directory,
    record: async (event) => {
      if (finished) throw new QualityStop("run_finished");
      await appendFile(join(directory, "events.jsonl"),
        JSON.stringify({ ...event, sequence: ++sequence, at: new Date().toISOString() }) + "\n");
      if (event.type === "finished") {
        await writeFile(join(directory, "result.json"), JSON.stringify(event, null, 2) + "\n", { flag: "wx" });
        finished = true;
      }
    },
    stopped: async () => {
      try { await readFile(join(directory, "stop.json")); return true; }
      catch (error) { if (missing(error)) return false; throw error; }
    },
  };
}
export async function requestStop(output: string, id: string) {
  const directory = runPath(output, id);
  await readFile(join(directory, "events.jsonl"));
  try {
    await readFile(join(directory, "result.json"));
    throw new QualityStop("run_finished");
  } catch (error) { if (!missing(error)) throw error; }
  try {
    await writeFile(join(directory, "stop.json"), JSON.stringify({ requestedAt: new Date().toISOString() }),
      { flag: "wx" });
  } catch (error) { if ((error as { code?: string }).code !== "EEXIST") throw error; }
  return { id, stopRequested: true };
}
export async function listRuns(output: string) {
  let entries;
  try { entries = await readdir(resolve(output), { withFileTypes: true }); }
  catch (error) { if (missing(error)) return []; throw error; }
  return Promise.all(entries.filter((entry) => entry.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))
    .map(async (entry) => {
      try {
        const result = JSON.parse(await readFile(join(runPath(output, entry.name), "result.json"), "utf8"));
        return { id: entry.name, state: "finished", ...result };
      } catch (error) {
        if (missing(error)) return { id: entry.name, state: "unfinished" };
        return { id: entry.name, state: "unreadable" };
      }
    }));
}
