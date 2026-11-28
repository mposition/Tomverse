import { z } from "zod";

/**
 * Tomverse Desktop remote control: what a Desktop reports about the Code tasks it is running, and what the account's
 * other signed-in devices may ask it to do (docs/ops/desktop-remote-control.md).
 *
 * Shared by the server routes and the Desktop main process, so both read the same limits and shapes. Pure: no
 * Prisma, no environment, no Node APIs.
 *
 * The PC decides every approval. A remote answer names one approval request by id and by the digest of the request
 * the Desktop reported, and the Desktop applies it only to that request while it is still open on its screen, once.
 * The server records who answered; it can never make an approval the Desktop does not already have open.
 */

export const DESKTOP_REMOTE_LIMITS = {
  /** Running tasks one report may describe. */
  tasks: 8,
  title: 120,
  progressLines: 4,
  progressLine: 160,
  /** The one command line an approval for a command shows. */
  target: 300,
  /** File paths an approval for a file change shows; a change of more files is answered at the PC. */
  files: 10,
  path: 240,
  /** A preview of a file change: lines per file, in all, and characters per line (the person turned it on at the PC). */
  previewLines: 8,
  previewTotal: 40,
  previewLine: 120,
  tool: 64,
  followUp: 2_000,
  /** The JSON body of one sync, in bytes. */
  uploadBytes: 24 * 1024,
  acks: 20,
  commandsPerSync: 10,
} as const;

/** A Desktop's report stays this long after its last sync; a PC that stops reporting leaves the list. */
export const DESKTOP_REMOTE_SNAPSHOT_TTL_MS = 3 * 60_000;
/**
 * After the PC turned remote control off, the server keeps an empty marker of that for this long, with the number of the
 * request that did it. A sync the PC had sent before, which reaches the server later, carries a lower number and is
 * refused, so it cannot put the report back. Longer than any request of the PC can stay on the wire.
 */
export const DESKTOP_REMOTE_WITHDRAWN_MS = 2 * 60_000;
/** A remote answer is handed to the PC only within this window and is never applied after it. */
export const DESKTOP_REMOTE_COMMAND_TTL_MS = 2 * 60_000;
/** Answer rows are kept this long after they were made, so the phone can show what became of them, then deleted. */
export const DESKTOP_REMOTE_COMMAND_RETENTION_MS = 15 * 60_000;

/** `DesktopRemoteCommand_kind_check`. */
export const DESKTOP_REMOTE_COMMAND_KINDS = ["approval", "stop", "follow_up"] as const;
/** `DesktopRemoteCommand_decision_check`. A remote answer is allow once or deny: never "allow for this run". */
export const DESKTOP_REMOTE_DECISIONS = ["once", "deny"] as const;
/** `DesktopRemoteCommand_result_check`: what the PC reported doing with an answer it received. */
export const DESKTOP_REMOTE_RESULTS = ["applied", "refused"] as const;
/** Why the PC refused an answer it received. */
export const DESKTOP_REMOTE_REFUSALS = ["not_open", "changed", "pc_only", "duplicate", "expired", "device", "unavailable"] as const;
/**
 * What an approval request asks for. Only `files` and `command` can be answered from another device; the rest (a
 * commit, push or pull request, an MCP tool, a web page, the browser panel) are answered at the PC.
 */
export const DESKTOP_REMOTE_APPROVAL_KINDS = ["files", "command", "web", "browser", "mcp", "git", "other"] as const;
export const DESKTOP_REMOTE_ANSWERABLE_KINDS: readonly DesktopRemoteApprovalKind[] = ["files", "command"];
/** Why a file change shows no preview lines. */
export const DESKTOP_REMOTE_PREVIEW_OMITTED = ["binary", "large", "secret", "unreadable"] as const;
export const DESKTOP_REMOTE_TASK_STATUSES = [
  "queued", "starting", "running", "approval", "stopping", "completed", "clarification", "blocked", "stopped", "unknown", "failed",
] as const;
export const DESKTOP_REMOTE_TASK_KINDS = ["foreground", "parallel", "scheduled"] as const;

export type DesktopRemoteCommandKind = (typeof DESKTOP_REMOTE_COMMAND_KINDS)[number];
export type DesktopRemoteDecision = (typeof DESKTOP_REMOTE_DECISIONS)[number];
export type DesktopRemoteResult = (typeof DESKTOP_REMOTE_RESULTS)[number];
export type DesktopRemoteRefusal = (typeof DESKTOP_REMOTE_REFUSALS)[number];
export type DesktopRemoteApprovalKind = (typeof DESKTOP_REMOTE_APPROVAL_KINDS)[number];
export type DesktopRemoteTaskStatus = (typeof DESKTOP_REMOTE_TASK_STATUSES)[number];

