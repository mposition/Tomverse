import { z } from "zod";

export const MAX_TERMINALS_PER_TASK = 4;
export const MAX_TERMINALS_TOTAL = 16;
export const MAX_TERMINAL_INPUT_CHARACTERS = 16_384;
export const MAX_TERMINAL_ATTACHMENT_CHARACTERS = 8_000;
export const TERMINAL_COLUMNS = { min: 20, max: 500 } as const;
export const TERMINAL_ROWS = { min: 4, max: 200 } as const;

/** A session id or a native history id; the host resolves it against the task it has open, never against a path. */
export const terminalTask = z.string().regex(/^[\w.:-]{1,160}$/);
const terminal = z.uuid();
const columns = z.number().int().min(TERMINAL_COLUMNS.min).max(TERMINAL_COLUMNS.max);
const rows = z.number().int().min(TERMINAL_ROWS.min).max(TERMINAL_ROWS.max);

/** What the window may ask of the terminals. It names the task and terminal, never a folder, shell or program. */
export const terminalCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("list"), task: terminalTask }).strict(),
  z.object({ type: z.literal("open"), task: terminalTask, cols: columns, rows }).strict(),
  z.object({ type: z.literal("attach"), terminal }).strict(),
  z.object({ type: z.literal("input"), terminal, data: z.string().min(1).max(MAX_TERMINAL_INPUT_CHARACTERS) }).strict(),
  z.object({ type: z.literal("resize"), terminal, cols: columns, rows }).strict(),
  z.object({ type: z.literal("share"), terminal, shared: z.boolean() }).strict(),
  z.object({ type: z.literal("close"), terminal }).strict(),
  z.object({ type: z.literal("set-enabled"), enabled: z.boolean() }).strict(),
]);
export type TerminalCommand = z.infer<typeof terminalCommand>;

export type TerminalInfo = {
  id: string;
  /** 1-based position among the task's terminals, the number the agent uses. */
  index: number;
  kind: "pty" | "pipe";
  running: boolean;
  exitCode: number | null;
  /** The agent may read this terminal's output. */
  shared: boolean;
};
export type TerminalListing = { enabled: boolean; terminals: TerminalInfo[] };
export type TerminalReplayResult = { data: string; seq: number } | null;

export type TerminalEvent =
  | { type: "output"; terminal: string; seq: number; data: string }
  | { type: "changed"; task: string; terminals: TerminalInfo[] };
