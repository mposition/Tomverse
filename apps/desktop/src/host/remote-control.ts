import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  DESKTOP_REMOTE_COMMAND_TTL_MS, DESKTOP_REMOTE_LIMITS, desktopRemoteApproval, desktopRemoteSnapshot, desktopRemoteSyncResponse, desktopRemoteTask,
  type DesktopRemoteAck, type DesktopRemoteApproval, type DesktopRemoteApprovalKind, type DesktopRemoteCommand, type DesktopRemoteRefusal,
  type DesktopRemoteSnapshot, type DesktopRemoteTask,
} from "../../../../lib/desktopRemoteControlContract";
import { DESKTOP_APP_ORIGIN, DESKTOP_REMOTE_SYNC } from "../../../../lib/nativeBearerGate";
import { checkBoundaries, writeFileAtomic } from "../../../tomverse-cli/src/runtime.js";
import type { ApprovalRequest, Decision, RunStatus, Task } from "../contract";
import type { LaneKind } from "../parallel-contract";
import { remoteControlCommand, type RemoteControlStatus, type RemoteControlView } from "../remote-control-contract";
import { cleanText } from "./journal-view";

/**
 * Remote control of this PC from the account's other signed-in devices (docs/ops/desktop-remote-control.md).
 *
 * Off by default, per account. While it is on and a task runs, the main process reports a short, redacted summary to
 * the server every few seconds and picks up what the person answered on another device. It never opens a connection
 * the server could use to reach the PC, and it sends nothing while nothing runs.
 *
 * The approval itself stays here. A remote answer is applied only to the request on this PC's screen right now, with
 * the same id and the same digest of the whole request, only once, only within its lifetime, and only as "allow once"
 * or "deny". What may be answered from elsewhere is decided here, deterministically: file changes whose paths are all
 * shown, and commands whose whole line is shown and that the permission boundary does not leave to a person (nothing
 * that sends anything off this computer, names a credential file or the app's own data). A commit, push or pull request
 * card, an MCP tool, a web page, the browser panel and every Settings action are answered at the PC.
 *
 * No Electron here: main.ts passes in what only it knows as plain functions, and the tests drive this directly.
 */

export type RemoteAccount = {
  accountId: string;
  origin: string;
  /** The connected Code key, removed from every line before it leaves. */
  key?: string;
  authorize(): Promise<string>;
};

export type RemoteTaskSource = {
  key: string;
  kind: LaneKind;
  title: string;
  status: RunStatus | "queued";
  task: Task | null;
  canStop: boolean;
  canFollowUp: boolean;
};

/** The approval card on the PC's screen and the task it belongs to. */
export type RemoteCard = { request: ApprovalRequest; taskKey: string };

export type RemoteControlDeps = {
  userData: string;
  account(): RemoteAccount | null;
  tasks(): RemoteTaskSource[];
  card(): RemoteCard | null;
  /** The approval window's own answer path; false when the card it names is no longer the one on screen. */
  answer(decision: Decision): boolean;
  stop(key: string): boolean;
  followUp(key: string, text: string): Promise<boolean>;
  /** Asked when the person turns remote control on. */
  confirmEnable(): Promise<boolean>;
  transport?: typeof fetch;
  now?(): number;
  every?(run: () => void, ms: number): { stop(): void };
};

/** While a request that may be answered from elsewhere is open: the answer should arrive quickly. */
export const REMOTE_FAST_POLL_MS = 2_000;
/** While tasks run and nothing waits for an answer. */
export const REMOTE_SLOW_POLL_MS = 8_000;
const REMOTE_MIN_GAP_MS = 1_000;
const REMOTE_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000];
/** The server said it does not offer remote control: ask again this much later. */
const REMOTE_UNAVAILABLE_MS = 10 * 60_000;
const SEEN_LIMIT = 500;

// ── What leaves the PC ────────────────────────────────────────────────────

/**
 * Credentials in the shapes that commonly turn up in commands and model text. On top of `cleanText`, which removes the
 * connected Code key and any Tomverse key and makes control characters visible.
 */