/** A `MobileDevice` id: what the Desktop bearer names and the web screen uses to pick a PC. */
export const desktopRemoteDeviceId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const line = (max: number) => z.string().max(max);

export const desktopRemoteTask = z.object({
  /** The task's run id on the PC: stop and follow-up name it. */
  key: z.uuid(),
  kind: z.enum(DESKTOP_REMOTE_TASK_KINDS),
  title: line(DESKTOP_REMOTE_LIMITS.title),
  status: z.enum(DESKTOP_REMOTE_TASK_STATUSES),
  /** The first line of the task's latest messages, oldest first, already redacted on the PC. */
  progress: z.array(line(DESKTOP_REMOTE_LIMITS.progressLine)).max(DESKTOP_REMOTE_LIMITS.progressLines),
  changes: z.int().min(0).max(100_000),
  canStop: z.boolean(),
  canFollowUp: z.boolean(),
}).strict();

export const desktopRemoteApproval = z.object({
  id: z.uuid(),
  taskKey: z.uuid(),
  /** The PC's digest of the whole request; an answer carries it back and is refused if the request differs. */
  digest,
  kind: z.enum(DESKTOP_REMOTE_APPROVAL_KINDS),
  tool: line(DESKTOP_REMOTE_LIMITS.tool),
  /** The command line, for a command; empty otherwise. */
  target: line(DESKTOP_REMOTE_LIMITS.target),
  files: z.array(z.object({
    path: line(DESKTOP_REMOTE_LIMITS.path),
    action: z.string().regex(/^[a-z_]{1,16}$/),
    /** Lines added and removed in this file. Sent only to a server that names `desktopRemotePreview`. */
    added: z.int().min(0).max(10_000_000).optional(),
    removed: z.int().min(0).max(10_000_000).optional(),
    /** The changed lines (`+ ` or `- ` first), redacted on the PC. Only when the person turned previews on there. */
    preview: z.array(line(DESKTOP_REMOTE_LIMITS.previewLine + 2)).max(DESKTOP_REMOTE_LIMITS.previewLines).optional(),
    omitted: z.enum(DESKTOP_REMOTE_PREVIEW_OMITTED).optional(),
  }).strict()).max(DESKTOP_REMOTE_LIMITS.files),
  moreFiles: z.int().min(0).max(100_000),
  /** Whether the PC accepts an answer from another device for this request. */
  remote: z.boolean(),
}).strict();

export const desktopRemoteSnapshot = z.object({
  tasks: z.array(desktopRemoteTask).max(DESKTOP_REMOTE_LIMITS.tasks),
  /** The request on the PC's screen now, if any: one at a time, as the PC shows them. */
  approval: desktopRemoteApproval.nullable(),
}).strict().superRefine((snapshot, context) => {
  const keys = new Set(snapshot.tasks.map((task) => task.key));
  if (keys.size !== snapshot.tasks.length) context.addIssue({ code: "custom", message: "Task keys repeat.", path: ["tasks"] });
  const approval = snapshot.approval;
  if (approval && !keys.has(approval.taskKey)) context.addIssue({ code: "custom", message: "The approval names no task.", path: ["approval"] });
  if (approval && approval.files.reduce((sum, file) => sum + (file.preview?.length ?? 0), 0) > DESKTOP_REMOTE_LIMITS.previewTotal) {
    context.addIssue({ code: "custom", message: "The preview is too long.", path: ["approval", "files"] });
  }
  if (approval?.remote && !DESKTOP_REMOTE_ANSWERABLE_KINDS.includes(approval.kind)) {
    context.addIssue({ code: "custom", message: "This kind of request is answered at the PC.", path: ["approval", "remote"] });
  }
});

export const desktopRemoteAck = z.object({
  id: z.uuid(),
  result: z.enum(DESKTOP_REMOTE_RESULTS),
  reason: z.enum(DESKTOP_REMOTE_REFUSALS).optional(),
}).strict();

/** `POST /api/desktop/remote/sync`, from the PC: what it runs now, and what it did with the answers it last received. */
/**
 * The PC numbers its requests, each higher than the last (its clock in milliseconds, or one more than the last number).
 * The server takes a report only when its number is higher than the last it took from that PC, and than the PC's
 * withdrawal.
 */
export const desktopRemoteSeq = z.int().min(1).max(Number.MAX_SAFE_INTEGER);

/** `DELETE /api/desktop/remote/sync`: the PC turned remote control off, or is signing out. */
export const desktopRemoteWithdrawRequest = z.object({ seq: desktopRemoteSeq }).strict();

