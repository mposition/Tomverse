import { createHash, randomUUID } from "node:crypto";
import type { ApprovalRequest, Change, Entry } from "../contract";
import { LIVE_CLI_LIMITS } from "../provider-cli-exec-contract";
import type { CliApproval, ExecEvent } from "./provider-cli-exec";

const mark = { running: "…", done: "✓", failed: "✗", declined: "⊘" } as const;
const oneLine = (value: string, max: number) => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * What the Code screen shows of a CLI run: the assistant's messages and one line per command or tool call in the order they
 * happened, the files the CLI reported changing, and the answer that is still being written. Everything is bounded, so a long
 * run cannot grow the task without limit. Text is passed through `clean` (credential and control-character removal) on the way in.
 */
export function createTranscript(clean: (text: string) => string) {
  const entries: Entry[] = [];
  const positions = new Map<string, number>();
  const changes = new Map<string, Change>();
  let streaming = "";
  let omitted = 0;
  let omittedAt = -1;

  const room = (message: boolean) => entries.length < LIVE_CLI_LIMITS.entries + (message ? 50 : 0);
  const place = (id: string, entry: Entry) => {
    const at = positions.get(id);
    if (at !== undefined) { entries[at] = entry; return; }
    if (!room(entry.role === "assistant")) {
      omitted += 1;
      const summary: Entry = { role: "event", text: `… +${omitted}` };
      if (omittedAt < 0) { omittedAt = entries.length; entries.push(summary); } else entries[omittedAt] = summary;
      return;
    }
    positions.set(id, entries.length);
    entries.push(entry);
  };

  const track = (path: string, kind: Change["kind"], current: Change["current"]) => {
    const previous = changes.get(path);
    const id = `cli:${createHash("sha256").update(path).digest("hex").slice(0, 16)}`;
    if (!previous && changes.size >= LIVE_CLI_LIMITS.changes) return;
    // A file the run created and then edited is still a created file.
    const merged = previous?.kind === "create" && kind === "update" ? "create" : kind;
    changes.set(path, { id, path, kind: merged, current: current === "failed" && previous?.current === "applied" ? "applied" : current });
  };

  return {
    apply(event: ExecEvent) {
      if (event.type === "delta") {
        streaming = (streaming + event.text).slice(-LIVE_CLI_LIMITS.message);
      } else if (event.type === "message") {
        streaming = "";
        place(`message:${event.id}`, { role: "assistant", text: clean(event.text) });
      } else if (event.type === "command") {
        const key = `tool:${event.id}`;
        const at = positions.get(key);
        const before = at === undefined ? undefined : entries[at];
        // The start names the command; the end (Claude Code) may not, so the start's text is kept.
        const command = event.command || (before?.role === "event" ? before.text.split("\n")[0]!.replace(/^\$ /, "").replace(/\s[…✓✗⊘]$/, "") : "");
        const head = `$ ${clean(oneLine(command, 200))} ${mark[event.state]}${event.exitCode ? ` ${event.exitCode}` : ""}`;
        const body = event.output ? `\n${clean(event.output.slice(-LIVE_CLI_LIMITS.commandOutput))}` : "";
        place(key, { role: "event", text: head + body });
      } else if (event.type === "tool") {
        place(`tool:${event.id}`, { role: "event", text: `⚙ ${clean(oneLine(`${event.name}${event.detail ? ` ${event.detail}` : ""}`, 200))} ${mark[event.state]}` });
      } else if (event.type === "files") {
        for (const file of event.files) {
          if (event.state === "running") continue;
          track(file.path, file.kind, event.state === "done" ? "applied" : "failed");
        }
      } else if (event.type === "notice" && event.text.trim()) {
        place(`notice:${entries.length}`, { role: "event", text: clean(event.text) });
      }
    },
    /** The transcript after the user's prompt. */
    get entries() { return entries; },
    get changes() { return [...changes.values()]; },
    get streaming() { return streaming; },
    clearStreaming() { streaming = ""; },
  };
}

/**
 * The approval card for something Claude Code asks to do. The card only shows what the CLI sent, as text; the answer is the
 * person's alone, and "run" (remember) is not offered because the CLI's own rule files are never written from here.
 */
export function approvalRequestFor(approval: CliApproval, root: string, clean: (text: string) => string): ApprovalRequest {
  const { input } = approval;
  const str = (value: unknown, max = 20_000) => (typeof value === "string" ? clean(value.slice(0, max)) : null);
  const base = { id: randomUUID(), root: clean(root), tool: clean(approval.tool.slice(0, 160)), canRemember: false } as const;
  if (approval.tool === "Bash" || approval.tool === "PowerShell") {
    const command = str(input.command, 8_000) ?? "";
    return { ...base, command: { mode: "shell", file: base.tool, args: [], cwd: clean(root), display: command, env: [],
      timeoutMs: typeof input.timeout === "number" && input.timeout > 0 ? Math.min(input.timeout, 3_600_000) : 120_000,
      ...(input.run_in_background === true ? { background: true } : {}) } };
  }
  const path = str(input.file_path, 2_048) ?? str(input.notebook_path, 2_048);
  if (path && (approval.tool === "Write" || approval.tool === "Edit" || approval.tool === "MultiEdit" || approval.tool === "NotebookEdit")) {
    const before = approval.tool === "Edit" ? str(input.old_string) : null;
    const after = approval.tool === "Write" ? str(input.content) : approval.tool === "Edit" ? str(input.new_string) : str(JSON.stringify(input), 8_000);
    return { ...base, files: [{ path, action: approval.tool === "Write" ? "create" : "update", eol: "lf", bom: false,
      preimage: null, postimage: null, before, after }] };
  }
  return { ...base, explanation: clean(JSON.stringify(input, null, 2).slice(0, 4_000)) };
}
