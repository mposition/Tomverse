import { createHash, randomUUID } from "node:crypto";
import { commandNamesSecretPath, isSecretPath } from "../../../tomverse-cli/src/workspace.js";
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

const SHOWN_LIMITS = { command: 8_000, content: 20_000, path: 2_048, other: 4_000 } as const;
const JSON_LIMIT = SHOWN_LIMITS.other;

/**
 * The approval card for something Claude Code asks to do, or null when it must not be asked: a request the card cannot show
 * in full (a longer command or file text would be approved unseen), or one naming a file that can hold credentials. The
 * answer is the person's alone, and "run" (remember) is not offered because the CLI's own rule files are never written from here.
 * Every field of the request is on the card: the ones that have no place of their own go into the explanation.
 */
export function approvalRequestFor(approval: CliApproval, root: string, clean: (text: string) => string): ApprovalRequest | null {
  const { input } = approval;
  // A value is shown whole or not at all.
  const whole = (value: unknown, max: number): string | null | undefined =>
    value === undefined ? undefined : typeof value === "string" && value.length <= max ? clean(value) : null;
  const base = { id: randomUUID(), root: clean(root), tool: clean(approval.tool.slice(0, 160)), canRemember: false } as const;
  const rest = (shown: readonly string[]) => {
    const extras = Object.fromEntries(Object.entries(input).filter(([key]) => !shown.includes(key)));
    if (!Object.keys(extras).length) return {};
    const json = JSON.stringify(extras, null, 2);
    return json.length <= JSON_LIMIT ? { explanation: clean(json) } : null;
  };
  if (approval.tool === "Bash" || approval.tool === "PowerShell") {
    const command = whole(input.command, SHOWN_LIMITS.command);
    const extras = rest(["command", "timeout", "run_in_background"]);
    // A command naming a credential file is refused, never shown: Claude Code's deny rules cover its file tools, and its own
    // read-only checks cover only the commands it runs without asking, so a command it asks about could read one if approved.
    // Every word is checked, a bare `credentials` or `secret` too: a refused command is one the CLI cannot run, never one run unseen.
    if (typeof command !== "string" || commandNamesSecretPath(String(input.command), { everyWord: true }) || !extras ||
        (input.timeout !== undefined && typeof input.timeout !== "number") ||
        (input.run_in_background !== undefined && typeof input.run_in_background !== "boolean")) return null;
    return { ...base, ...extras, command: { mode: "shell", file: base.tool, args: [], cwd: clean(root), display: command, env: [],
      timeoutMs: typeof input.timeout === "number" && input.timeout > 0 ? Math.min(input.timeout, 3_600_000) : 120_000,
      ...(input.run_in_background === true ? { background: true } : {}) } };
  }
  const named = whole(input.file_path ?? input.notebook_path, SHOWN_LIMITS.path);
  if (approval.tool === "Write" || approval.tool === "Edit" || approval.tool === "MultiEdit" || approval.tool === "NotebookEdit") {
    if (typeof named !== "string" || isSecretPath(named)) return null;
    const file = { path: named, action: approval.tool === "Write" ? "create" : "update", eol: "lf", bom: false, preimage: null, postimage: null } as const;
    if (approval.tool === "Write") {
      const content = whole(input.content, SHOWN_LIMITS.content);
      const extras = rest(["file_path", "content"]);
      return typeof content === "string" && extras ? { ...base, ...extras, files: [{ ...file, before: null, after: content }] } : null;
    }
    if (approval.tool === "Edit") {
      const old = whole(input.old_string, SHOWN_LIMITS.content);
      const replacement = whole(input.new_string, SHOWN_LIMITS.content);
      const extras = rest(["file_path", "old_string", "new_string"]);
      return typeof old === "string" && typeof replacement === "string" && extras
        ? { ...base, ...extras, files: [{ ...file, before: old, after: replacement }] } : null;
    }
    const serialized = JSON.stringify(input, null, 2);
    return serialized.length <= SHOWN_LIMITS.content ? { ...base, files: [{ ...file, before: null, after: clean(serialized) }] } : null;
  }
  // Any other tool: its whole input is the card.
  const json = JSON.stringify(input, null, 2);
  const path = typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : undefined;
  if (json.length > JSON_LIMIT || (path !== undefined && isSecretPath(path))) return null;
  return { ...base, explanation: clean(json) };
}