/** A report without the preview fields: what a server with previews switched off keeps of a newer PC's report. */
export function withoutDesktopRemotePreview(snapshot: z.infer<typeof desktopRemoteSnapshot>): z.infer<typeof desktopRemoteSnapshot> {
  if (!snapshot.approval) return snapshot;
  return { ...snapshot, approval: { ...snapshot.approval, files: snapshot.approval.files.map(({ path, action }) => ({ path, action })) } };
}

export const desktopRemoteSyncRequest = z.object({
  seq: desktopRemoteSeq,
  snapshot: desktopRemoteSnapshot,
  acks: z.array(desktopRemoteAck).max(DESKTOP_REMOTE_LIMITS.acks),
}).strict();

const commandBase = { id: z.uuid(), deviceId: desktopRemoteDeviceId, taskKey: z.uuid(), ageMs: z.int().min(0) };
export const desktopRemoteCommand = z.discriminatedUnion("kind", [
  z.object({ ...commandBase, kind: z.literal("approval"), approvalId: z.uuid(), digest, decision: z.enum(DESKTOP_REMOTE_DECISIONS) }).strict(),
  z.object({ ...commandBase, kind: z.literal("stop") }).strict(),
  z.object({ ...commandBase, kind: z.literal("follow_up"), text: z.string().min(1).max(DESKTOP_REMOTE_LIMITS.followUp) }).strict(),
]);

export const desktopRemoteSyncResponse = z.object({
  ok: z.literal(true),
  /** The device the bearer names; the PC refuses a command that names another. */
  deviceId: desktopRemoteDeviceId,
  commands: z.array(desktopRemoteCommand).max(DESKTOP_REMOTE_LIMITS.commandsPerSync),
}).strict();

/**
 * The passkey that confirms a remote command (docs/ops/desktop-remote-control.md): a WebAuthn assertion over a
 * single-use challenge the server bound to this one command. Shapes only; the checks are in lib/webauthnCore.ts.
 */
export const DESKTOP_REMOTE_PASSKEY_LIMITS = {
  /** Passkeys one account may register. */
  perAccount: 5,
  label: 80,
  /** A challenge is valid this long, once. */
  challengeTtlMs: 2 * 60_000,
} as const;

const base64urlText = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9_-]+$/);

export const desktopRemotePasskeyAssertion = z.object({
  challengeId: z.uuid(),
  credentialId: base64urlText(1400),
  clientDataJSON: base64urlText(6000),
  authenticatorData: base64urlText(6000),
  signature: base64urlText(1400),
}).strict();

const approvalRequest = z.object({ kind: z.literal("approval"), deviceId: desktopRemoteDeviceId, taskKey: z.uuid(), approvalId: z.uuid(), digest,
  decision: z.enum(DESKTOP_REMOTE_DECISIONS) }).strict();
const stopRequest = z.object({ kind: z.literal("stop"), deviceId: desktopRemoteDeviceId, taskKey: z.uuid() }).strict();
const followUpRequest = z.object({ kind: z.literal("follow_up"), deviceId: desktopRemoteDeviceId, taskKey: z.uuid(),
  text: z.string().trim().min(1).max(DESKTOP_REMOTE_LIMITS.followUp) }).strict();

/** One command as the server records it. */
export const desktopRemoteCommandRequest = z.discriminatedUnion("kind", [approvalRequest, stopRequest, followUpRequest]);

/** `POST /api/desktop/remote/commands`, from the signed-in web screen: the command, and its passkey where one is needed. */
export const desktopRemoteCommandSubmission = z.discriminatedUnion("kind", [
  approvalRequest.extend({ passkey: desktopRemotePasskeyAssertion.optional() }).strict(),
  stopRequest,
  followUpRequest.extend({ passkey: desktopRemotePasskeyAssertion.optional() }).strict(),
]);

/**
 * Whether a command is confirmed with a passkey once the account has one: "allow once" and a follow-up widen what
 * the task does. Deny and stop only reduce what happens, so they stay one tap.
 */
export const desktopRemoteNeedsPasskey = (command: DesktopRemoteCommandRequest) =>
  (command.kind === "approval" && command.decision === "once") || command.kind === "follow_up";

