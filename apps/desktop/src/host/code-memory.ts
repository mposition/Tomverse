import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectMemory, memoryFileFor, writeFileAtomic } from "../../../tomverse-cli/src/runtime.js";
import type { CodeMemoryView } from "../contract";
import type { ProjectRoot } from "./project-root";

/**
 * The agent's notes about a project, for Desktop Code. They live in Desktop's own data folder (which the file tools never touch),
 * one file per project, with one switch for all of them. Off means off: the task runtime is given no memory, so it reads and
 * writes nothing.
 */

const settingsFile = (directory: string) => join(directory, "settings.json");

export function codeMemoryEnabled(directory: string): boolean {
  try { return (JSON.parse(readFileSync(settingsFile(directory), "utf8")) as { enabled?: unknown }).enabled !== false; }
  catch { return true; }
}

export function setCodeMemoryEnabled(directory: string, enabled: boolean) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileAtomic(settingsFile(directory), JSON.stringify({ enabled }));
}

export const codeMemoryFile = (directory: string, project: ProjectRoot) =>
  memoryFileFor(directory, JSON.stringify([project.path, project.identity]));

/** The memory a task of this project gets, or none when the person turned memory off. */
export function codeMemoryFor(directory: string | undefined, project: ProjectRoot, redact: (text: string) => string): ProjectMemory | undefined {
  if (!directory || !codeMemoryEnabled(directory)) return undefined;
  return new ProjectMemory(codeMemoryFile(directory, project), project.path, redact);
}

/** What the settings screen shows and changes. */
export function codeMemoryView(directory: string, project: ProjectRoot | null, change?:
  { action: "clear" } | { action: "remove"; id: string } | { action: "set-enabled"; enabled: boolean } | { action: "read" }): CodeMemoryView {
  if (change?.action === "set-enabled") setCodeMemoryEnabled(directory, change.enabled);
  const memory = project ? new ProjectMemory(codeMemoryFile(directory, project), project.path) : undefined;
  if (memory && change?.action === "clear") memory.clear();
  if (memory && change?.action === "remove") memory.remove(change.id);
  return { enabled: codeMemoryEnabled(directory), project: !!project, entries: memory?.list() ?? [] };
}