const SECRET_SHAPES: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g, "[removed]"],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "[removed]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[removed]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[removed]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[removed]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[removed]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "[removed]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[removed]"],
  [/(\/\/)[^\s/:@]+:[^\s/@]+@/g, "$1[removed]@"],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [removed]"],
  [/\b([A-Za-z_-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z_-]*)(\s*[:=]\s*|\s+)("[^"]*"|'[^']*'|[^\s"'&;]+)/gi, "$1$2[removed]"],
];

/** One line as it may leave the PC: redacted, on one line, and cut to `max` characters. */
export function remoteText(text: string, key: string | undefined, max: number): string {
  let value = cleanText(text, key);
  for (const [shape, replacement] of SECRET_SHAPES) value = value.replace(shape, replacement);
  value = value.replace(/\s+/g, " ").trim();
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
}

const shownWhole = (text: string, key: string | undefined, max: number) =>
  text.length <= max && !/[\r\n]/.test(text) && remoteText(text, key, Number.MAX_SAFE_INTEGER) === text.trim();

/** The first line of a message that is prose: code blocks (file contents, diffs, output the model quotes) are skipped whole. */
function firstProseLine(text: string): string | undefined {
  let fenced = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(?:```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (!fenced && line && !/^(?: {4}|\t)/.test(raw)) return line;
  }
  return undefined;
}

/** The first prose line of the task's latest few messages, oldest first. */
export function recentProgress(task: Task | null, key?: string): string[] {
  const lines: string[] = [];
  for (const entry of [...(task?.entries ?? [])].reverse()) {
    if (entry.role !== "assistant" && entry.role !== "event") continue;
    const first = firstProseLine(entry.text);
    if (!first) continue;
    lines.unshift(remoteText(first, key, DESKTOP_REMOTE_LIMITS.progressLine));
    if (lines.length === DESKTOP_REMOTE_LIMITS.progressLines) break;
  }
  return lines;
}

/** What the request asks for. The order puts the kinds answered at the PC first, so a mixed request is one of those. */
export function remoteApprovalKind(request: ApprovalRequest): DesktopRemoteApprovalKind {
  if (request.git) return "git";
  if (request.mcp) return "mcp";
  if (request.browser) return "browser";
  if (request.web) return "web";
  if (request.command) return "command";
  if (request.files?.length) return "files";
  return "other";
}

/**
 * Whether another device may answer this request. Deterministic and checked again when an answer arrives: the person
 * there must see the whole of what they approve, and nothing that leaves this computer is approved from elsewhere.
 */
export function remoteAnswerable(request: ApprovalRequest, key?: string): boolean {
  const kind = remoteApprovalKind(request);
  if (kind === "files") {
    const files = request.files ?? [];
    return files.length <= DESKTOP_REMOTE_LIMITS.files && files.every((file) => shownWhole(file.path, key, DESKTOP_REMOTE_LIMITS.path));
  }
  if (kind !== "command" || !request.command) return false;
  const command = request.command;
  if ((command.mode !== "argv" && command.mode !== "shell") || !shownWhole(command.display, key, DESKTOP_REMOTE_LIMITS.target)) return false;
  // The CLI's own boundary: a command it leaves to a person in every mode (it sends something off this computer, names
  // a credential file or the app's data folder) is never answered from another device.
  const boundary = checkBoundaries({
    approvalId: request.id, toolCallId: request.id, toolName: request.tool, input: null, root: request.root,
    command: { mode: command.mode, file: command.file, args: command.args, display: command.display, shell: null, cwd: command.cwd,
      timeoutMs: command.timeoutMs, envNames: command.env, ...(command.background ? { background: true } : {}) },
  });
  return boundary === null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((name) => record[name] !== undefined).sort()
      .map((name) => `${JSON.stringify(name)}:${canonical(record[name])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The digest of the whole request (everything but the display language). An answer carries it back. */
export function approvalDigest(request: ApprovalRequest): string {
  const { language: _language, ...rest } = request;
  void _language;
  return createHash("sha256").update("tomverse-remote-approval-v1\n" + canonical(rest)).digest("hex");
}

export function remoteApprovalSummary(card: RemoteCard, key?: string): DesktopRemoteApproval | null {
  const { request } = card;
  const kind = remoteApprovalKind(request);
  const files = kind === "files" ? request.files ?? [] : [];
  const summary = desktopRemoteApproval.safeParse({
    id: request.id, taskKey: card.taskKey, digest: approvalDigest(request), kind,
    tool: remoteText(request.tool, key, DESKTOP_REMOTE_LIMITS.tool),
    target: kind === "command" && request.command ? remoteText(request.command.display, key, DESKTOP_REMOTE_LIMITS.target) : "",
    files: files.slice(0, DESKTOP_REMOTE_LIMITS.files).map((file) => ({
      path: remoteText(file.path, key, DESKTOP_REMOTE_LIMITS.path), action: /^[a-z_]{1,16}$/.test(file.action) ? file.action : "update",
    })),
    moreFiles: Math.max(0, files.length - DESKTOP_REMOTE_LIMITS.files),
    remote: remoteAnswerable(request, key),
  });
  return summary.success ? summary.data : null;
}

/** The report: the running tasks and the request on the screen. Everything in it went through `remoteText`. */
export function remoteSnapshot(tasks: RemoteTaskSource[], card: RemoteCard | null, key?: string): DesktopRemoteSnapshot {
  const rows: DesktopRemoteTask[] = [];
  for (const source of tasks) {
    if (rows.length === DESKTOP_REMOTE_LIMITS.tasks) break;
    const row = desktopRemoteTask.safeParse({
      key: source.key, kind: source.kind, title: remoteText(source.title, key, DESKTOP_REMOTE_LIMITS.title), status: source.status,
      progress: recentProgress(source.task, key), changes: Math.min(source.task?.changes.length ?? 0, 100_000),
      canStop: source.canStop, canFollowUp: source.canFollowUp,
    });
    if (row.success && !rows.some((entry) => entry.key === row.data.key)) rows.push(row.data);
  }
  const approval = card && rows.some((row) => row.key === card.taskKey) ? remoteApprovalSummary(card, key) : null;
  return desktopRemoteSnapshot.parse({ tasks: rows, approval });
}

// ── The switch ────────────────────────────────────────────────────────────

const settingsFile = (userData: string) => join(userData, "remote-control.json");
const savedSetting = z.object({ accountId: z.string().min(1).max(200), enabled: z.literal(true) }).strict();

function readSetting(userData: string): string | null {
  try { return savedSetting.parse(JSON.parse(readFileSync(settingsFile(userData), "utf8"))).accountId; }
  catch { return null; }
}

// ── The loop ──────────────────────────────────────────────────────────────

const refused = (id: string, reason: DesktopRemoteRefusal): DesktopRemoteAck => ({ id, result: "refused", reason });

export function createRemoteControl(deps: RemoteControlDeps) {
  const clock = deps.now ?? Date.now;
  // Looked up on each request, like the other account modules of the main process.
  const transport: typeof fetch = (input, init) => (deps.transport ?? globalThis.fetch)(input, init);
  /** The account remote control is on for, from the settings file: one account at a time, and never another's. */
  let enabledFor: string | null = null;
  let status: RemoteControlStatus = "signed_out";
  let accountId: string | null = null;
  /** The account of the last tick that had one, for the sign-out that no longer has it. */
  let lastAccount: RemoteAccount | null = null;
  let timer: { stop(): void } | undefined;
  let inFlight = false;
  let lastSent: string | null = null;
  let lastHadTasks = false;
  let lastSyncAt = 0;
  let nextAt = 0;
  let pausedUntil = 0;
  let failures = 0;
  let deviceId: string | null = null;
  let generation = 0;
  let acks: DesktopRemoteAck[] = [];
  const seen = new Set<string>();
  const answered = new Set<string>();

  const remember = (set: Set<string>, value: string) => {
    set.add(value);
    if (set.size > SEEN_LIMIT) set.delete(set.values().next().value!);
  };

  /** Forgets the session's state. A sync still in flight belongs to the old generation and changes nothing when it returns. */
  function resetSession() {
    generation += 1;
    inFlight = false;
    lastSent = null;
    lastHadTasks = false;
    nextAt = 0;
    pausedUntil = 0;
    failures = 0;
    deviceId = null;
    acks = [];
    seen.clear();
    answered.clear();
  }

  const request = async (account: RemoteAccount, method: "POST" | "DELETE", body?: object, timeoutMs = 10_000) => {
    const token = await account.authorize();
    return transport(new URL(DESKTOP_REMOTE_SYNC, account.origin), {
      method, ...(body ? { body: JSON.stringify(body) } : {}),
      headers: { Authorization: "Bearer " + token, Origin: DESKTOP_APP_ORIGIN, ...(body ? { "Content-Type": "application/json" } : {}) },
      credentials: "omit", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(timeoutMs),
    });
  };

  async function withdraw(account: RemoteAccount, timeoutMs = 3_000) {
    try {
      const response = await request(account, "DELETE", undefined, timeoutMs);
      await response.body?.cancel().catch(() => {});
    } catch { /* The server deletes the report when it expires, and hides it once the device signs out. */ }
  }

  async function apply(command: DesktopRemoteCommand, account: RemoteAccount, device: string, askedAt: number): Promise<DesktopRemoteAck> {
    if (command.deviceId !== device) return refused(command.id, "device");
    if (seen.has(command.id)) return refused(command.id, "duplicate");
    remember(seen, command.id);
    // The server's age stops when it answered this sync. The time since this PC asked covers the way here and the
    // wait behind earlier answers; counting from the ask can only make an answer look older than it is.
    if (command.ageMs + Math.max(0, clock() - askedAt) > DESKTOP_REMOTE_COMMAND_TTL_MS) return refused(command.id, "expired");
    if (command.kind === "approval") {
      if (answered.has(command.approvalId)) return refused(command.id, "duplicate");
      const card = deps.card();
      if (!card || card.request.id !== command.approvalId || card.taskKey !== command.taskKey) return refused(command.id, "not_open");
      if (approvalDigest(card.request) !== command.digest) return refused(command.id, "changed");
      if (!remoteAnswerable(card.request, account.key)) return refused(command.id, "pc_only");
      remember(answered, command.approvalId);
      return deps.answer({ id: card.request.id, action: command.decision }) ? { id: command.id, result: "applied" } : refused(command.id, "not_open");
    }
    const task = deps.tasks().find((entry) => entry.key === command.taskKey);
    if (!task) return refused(command.id, "not_open");
    if (command.kind === "stop") {
      if (!task.canStop) return refused(command.id, "unavailable");
      return deps.stop(task.key) ? { id: command.id, result: "applied" } : refused(command.id, "unavailable");
    }
    const text = command.text.trim();
    if (!task.canFollowUp || !text || text.length > DESKTOP_REMOTE_LIMITS.followUp) return refused(command.id, "unavailable");
    let sent = false;
    try { sent = await deps.followUp(task.key, text); } catch { sent = false; }
    return sent ? { id: command.id, result: "applied" } : refused(command.id, "unavailable");
  }

  function fail(retryAfterMs?: number) {
    status = "error";
    const wait = retryAfterMs ?? REMOTE_BACKOFF_MS[Math.min(failures, REMOTE_BACKOFF_MS.length - 1)]!;
    failures += 1;
    pausedUntil = clock() + wait;
  }

  async function sync(account: RemoteAccount, snapshot: DesktopRemoteSnapshot, json: string) {
    const run = generation;
    inFlight = true;
    const askedAt = clock();
    lastSyncAt = askedAt;
    const sending = acks.splice(0, DESKTOP_REMOTE_LIMITS.acks);
    try {
      const response = await request(account, "POST", { snapshot, acks: sending });
      if (run !== generation) { await response.body?.cancel().catch(() => {}); return; }
      if (!response.ok) {
        const detail = await response.json().catch(() => null) as { code?: unknown } | null;
        acks.unshift(...sending);
        if (response.status === 503 && detail?.code === "NOT_AVAILABLE") {
          status = "unavailable";
          pausedUntil = clock() + REMOTE_UNAVAILABLE_MS;
          return;
        }
        const retryAfter = Number(response.headers.get("retry-after"));
        fail(response.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 3_600) * 1_000 : undefined);
        return;
      }
      const body = desktopRemoteSyncResponse.parse(await response.json());
      if (run !== generation) return;
      failures = 0;
      status = "connected";
      lastSent = json;
      lastHadTasks = snapshot.tasks.length > 0;
      deviceId = body.deviceId;
      for (const command of body.commands) {
        const ack = await apply(command, account, body.deviceId, askedAt);
        if (run !== generation) return;
        acks.push(ack);
      }
      const now = clock();
      nextAt = now + (acks.length ? REMOTE_MIN_GAP_MS : snapshot.approval?.remote ? REMOTE_FAST_POLL_MS : REMOTE_SLOW_POLL_MS);
    } catch {
      if (run !== generation) return;
      acks.unshift(...sending);
      fail();
    } finally {
      if (run === generation) inFlight = false;
    }
  }

  function tick() {
    const account = deps.account();
    if ((account?.accountId ?? null) !== accountId) {
      resetSession();
      accountId = account?.accountId ?? null;
    }
    if (!account) { status = "signed_out"; return; }
    lastAccount = account;
    if (enabledFor !== account.accountId) { status = "off"; return; }
    if (inFlight) return;
    const now = clock();
    if (now < pausedUntil) return;
    let snapshot: DesktopRemoteSnapshot;
    try { snapshot = remoteSnapshot(deps.tasks(), deps.card(), account.key); }
    catch { return; }
    // Nothing runs and the server already knows: no request at all.
    if (!snapshot.tasks.length && !lastHadTasks) {
      if (status !== "unavailable" && status !== "error") status = "idle";
      return;
    }
    const json = JSON.stringify(snapshot);
    if (json === lastSent && now < nextAt && !acks.length) return;
    if (now - lastSyncAt < REMOTE_MIN_GAP_MS) return;
    void sync(account, snapshot, json);
  }

  function view(): RemoteControlView {
    const account = deps.account();
    return {
      enabled: Boolean(account && enabledFor === account.accountId),
      status: !account ? "signed_out" : enabledFor !== account.accountId ? "off" : status === "off" || status === "signed_out" ? "idle" : status,
      page: account ? new URL("/remote", account.origin).toString() : null,
    };
  }

  async function set(enabled: boolean) {
    const account = deps.account();
    if (!account) return;
    if (enabled) {
      if (enabledFor === account.accountId) return;
      if (!(await deps.confirmEnable())) return;
      if (deps.account()?.accountId !== account.accountId) return;
      mkdirSync(dirname(settingsFile(deps.userData)), { recursive: true, mode: 0o700 });
      writeFileAtomic(settingsFile(deps.userData), JSON.stringify({ accountId: account.accountId, enabled: true }));
      enabledFor = account.accountId;
      resetSession();
      status = "idle";
      return;
    }
    if (enabledFor !== account.accountId) return;
    rmSync(settingsFile(deps.userData), { force: true });
    enabledFor = null;
    resetSession();
    status = "off";
    await withdraw(account);
  }

  return {
    start() {
      enabledFor = readSetting(deps.userData);
      timer?.stop();
      timer = (deps.every ?? ((run, ms) => {
        const handle = setInterval(run, ms);
        handle.unref?.();
        return { stop: () => clearInterval(handle) };
      }))(tick, 1_000);
    },
    shutdown() {
      timer?.stop();
      timer = undefined;
      resetSession();
    },
    /** Typed commands from Settings; the renderer names nothing else. */
    async command(value: unknown): Promise<RemoteControlView> {
      const input = remoteControlCommand.parse(value);
      if (input.action === "set") await set(input.enabled);
      return view();
    },
    /**
     * The account is signing out (the main process no longer offers it as an account): the server forgets this PC's
     * report now rather than when it expires, with the access token the sign-out still holds.
     */
    async signingOut(accessToken: string) {
      const account = lastAccount;
      const reported = deviceId !== null || lastHadTasks;
      resetSession();
      if (account && enabledFor === account.accountId && reported) await withdraw({ ...account, authorize: async () => accessToken }, 2_000);
    },
    tick,
    view,
    /** Whether a sync is running now. */
    busy: () => inFlight,
  };
}

export type RemoteControl = ReturnType<typeof createRemoteControl>;