/** `POST /api/desktop/remote/passkey`. */
export const desktopRemotePasskeyRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("options-register") }).strict(),
  z.object({ action: z.literal("options-command"), command: desktopRemoteCommandRequest }).strict(),
  z.object({ action: z.literal("options-remove"), passkeyId: z.uuid() }).strict(),
  z.object({
    action: z.literal("register"), challengeId: z.uuid(), label: z.string().trim().min(1).max(DESKTOP_REMOTE_PASSKEY_LIMITS.label),
    credentialId: base64urlText(1400), clientDataJSON: base64urlText(6000), attestationObject: base64urlText(20_000),
    /** An account that has a passkey already adds the next one only with it. */
    passkey: desktopRemotePasskeyAssertion.optional(),
  }).strict(),
  z.object({ action: z.literal("remove"), passkeyId: z.uuid(), passkey: desktopRemotePasskeyAssertion }).strict(),
]);
export type DesktopRemotePasskeyRequest = z.infer<typeof desktopRemotePasskeyRequest>;
export type DesktopRemotePasskeyAssertion = z.infer<typeof desktopRemotePasskeyAssertion>;

export type DesktopRemotePasskeyView = { id: string; label: string; createdAt: string; lastUsedAt: string | null };

/** What the screen knows of passkeys: whether the server offers them, and the account's own. */
export type DesktopRemotePasskeyState = { enabled: boolean; passkeys: DesktopRemotePasskeyView[] };

export type DesktopRemoteTask = z.infer<typeof desktopRemoteTask>;
export type DesktopRemoteApproval = z.infer<typeof desktopRemoteApproval>;
export type DesktopRemoteSnapshot = z.infer<typeof desktopRemoteSnapshot>;
export type DesktopRemoteAck = z.infer<typeof desktopRemoteAck>;
export type DesktopRemoteSyncRequest = z.infer<typeof desktopRemoteSyncRequest>;
export type DesktopRemoteCommand = z.infer<typeof desktopRemoteCommand>;
export type DesktopRemoteSyncResponse = z.infer<typeof desktopRemoteSyncResponse>;
export type DesktopRemoteCommandRequest = z.infer<typeof desktopRemoteCommandRequest>;

/** What became of one answer, as the web screen shows it. */
export type DesktopRemoteCommandState = "waiting" | "delivered" | "applied" | "refused" | "expired";

export type DesktopRemoteCommandView = {
  id: string;
  kind: DesktopRemoteCommandKind;
  taskKey: string;
  approvalId: string | null;
  decision: DesktopRemoteDecision | null;
  state: DesktopRemoteCommandState;
  reason: DesktopRemoteRefusal | null;
  createdAt: string;
};

export type DesktopRemoteDeviceView = {
  deviceId: string;
  label: string;
  updatedAt: string;
  snapshot: DesktopRemoteSnapshot;
  commands: DesktopRemoteCommandView[];
};

/** `GET /api/desktop/remote/devices`. `canAct` is false for a session that is not recently signed in: it may only look. */
export type DesktopRemoteDevicesResponse = {
  ok: true;
  canAct: boolean;
  /** Absent from a server that predates passkeys; the screen then asks for none. */
  passkey?: DesktopRemotePasskeyState;
  devices: DesktopRemoteDeviceView[];
};

export type DesktopRemoteCommandRefusal =
  | "DEVICE_NOT_FOUND" | "TASK_NOT_RUNNING" | "APPROVAL_NOT_OPEN" | "APPROVAL_CHANGED" | "APPROVAL_PC_ONLY"
  | "STOP_UNAVAILABLE" | "FOLLOW_UP_UNAVAILABLE" | "ALREADY_ANSWERED" | "PASSKEY_REQUIRED" | "PASSKEY_INVALID";

/**
 * Whether a web request may be recorded against the PC's latest report. The PC checks again before it acts; this is
 * the server's half, so an answer for a request the PC never reported, or reported as answered at the PC, is never
 * stored at all.
 */
export function checkDesktopRemoteCommand(
  input: DesktopRemoteCommandRequest,
  snapshot: DesktopRemoteSnapshot,
): { ok: true } | { ok: false; code: DesktopRemoteCommandRefusal } {
  const task = snapshot.tasks.find((entry) => entry.key === input.taskKey);
  if (input.kind === "approval") {
    const approval = snapshot.approval;
    if (!approval || approval.id !== input.approvalId || approval.taskKey !== input.taskKey || !task) return { ok: false, code: "APPROVAL_NOT_OPEN" };
    if (approval.digest !== input.digest) return { ok: false, code: "APPROVAL_CHANGED" };
    if (!approval.remote || !DESKTOP_REMOTE_ANSWERABLE_KINDS.includes(approval.kind)) return { ok: false, code: "APPROVAL_PC_ONLY" };
    return { ok: true };
  }
  if (!task) return { ok: false, code: "TASK_NOT_RUNNING" };
  if (input.kind === "stop") return task.canStop ? { ok: true } : { ok: false, code: "STOP_UNAVAILABLE" };
  return task.canFollowUp ? { ok: true } : { ok: false, code: "FOLLOW_UP_UNAVAILABLE" };
}
