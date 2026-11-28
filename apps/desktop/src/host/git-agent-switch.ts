import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const record = z.object({ enabled: z.boolean() }).strict();

/** Whether the person let the agent propose commits and pushes. Off until they turn it on; every proposal still needs an approval card. */
export function readAgentGitSwitch(file: string | undefined): boolean {
  if (!file) return false;
  try { return record.parse(JSON.parse(readFileSync(file, "utf8"))).enabled; }
  catch { return false; }
}

export function writeAgentGitSwitch(file: string, enabled: boolean) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = file + ".tmp";
  writeFileSync(temporary, JSON.stringify({ enabled }), { mode: 0o600 });
  renameSync(temporary, file);
}
