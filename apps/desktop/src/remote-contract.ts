import { z } from "zod";

/**
 * What the remote-project screen asks of the main process, and what it gets back. The screen names an action and the three things
 * a person types (the SSH target, an optional port, the folder on that machine); the main process validates them in full
 * (apps/tomverse-cli/src/remote-target.ts) before ssh is given anything. No key, password or passphrase is ever typed here: the
 * connection uses the person's own ssh and its configuration.
 */

/** What a person typed, as text: the main process is the judge of whether it is a target. */
export const remoteTargetInput = z.object({
  destination: z.string().max(300),
  port: z.union([z.string().max(8), z.number()]).optional(),
  folder: z.string().max(1100),
}).strict();
export type RemoteTargetInput = z.infer<typeof remoteTargetInput>;

/** How the agent's commands are started on the remote machine: `sh -c` (the default) or `bash -lc`, which reads the remote user's profile. */
export const remoteShell = z.enum(["sh", "bash-login"]);
export type RemoteShell = z.infer<typeof remoteShell>;

export const remoteProjectInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read") }).strict(),
  z.object({ action: z.literal("set-enabled"), enabled: z.boolean() }).strict(),
  /** For the remote project that is open now: how its commands are started. Takes effect for the next task. */
  z.object({ action: z.literal("set-shell"), shell: remoteShell }).strict(),
  z.object({ action: z.literal("test"), target: remoteTargetInput }).strict(),
  z.object({ action: z.literal("open"), target: remoteTargetInput }).strict(),
  z.object({ action: z.literal("reconnect") }).strict(),
]);
export type RemoteProjectInput = z.infer<typeof remoteProjectInput>;

/** Why a connection or a folder was refused, in the words of the screen (it has its own text for each). */
export const REMOTE_FAILURES = [
  "invalid-target", "ssh-missing", "auth", "host-key", "host-key-changed", "name-not-found", "unreachable", "timeout", "connection-lost",
  "folder-missing", "not-a-folder", "folder-too-broad", "unsupported-remote", "protocol", "disabled", "busy", "failed",
] as const;
export type RemoteFailure = (typeof REMOTE_FAILURES)[number];

export type RemoteResult =
  | { ok: true; system: string; folder: string }
  | { ok: false; failure: RemoteFailure; message: string };

export type RemoteRecent = { destination: string; port?: number; folder: string };

export type RemoteConnectionState = "connected" | "lost" | "unknown";

/** The remote project that is open, as the window shows it. `shell` is in the Settings view; the status above the composer does not need it. */
export type RemoteCurrent = { label: string; folder: string; state: RemoteConnectionState; shell?: RemoteShell };

export type RemoteView = {
  /** The switch in Settings. Off: nothing of this exists and no ssh is started. */
  enabled: boolean;
  recent: RemoteRecent[];
  current: RemoteCurrent | null;
  /** The OS sandbox is on for local commands, but commands of a remote project run outside it. */
  sandboxOutside: boolean;
};

export type RemoteProjectReply = { view: RemoteView; result?: RemoteResult };

/** What the snapshot says of the open project when it is on another machine. */
export type RemoteSnapshot = RemoteCurrent & { sandboxOutside: boolean };
