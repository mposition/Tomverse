import { randomUUID } from "node:crypto";
import { MAX_TERMINALS_PER_TASK, MAX_TERMINALS_TOTAL, type TerminalEvent, type TerminalInfo, type TerminalReplayResult } from "../terminal-contract";
import type { TerminalReadReply } from "../../../tomverse-cli/src/terminal-read.js";
import { ScrollbackBuffer } from "./terminal-buffer";
import type { TerminalLaunch, TerminalSession } from "./terminal-session";

type Entry = {
  id: string;
  task: string;
  index: number;
  session: TerminalSession;
  buffer: ScrollbackBuffer;
  running: boolean;
  exitCode: number | null;
  shared: boolean;
  touched: number;
};

export type TerminalHostOptions = {
  launch: TerminalLaunch;
  env: () => Record<string, string>;
  emit: (event: TerminalEvent) => void;
  perTask?: number;
  total?: number;
  scrollback?: number;
};

/**
 * The terminals of every open task. The host owns the shells: the window only names a task or a terminal. The folder a
 * terminal starts in is given by the caller for the task, never by the window. A task keeps its terminals, and their
 * scrollback, while another task is on screen.
 */
export class TerminalHost {
  private readonly entries = new Map<string, Entry>();
  private clock = 0;

  constructor(private readonly options: TerminalHostOptions) {}

  private forTask(task: string) {
    return [...this.entries.values()].filter((entry) => entry.task === task).sort((a, b) => a.index - b.index);
  }

  private info(entry: Entry): TerminalInfo {
    return { id: entry.id, index: entry.index, kind: entry.session.kind, running: entry.running, exitCode: entry.exitCode, shared: entry.shared };
  }

  private changed(task: string) {
    this.options.emit({ type: "changed", task, terminals: this.list(task) });
  }

  get count() { return this.entries.size; }

  list(task: string): TerminalInfo[] {
    return this.forTask(task).map((entry) => this.info(entry));
  }

  open(task: string, cwd: string, cols: number, rows: number): TerminalInfo {
    const open = this.forTask(task);
    if (open.length >= (this.options.perTask ?? MAX_TERMINALS_PER_TASK)) throw new Error("Close a terminal before opening another.");
    if (this.entries.size >= (this.options.total ?? MAX_TERMINALS_TOTAL)) throw new Error("Too many terminals are open. Close one first.");
    const used = new Set(open.map((entry) => entry.index));
    let index = 1;
    while (used.has(index)) index += 1;
    const id = randomUUID();
    const buffer = new ScrollbackBuffer(this.options.scrollback);
    const created: { entry?: Entry } = {};
    const session = this.options.launch({
      cwd, cols, rows, env: this.options.env(),
      onData: (data) => {
        const seq = buffer.push(data);
        if (created.entry && this.entries.get(id) === created.entry) this.options.emit({ type: "output", terminal: id, seq, data });
      },
      onExit: (code) => {
        const entry = created.entry;
        if (!entry || this.entries.get(id) !== entry) return;
        entry.running = false;
        entry.exitCode = code;
        this.changed(task);
      },
    });
    const entry: Entry = { id, task, index, session, buffer, running: true, exitCode: null, shared: true, touched: ++this.clock };
    created.entry = entry;
    this.entries.set(id, entry);
    this.changed(task);
    return this.info(entry);
  }

  attach(id: string): TerminalReplayResult {
    const entry = this.entries.get(id);
    if (!entry) return null;
    entry.touched = ++this.clock;
    return entry.buffer.replay();
  }

  input(id: string, data: string) {
    const entry = this.entries.get(id);
    if (!entry?.running) return;
    entry.touched = ++this.clock;
    entry.session.write(data);
  }

  resize(id: string, cols: number, rows: number) {
    const entry = this.entries.get(id);
    if (entry?.running) entry.session.resize(cols, rows);
  }

  share(id: string, shared: boolean) {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.shared = shared;
    this.changed(entry.task);
  }

  async close(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.changed(entry.task);
    await entry.session.kill().catch(() => {});
  }

  async closeTask(task: string) {
    await Promise.all(this.forTask(task).map((entry) => this.close(entry.id)));
  }

  /** Ends the terminals of every task that is not in `keep`: a deleted task, or one from a project that is no longer open. */
  async retainTasks(keep: ReadonlySet<string>) {
    const gone = new Set([...this.entries.values()].filter((entry) => !keep.has(entry.task)).map((entry) => entry.task));
    await Promise.all([...gone].map((task) => this.closeTask(task)));
  }

  async closeAll() {
    await Promise.all([...this.entries.keys()].map((id) => this.close(id)));
  }

  /** The app is quitting: end every shell tree without waiting. */
  closeAllSync() {
    const all = [...this.entries.values()];
    this.entries.clear();
    for (const entry of all) {
      try { entry.session.killSync(); } catch { /* Already gone. */ }
    }
  }

  /** What the agent may read: only shared terminals, newest output as plain text. */
  read(task: string, request: { terminal?: number; lines: number }): TerminalReadReply {
    const shared = this.forTask(task).filter((entry) => entry.shared);
    const terminals = shared.map((entry) => ({ index: entry.index, running: entry.running, exitCode: entry.exitCode }));
    const chosen = request.terminal === undefined
      ? [...shared].sort((a, b) => b.touched - a.touched)[0]
      : shared.find((entry) => entry.index === request.terminal);
    return { terminals, terminal: chosen?.index ?? null, text: chosen ? chosen.buffer.tail(request.lines) : "" };
  }
}

